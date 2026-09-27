import { link, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Candidate } from '../model/candidate.ts';
import { parseCandidate } from '../model/candidate.ts';
import { sha256Of } from '../util/sha256.ts';
import { GhTransport, type ApiResult } from './transport.ts';

export interface BuildRun {
  id: number;
  run_attempt: number;
  path: string;
  head_sha: string;
  conclusion: string | null;
  repository: { id: number };
}

export interface ReleaseAsset {
  id: number;
  name: string;
  state: string;
  digest?: string;
}

export interface ActionsArtifact {
  id: number;
  name: string;
  expired: boolean;
  workflow_run: { id: number; repository_id: number; head_sha: string };
}

export interface CandidateDownloadApi {
  get(path: string): Promise<ApiResult<unknown>>;
  /** Streams the exact release asset ID to a temporary file; no name-based lookup. */
  download(path: string, destination: string): Promise<ApiResult<true>>;
}

export type DownloadCandidateResult = { ok: true; path: string; sha256: string } | { ok: false; error: string };

const repoName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Retrieves one recorded asset by ID, after checking the entire candidate's build and asset origins. */
export async function downloadCandidate(candidate: Candidate, profile: string, directory: string, api: CandidateDownloadApi = new GhTransport()): Promise<DownloadCandidateResult> {
  const parsed = parseCandidate(candidate);
  if (!parsed.ok) return { ok: false, error: `invalid candidate: ${parsed.error.message}` };
  const artifact = parsed.value.artifacts.find((item) => item.profile === profile);
  if (artifact === undefined) return { ok: false, error: `candidate ${candidate.id} has no artifact for profile ${profile}` };

  try {
    const repository = await api.get(`repositories/${candidate.repositoryId}`);
    if (!repository.ok) return { ok: false, error: `cannot inspect candidate repository: ${repository.reason}` };
    const repo = repository.value as { id?: unknown; full_name?: unknown } | null;
    if (repo?.id !== candidate.repositoryId || typeof repo.full_name !== 'string' || !repoName.test(repo.full_name)) {
      return { ok: false, error: 'candidate repository identity does not match GitHub' };
    }
    const prefix = `repos/${repo.full_name}`;
    const run = await api.get(`${prefix}/actions/runs/${candidate.build.runId}`);
    if (!run.ok) return { ok: false, error: `cannot inspect candidate build: ${run.reason}` };
    const releases: ReleaseAsset[] = [];
    const actions: ActionsArtifact[] = [];
    for (const entry of candidate.artifacts) {
      const release = await api.get(`${prefix}/releases/assets/${entry.assetId}`);
      const action = await api.get(`${prefix}/actions/artifacts/${entry.actionsArtifactId}`);
      if (!release.ok || !action.ok) return { ok: false, error: `${entry.profile}/${entry.name}: candidate asset metadata is unavailable` };
      releases.push(release.value as ReleaseAsset);
      actions.push(action.value as ActionsArtifact);
    }
    const checked = verifyCandidateAssets(candidate, run.value as BuildRun, releases, actions);
    if (!checked.ok) return { ok: false, error: checked.issues.join('; ') };

    await mkdir(directory, { recursive: true });
    const temporary = await mkdtemp(join(directory, '.release-qa-download-'));
    try {
      const pending = join(temporary, artifact.name);
      const downloaded = await api.download(`${prefix}/releases/assets/${artifact.assetId}`, pending);
      if (!downloaded.ok) return { ok: false, error: `could not download candidate asset ${artifact.assetId}: ${downloaded.reason}` };
      const actual = await sha256Of(pending);
      if (actual !== artifact.sha256) return { ok: false, error: `downloaded asset ${artifact.assetId} does not match the candidate: expected SHA-256 ${artifact.sha256}, found ${actual}` };
      const path = join(directory, artifact.name);
      await link(pending, path); // atomic create: never replace an unrelated file in the destination
      return { ok: true, path, sha256: actual };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  } catch (error) {
    return { ok: false, error: `could not download candidate: ${message(error)}` };
  }
}

/** Checks identities from the API; a caller must still hash downloaded bytes before use or selection. */
export function verifyCandidateAssets(candidate: Candidate, run: BuildRun, releases: readonly ReleaseAsset[], actions: readonly ActionsArtifact[]): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (run.id !== candidate.build.runId || run.run_attempt !== candidate.build.attempt ||
      run.path !== candidate.build.workflowPath ||
      run.head_sha !== candidate.sourceSha || run.repository.id !== candidate.repositoryId || run.conclusion !== 'success') {
    issues.push('recorded build run does not match a successful candidate preparation');
  }
  for (const artifact of candidate.artifacts) {
    const release = releases.find((item) => item.id === artifact.assetId);
    if (release === undefined || release.name !== artifact.name || release.state !== 'uploaded' || release.digest !== `sha256:${artifact.sha256}`) {
      issues.push(`${artifact.profile}/${artifact.name}: draft release asset identity or SHA-256 differs`);
    }
    const action = actions.find((item) => item.id === artifact.actionsArtifactId);
    // An expired archive is not needed for download once the exact release asset survives, but its recorded origin is.
    if (action === undefined || action.workflow_run.id !== candidate.build.runId ||
        action.workflow_run.repository_id !== candidate.repositoryId || action.workflow_run.head_sha !== candidate.sourceSha) {
      issues.push(`${artifact.profile}/${artifact.name}: Actions artifact is not from the recorded build`);
    }
  }
  return { ok: issues.length === 0, issues };
}
