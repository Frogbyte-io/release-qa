import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { stat } from 'node:fs/promises';
import {
  claimStatus,
  discoverProjects,
  evaluatePullRequest,
  inspectGitHubAccess,
  listManualRuns,
  loadCandidateProgress,
  machineId,
  MAX_EVIDENCE_FILES,
  MAX_NOTES_LENGTH,
  readManualRun,
  recordManualCheck,
  recordScenarioClaim,
  syncManualRun,
  type Candidate,
  type EnvironmentProbes,
  type EnvironmentProfile,
  type ManualRunSummary,
  type Requirement,
  type ScenarioClaim,
} from '@frogbyte-io/release-qa';
import {
  MANUAL_OUTCOME_CHOICES,
  type ActionResult,
  type ClaimView,
  type EvidenceChoice,
  type ManualCheckStateResult,
  type ManualClaimRequest,
  type ManualRecordRequest,
  type ManualRecordResult,
  type ManualResultView,
  type ManualTarget,
  type PickEvidenceResult,
} from '../shared/contract.ts';
import { parseTarget, type ActionApi } from './release-actions.ts';

/** An advisory claim goes stale after this long. Staleness is only ever shown; it never releases or locks anything. */
export const CLAIM_STALE_MS = 4 * 60 * 60 * 1000;

const WRITE_ROLES = ['admin', 'maintain', 'write'];
const requirementKey = /^[a-z0-9_-]+\/[a-z0-9_-]+$/;
const runIdPattern = /^manual-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$/;
const MAX_HANDLES = 200;

/**
 * The files the person chose, kept in the privileged process. The window is given a random handle and a display name; it
 * cannot name a path, so it cannot ask for a file it was never shown a dialog for.
 */
export class EvidenceRegistry {
  private readonly files = new Map<string, { path: string; name: string; bytes: number }>();

  add(paths: readonly string[], sizes: readonly number[]): EvidenceChoice[] {
    return paths.map((path, index) => {
      const token = randomUUID();
      const choice = { token, name: basename(path).slice(0, 120), bytes: sizes[index] ?? 0 };
      this.files.set(token, { path, name: choice.name, bytes: choice.bytes });
      // A long session cannot grow this without bound: the oldest handles are forgotten first.
      while (this.files.size > MAX_HANDLES) this.files.delete(this.files.keys().next().value as string);
      return choice;
    });
  }

  /** The paths behind these handles, or `undefined` if any handle is unknown. Handles stay valid until `forget`. */
  resolve(tokens: readonly string[]): string[] | undefined {
    const paths = tokens.map((token) => this.files.get(token)?.path);
    return paths.every((path): path is string => path !== undefined) ? paths : undefined;
  }

  forget(tokens: readonly string[]): void {
    for (const token of tokens) this.files.delete(token);
  }
}

export interface ManualDeps {
  api: ActionApi;
  /** Where manual results live on this computer. */
  stateDir: string;
  evidence: EvidenceRegistry;
  /** Shows the file dialog and returns the chosen absolute paths; empty when cancelled. */
  choose?: () => Promise<string[]>;
  evaluate?: typeof evaluatePullRequest;
  probes?: EnvironmentProbes;
  now?: () => Date;
}

const refusal = (error: string): { ok: false; error: string } => ({ ok: false, error });
const record = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

export function parseManualTarget(value: unknown): ManualTarget | undefined {
  const target = parseTarget(value);
  const requirement = record(value)?.requirement;
  return target === undefined || typeof requirement !== 'string' || !requirementKey.test(requirement) ? undefined : { ...target, requirement };
}

export function parseRecordRequest(value: unknown): ManualRecordRequest | undefined {
  const target = parseManualTarget(value);
  const request = record(value);
  if (target === undefined || request === undefined) return undefined;
  if (!MANUAL_OUTCOME_CHOICES.includes(request.outcome as never) || typeof request.notes !== 'string' || request.notes.length > MAX_NOTES_LENGTH * 2) return undefined;
  if (!Array.isArray(request.evidence) || request.evidence.length > MAX_EVIDENCE_FILES || !request.evidence.every((token) => typeof token === 'string' && token.length <= 100)) return undefined;
  return { ...target, outcome: request.outcome as ManualRecordRequest['outcome'], notes: request.notes, evidence: request.evidence as string[] };
}

export function parseClaimRequest(value: unknown): ManualClaimRequest | undefined {
  const target = parseManualTarget(value);
  const intent = record(value)?.intent;
  return target === undefined || (intent !== 'claim' && intent !== 'release') ? undefined : { ...target, intent };
}

/** Everything a manual result needs from GitHub, found by the privileged side: the window sends only a requirement key. */
interface Context {
  login: string;
  role: string;
  candidate: Candidate;
  releaseId: number;
  requirement: Requirement;
  profile: EnvironmentProfile;
}

async function contextFor(target: ManualTarget, deps: ManualDeps): Promise<{ ok: true; value: Context } | { ok: false; error: string }> {
  const access = await inspectGitHubAccess(target.repository, deps.api);
  if (!access.ok) return refusal(access.reason === 'logged-out' ? 'GitHub sign-in has expired. Run "gh auth login", then try again.' : `GitHub refused this: ${access.reason}.`);
  const user = await deps.api.currentUser();
  if (!user.ok) return refusal('GitHub sign-in has expired. Run "gh auth login", then try again.');

  const discovery = await discoverProjects(deps.api, `https://github.com/${target.repository}`);
  const project = discovery.projects.find((item) => item.repository === target.repository)?.project;
  if (project === undefined) return refusal('This repository has no readable QA project.');
  const requirement = project.requirements.find((item) => item.key === target.requirement);
  if (requirement === undefined || requirement.mode !== 'manual') return refusal('That is not a manual check of this project.');
  const profile = project.profiles.find((item) => requirement.key.startsWith(`${item.id}/`));
  if (profile === undefined) return refusal('The project defines no environment for this check.');

  // Pinned to the head the person saw: if the pull request moved on, the check they are looking at may be for another build.
  const evaluated = await (deps.evaluate ?? evaluatePullRequest)(target.repository, target.number, deps.api, target.headSha);
  if (!evaluated.ok) return refusal(evaluated.error);
  const { candidate, candidateReleaseId } = evaluated.value;
  if (candidate === undefined || candidateReleaseId === undefined) return refusal('This pull request has no active candidate to record a check against.');
  return { ok: true, value: { login: user.value, role: access.role, candidate, releaseId: candidateReleaseId, requirement, profile } };
}

const summarize = (run: ManualRunSummary): ManualResultView => ({
  runId: run.runId,
  outcome: run.outcome,
  reporter: run.report.actor,
  recordedAt: run.meta.recordedAt,
  evidenceCount: run.evidence.length,
  synced: run.synced,
  ...(run.problem === undefined ? {} : { problem: run.problem }),
});

async function currentClaims(target: ManualTarget, context: Context, deps: ManualDeps): Promise<{ ok: true; claims: ScenarioClaim[] } | { ok: false; error: string }> {
  const progress = await loadCandidateProgress(target.repository, context.releaseId, context.candidate.id, deps.api);
  return progress.ok ? { ok: true, claims: progress.value.claims } : refusal(`The claims on this candidate could not be read (${progress.reason}).`);
}

function ownerView(claims: readonly ScenarioClaim[], context: Context, requirement: string, now: Date): ClaimView | undefined {
  const { owner, stale } = claimStatus(claims, context.candidate.id, requirement, now.getTime());
  return owner === undefined ? undefined : { actor: owner.actor, action: owner.action, recordedAt: owner.recordedAt, stale, mine: owner.actor === context.login };
}

/** What the manual check view shows: who you are, who (if anyone) says they are doing it, and the results saved on this computer. */
export async function loadManualCheck(input: unknown, deps: ManualDeps): Promise<ManualCheckStateResult> {
  const target = parseManualTarget(input);
  if (target === undefined) return refusal('That is not a valid manual check.');
  const found = await contextFor(target, deps);
  if (!found.ok) return found;
  const context = found.value;
  const claims = await currentClaims(target, context, deps);
  if (!claims.ok) return claims;
  const owner = ownerView(claims.claims, context, target.requirement, (deps.now ?? (() => new Date()))());
  const results = (await listManualRuns(deps.stateDir))
    .filter((run) => run.meta.repository === target.repository && run.meta.requirement === target.requirement && run.report.candidateId === context.candidate.id)
    .map(summarize);
  return {
    ok: true,
    state: {
      login: context.login,
      requirement: { key: context.requirement.key, title: context.requirement.title, mode: 'manual', profile: context.profile.id },
      candidateId: context.candidate.id,
      ...(owner === undefined ? {} : { owner }),
      results,
      readOnly: !WRITE_ROLES.includes(context.role),
    },
  };
}

/** Shows the file dialog. Only handles and names go back to the window. */
export async function pickEvidence(deps: ManualDeps): Promise<PickEvidenceResult> {
  if (deps.choose === undefined) return refusal('Choosing files is not available here.');
  const paths = (await deps.choose()).slice(0, MAX_EVIDENCE_FILES);
  const sizes: number[] = [];
  for (const path of paths) {
    const info = await stat(path).catch(() => undefined);
    if (info === undefined || !info.isFile()) return refusal(`${basename(path)} cannot be read.`);
    sizes.push(info.size);
  }
  return { ok: true, files: deps.evidence.add(paths, sizes) };
}

/**
 * Records the person's verdict on this computer. Nothing is uploaded: the result is "not synced" until `syncManualResult`.
 * The reporter is the signed-in GitHub user (the shared recording asks GitHub); the window has no field for it.
 */
export async function recordManual(input: unknown, deps: ManualDeps): Promise<ManualRecordResult> {
  const request = parseRecordRequest(input);
  if (request === undefined) return refusal('That is not a valid manual result.');
  const found = await contextFor(request, deps);
  if (!found.ok) return found;
  const context = found.value;
  if (!WRITE_ROLES.includes(context.role)) return refusal('Your account has read-only access to this repository; it cannot record results.');
  const paths = deps.evidence.resolve(request.evidence);
  if (paths === undefined) return refusal('One of the evidence files is no longer available. Choose it again.');

  const recorded = await recordManualCheck({
    stateDir: deps.stateDir,
    repository: request.repository,
    pullRequest: request.number,
    releaseId: context.releaseId,
    candidate: context.candidate,
    profile: context.profile,
    requirement: context.requirement,
    outcome: request.outcome,
    notes: request.notes,
    evidence: paths,
    api: deps.api,
    ...(deps.probes === undefined ? {} : { probes: deps.probes }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  if (!recorded.ok) return recorded;
  deps.evidence.forget(request.evidence);
  const saved = await readManualRun(deps.stateDir, recorded.runId);
  if (saved === undefined) return refusal('The result was saved but could not be read back. Check the app data folder.');
  return { ok: true, message: `Saved on this computer as ${context.login}. It is not uploaded yet, so it does not count until you upload it.`, result: summarize(saved) };
}

/** Uploads one saved manual result with the shared sync. Needs write access now, not only when it was recorded. */
export async function syncManualResult(input: unknown, deps: ManualDeps): Promise<ActionResult> {
  const runId = record(input)?.runId;
  if (typeof runId !== 'string' || !runIdPattern.test(runId)) return refusal('That is not a saved manual result.');
  const saved = await readManualRun(deps.stateDir, runId);
  if (saved === undefined) return refusal('That saved result no longer exists.');
  const access = await inspectGitHubAccess(saved.meta.repository, deps.api);
  if (!access.ok) return refusal(access.reason === 'logged-out' ? 'GitHub sign-in has expired. Run "gh auth login", then try again.' : `GitHub refused this: ${access.reason}. The result is still saved here.`);
  if (!WRITE_ROLES.includes(access.role)) return refusal('Your account no longer has write access to this repository, so the result was not uploaded. It is still saved here.');
  const synced = await syncManualRun(deps.stateDir, runId, deps.api);
  return synced.ok
    ? { ok: true, message: `Uploaded ${synced.uploaded} file${synced.uploaded === 1 ? '' : 's'} to the candidate's draft release.` }
    : refusal(`${synced.error}. The result is still saved here and can be uploaded again.`);
}

/**
 * Says who is doing a check. Advisory: a claim is a record, never a lock, and nobody is stopped from recording a result whatever
 * it says. Taking over from someone else is allowed at any time (stale or not); only the owner can release.
 */
export async function claimManual(input: unknown, deps: ManualDeps): Promise<ActionResult> {
  const request = parseClaimRequest(input);
  if (request === undefined) return refusal('That is not a valid claim.');
  const found = await contextFor(request, deps);
  if (!found.ok) return found;
  const context = found.value;
  if (!WRITE_ROLES.includes(context.role)) return refusal('Your account has read-only access to this repository; it cannot claim checks.');
  const claims = await currentClaims(request, context, deps);
  if (!claims.ok) return claims;
  const now = (deps.now ?? (() => new Date()))();
  const owner = ownerView(claims.claims, context, request.requirement, now);

  let action: ScenarioClaim['action'];
  if (request.intent === 'release') {
    if (owner === undefined || !owner.mine) return refusal(owner === undefined ? 'Nobody has claimed this check.' : `${owner.actor} holds this claim; only they can release it. You can take over instead.`);
    action = 'release';
  } else if (owner?.mine === true) {
    return { ok: true, message: 'You already have this check.' };
  } else {
    action = owner === undefined ? 'claim' : 'takeover';
  }
  const claim: ScenarioClaim = {
    id: `claim-${randomUUID()}`,
    candidateId: context.candidate.id,
    requirement: request.requirement,
    machineId: await machineId(deps.stateDir),
    actor: context.login,
    action,
    recordedAt: now.toISOString(),
    staleAfterMs: CLAIM_STALE_MS,
  };
  const recorded = await recordScenarioClaim(request.repository, context.releaseId, claim, deps.api);
  if (!recorded.ok) return refusal(`The claim was not recorded (${recorded.reason}).`);
  return { ok: true, message: action === 'release' ? 'Released. Nobody is marked as doing this check.' : action === 'takeover' ? `You took this check over from ${owner?.actor ?? 'someone'}.` : 'You are marked as doing this check. This is a note for others, not a lock.' };
}
