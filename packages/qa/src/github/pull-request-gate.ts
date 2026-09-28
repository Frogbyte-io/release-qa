import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { evaluate, type Evaluation, type AuthorizedException, type RetryResolution } from '../model/evaluate.ts';
import { parseCandidate } from '../model/candidate.ts';
import { parseException } from '../model/exception.ts';
import { parseProject } from '../model/project.ts';
import { loadCandidateProgress, type SyncApi } from './sync.ts';
import { hasReleaseIntent, renderQaSection, type ReleaseIntentPolicy } from './gate.ts';
import { GhTransport, type ApiResult } from './transport.ts';

export interface GateApi extends SyncApi {
  get(path: string): Promise<ApiResult<unknown>>;
  list(path: string): Promise<ApiResult<unknown[]>>;
}

export interface PullRequestGateEvaluation {
  pullRequest: number;
  headSha: string;
  baseSha: string;
  candidateId?: string;
  releaseIntent: string[];
  evaluation: Evaluation;
  summary: string;
  markers: { releaseNotes: string; qa: string };
}

export type PullRequestGateResult = { ok: true; value: PullRequestGateEvaluation } | { ok: false; error: string; markers?: { releaseNotes: string; qa: string } };

const gitSha = /^[0-9a-f]{40}$/;
interface GatePolicy extends ReleaseIntentPolicy { required: string[]; }
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const fail = (message: string): PullRequestGateResult => ({ ok: false, error: message });

/** Evaluates the live PR against trusted target-branch policy and the exact selected candidate. */
export async function evaluatePullRequest(repository: string, pullRequest: number, api: GateApi = new GhTransport(), expectedHeadSha?: string, candidateReleaseId?: number, candidateReleaseSnapshot?: unknown): Promise<PullRequestGateResult> {
  let trustedMarkers: { releaseNotes: string; qa: string } | undefined;
  const failure = (message: string): PullRequestGateResult => ({ ok: false, error: message, ...(trustedMarkers === undefined ? {} : { markers: trustedMarkers }) });
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !Number.isSafeInteger(pullRequest) || pullRequest <= 0) return failure('invalid repository or pull request number');
  try {
    const prefix = `repos/${repository}`;
    const initialResult = await api.get(`${prefix}/pulls/${pullRequest}`);
    if (!initialResult.ok) return failure(`cannot read pull request: ${initialResult.reason}`);
    const initial = record(initialResult.value);
    const initialHead = record(initial?.head);
    const initialBase = record(initial?.base);
    const repositoryId = record(initialHead?.repo)?.id;
    if (initial?.state !== 'open' || typeof initialHead?.sha !== 'string' || !gitSha.test(initialHead.sha) || typeof initialHead.ref !== 'string' ||
        typeof initialBase?.ref !== 'string' || !Number.isSafeInteger(repositoryId) || repositoryId !== record(initialBase.repo)?.id) return failure('pull request is closed, malformed, or from a fork');
    if (expectedHeadSha !== undefined && initialHead.sha !== expectedHeadSha) return failure('pull request head does not match the event head; evaluate again');

    const branchResult = await api.get(`${prefix}/branches/${encodeURIComponent(initialBase.ref)}`);
    const baseSha = branchResult.ok ? record(record(branchResult.value)?.commit)?.sha : undefined;
    if (typeof baseSha !== 'string' || !gitSha.test(baseSha)) return failure('cannot verify the current target branch tip');
    const policyResult = await readTrustedJson(api, `${prefix}/contents/qa/policy.json?ref=${baseSha}`);
    if (!policyResult.ok) return failure(`cannot load trusted QA policy: ${policyResult.error}`);
    const policy = parsePolicy(policyResult.value);
    if (!policy.ok) return failure(policy.error);
    const projectResult = await readTrustedJson(api, `${prefix}/contents/qa/project.json?ref=${baseSha}`);
    if (!projectResult.ok) return failure(`cannot load trusted QA project: ${projectResult.error}`);
    const project = parseProject(projectResult.value);
    if (!project.ok) return failure(`invalid trusted QA project: ${project.error.message}`);
    trustedMarkers = project.value.markers;
    const changed = await api.list(`${prefix}/pulls/${pullRequest}/files?per_page=100`);
    if (!changed.ok) return failure(`cannot inspect changed files: ${changed.reason}`);
    const files = changed.value.map((file) => record(file)?.filename);
    if (files.some((file) => typeof file !== 'string')) return failure('pull request changed-file list is incomplete');
    const releaseIntent = hasReleaseIntent({ branch: initialHead.ref, labels: labelNames(initial), files: files as string[] }, policy.value);

    // A non-release PR is green only if it remains non-release after a fresh read.
    if (releaseIntent.length === 0) {
      const currentIntent = await readCurrentReleaseIntent(api, prefix, pullRequest, policy.value);
      if (!currentIntent.ok || currentIntent.value.length > 0) return failure('release intent changed during evaluation; evaluate again');
      const fresh = await readIdentity(api, prefix, pullRequest, initialBase.ref, repositoryId as number);
      if (!fresh.ok || fresh.value.headSha !== initialHead.sha || fresh.value.baseSha !== baseSha) return failure('pull request or target branch changed during evaluation');
      return { ok: true, value: { pullRequest, headSha: initialHead.sha, baseSha, releaseIntent, evaluation: passedEvaluation(), summary: 'No release intent; normal merge policy applies.', markers: project.value.markers } };
    }

    let release: Record<string, unknown> | undefined;
    if (candidateReleaseSnapshot !== undefined) {
      release = record(candidateReleaseSnapshot);
    } else if (candidateReleaseId === undefined) {
      const releasesResult = await api.list(`${prefix}/releases?per_page=100`);
      if (!releasesResult.ok) return failure(`cannot list candidate releases: ${releasesResult.reason}`);
      release = releasesResult.value.map(record).find((item) => item?.draft === true && item.name === `QA PR #${pullRequest}`);
    } else {
      if (!Number.isSafeInteger(candidateReleaseId) || candidateReleaseId <= 0) return failure('invalid candidate release id');
      const releaseResult = await api.get(`${prefix}/releases/${candidateReleaseId}`);
      release = record(releaseResult.ok ? releaseResult.value : undefined);
    }
    if (release === undefined || release.draft !== true || release.name !== `QA PR #${pullRequest}` || !Number.isSafeInteger(release.id) || !Array.isArray(release.assets)) return failure('manual check required: no draft candidate release for this pull request');
    const assets = release.assets.map(record).filter((item) => item !== undefined);
    const candidateAsset = assets.find((asset) => asset.name === 'candidate.json');
    if (candidateAsset === undefined || !Number.isSafeInteger(candidateAsset.id)) return failure('manual check required: no active candidate selected');
    const candidateJson = await downloadJson(api, `${prefix}/releases/assets/${candidateAsset.id}`);
    if (!candidateJson.ok) return failure(`cannot load active candidate: ${candidateJson.error}`);
    const parsedCandidate = parseCandidate(candidateJson.value);
    if (!parsedCandidate.ok) return failure(`invalid active candidate: ${parsedCandidate.error.message}`);
    const candidate = parsedCandidate.value;
    if (candidate.pullRequest !== pullRequest || candidate.repositoryId !== record(initialHead.repo)?.id) return failure('active candidate belongs to a different pull request or repository');
    if (candidate.policyDigest !== policyResult.sha256) return failure('candidate was prepared against a different QA policy; prepare it again');

    const required = policy.value.required.map((key) => project.value.requirements.find((requirement) => requirement.key === key));
    if (required.some((requirement) => requirement === undefined)) return failure('trusted policy requires a check missing from qa/project.json');

    const progress = await loadCandidateProgress(repository, Number(release.id), candidate.id, api, release.assets as unknown[]);
    if (!progress.ok) return failure(`cannot load shared QA reports: ${progress.reason}`);
    const exceptions: AuthorizedException[] = [];
    const authorityActors = new Set<string>();
    for (const asset of assets.filter((item) => typeof item.name === 'string' && /^(qa-)?exception-/.test(item.name) && item.state === 'uploaded')) {
      const uploader = record(asset.uploader)?.login;
      if (typeof uploader !== 'string' || !Number.isSafeInteger(asset.id)) continue;
      const raw = await downloadJson(api, `${prefix}/releases/assets/${asset.id}`);
      if (!raw.ok) continue;
      const parsed = parseException(raw.value, { candidate, requirements: project.value.requirements.map((item) => item.key) });
      if (!parsed.ok) continue;
      authorityActors.add(uploader);
      exceptions.push({ exception: parsed.value, authority: { login: uploader, authorized: false } });
    }
    const retryUploads: Array<{ uploader: string; resolution: RetryResolution }> = [];
    for (const asset of assets.filter((item) => typeof item.name === 'string' && item.name.startsWith('qa-retry-resolution-') && item.state === 'uploaded')) {
      const uploader = record(asset.uploader)?.login;
      if (typeof uploader !== 'string' || !Number.isSafeInteger(asset.id)) continue;
      const raw = await downloadJson(api, `${prefix}/releases/assets/${asset.id}`);
      if (!raw.ok) continue;
      const resolution = record(raw.value);
      if (resolution?.candidateId !== candidate.id || resolution.acknowledgedBy !== uploader ||
          typeof resolution.failedAttemptId !== 'string' || typeof resolution.passingAttemptId !== 'string') continue;
      authorityActors.add(uploader);
      retryUploads.push({ uploader, resolution: { failedAttemptId: resolution.failedAttemptId, passingAttemptId: resolution.passingAttemptId, acknowledgedBy: uploader } });
    }

    // Establish that the PR and target still match the candidate before trusting
    // uploader permissions, then repeat the complete snapshot after those lookups.
    const authorityIdentity = await readIdentity(api, prefix, pullRequest, initialBase.ref, repositoryId as number);
    if (!authorityIdentity.ok || authorityIdentity.value.headSha !== initialHead.sha || authorityIdentity.value.baseSha !== baseSha) {
      return failure('pull request or target branch changed during evaluation');
    }

    const retryResolutions: RetryResolution[] = [];
    for (const login of authorityActors) {
      const permission = await api.get(`${prefix}/collaborators/${encodeURIComponent(login)}/permission`);
      const role = permission.ok ? record(permission.value)?.permission : undefined;
      for (const entry of exceptions) if (entry.authority.login === login) {
        entry.authority.authorized = ['admin', 'maintain'].includes(String(role)) && entry.exception.actor === login;
      }
      if (['write', 'maintain', 'admin'].includes(String(role))) {
        retryResolutions.push(...retryUploads.filter((item) => item.uploader === login).map((item) => item.resolution));
      }
    }
    // Recheck release intent, draft identity, candidate identity, and PR/branch identity after all
    // collaborator permission calls so those calls cannot make the earlier snapshot stale.
    const currentIntent = await readCurrentReleaseIntent(api, prefix, pullRequest, policy.value);
    if (!currentIntent.ok || currentIntent.value.length === 0) return failure('release intent changed during evaluation; evaluate again');
    const finalReleaseResult = await api.get(`${prefix}/releases/${release.id}`);
    const finalRelease = record(finalReleaseResult.ok ? finalReleaseResult.value : undefined);
    const finalAssets = Array.isArray(finalRelease?.assets) ? finalRelease.assets.map(record) : [];
    const finalCandidate = finalAssets.find((item) => item?.name === 'candidate.json');
    if (finalRelease?.draft !== true || finalRelease.name !== `QA PR #${pullRequest}` || record(finalCandidate)?.id !== candidateAsset.id) {
      return failure('active candidate release changed during evaluation; run the gate again');
    }
    const fresh = await readIdentity(api, prefix, pullRequest, initialBase.ref, repositoryId as number);
    if (!fresh.ok || fresh.value.headSha !== initialHead.sha || fresh.value.baseSha !== baseSha) return failure('pull request or target branch changed during evaluation');
    const evaluation = evaluate({
      candidate,
      currentHeadSha: initialHead.sha,
      currentBaseSha: baseSha,
      required: required as NonNullable<(typeof required)[number]>[],
      profiles: project.value.profiles,
      reports: progress.value.reports.map(({ report, uploader, assetId }) => ({ report, provenance: { uploader, uploadedAt: '', assetId } })),
      exceptions,
      retryResolutions,
    });
    const summary = renderQaSection(evaluation);
    return { ok: true, value: { pullRequest, headSha: initialHead.sha, baseSha, candidateId: candidate.id, releaseIntent, evaluation, summary, markers: project.value.markers } };
  } catch {
    return failure('GitHub state could not be safely evaluated');
  }
}

async function readCurrentReleaseIntent(api: GateApi, prefix: string, pullRequest: number, policy: ReleaseIntentPolicy): Promise<{ ok: true; value: string[] } | { ok: false }> {
  const prResult = await api.get(`${prefix}/pulls/${pullRequest}`);
  const pr = record(prResult.ok ? prResult.value : undefined);
  const head = record(pr?.head);
  if (pr?.state !== 'open' || typeof head?.ref !== 'string') return { ok: false };
  const filesResult = await api.list(`${prefix}/pulls/${pullRequest}/files?per_page=100`);
  if (!filesResult.ok) return { ok: false };
  const files = filesResult.value.map((value) => record(value)?.filename);
  if (files.some((file) => typeof file !== 'string')) return { ok: false };
  return { ok: true, value: hasReleaseIntent({ branch: head.ref, labels: labelNames(pr), files: files as string[] }, policy) };
}

async function readIdentity(api: GateApi, prefix: string, pullRequest: number, baseBranch: string, repositoryId: number): Promise<{ ok: true; value: { headSha: string; baseSha: string } } | { ok: false }> {
  const pr = await api.get(`${prefix}/pulls/${pullRequest}`);
  const pull = record(pr.ok ? pr.value : undefined);
  const head = record(pull?.head);
  const base = record(pull?.base);
  if (pull?.state !== 'open' || base?.ref !== baseBranch || record(head?.repo)?.id !== repositoryId || record(base.repo)?.id !== repositoryId) return { ok: false };
  const branch = await api.get(`${prefix}/branches/${encodeURIComponent(String(base.ref))}`);
  const headSha = head?.sha;
  const baseSha = record(record(branch.ok ? branch.value : undefined)?.commit)?.sha;
  return typeof headSha === 'string' && typeof baseSha === 'string' ? { ok: true, value: { headSha, baseSha } } : { ok: false };
}

async function readTrustedJson(api: GateApi, path: string): Promise<{ ok: true; value: unknown; sha256: string } | { ok: false; error: string }> {
  const response = await api.get(path);
  if (!response.ok) return { ok: false, error: response.reason };
  const file = record(response.value);
  if (file?.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string') return { ok: false, error: 'trusted JSON file was not readable' };
  try {
    const bytes = Buffer.from(file.content, 'base64');
    return { ok: true, value: JSON.parse(bytes.toString('utf8')) as unknown, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  catch { return { ok: false, error: 'trusted JSON file is malformed' }; }
}

async function downloadJson(api: GateApi, path: string): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'release-qa-gate-'));
  const destination = join(directory, 'record.json');
  try {
    const result = await api.download(path, destination);
    if (!result.ok) return { ok: false, error: result.reason };
    return { ok: true, value: JSON.parse((await readFile(destination, 'utf8'))) as unknown };
  } catch { return { ok: false, error: 'asset record is malformed or unavailable' }; }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function parsePolicy(value: unknown): { ok: true; value: GatePolicy } | { ok: false; error: string } {
  const policy = record(value);
  if (typeof policy?.releaseBranchPrefix !== 'string' || !policy.releaseBranchPrefix || typeof policy.releaseLabel !== 'string' || !policy.releaseLabel ||
      !Array.isArray(policy.releaseFiles) || !policy.releaseFiles.every((file) => typeof file === 'string' && file.length > 0) ||
      !Array.isArray(policy.required) || !policy.required.every((key) => typeof key === 'string') || policy.required.length === 0) return { ok: false, error: 'trusted release policy is invalid' };
  return { ok: true, value: { releaseBranchPrefix: policy.releaseBranchPrefix, releaseLabel: policy.releaseLabel, releaseFiles: policy.releaseFiles as string[], required: policy.required as string[] } };
}

function labelNames(pr: Record<string, unknown>): string[] {
  return Array.isArray(pr.labels) ? pr.labels.flatMap((value) => typeof record(value)?.name === 'string' ? [record(value)!.name as string] : []) : [];
}

function passedEvaluation(): Evaluation { return { readiness: 'passed', reasons: [], excused: [], acceptedReportIds: [], exceptionIds: [], ignored: [] }; }
