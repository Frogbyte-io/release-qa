import { hasReleaseIntent } from './gate.ts';
import type { ApiResult } from './transport.ts';

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;

export interface DeferredGateResult {
  schemaVersion: 1;
  repository: string;
  pullRequest: number;
  eventHead: string;
  state: 'success' | 'failure';
  description: string;
  summary: string;
  headSha?: string;
  baseRef?: string;
  baseSha?: string;
  candidateId?: string;
  candidateReleaseId?: number;
  candidateAssetId?: number;
  releaseIntent?: string[];
}

export interface GateFinalizeApi {
  get(path: string): Promise<ApiResult<unknown>>;
  list(path: string): Promise<ApiResult<unknown[]>>;
  post(path: string, body: unknown): Promise<ApiResult<unknown>>;
}

export type GateFinalization = { ok: true; state: 'success' | 'failure'; description: string; summary: string } | { ok: false; error: string };

/** Validates the evaluator artifact against current GitHub state before publishing the required status. */
export async function finalizeGateResult(repository: string, pullRequest: number, eventHead: string, input: unknown, api: GateFinalizeApi, runUrl?: string): Promise<GateFinalization> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !Number.isSafeInteger(pullRequest) || pullRequest <= 0 || !/^[0-9a-f]{40}$/.test(eventHead)) {
    return { ok: false, error: 'invalid event identity; required status was not published' };
  }
  const result = parseResult(input, repository, pullRequest, eventHead);
  let state: 'success' | 'failure' = result?.state ?? 'failure';
  let description = result?.description ?? 'QA blocked: evaluator result is missing or invalid';
  let summary = result?.summary ?? `**BLOCKED**: ${description}`;

  const current = await api.get(`repos/${repository}/pulls/${pullRequest}`);
  const pull = record(current.ok ? current.value : undefined);
  const head = record(pull?.head);
  const base = record(pull?.base);
  if (!current.ok || pull?.state !== 'open' || head?.sha !== eventHead) {
    state = 'failure';
    description = 'QA blocked: PR head changed before finalization';
    summary = `**BLOCKED**: ${description}`;
  } else if (state === 'success' && result !== undefined) {
    const finalCheck = await verifySuccessfulResult(repository, pullRequest, result, pull, api);
    if (finalCheck !== undefined) {
      state = 'failure';
      description = `QA blocked: ${finalCheck}`;
      summary = `**BLOCKED**: ${finalCheck}`;
    }
  }

  const posted = await api.post(`repos/${repository}/statuses/${eventHead}`, {
    state,
    context: 'release-qa',
    description: description.slice(0, 140),
    ...(runUrl === undefined ? {} : { target_url: runUrl }),
  });
  if (!posted.ok) return { ok: false, error: `could not publish required release-qa status: ${posted.reason}` };
  return { ok: true, state, description, summary };
}

function parseResult(input: unknown, repository: string, pullRequest: number, eventHead: string): DeferredGateResult | undefined {
  const value = record(input);
  if (value?.schemaVersion !== 1 || value.repository !== repository || value.pullRequest !== pullRequest || value.eventHead !== eventHead ||
      !['success', 'failure'].includes(String(value.state)) || typeof value.description !== 'string' || typeof value.summary !== 'string') return undefined;
  if (value.state === 'success' && (value.headSha !== eventHead || typeof value.baseRef !== 'string' || typeof value.baseSha !== 'string' || !/^[0-9a-f]{40}$/.test(value.baseSha) || !Array.isArray(value.releaseIntent) || value.releaseIntent.some((item) => typeof item !== 'string'))) return undefined;
  return value as unknown as DeferredGateResult;
}

async function verifySuccessfulResult(repository: string, pullRequest: number, result: DeferredGateResult, pull: JsonRecord, api: GateFinalizeApi): Promise<string | undefined> {
  const head = record(pull.head);
  const base = record(pull.base);
  const headRef = head?.ref;
  if (head?.sha !== result.headSha) return 'PR head changed before finalization';
  if (typeof headRef !== 'string' || base?.ref !== result.baseRef || typeof result.baseRef !== 'string' || typeof result.baseSha !== 'string') return 'PR target changed before finalization';
  const branch = await api.get(`repos/${repository}/branches/${encodeURIComponent(result.baseRef)}`);
  const currentBaseSha = branch.ok ? record(record(branch.value)?.commit)?.sha : undefined;
  if (currentBaseSha !== result.baseSha) return 'target branch changed before finalization';

  const policyResult = await api.get(`repos/${repository}/contents/qa/policy.json?ref=${result.baseSha}`);
  const policyFile = record(policyResult.ok ? policyResult.value : undefined);
  if (policyFile?.encoding !== 'base64' || typeof policyFile.content !== 'string') return 'trusted release policy could not be rechecked';
  let policy: { releaseBranchPrefix: string; releaseLabel: string; releaseFiles: string[] };
  try { policy = JSON.parse(Buffer.from(policyFile.content, 'base64').toString('utf8')) as typeof policy; }
  catch { return 'trusted release policy could not be rechecked'; }
  if (typeof policy.releaseBranchPrefix !== 'string' || typeof policy.releaseLabel !== 'string' || !Array.isArray(policy.releaseFiles) || policy.releaseFiles.some((item) => typeof item !== 'string')) return 'trusted release policy is invalid';

  const filesResult = await api.list(`repos/${repository}/pulls/${pullRequest}/files?per_page=100`);
  if (!filesResult.ok) return 'PR files could not be rechecked';
  const files = filesResult.value.map((item) => record(item)?.filename);
  if (files.some((item) => typeof item !== 'string')) return 'PR file list is incomplete';
  const labels = Array.isArray(pull.labels) ? pull.labels.map((item) => record(item)?.name).filter((item): item is string => typeof item === 'string') : [];
  const currentIntent = hasReleaseIntent({ branch: headRef, labels, files: files as string[] }, policy);
  if ((result.releaseIntent?.length ?? 0) > 0 && currentIntent.length === 0) return 'release intent changed before finalization';
  if ((result.releaseIntent?.length ?? 0) === 0 && currentIntent.length > 0) return 'release intent changed before finalization';

  if (result.candidateReleaseId !== undefined || result.candidateAssetId !== undefined) {
    if (!Number.isSafeInteger(result.candidateReleaseId) || !Number.isSafeInteger(result.candidateAssetId)) return 'candidate identity is incomplete';
    const releaseResult = await api.get(`repos/${repository}/releases/${result.candidateReleaseId}`);
    const release = record(releaseResult.ok ? releaseResult.value : undefined);
    const assets = Array.isArray(release?.assets) ? release.assets.map(record) : [];
    const candidate = assets.find((asset) => asset?.name === 'candidate.json');
    if (!releaseResult.ok || release?.draft !== true || release.name !== `QA PR #${pullRequest}` || record(candidate)?.id !== result.candidateAssetId) return 'active candidate changed before finalization';
  } else if (currentIntent.length > 0) {
    return 'release candidate was not brokered';
  }
  return undefined;
}
