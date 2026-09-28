import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Candidate } from '../model/candidate.ts';
import { parseCandidate } from '../model/candidate.ts';
import { sha256Of } from '../util/sha256.ts';
import { GhTransport, inspectGitHubAccess, type ApiResult, type GitHubApi } from './transport.ts';

export interface BuildRun {
  id: number;
  run_attempt: number;
  path: string;
  head_sha: string;
  event?: string;
  display_title?: string;
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

export interface PreparationApi extends GitHubApi {
  list(path: string): Promise<ApiResult<unknown[]>>;
}

export interface CandidateDispatchApi extends PreparationApi {
  post(path: string, body: unknown): Promise<ApiResult<unknown>>;
}

export type CandidatePreparation =
  | { ok: true; runId: number; repositoryId: number; sourceSha: string; baseSha: string; policyDigest: string; workflowHeadSha: string }
  | { ok: false; error: string; runId?: number };

export type PreparationPreflight =
  | { ok: true; repositoryId: number; sourceSha: string; baseSha: string; policyDigest: string; releaseIntent: string[] }
  | { ok: false; error: string };

const gitSha = /^[0-9a-f]{40}$/;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Dispatches only the workflow from the trusted default branch. The workflow rechecks every input before withdrawing selection. */
export async function prepareCandidate(repository: string, prNumber: number, expectedHead: string, api: CandidateDispatchApi = new GhTransport()): Promise<CandidatePreparation> {
  const preflight = await inspectCandidatePreparation(repository, prNumber, expectedHead, api);
  if (!preflight.ok) return preflight;
  try {
    const info = await api.get(`repos/${repository}`);
    const branchName = record(info.ok ? info.value : undefined)?.default_branch;
    if (typeof branchName !== 'string' || !branchName) return { ok: false, error: 'cannot identify the trusted default branch' };
    const branch = await api.get(`repos/${repository}/branches/${encodeURIComponent(branchName)}`);
    const workflowHeadSha = record(record(branch.ok ? branch.value : undefined)?.commit)?.sha;
    if (typeof workflowHeadSha !== 'string' || !gitSha.test(workflowHeadSha)) return { ok: false, error: 'cannot verify the trusted workflow revision' };
    const path = `repos/${repository}/actions/workflows/qa-prepare.yml/dispatches`;
    const dispatched = await api.post(path, {
      ref: branchName,
      return_run_details: true,
      inputs: { pr_number: String(prNumber), expected_head: expectedHead, expected_base: preflight.baseSha, policy_digest: preflight.policyDigest },
    });
    if (!dispatched.ok) return { ok: false, error: `candidate preparation dispatch failed: ${dispatched.reason}` };
    const runId = record(dispatched.value)?.workflow_run_id;
    if (typeof runId !== 'number' || !Number.isSafeInteger(runId) || runId <= 0) return { ok: false, error: 'candidate preparation dispatch did not return a run ID' };
    let run: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await api.get(`repos/${repository}/actions/runs/${runId}`);
      if (response.ok) {
        run = record(response.value);
        if (typeof run?.head_sha === 'string' && run.head_sha !== workflowHeadSha) return { ok: false, error: 'dispatched preparation used a different workflow revision', runId };
        if (run?.id === runId && run.path === '.github/workflows/qa-prepare.yml' &&
            run.event === 'workflow_dispatch' && run.display_title === `qa-prepare PR #${prNumber} ${expectedHead}` &&
            record(run.repository)?.id === preflight.repositoryId) break;
      } else if (response.reason !== 'not-found') return { ok: false, error: `cannot inspect dispatched preparation: ${response.reason}`, runId };
      if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (run?.id !== runId || run.path !== '.github/workflows/qa-prepare.yml' ||
        run.event !== 'workflow_dispatch' || run.display_title !== `qa-prepare PR #${prNumber} ${expectedHead}` ||
        record(run.repository)?.id !== preflight.repositoryId || run.head_sha !== workflowHeadSha) {
      return { ok: false, error: 'dispatched preparation run does not match the trusted workflow revision and PR source', runId };
    }
    return { ok: true, runId, repositoryId: preflight.repositoryId, sourceSha: expectedHead, baseSha: preflight.baseSha, policyDigest: preflight.policyDigest, workflowHeadSha };
  } catch {
    return { ok: false, error: 'candidate preparation dispatch could not verify GitHub state' };
  }
}

/** Reads release intent and policy from the current trusted base, not the PR's potentially stale base SHA. */
export async function inspectCandidatePreparation(repository: string, prNumber: number, expectedHead: string, api: PreparationApi = new GhTransport()): Promise<PreparationPreflight> {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0 || !gitSha.test(expectedHead)) return { ok: false, error: 'invalid PR number or expected head SHA' };
  try {
    const access = await inspectGitHubAccess(repository, api);
    if (!access.ok) return { ok: false, error: `cannot prepare a candidate: ${access.reason}` };
    if (!['write', 'maintain', 'admin'].includes(access.role)) return { ok: false, error: 'candidate preparation requires repository write access' };
    const prefix = `repos/${repository}`;
    const response = await api.get(`${prefix}/pulls/${prNumber}`);
    if (!response.ok) return { ok: false, error: `cannot inspect PR #${prNumber}: ${response.reason}` };
    const pr = record(response.value);
    const head = record(pr?.head);
    const base = record(pr?.base);
    if (pr?.state !== 'open' || head?.sha !== expectedHead) return { ok: false, error: `PR #${prNumber} is closed or its head no longer matches ${expectedHead}` };
    if (record(head.repo)?.id !== access.repositoryId || record(base?.repo)?.id !== access.repositoryId) {
      return { ok: false, error: 'candidate preparation requires a same-repository PR' };
    }
    if (typeof head.ref !== 'string' || typeof base?.ref !== 'string') return { ok: false, error: 'PR branch metadata is incomplete' };
    const branch = await api.get(`${prefix}/branches/${encodeURIComponent(base.ref)}`);
    if (!branch.ok) return { ok: false, error: `cannot inspect target branch: ${branch.reason}` };
    const baseSha = record(record(branch.value)?.commit)?.sha;
    if (typeof baseSha !== 'string' || !gitSha.test(baseSha)) return { ok: false, error: 'target branch has no valid tip SHA' };
    const policyResponse = await api.get(`${prefix}/contents/qa/policy.json?ref=${baseSha}`);
    if (!policyResponse.ok) return { ok: false, error: `cannot read trusted QA policy: ${policyResponse.reason}` };
    const policyFile = record(policyResponse.value);
    const encoded = policyFile?.content;
    if (policyFile?.type !== 'file' || policyFile.encoding !== 'base64' || typeof encoded !== 'string') {
      return { ok: false, error: 'trusted QA policy is not a readable file' };
    }
    const bytes = Buffer.from(encoded, 'base64');
    const policy = record(JSON.parse(bytes.toString('utf8')) as unknown);
    if (typeof policy?.releaseBranchPrefix !== 'string' || !policy.releaseBranchPrefix ||
        typeof policy.releaseLabel !== 'string' || !policy.releaseLabel ||
        !Array.isArray(policy.releaseFiles) || !policy.releaseFiles.every((file) => typeof file === 'string' && file.length > 0)) {
      return { ok: false, error: 'trusted QA policy has invalid release intent rules' };
    }
    const changed = await api.list(`${prefix}/pulls/${prNumber}/files?per_page=100`);
    if (!changed.ok) return { ok: false, error: `cannot inspect changed files: ${changed.reason}` };
    const files = changed.value.map((file) => record(file)?.filename);
    if (files.some((file) => typeof file !== 'string')) return { ok: false, error: 'PR changed-file list is incomplete' };
    const reasons: string[] = [];
    if (head.ref.startsWith(policy.releaseBranchPrefix)) reasons.push('release branch');
    if (Array.isArray(pr.labels) && pr.labels.some((label) => record(label)?.name === policy.releaseLabel)) reasons.push('release label');
    const changedReleaseFiles = files.filter((file) => (policy.releaseFiles as string[]).includes(file as string));
    if (changedReleaseFiles.length > 0) reasons.push(`release file changed: ${changedReleaseFiles.join(', ')}`);
    if (reasons.length === 0) return { ok: false, error: 'PR has no trusted release intent' };
    const current = await api.get(`${prefix}/pulls/${prNumber}`);
    const currentPr = current.ok ? record(current.value) : undefined;
    if (currentPr?.state !== 'open' || record(currentPr?.head)?.sha !== expectedHead || record(currentPr?.head)?.ref !== head.ref || record(currentPr?.base)?.ref !== base.ref) {
      return { ok: false, error: 'PR state, head, or target changed during candidate preparation preflight' };
    }
    const labelNames = (value: Record<string, unknown> | undefined): string =>
      JSON.stringify((Array.isArray(value?.labels) ? value.labels : []).map((label) => record(label)?.name).sort());
    if (labelNames(currentPr) !== labelNames(pr)) return { ok: false, error: 'PR release labels changed during candidate preparation preflight' };
    const currentBase = await api.get(`${prefix}/branches/${encodeURIComponent(base.ref)}`);
    if (!currentBase.ok || record(record(currentBase.value)?.commit)?.sha !== baseSha) return { ok: false, error: 'target branch changed during candidate preparation preflight' };
    return { ok: true, repositoryId: access.repositoryId, sourceSha: expectedHead, baseSha, policyDigest: createHash('sha256').update(bytes).digest('hex'), releaseIntent: reasons };
  } catch {
    return { ok: false, error: 'candidate preparation preflight could not verify GitHub state' };
  }
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
      run.head_sha !== (candidate.build.workflowHeadSha ?? candidate.sourceSha) || run.repository.id !== candidate.repositoryId || run.conclusion !== 'success') {
    issues.push('recorded build run does not match a successful candidate preparation');
  }
  if (candidate.build.workflowHeadSha !== undefined &&
      (run.event !== 'workflow_dispatch' || run.display_title !== `qa-prepare PR #${candidate.pullRequest} ${candidate.sourceSha}`)) {
    issues.push('recorded build run is not bound to the candidate PR and source SHA');
  }
  for (const artifact of candidate.artifacts) {
    const release = releases.find((item) => item.id === artifact.assetId);
    if (release === undefined || release.name !== artifact.name || release.state !== 'uploaded' || release.digest !== `sha256:${artifact.sha256}`) {
      issues.push(`${artifact.profile}/${artifact.name}: draft release asset identity or SHA-256 differs`);
    }
    const action = actions.find((item) => item.id === artifact.actionsArtifactId);
    // An expired archive is not needed for download once the exact release asset survives, but its recorded origin is.
    if (action === undefined || action.workflow_run.id !== candidate.build.runId ||
        action.workflow_run.repository_id !== candidate.repositoryId || action.workflow_run.head_sha !== (candidate.build.workflowHeadSha ?? candidate.sourceSha)) {
      issues.push(`${artifact.profile}/${artifact.name}: Actions artifact is not from the recorded build`);
    }
  }
  return { ok: issues.length === 0, issues };
}
