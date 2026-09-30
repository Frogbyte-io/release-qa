import {
  evaluatePullRequest,
  inspectGitHubAccess,
  mergeReleasePr,
  prepareCandidate,
  type ApiResult,
  type MergeApi,
} from '@frogbyte-io/release-qa';
import { MERGE_METHODS, type ActionResult, type MergePreviewResult, type MergeRequest, type PullTarget } from '../shared/contract.ts';
import type { DashboardApi } from './qa-commands.ts';

/** The read transport plus the two writes the dashboard makes. The real one is the GitHub CLI session. */
export type ActionApi = DashboardApi & MergeApi & {
  post(path: string, body: unknown): Promise<ApiResult<unknown>>;
};

export interface ActionDeps {
  api: ActionApi;
  evaluate?: typeof evaluatePullRequest;
  prepare?: typeof prepareCandidate;
  /** The shared merge for release pull requests: saves the reviewed notes, merges, and confirms the outcome. */
  mergeRelease?: typeof mergeReleasePr;
}

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** `.` and `..` match the pattern but are path segments, not names; they must not reach an API path or a URL. */
const repositoryName = { test: (value: string): boolean => repositoryPattern.test(value) && value.split('/').every((part) => part !== '.' && part !== '..') };
const gitSha = /^[0-9a-f]{40}$/;
const WRITE_ROLES = ['admin', 'maintain', 'write'];

/** Everything from the window is checked here, as if it came from anywhere: shape, then meaning. */
export function parsePullRef(value: unknown): Pick<PullTarget, 'repository' | 'number'> | undefined {
  const ref = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  if (typeof ref?.repository !== 'string' || !repositoryName.test(ref.repository)) return undefined;
  if (typeof ref.number !== 'number' || !Number.isSafeInteger(ref.number) || ref.number <= 0) return undefined;
  return { repository: ref.repository, number: ref.number };
}

export const parseRepository = (value: unknown): string | undefined => (typeof value === 'string' && repositoryName.test(value) ? value : undefined);

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

export const refusal = (error: string): { ok: false; error: string } => ({ ok: false, error });
const uncertain = (error: string): { ok: false; error: string; uncertain: true } => ({ ok: false, error, uncertain: true });

const ACCESS_TEXT: Record<string, string> = {
  'logged-out': 'GitHub sign-in has expired. Run "gh auth login", then refresh.',
  'missing-scope': 'The GitHub token lacks a needed permission scope.',
  'insufficient-role': 'Your account does not have write access to this repository.',
  'organization-rejected': 'The organization has not approved this sign-in.',
  'not-found': 'The repository or pull request was not found.',
  'network-error': 'GitHub could not be reached, or refused the request.',
};
export const accessText = (reason: string): string => ACCESS_TEXT[reason] ?? reason;

export async function requireWrite(repository: string, api: ActionApi, action = 'merge'): Promise<{ ok: true } | { ok: false; error: string }> {
  const access = await inspectGitHubAccess(repository, api);
  if (!access.ok) return refusal(accessText(access.reason));
  return WRITE_ROLES.includes(access.role) ? { ok: true } : refusal('Your account has read-only access to this repository; it cannot ' + action + '.');
}

/**
 * Starts candidate preparation: dispatches the trusted workflow from the default branch for the head the person saw.
 * The shared preparation checks write access, the trusted policy and the pull request's current state before dispatching.
 */
export async function prepareReleaseCandidate(input: unknown, deps: ActionDeps): Promise<ActionResult> {
  const target = parseTarget(input);
  if (target === undefined) return refusal('That is not a valid pull request.');
  const prepared = await (deps.prepare ?? prepareCandidate)(target.repository, target.number, target.headSha, deps.api);
  if (!prepared.ok) {
    // A run can already exist when only its verification failed; saying so keeps a retry from starting a second one.
    return refusal(prepared.runId === undefined ? prepared.error : `${prepared.error} (workflow run ${prepared.runId} was already started; check it before trying again)`);
  }
  return { ok: true, message: `Candidate preparation started for ${target.headSha.slice(0, 7)} (workflow run ${prepared.runId}). The candidate appears here after the run succeeds; refresh to see it.` };
}

/**
 * Reads what a merge would do, fresh, for the confirmation. It deliberately does not pin the head: if the pull request
 * moved since the window drew it, the preview reports the new head so the window can say so, rather than failing with an
 * evaluator message. The merge itself does pin the head.
 */
export async function previewMerge(input: unknown, deps: ActionDeps): Promise<MergePreviewResult> {
  const target = parseTarget(input);
  if (target === undefined) return refusal('That is not a valid pull request.');
  const allowed = await requireWrite(target.repository, deps.api);
  if (!allowed.ok) return allowed;
  const evaluated = await (deps.evaluate ?? evaluatePullRequest)(target.repository, target.number, deps.api);
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
 *
 * A release pull request is merged by the shared `mergeReleasePr`, which is what the publication step relies on: it needs the
 * reviewed release notes saved first, a merge commit (so the merged tree is the tested tree), and a check of the outcome
 * afterwards. Only an ordinary pull request takes the merge method the person chose.
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

  if (value.releaseIntent.length > 0) {
    const merged = await (deps.mergeRelease ?? mergeReleasePr)(request.repository, request.number, request.headSha, deps.api);
    if (merged.ok) return { ok: true, message: `Merged #${request.number} as ${merged.sha.slice(0, 7)}. The release notes you reviewed were saved with the candidate; publication follows from the merge.` };
    // The shared merge reports an unknown outcome only in words; these are the two phrases it uses (publish.ts).
    return /unconfirmed|did not confirm/.test(merged.error)
      ? uncertain(`Merge outcome unconfirmed: ${merged.error}. Check the pull request before trying again.`)
      : refusal(`Not merged: ${merged.error}`);
  }
  return mergeOrdinary(request, deps.api);
}

async function mergeOrdinary(request: MergeRequest, api: ActionApi): Promise<ActionResult> {
  const path = `repos/${request.repository}/pulls/${request.number}`;
  const merged = await api.put(`${path}/merge`, { sha: request.headSha, merge_method: request.method });
  if (merged.ok) {
    const sha = (merged.value as { sha?: unknown } | null)?.sha;
    return { ok: true, message: `Merged #${request.number}${typeof sha === 'string' ? ` as ${sha.slice(0, 7)}` : ''}.` };
  }
  // The transport cannot tell a refusal from a reply that never arrived, so look at what GitHub has now.
  const now = await api.get(path);
  const pull = now.ok ? (now.value as { merged?: unknown; head?: { sha?: unknown } } | null) : undefined;
  if (pull?.merged === true && pull.head?.sha === request.headSha) return { ok: true, message: `Merged #${request.number}. GitHub’s reply was lost, but the pull request shows as merged.` };
  if (typeof pull?.head?.sha === 'string' && pull.head.sha !== request.headSha) return refusal('Not merged: the pull request changed just before the merge. Refresh and review the new head.');
  if (pull === undefined) return uncertain(`Merge outcome unknown: ${accessText(merged.reason)} Check the pull request before trying again.`);
  return refusal(merged.reason === 'network-error'
    ? 'Not merged: GitHub did not complete it. It may have been refused (protected branch, a merge method the repository does not allow, or a conflict) or not reached. Refresh, then try again.'
    : `Not merged: ${accessText(merged.reason)}`);
}
