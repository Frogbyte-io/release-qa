import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkTestRoot,
  discoverProjects,
  downloadCandidate,
  evaluatePullRequest,
  isRunId,
  listRuns,
  installableArtifact,
  loadProject,
  parseCandidate,
  reportForSync,
  resumeRun,
  selectPlan,
  startRun,
  syncRun,
  type Candidate,
  type CandidateDownloadApi,
  type Project,
  type RunOptions,
  type RunResult,
  type SyncApi,
} from '@frogbyte-io/release-qa';
import type {
  ActionResult,
  CheckoutView,
  RunConfirmation,
  RunEntry,
  RunListResult,
  RunPreviewResult,
  RunProgressLine,
  RunRequest,
  RunStatus,
  SyncRequest,
} from '../shared/contract.ts';
import { accessText, parseRepository, parseTarget, requireWrite, type ActionApi } from './release-actions.ts';

/** Everything a run touches on GitHub: the reads and writes of a merge, downloading an asset by id, and uploading results. */
export type RunApi = ActionApi & CandidateDownloadApi & SyncApi;

export interface CheckoutStore {
  get(repository: string): Promise<string | undefined>;
  set(repository: string, path: string): Promise<void>;
}

/** Runs git in a folder and returns what it printed; rejects when git fails. */
export type Git = (cwd: string, args: string[]) => Promise<string>;
const realGit: Git = (cwd, args) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd, timeout: 15_000, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
});

export interface RunDeps {
  api: RunApi;
  checkouts: CheckoutStore;
  session: RunSession;
  /** Downloaded candidates live here, under the app's own data folder, never in the consumer's checkout. */
  candidatesDir: string;
  /** The operating system's folder dialog. Owned by the main process; the window cannot name a path. */
  chooseDirectory(): Promise<string | undefined>;
  /** The file that hosts the consumer's code in a child process, when this code has been bundled (see `RunOptions`). */
  consumerWorker?: string;
  git?: Git;
  /** Seams for tests: the shared functions, replaced by fakes. */
  evaluate?: typeof evaluatePullRequest;
  download?: typeof downloadCandidate;
  start?: typeof startRun;
  resume?: typeof resumeRun;
  sync?: typeof syncRun;
}

const MAX_TEXT = 300;
const refusal = (error: string): { ok: false; error: string } => ({ ok: false, error: error.slice(0, MAX_TEXT * 2) });
const uncertain = (error: string): { ok: false; error: string; uncertain: true } => ({ ...refusal(error), uncertain: true });
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

// ---------------------------------------------------------------------------------------------------------------
// What the window may say. Everything is checked again here.

export function parseRunRequest(value: unknown): RunRequest | undefined {
  const target = parseTarget(value);
  const rec = value as Record<string, unknown>;
  if (target === undefined || typeof rec.profile !== 'string' || !idPattern.test(rec.profile) || typeof rec.suite !== 'string' || !idPattern.test(rec.suite)) return undefined;
  if (rec.runId !== undefined && !isRunId(rec.runId)) return undefined;
  return { ...target, profile: rec.profile, suite: rec.suite, ...(rec.runId === undefined ? {} : { runId: rec.runId as string }) };
}

export function parseRunConfirmation(value: unknown): RunConfirmation | undefined {
  const request = parseRunRequest(value);
  // A request that parsed is an object; reading fields first would throw on a null from the window instead of refusing it.
  if (request === undefined) return undefined;
  const { candidateId, root } = value as Record<string, unknown>;
  if (typeof candidateId !== 'string' || candidateId.length === 0 || candidateId.length > 200) return undefined;
  if (typeof root !== 'string' || root.length === 0 || root.length > 4096) return undefined;
  return { ...request, candidateId, root };
}

export function parseSyncRequest(value: unknown): SyncRequest | undefined {
  const target = parseTarget(value);
  const runId = (value as Record<string, unknown> | undefined)?.runId;
  return target === undefined || !isRunId(runId) ? undefined : { ...target, runId };
}

// ---------------------------------------------------------------------------------------------------------------
// The one run this app does at a time. It is state in the main process, so closing the window loses none of it.

const PROGRESS_LINES = 200;

type Active = Extract<RunStatus, { state: 'preparing' | 'running' | 'finished' | 'failed' }>;

export class RunSession {
  private status: RunStatus = { state: 'idle' };
  private controller: AbortController | undefined;
  private job: Promise<void> = Promise.resolve();
  private readonly notify: (status: RunStatus) => void;
  private uploading = false;

  constructor(notify: (status: RunStatus) => void = () => undefined) {
    this.notify = notify;
  }

  get current(): RunStatus { return this.status; }
  get busy(): boolean { return this.status.state === 'preparing' || this.status.state === 'running'; }
  /** True while an upload reads a run's journal; no run may start or resume under it, nor a second upload begin. */
  get syncing(): boolean { return this.uploading; }

  /** Claims the session for an upload; refused while a run or another upload is under way. Pair with `endSync`. */
  beginSync(): boolean {
    if (this.busy || this.uploading) return false;
    this.uploading = true;
    return true;
  }

  endSync(): void { this.uploading = false; }

  /** Resolves when the work started by the last `begin` has ended. */
  settled(): Promise<void> { return this.job; }

  /** Claims the session for a new run; refuses while another is under way, since one machine has one test root. */
  begin(info: Pick<Active, 'kind' | 'repository' | 'number' | 'candidateId' | 'profile' | 'suite'> & { runId?: string }, work: (controller: AbortController) => Promise<void>): boolean {
    if (this.busy || this.uploading) return false;
    const controller = new AbortController();
    this.controller = controller;
    this.set({ state: 'preparing', ...info, message: info.kind === 'resume' ? 'Preparing to resume the run.' : 'Downloading and verifying the candidate.', stopping: false, progress: [] });
    this.job = work(controller).catch((error: unknown) => {
      this.patch({ state: 'failed', message: `The run stopped: ${error instanceof Error ? error.message : String(error)}`.slice(0, MAX_TEXT * 2) });
    });
    return true;
  }

  patch(changes: Partial<Active>): void {
    if (this.status.state === 'idle') return;
    this.set({ ...this.status, ...changes } as Active);
  }

  progress(line: RunProgressLine): void {
    if (this.status.state === 'idle') return;
    this.set({ ...this.status, progress: [...this.status.progress, line].slice(-PROGRESS_LINES) });
  }

  stop(): boolean {
    if (!this.busy || this.controller === undefined) return false;
    this.controller.abort();
    this.patch({ stopping: true });
    return true;
  }

  private set(status: RunStatus): void {
    this.status = status;
    this.notify(status);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The checkout: the consumer's code that will run on this machine.

async function inspectCheckout(repository: string, path: string, deps: RunDeps): Promise<{ ok: true; project: Project; projectPath: string } | { ok: false; error: string }> {
  const projectPath = join(path, 'qa', 'project.json');
  const local = await loadProject(projectPath);
  if (!local.ok) return refusal(`${path} does not hold a usable qa/project.json: ${local.error.slice(0, MAX_TEXT)}`);
  const remote = await discoverProjects(deps.api, `https://github.com/${repository}`);
  const project = remote.projects[0]?.project;
  if (project === undefined) return refusal(`The project file of ${repository} on GitHub could not be read (${remote.problems[0]?.reason ?? 'unknown'}), so the folder cannot be checked against it.`);
  if (project.projectId !== local.project.projectId) {
    return refusal(`${path} is the checkout of project "${local.project.projectId}", but ${repository} is project "${project.projectId}".`);
  }
  return { ok: true, project: local.project, projectPath };
}

const viewOf = (path: string, inspected: { ok: true } | { ok: false; error: string }): CheckoutView => (inspected.ok ? { status: 'ready', path } : { status: 'invalid', path, error: inspected.error });

export async function getCheckout(input: unknown, deps: RunDeps): Promise<CheckoutView> {
  const repository = parseRepository(input);
  if (repository === undefined) return { status: 'invalid', path: '', error: 'That is not a valid repository.' };
  const path = await deps.checkouts.get(repository);
  return path === undefined ? { status: 'none' } : viewOf(path, await inspectCheckout(repository, path, deps));
}

/** Opens the folder dialog. A folder is remembered only if it is a checkout of this project; anything else is reported and dropped. */
export async function chooseCheckout(input: unknown, deps: RunDeps): Promise<CheckoutView> {
  const repository = parseRepository(input);
  if (repository === undefined) return { status: 'invalid', path: '', error: 'That is not a valid repository.' };
  const path = await deps.chooseDirectory();
  if (path === undefined) return getCheckout(repository, deps);
  const inspected = await inspectCheckout(repository, path, deps);
  if (inspected.ok) await deps.checkouts.set(repository, path);
  return viewOf(path, inspected);
}

/** The test root and journals live in the checkout's `.release-qa`, where `release-qa run` from that folder puts them too. */
const rootOf = (checkout: string): string => join(checkout, '.release-qa');
const stateDirOf = (checkout: string): string => join(rootOf(checkout), 'runs');

// ---------------------------------------------------------------------------------------------------------------
// Reading what a run would do

/** The active candidate's record, from the draft release's `candidate.json` (the asset the evaluator selected). */
async function loadCandidateRecord(repository: string, assetId: number, deps: RunDeps): Promise<{ ok: true; candidate: Candidate } | { ok: false; error: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'release-qa-candidate-'));
  try {
    const downloaded = await deps.api.download(`repos/${repository}/releases/assets/${assetId}`, join(dir, 'candidate.json'));
    if (!downloaded.ok) return refusal(`The candidate record could not be downloaded: ${accessText(downloaded.reason)}`);
    const parsed = parseCandidate(JSON.parse(await readFile(join(dir, 'candidate.json'), 'utf8')) as unknown);
    return parsed.ok ? { ok: true, candidate: parsed.value } : refusal(`The candidate record is not valid: ${parsed.error.message}`);
  } catch {
    return refusal('The candidate record could not be read.');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface Assessment {
  candidate: Candidate;
  releaseId: number;
  checkout: string;
  projectPath: string;
  root: string;
  automated: string[];
  manual: string[];
  artifact: Candidate['artifacts'][number];
}

/**
 * Everything that must hold before a run may start or resume, read now and touching nothing on this machine: write
 * access, a checkout of this project, a plan for the profile and suite, the active candidate at the head the person saw,
 * the checkout being exactly the candidate's test revision, and a designated test root.
 */
async function assess(request: RunRequest, deps: RunDeps): Promise<{ ok: true; value: Assessment } | { ok: false; error: string }> {
  const allowed = await requireWrite(request.repository, deps.api, 'run tests here');
  if (!allowed.ok) return allowed;
  const stored = await deps.checkouts.get(request.repository);
  if (stored === undefined) return refusal('Choose a local checkout of this repository first.');
  const inspected = await inspectCheckout(request.repository, stored, deps);
  if (!inspected.ok) return inspected;
  const plan = selectPlan(inspected.project, request.profile, request.suite);
  if (!plan.ok) return refusal(plan.error);

  if (request.runId !== undefined) {
    const run = (await listRuns(stateDirOf(stored))).find((item) => item.runId === request.runId);
    if (run === undefined) return refusal(`There is no local run ${request.runId} for this checkout.`);
    if (run.profile !== request.profile || run.suite !== request.suite) return refusal(`Run ${request.runId} was for ${run.profile}/${run.suite}, not ${request.profile}/${request.suite}.`);
    if (run.problem !== undefined && !run.resumable) return refusal(`Run ${request.runId} cannot be resumed: ${run.problem}.`);
    if (!run.resumable) return refusal(`Run ${request.runId} has nothing left to run.`);
  }

  const evaluated = await (deps.evaluate ?? evaluatePullRequest)(request.repository, request.number, deps.api, request.headSha);
  if (!evaluated.ok) return refusal(`The pull request could not be evaluated: ${evaluated.error}`);
  const { candidateId, candidateReleaseId, candidateAssetId } = evaluated.value;
  if (candidateId === undefined || candidateReleaseId === undefined || candidateAssetId === undefined) return refusal('This pull request has no active candidate. Prepare one first.');
  const loaded = await loadCandidateRecord(request.repository, candidateAssetId, deps);
  if (!loaded.ok) return loaded;
  const { candidate } = loaded;
  if (candidate.id !== candidateId || candidate.pullRequest !== request.number) return refusal('The active candidate changed while it was being read. Refresh and try again.');
  const chosen = installableArtifact(candidate, request.profile);
  if (!chosen.ok) return refusal(`${chosen.error}.`);
  const artifact = chosen.artifact;
  if (request.runId !== undefined) {
    const run = (await listRuns(stateDirOf(stored))).find((item) => item.runId === request.runId);
    if (run?.candidateId !== candidate.id) return refusal(`Run ${request.runId} tested candidate ${run?.candidateId ?? 'unknown'}; the active candidate is now ${candidate.id}. A run for another candidate is not resumed.`);
  }

  // The scenarios that will run come from this folder, so it must be the candidate's own test revision and unmodified.
  const git = deps.git ?? realGit;
  try {
    const head = (await git(stored, ['rev-parse', 'HEAD'])).trim();
    if (head !== candidate.testRevision) return refusal(`The checkout is at ${head.slice(0, 7)}, but candidate ${candidate.id} was built with tests at ${candidate.testRevision.slice(0, 7)}. Check that revision out first.`);
    if ((await git(stored, ['status', '--porcelain', '--untracked-files=no'])).trim() !== '') return refusal('The checkout has uncommitted changes to tracked files; the tests that run would not be the candidate\'s tests.');
  } catch {
    return refusal('The checkout\'s git state could not be read. Is it a git working copy?');
  }

  const root = rootOf(stored);
  const designated = await checkTestRoot(root);
  if (!designated.ok) {
    const why = { 'not-a-directory': 'does not exist', 'unsafe-root': 'is not a safe place for a test root', 'missing-marker': 'has not been designated a test root' }[designated.reason];
    return refusal(`The test root ${root} ${why}. Designate it once with: release-qa designate --root "${root}"`);
  }
  return { ok: true, value: { candidate, releaseId: candidateReleaseId, checkout: stored, projectPath: inspected.projectPath, root, automated: plan.automated.map((r) => r.key), manual: plan.manual.map((r) => r.key), artifact } };
}

/** What the person is shown before confirming. It changes nothing on this machine. */
export async function previewRun(input: unknown, deps: RunDeps): Promise<RunPreviewResult> {
  const request = parseRunRequest(input);
  if (request === undefined) return refusal('That is not a valid run request.');
  const assessed = await assess(request, deps);
  if (!assessed.ok) return assessed;
  const { candidate, releaseId, checkout, root, automated, manual, artifact } = assessed.value;
  return {
    ok: true,
    repository: request.repository,
    number: request.number,
    headSha: request.headSha,
    candidateId: candidate.id,
    candidateReleaseId: releaseId,
    profile: request.profile,
    suite: request.suite,
    artifactName: artifact.name,
    artifactSha256: artifact.sha256,
    checkout,
    root,
    automated,
    manual,
    ...(request.runId === undefined ? {} : { resumes: request.runId }),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Doing it

/** A candidate as `release-qa run --candidate` reads it: a manifest beside the one verified file for the profile. */
async function stageCandidate(candidate: Candidate, repository: string, profile: string, deps: RunDeps): Promise<{ ok: true; manifest: string } | { ok: false; error: string }> {
  // These become folder names. The candidate record was validated, but a name that reaches a path is checked again here.
  if (!idPattern.test(candidate.id) || !idPattern.test(profile) || candidate.id.includes('..')) return refusal('The candidate id is not safe to use as a folder name.');
  const final = join(deps.candidatesDir, repository.replace('/', '__'), candidate.id, profile);
  const incoming = `${final}.incoming`;
  await rm(incoming, { recursive: true, force: true });
  const downloaded = await (deps.download ?? downloadCandidate)(candidate, profile, incoming, deps.api);
  if (!downloaded.ok) {
    await rm(incoming, { recursive: true, force: true });
    return refusal(`The candidate could not be downloaded: ${downloaded.error}`);
  }
  const chosen = installableArtifact(candidate, profile);
  if (!chosen.ok) { await rm(incoming, { recursive: true, force: true }); return refusal(`${chosen.error}.`); }
  const artifact = chosen.artifact;
  await writeFile(join(incoming, 'candidate.json'), `${JSON.stringify({ schemaVersion: 1, id: candidate.id, artifacts: [{ profile, name: artifact.name, path: artifact.name, sha256: downloaded.sha256 }] }, null, 2)}\n`);
  // Replaced only after the new download verified, so an earlier interrupted run of this candidate can still be resumed if this fails.
  await rm(final, { recursive: true, force: true });
  await rename(incoming, final);
  return { ok: true, manifest: join(final, 'candidate.json') };
}

const exitText = (code: number): string => ({
  0: 'Finished: every automated scenario passed.',
  1: 'Finished: a scenario failed. The failure is recorded and stays on record.',
  2: 'Finished: nothing failed, but some work was blocked or is left for a person.',
  3: 'Stopped: the run did not finish (interrupted, cancelled or a cleanup failed). Resume it once the cause is dealt with.',
}[code] ?? `Finished with exit code ${code}.`);

function outcomeOf(session: RunSession, result: RunResult): void {
  if (!result.ok) {
    session.patch({ state: 'failed', message: result.error.slice(0, MAX_TEXT * 2) });
    return;
  }
  const { summary } = result;
  session.patch({
    // Exit 3 is a run that did not finish, not a finished run with a bad result; it is not drawn as one.
    state: summary.exitCode === 3 ? 'failed' : 'finished',
    runId: summary.runId,
    message: exitText(summary.exitCode),
    exitCode: summary.exitCode,
    results: summary.results.map((item) => ({ requirement: item.requirement, outcome: item.outcome })),
  });
}

/**
 * Starts (or resumes) a run after the person confirmed. Everything they were shown is checked again: the candidate and
 * test root must be the ones they confirmed. It returns once the run is claimed; the download and the run itself go on in
 * this process and report through the session, so closing the window does not stop them.
 */
export async function startRunAction(input: unknown, deps: RunDeps): Promise<ActionResult> {
  const confirmation = parseRunConfirmation(input);
  if (confirmation === undefined) return refusal('That is not a valid run request.');
  if (deps.session.busy || deps.session.syncing) return refusal('A run or an upload is already under way in this app. Wait for it to finish.');
  const assessed = await assess(confirmation, deps);
  if (!assessed.ok) return assessed;
  const { candidate, checkout, projectPath, root } = assessed.value;
  if (candidate.id !== confirmation.candidateId) return refusal(`The active candidate is now ${candidate.id}, not the ${confirmation.candidateId} you confirmed. Review it again.`);
  if (root !== confirmation.root) return refusal('The test root is not the one you confirmed. Review it again.');

  const kind = confirmation.runId === undefined ? 'start' : 'resume';
  const begun = deps.session.begin(
    { kind, repository: confirmation.repository, number: confirmation.number, candidateId: candidate.id, profile: confirmation.profile, suite: confirmation.suite, ...(confirmation.runId === undefined ? {} : { runId: confirmation.runId }) },
    async (controller) => {
      const options: RunOptions = {
        stateDir: stateDirOf(checkout),
        signal: controller.signal,
        ...(deps.consumerWorker === undefined ? {} : { consumerWorker: deps.consumerWorker }),
        onStart: (runId) => deps.session.patch({ runId }),
        onEvent: (event) => deps.session.progress({ scenario: event.scenario, phase: event.phase, status: event.status, ...(event.detail === undefined ? {} : { detail: event.detail }) }),
      };
      if (confirmation.runId !== undefined) {
        deps.session.patch({ state: 'running', message: 'Resuming: installing the candidate in the test root and running what is left.' });
        outcomeOf(deps.session, await (deps.resume ?? resumeRun)(confirmation.runId, options));
        return;
      }
      const staged = await stageCandidate(candidate, confirmation.repository, confirmation.profile, deps);
      if (!staged.ok) {
        deps.session.patch({ state: 'failed', message: staged.error });
        return;
      }
      // A stop during the download must not become a run: nothing is installed yet, so end here and say so.
      if (controller.signal.aborted) {
        deps.session.patch({ state: 'failed', message: 'Stopped before the run began. Nothing was installed.' });
        return;
      }
      deps.session.patch({ state: 'running', message: 'Installing the candidate in the test root and running the suite.' });
      outcomeOf(deps.session, await (deps.start ?? startRun)({ project: projectPath, candidate: staged.manifest, profile: confirmation.profile, suite: confirmation.suite, root }, options));
    },
  );
  if (!begun) return refusal('A run is already under way in this app. Wait for it to finish or stop it.');
  return { ok: true, message: kind === 'resume' ? `Resuming ${confirmation.runId}.` : `Started ${confirmation.suite} on ${confirmation.profile} for candidate ${candidate.id}.` };
}

export async function cancelRunAction(deps: RunDeps): Promise<ActionResult> {
  return deps.session.stop() ? { ok: true, message: 'Stopping after the current step; cleanup still runs.' } : refusal('No run is under way.');
}

/** Local runs of one candidate in the remembered checkout, with whether each still has results only on this machine. */
export async function listRunsAction(input: unknown, deps: RunDeps): Promise<RunListResult> {
  const rec = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const repository = parseRepository(rec.repository);
  if (repository === undefined || typeof rec.candidateId !== 'string' || rec.candidateId.length === 0 || rec.candidateId.length > 200) return refusal('That is not a valid request.');
  const checkout = await deps.checkouts.get(repository);
  if (checkout === undefined) return { ok: true, runs: [] };
  const status = deps.session.current;
  const runs: RunEntry[] = (await listRuns(stateDirOf(checkout)))
    .filter((run) => run.candidateId === rec.candidateId)
    .map((run) => ({ ...run, active: deps.session.busy && status.state !== 'idle' && status.runId === run.runId }));
  return { ok: true, runs };
}

const HINTS: Array<[RegExp, string]> = [
  [/insufficient-role/, accessText('insufficient-role')],
  [/logged-out/, accessText('logged-out')],
  [/organization-rejected/, accessText('organization-rejected')],
  [/missing-scope/, accessText('missing-scope')],
  [/network-error/, accessText('network-error')],
];

/**
 * Uploads a local run's report, events and evidence to the candidate's draft release. Nothing local is changed except
 * the acknowledgements the shared sync records after GitHub has confirmed the upload, so a failure never loses local
 * results, the run stays "not synced" until acknowledged, and a retry is safe. The window reads the run's state again
 * afterwards rather than assuming what a failure left behind.
 */
export async function syncRunAction(input: unknown, deps: RunDeps): Promise<ActionResult> {
  const request = parseSyncRequest(input);
  if (request === undefined) return refusal('That is not a valid sync request.');
  if (!deps.session.beginSync()) return refusal('A run or an upload is under way; sync after it finishes.');
  try {
    return await syncChecked(request, deps);
  } finally {
    deps.session.endSync();
  }
}

async function syncChecked(request: SyncRequest, deps: RunDeps): Promise<ActionResult> {
  const allowed = await requireWrite(request.repository, deps.api, 'upload results');
  if (!allowed.ok) return refusal(`${allowed.error} Your local results are kept and still marked not synced.`);
  const checkout = await deps.checkouts.get(request.repository);
  if (checkout === undefined) return refusal('Choose the local checkout this run was made in first.');
  const run = (await listRuns(stateDirOf(checkout))).find((item) => item.runId === request.runId);
  if (run === undefined) return refusal(`There is no local run ${request.runId} for this checkout.`);

  const evaluated = await (deps.evaluate ?? evaluatePullRequest)(request.repository, request.number, deps.api, request.headSha);
  if (!evaluated.ok) return refusal(`Not synced: the pull request could not be evaluated (${evaluated.error}). Your local results are kept.`);
  const { candidateId, candidateReleaseId, candidateAssetId } = evaluated.value;
  if (candidateId === undefined || candidateReleaseId === undefined || candidateAssetId === undefined) return refusal('Not synced: this pull request has no active candidate. Your local results are kept.');
  if (candidateId !== run.candidateId) return refusal(`Not synced: this run tested candidate ${run.candidateId}, but the active candidate is now ${candidateId}. Results for a replaced candidate are not uploaded. Your local results are kept.`);
  const loaded = await loadCandidateRecord(request.repository, candidateAssetId, deps);
  if (!loaded.ok) return refusal(`Not synced: ${loaded.error} Your local results are kept.`);
  const identity = await deps.api.currentUser();
  if (!identity.ok) return refusal(`Not synced: cannot tell who is signed in (${identity.reason}). Your local results are kept.`);

  const report = await reportForSync(stateDirOf(checkout), request.runId, { policyDigest: loaded.candidate.policyDigest, testRevision: loaded.candidate.testRevision, actor: identity.value });
  if (!report.ok) return refusal(`Not synced: ${report.error}. Your local results are kept.`);
  const synced = await (deps.sync ?? syncRun)({ repository: request.repository, releaseId: candidateReleaseId, runId: request.runId, runDirectory: report.runDirectory, report: report.report, api: deps.api });
  if (!synced.ok) {
    const hint = HINTS.find(([pattern]) => pattern.test(synced.error))?.[1];
    return uncertain(`Not synced: ${synced.error.slice(0, MAX_TEXT)}${hint === undefined ? '' : ` ${hint}`} Your local results are kept; syncing again is safe.`);
  }
  return { ok: true, message: `Synced run ${request.runId}: ${synced.uploaded} file${synced.uploaded === 1 ? '' : 's'} uploaded to the candidate's draft release.` };
}
