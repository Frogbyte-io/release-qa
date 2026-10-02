import { rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { downloadCandidate, type CandidateDownloadApi } from '../github/candidate.ts';
import { evaluatePullRequest, type GateApi } from '../github/pull-request-gate.ts';
import { syncRun } from '../github/sync.ts';
import { GhTransport } from '../github/transport.ts';
import type { Candidate } from '../model/candidate.ts';
import { reportForSync } from './run.ts';

/** Everything these commands read from or write to GitHub. The default is the signed-in `gh` (or `GH_TOKEN`). */
export type CiApi = GateApi & CandidateDownloadApi;

/** Seams for tests: the shared functions, replaced by fakes. */
export interface CiDeps {
  api?: CiApi;
  evaluate?: typeof evaluatePullRequest;
  download?: typeof downloadCandidate;
  sync?: typeof syncRun;
}

export interface Target {
  repository: string;
  pullRequest: number;
  head: string;
  candidateId: string;
}

export type DownloadResult =
  | { ok: true; candidateId: string; profile: string; manifest: string; artifact: string; sha256: string }
  | { ok: false; error: string };

export type SyncResult =
  | { ok: true; candidateId: string; runId: string; releaseId: number; actor: string; uploaded: number }
  | { ok: false; error: string };

const MANIFEST = 'candidate.json';
const WRITERS = ['write', 'maintain', 'admin'];

/**
 * The active candidate of a pull request as the merge gate sees it, at the head and candidate the person reviewed.
 * Both commands start here, so neither can act on a candidate that has since been replaced or a pull request that moved.
 */
async function activeCandidate(target: Target, api: CiApi, deps: CiDeps): Promise<{ ok: true; candidate: Candidate; releaseId: number } | { ok: false; error: string }> {
  const evaluated = await (deps.evaluate ?? evaluatePullRequest)(target.repository, target.pullRequest, api, target.head);
  if (!evaluated.ok) return { ok: false, error: `cannot read the active candidate of ${target.repository}#${target.pullRequest}: ${evaluated.error}` };
  const { candidate, candidateId, candidateReleaseId } = evaluated.value;
  if (candidate === undefined || candidateId === undefined || candidateReleaseId === undefined) return { ok: false, error: `${target.repository}#${target.pullRequest} has no active candidate` };
  if (candidateId !== target.candidateId) return { ok: false, error: `the active candidate is ${candidateId}, not ${target.candidateId}; it was replaced after it was reviewed` };
  return { ok: true, candidate, releaseId: candidateReleaseId };
}

/**
 * Downloads the candidate's file for one profile, checks its SHA-256 against the candidate record, and only then writes
 * the local manifest `run --candidate` reads. A file that does not verify leaves nothing in `out`; an existing manifest or
 * file is never replaced. Never throws.
 */
export async function runDownloadCandidate(input: Target & { profile: string; out: string }, cwd: string, deps: CiDeps = {}): Promise<DownloadResult> {
  try {
    const api = deps.api ?? new GhTransport();
    const out = resolve(cwd, input.out);
    const active = await activeCandidate(input, api, deps);
    if (!active.ok) return active;
    const { candidate } = active;
    const artifact = candidate.artifacts.find((item) => item.profile === input.profile);
    if (artifact === undefined) return { ok: false, error: `candidate ${candidate.id} has no artifact for profile ${input.profile}` };
    if (await exists(join(out, MANIFEST))) return { ok: false, error: `${join(out, MANIFEST)} already exists; it is not replaced` };

    const downloaded = await (deps.download ?? downloadCandidate)(candidate, input.profile, out, api);
    if (!downloaded.ok) return downloaded;
    const manifest = join(out, MANIFEST);
    try {
      const body = { schemaVersion: 1, id: candidate.id, artifacts: [{ profile: input.profile, name: artifact.name, path: artifact.name, sha256: downloaded.sha256 }] };
      await writeFile(manifest, `${JSON.stringify(body, null, 2)}\n`, { flag: 'wx' });
    } catch (error) {
      // A verified file without a manifest is not a candidate; do not leave it behind.
      await rm(downloaded.path, { force: true });
      return { ok: false, error: `could not write ${manifest}: ${error instanceof Error ? error.message : String(error)}` };
    }
    return { ok: true, candidateId: candidate.id, profile: input.profile, manifest, artifact: downloaded.path, sha256: downloaded.sha256 };
  } catch (error) {
    return { ok: false, error: `could not download the candidate: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Uploads one local run to the active candidate's draft release. The merge gate counts an uploaded report only when the
 * uploader is a user with write access to the repository and is also the report's actor, so that is checked here, before
 * anything is uploaded, instead of leaving a result the gate would ignore. Never throws.
 */
export async function runSyncRun(input: Target & { runId: string; stateDir: string }, deps: CiDeps = {}): Promise<SyncResult> {
  try {
    const api = deps.api ?? new GhTransport();
    const active = await activeCandidate(input, api, deps);
    if (!active.ok) return active;
    const { candidate, releaseId } = active;

    const identity = await api.currentUser();
    if (!identity.ok) {
      return { ok: false, error: `cannot tell which user is uploading (${identity.reason}). The merge gate only counts reports uploaded by a user with write access to ${input.repository}; the GITHUB_TOKEN of a workflow is not a user` };
    }
    const permission = await api.get(`repos/${input.repository}/collaborators/${encodeURIComponent(identity.value)}/permission`);
    const role = permission.ok && permission.value !== null && typeof permission.value === 'object' ? (permission.value as { permission?: unknown }).permission : undefined;
    if (!WRITERS.includes(String(role))) {
      return { ok: false, error: `${identity.value} does not have write access to ${input.repository}${permission.ok ? ` (role: ${String(role)})` : ` (${permission.reason})`}; the merge gate would ignore this upload` };
    }

    const report = await reportForSync(resolve(input.stateDir), input.runId, { policyDigest: candidate.policyDigest, testRevision: candidate.testRevision, actor: identity.value });
    if (!report.ok) return report;
    if (report.report.candidateId !== candidate.id) return { ok: false, error: `run ${input.runId} tested candidate ${report.report.candidateId}, but the active candidate is ${candidate.id}; results for another candidate are not uploaded` };

    const synced = await (deps.sync ?? syncRun)({ repository: input.repository, releaseId, runId: input.runId, runDirectory: report.runDirectory, report: report.report, api });
    if (!synced.ok) return { ok: false, error: `${synced.error}; local results are kept and syncing again is safe` };
    return { ok: true, candidateId: candidate.id, runId: input.runId, releaseId, actor: identity.value, uploaded: synced.uploaded };
  } catch (error) {
    return { ok: false, error: `could not sync the run: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}
