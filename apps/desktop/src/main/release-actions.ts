import {
  evaluatePullRequest,
  inspectGitHubAccess,
  prepareCandidate,
  type ApiResult,
} from '@frogbyte-io/release-qa';
import { MERGE_METHODS, type ActionResult, type MergePreviewResult, type MergeRequest, type PullTarget } from '../shared/contract.ts';
import type { DashboardApi } from './qa-commands.ts';

/** The read transport plus the two writes the dashboard makes. The real one is the GitHub CLI session. */
export type ActionApi = DashboardApi & {
  post(path: string, body: unknown): Promise<ApiResult<unknown>>;
  put(path: string, body: unknown): Promise<ApiResult<unknown>>;
};

export interface ActionDeps {
  api: ActionApi;
  evaluate?: typeof evaluatePullRequest;
  prepare?: typeof prepareCandidate;
}

const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const gitSha = /^[0-9a-f]{40}$/;
const WRITE_ROLES = ['admin', 'maintain', 'write'];

/** Everything from the window is checked here, as if it came from anywhere: shape, then meaning. */
export function parsePullRef(value: unknown): Pick<PullTarget, 'repository' | 'number'> | undefined {
  const ref = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  if (typeof ref?.repository !== 'string' || !repositoryName.test(ref.repository)) return undefined;
  if (typeof ref.number !== 'number' || !Number.isSafeInteger(ref.number) || ref.number <= 0) return undefined;
  return { repository: ref.repository, number: ref.number };
}

export function parseTarget(value: unknown): PullTarget | undefined {
  const ref = parsePullRef(value);
  const headSha = (value as Record<string, unknown> | undefined)?.headSha;
  if (ref === undefined || typeof headSha !== 'string' || !gitSha.test(headSha)) return undefined;
  return { ...ref, headSha };
}

export function parseMergeRequest(value: unknown): MergeRequest | undefined {
  const target = parseTarget(value);
  const request = value as Record<string, unknown>;
  if (target === undefined || !MERGE_METHODS.includes(request.method as never)) return undefined;
  if (request.candidateId !== undefined && (typeof request.candidateId !== 'string' || request.candidateId.length === 0 || request.candidateId.length > 200)) return undefined;
  return { ...target, method: request.method as MergeRequest['method'], ...(typeof request.candidateId === 'string' ? { candidateId: request.candidateId } : {}) };
}

/** Where a pull request lives, built here from validated parts, never taken from the window as a URL. */
export const pullRequestUrl = (repository: string, number: number): string => `https://github.com/${repository}/pull/${number}`;

const refusal = (error: string): { ok: false; error: string } => ({ ok: false, error });

const ACCESS_TEXT: Record<string, string> = {
  'logged-out': 'GitHub sign-in has expired. Run "gh auth login", then refresh.',
  'missing-scope': 'The GitHub token lacks a needed permission scope.',
  'insufficient-role': 'Your account does not have write access to this repository.',
  'organization-rejected': 'The organization has not approved this sign-in.',
  'not-found': 'The repository or pull request was not found.',
  'network-error': 'GitHub could not be reached.',
};
const accessText = (reason: string): string => ACCESS_TEXT[reason] ?? reason;

async function requireWrite(repository: string, api: ActionApi): Promise<{ ok: true } | { ok: false; error: string }> {
  const access = await inspectGitHubAccess(repository, api);
  if (!access.ok) return refusal(accessText(access.reason));
  return WRITE_ROLES.includes(access.role) ? { ok: true } : refusal('Your account has read-only access to this repository; it cannot prepare candidates or merge.');
}

/**
 * Starts candidate preparation: dispatches the trusted workflow from the default branch for the head the person saw.
 * The shared preparation checks it against the trusted policy and the pull request's current state before dispatching.
 */
export async function prepareReleaseCandidate(input: unknown, deps: ActionDeps): Promise<ActionResult> {
  const target = parseTarget(input);
  if (target === undefined) return refusal('That is not a valid pull request.');
  const allowed = await requireWrite(target.repository, deps.api);
  if (!allowed.ok) return allowed;
  const prepared = await (deps.prepare ?? prepareCandidate)(target.repository, target.number, target.headSha, deps.api);
  if (!prepared.ok) return refusal(prepared.error);
  return {
    ok: true,
    message: `Candidate preparation started for ${target.headSha.slice(0, 7)} (workflow run ${prepared.runId}). The candidate appears here after the run succeeds; refresh to see it.`,
    url: `https://github.com/${target.repository}/actions/runs/${prepared.runId}`,
  };
}

/** Reads what a merge would do, fresh, so the confirmation shows GitHub's state now rather than the window's copy. */
export async function previewMerge(input: unknown, deps: ActionDeps): Promise<MergePreviewResult> {
  const target = parseTarget(input);
  if (target === undefined) return refusal('That is not a valid pull request.');
  const allowed = await requireWrite(target.repository, deps.api);
  if (!allowed.ok) return allowed;
  const evaluated = await (deps.evaluate ?? evaluatePullRequest)(target.repository, target.number, deps.api, target.headSha);
  if (!evaluated.ok) return refusal(evaluated.error);
  const { value } = evaluated;
  return {
    ok: true,
    headSha: value.headSha,
    baseRef: value.baseRef,
    readiness: value.evaluation.readiness,
    ...(value.candidateId === undefined ? {} : { candidateId: value.candidateId }),
    ...(value.candidateReleaseId === undefined ? {} : { candidateReleaseId: value.candidateReleaseId }),
    publishes: value.releaseIntent.length > 0,
    releaseIntent: value.releaseIntent,
  };
}

/**
 * Merges after the person confirmed. Nothing the window says is trusted: the pull request is evaluated again now, and the
 * merge happens only if QA is not blocked, the head is still the one they saw and the candidate is still the one they reviewed.
 * GitHub is also told the head SHA, so a push between this check and the merge makes GitHub refuse it.
 */
export async function mergePullRequest(input: unknown, deps: ActionDeps): Promise<ActionResult> {
  const request = parseMergeRequest(input);
  if (request === undefined) return refusal('That is not a valid merge request.');
  const allowed = await requireWrite(request.repository, deps.api);
  if (!allowed.ok) return allowed;

  const evaluated = await (deps.evaluate ?? evaluatePullRequest)(request.repository, request.number, deps.api, request.headSha);
  if (!evaluated.ok) return refusal(`Not merged: ${evaluated.error}`);
  const { value } = evaluated;
  if (value.evaluation.readiness === 'blocked') return refusal('Not merged: QA is blocked for this pull request. Refresh to see why.');
  if (value.candidateId !== request.candidateId) {
    return refusal(`Not merged: the active candidate is now ${value.candidateId ?? 'none'}, not the ${request.candidateId ?? 'none'} you reviewed. Review it again.`);
  }

  const merged = await deps.api.put(`repos/${request.repository}/pulls/${request.number}/merge`, { sha: request.headSha, merge_method: request.method });
  if (merged.ok) {
    const sha = (merged.value as { sha?: unknown } | null)?.sha;
    return { ok: true, message: `Merged #${request.number}${typeof sha === 'string' ? ` as ${sha.slice(0, 7)}` : ''}.`, url: pullRequestUrl(request.repository, request.number) };
  }
  // GitHub does not say why in a form the transport keeps, so look: a moved head is the case worth naming.
  const now = await deps.api.get(`repos/${request.repository}/pulls/${request.number}`);
  const head = now.ok ? ((now.value as { head?: { sha?: unknown } } | null)?.head?.sha) : undefined;
  if (typeof head === 'string' && head !== request.headSha) return refusal('Not merged: the pull request changed just before the merge. Refresh and review the new head.');
  return refusal(merged.reason === 'network-error' ? 'Not merged: GitHub refused it (the branch may be protected, or the merge method is not allowed).' : `Not merged: ${accessText(merged.reason)}`);
}
