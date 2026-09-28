import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Candidate } from '../model/candidate.ts';
import { parseCandidate } from '../model/candidate.ts';
import { evaluate, type Evaluation, type EvaluationInput } from '../model/evaluate.ts';
import { GhTransport, type ApiResult } from './transport.ts';
import { evaluatePullRequest, type GateApi } from './pull-request-gate.ts';
import { readManagedSection } from './pull-request.ts';
import { verifyCandidateAssets, type BuildRun, type ReleaseAsset, type ActionsArtifact } from './candidate.ts';

export interface PublicationInput {
  repository: string;
  candidate: Candidate;
  evaluation: EvaluationInput;
  /** Digest of qa/policy.json read from the current default branch. */
  currentPolicyDigest: string;
  /** Identity captured from the PR after merge. */
  pullRequest: number;
  merged: boolean;
  mergedHeadSha: string;
  mergeCommitSha: string;
  mergeTreeSha: string;
  expectedTag: string;
  tagName: string;
  /** The release notes section captured from the reviewed PR body before merge. */
  changelog: string;
}

export interface PublicationManifest {
  schemaVersion: 1;
  repository: string;
  candidateId: string;
  pullRequest: number;
  sourceSha: string;
  sourceTreeSha: string;
  mergeSha: string;
  mergeTreeSha: string;
  policyDigest: string;
  tag: string;
  changelog: string;
  artifacts: Array<{ profile: string; name: string; sha256: string; assetId: number }>;
  evaluation: Evaluation;
  idempotencyKey: string;
}

export type PublicationCheck = { ok: true; manifest: PublicationManifest } | { ok: false; reasons: string[] };
const repoName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const sha = /^[0-9a-f]{40}$/;
const digest = /^[0-9a-f]{64}$/;

/** Pure fail-closed check; callers must build evaluation from a fresh read of policy, reports and authority. */
export function verifyPublication(input: PublicationInput): PublicationCheck {
  const reasons: string[] = [];
  const parsed = parseCandidate(input.candidate);
  if (!repoName.test(input.repository)) reasons.push('invalid repository');
  if (!parsed.ok) reasons.push(`invalid candidate: ${parsed.error.message}`);
  if (!Number.isSafeInteger(input.pullRequest) || input.pullRequest !== input.candidate.pullRequest) reasons.push('pull request does not match candidate');
  if (!input.merged) reasons.push('pull request is not merged');
  if (!sha.test(input.mergedHeadSha) || input.mergedHeadSha !== input.candidate.sourceSha) reasons.push('merged PR head does not match tested source SHA');
  if (!sha.test(input.mergeCommitSha)) reasons.push('merge commit SHA is unavailable');
  if (!sha.test(input.mergeTreeSha) || input.mergeTreeSha !== input.candidate.sourceTreeSha) reasons.push('merge tree differs from tested source tree');
  if (!digest.test(input.currentPolicyDigest) || input.currentPolicyDigest !== input.candidate.policyDigest) reasons.push('current QA policy differs from candidate policy');
  if (!input.expectedTag || input.tagName !== input.expectedTag) reasons.push('release tag does not match expected tag');
  if (!input.changelog.trim() || /<!--\s*(?:release-notes|changelog):start\s*-->/i.test(input.changelog)) reasons.push('reviewed changelog could not be identified');
  if (new Set(input.candidate.artifacts.map((artifact) => artifact.name)).size !== input.candidate.artifacts.length) reasons.push('final artifact names collide');
  if (input.candidate.artifacts.some((artifact) => artifact.name === 'release-qa-record.json')) reasons.push('candidate uses a reserved publication asset name');
  if (input.candidate.artifacts.some((artifact) => /^qa-merge-notes-[0-9a-f]{40}\.json$/.test(artifact.name))) reasons.push('candidate uses a reserved merge notes asset name');
  const evaluation = evaluate(input.evaluation);
  if (evaluation.readiness === 'blocked') reasons.push('current QA evidence does not pass');
  if (input.evaluation.candidate.id !== input.candidate.id || input.evaluation.candidate.policyDigest !== input.candidate.policyDigest ||
      JSON.stringify(input.evaluation.candidate) !== JSON.stringify(input.candidate)) reasons.push('evaluation is for a different candidate or tested binary set');
  if (reasons.length) return { ok: false, reasons };
  const manifest: PublicationManifest = {
    schemaVersion: 1, repository: input.repository, candidateId: input.candidate.id,
    pullRequest: input.pullRequest, sourceSha: input.candidate.sourceSha,
    sourceTreeSha: input.candidate.sourceTreeSha, mergeSha: input.mergeCommitSha,
    mergeTreeSha: input.mergeTreeSha, policyDigest: input.currentPolicyDigest,
    tag: input.tagName, changelog: input.changelog,
    artifacts: input.candidate.artifacts.map(({ profile, name, sha256, assetId }) => ({ profile, name, sha256, assetId })),
    evaluation, idempotencyKey: createHash('sha256').update(`${input.repository}\n${input.candidate.id}\n${input.tagName}\n${input.mergeCommitSha}`).digest('hex'),
  };
  return { ok: true, manifest };
}

/** Reloads all QA records and permissions after merge, then binds the reviewed notes to the exact shipped tree. */
export async function preparePublication(repository: string, pullRequest: number, reviewedBody: string, api: GateApi = new GhTransport()): Promise<PublicationCheck> {
  if (!repoName.test(repository) || !Number.isSafeInteger(pullRequest) || pullRequest <= 0) return { ok: false, reasons: ['invalid publication identity'] };
  const checked = await evaluatePullRequest(repository, pullRequest, api, undefined, undefined, undefined, { publication: true });
  if (!checked.ok) return { ok: false, reasons: [checked.error] };
  const gate = checked.value;
  if (gate.releaseIntent.length === 0) {
    const releases = await api.list(`repos/${repository}/releases?per_page=100`);
    if (!releases.ok) return { ok: false, reasons: ['cannot determine whether a prior release candidate exists'] };
    const prior = releases.value.map(asRecord).find((item) => item?.draft === true && item.name === `QA PR #${pullRequest}`);
    if (prior) return { ok: false, reasons: ['release intent was removed after a candidate was selected; repair required'] };
    return { ok: false, reasons: ['no release intent'] };
  }
  if (!gate.publication) return { ok: false, reasons: ['merged PR has no active release candidate'] };
  const { candidate, evaluationInput, policyDigest, mergeSha } = gate.publication;
  const build = await api.get(`repos/${repository}/actions/runs/${candidate.build.runId}`);
  if (!build.ok) return { ok: false, reasons: ['candidate build run is unavailable'] };
  const releases: ReleaseAsset[] = [];
  const actions: ActionsArtifact[] = [];
  for (const artifact of candidate.artifacts) {
    const release = await api.get(`repos/${repository}/releases/assets/${artifact.assetId}`);
    const action = await api.get(`repos/${repository}/actions/artifacts/${artifact.actionsArtifactId}`);
    if (!release.ok || !action.ok) return { ok: false, reasons: [`candidate asset origin is unavailable: ${artifact.name}`] };
    releases.push(release.value as ReleaseAsset);
    actions.push(action.value as ActionsArtifact);
  }
  const provenance = verifyCandidateAssets(candidate, build.value as BuildRun, releases, actions);
  if (!provenance.ok) return { ok: false, reasons: provenance.issues };
  const notes = readManagedSection(reviewedBody, gate.markers.releaseNotes);
  if (!notes.ok) return { ok: false, reasons: [`reviewed changelog is ambiguous: ${notes.error}`] };
  const prefix = `repos/${repository}`;
  const mergeCommit = await api.get(`${prefix}/git/commits/${mergeSha}`);
  const branchCommit = await api.get(`${prefix}/git/commits/${gate.baseSha}`);
  const mergeTree = asRecord(asRecord(mergeCommit.ok ? mergeCommit.value : undefined)?.tree)?.sha;
  const branchTree = asRecord(asRecord(branchCommit.ok ? branchCommit.value : undefined)?.tree)?.sha;
  if (typeof mergeTree !== 'string' || !sha.test(mergeTree) || branchTree !== mergeTree) return { ok: false, reasons: ['merge tree or current target tree could not be verified'] };
  const versionResult = await api.get(`${prefix}/contents/VERSION?ref=${candidate.sourceSha}`);
  const versionFile = asRecord(versionResult.ok ? versionResult.value : undefined);
  if (versionFile?.encoding !== 'base64' || typeof versionFile.content !== 'string') return { ok: false, reasons: ['release version is unavailable at tested source'] };
  const version = Buffer.from(versionFile.content, 'base64').toString('utf8').trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) return { ok: false, reasons: ['release version is invalid'] };
  const tag = `v${version}`;
  const tagResult = await api.get(`${prefix}/git/ref/tags/${encodeURIComponent(tag)}`);
  if (tagResult.ok && await resolveTagCommit(api, prefix, tagResult.value) !== mergeSha) return { ok: false, reasons: ['release tag points to a different commit'] };
  if (!tagResult.ok && tagResult.reason !== 'not-found') return { ok: false, reasons: ['release tag could not be checked'] };
  const freshPr = await api.get(`${prefix}/pulls/${pullRequest}`);
  const freshBranch = await api.get(`${prefix}/branches/${encodeURIComponent(gate.baseRef)}`);
  const pr = asRecord(freshPr.ok ? freshPr.value : undefined);
  if (pr?.merged !== true || asRecord(pr.head)?.sha !== candidate.sourceSha || pr.merge_commit_sha !== mergeSha || pr.body !== reviewedBody || asRecord(asRecord(freshBranch.ok ? freshBranch.value : undefined)?.commit)?.sha !== gate.baseSha) {
    return { ok: false, reasons: ['merged PR or target branch changed during publication verification'] };
  }
  return verifyPublication({ repository, candidate, evaluation: evaluationInput, currentPolicyDigest: policyDigest,
    pullRequest, merged: true, mergedHeadSha: gate.headSha, mergeCommitSha: mergeSha, mergeTreeSha: mergeTree,
    expectedTag: tag, tagName: tag, changelog: notes.content });
}

export interface PublishApi {
  get(path: string): Promise<ApiResult<unknown>>;
  list(path: string): Promise<ApiResult<unknown[]>>;
  post(path: string, body: unknown): Promise<ApiResult<unknown>>;
  patch(path: string, body: unknown): Promise<ApiResult<unknown>>;
  upload(repository: string, releaseId: number, name: string, content: Buffer): Promise<ApiResult<{ id: number; name: string; state: string }>>;
  download(path: string, destination: string): Promise<ApiResult<true>>;
  delete(path: string): Promise<ApiResult<unknown>>;
}

export type PublishResult = { ok: true; releaseId: number; retried: boolean } | { ok: false; error: string };

export function renderPublicationNotes(manifest: PublicationManifest): string {
  const decision = manifest.evaluation.readiness === 'approved-with-exceptions'
    ? `Approved with exceptions: ${manifest.evaluation.exceptionIds.join(', ')}` : 'Passed';
  return `${manifest.changelog.trim()}\n\n## Release QA\n\n${decision}\n\n` +
    `Candidate: ${manifest.candidateId}\nSource: ${manifest.sourceSha}\nMerge: ${manifest.mergeSha}\nPolicy: ${manifest.policyDigest}\n\n` +
    manifest.artifacts.map((artifact) => `- ${artifact.name}: SHA-256 ${artifact.sha256}`).join('\n');
}

/** Creates or resumes one immutable GitHub release and verifies every published byte against its tested hash. */
export async function publishApprovedCandidate(manifest: PublicationManifest, api: PublishApi = new GhTransport(), beforePublish?: () => Promise<boolean>): Promise<PublishResult> {
  if (!repoName.test(manifest.repository) || !manifest.tag || manifest.artifacts.length === 0) return { ok: false, error: 'invalid publication manifest' };
  const prefix = `repos/${manifest.repository}`;
  const body = renderPublicationNotes(manifest);
  const releases = await api.list(`${prefix}/releases?per_page=100`);
  if (!releases.ok) return { ok: false, error: `cannot list releases: ${releases.reason}` };
  let release = releases.value.map(asRecord).find((item) => item?.tag_name === manifest.tag);
  const retried = release !== undefined;
  if (release === undefined) {
    const created = await api.post(`${prefix}/releases`, { tag_name: manifest.tag, target_commitish: manifest.mergeSha, name: manifest.tag, body, draft: true, prerelease: false });
    if (!created.ok) return { ok: false, error: `release creation is unconfirmed; retry safely: ${created.reason}` };
    release = asRecord(created.value);
  }
  if (!Number.isSafeInteger(release?.id) || release?.tag_name !== manifest.tag) return { ok: false, error: 'release identity is invalid; retry after repair' };
  const releaseId = release.id as number;
  if (release.body !== body || release.name !== manifest.tag) return { ok: false, error: 'release has conflicting metadata' };
  const assetsResult = await api.list(`${prefix}/releases/${releaseId}/assets?per_page=100`);
  if (!assetsResult.ok) return { ok: false, error: `cannot verify release assets: ${assetsResult.reason}` };
  const listedAssets = assetsResult.value.map(asRecord);
  if (listedAssets.some((asset) => !asset || typeof asset.name !== 'string' || !Number.isSafeInteger(asset.id))) return { ok: false, error: 'release asset listing is incomplete' };
  const allowed = new Set([...manifest.artifacts.map((artifact) => artifact.name), 'release-qa-record.json']);
  for (const asset of listedAssets) {
    if (asset && !allowed.has(asset.name as string)) {
      if (release.draft !== true) return { ok: false, error: 'published release contains an unapproved asset; repair required' };
      const removed = await api.delete(`${prefix}/releases/assets/${asset.id}`);
      if (!removed.ok) return { ok: false, error: `superseded asset ${asset.name} could not be removed from the final draft` };
    }
  }
  const existing = new Map(listedAssets.filter((x): x is Record<string, unknown> => !!x && allowed.has(x.name as string)).map((x) => [x.name as string, x]));
  if (release.draft !== true && [...manifest.artifacts.map((artifact) => artifact.name), 'release-qa-record.json'].some((name) => !existing.has(name))) {
    return { ok: false, error: 'published release is incomplete; repair required before retry' };
  }
  for (const artifact of manifest.artifacts) {
    const already = existing.get(artifact.name);
    if (already) {
      if (typeof already.id !== 'number') return { ok: false, error: `asset ${artifact.name} has no verifiable id` };
      const verified = await downloadAndHash(api, `${prefix}/releases/assets/${already.id}`);
      if (!verified.ok) return { ok: false, error: `cannot verify existing ${artifact.name}: ${verified.error}` };
      if (verified.sha256 !== artifact.sha256) return { ok: false, error: `asset ${artifact.name} differs from tested bytes; repair required` };
      continue;
    }
    const source = await downloadAndHash(api, `${prefix}/releases/assets/${artifact.assetId}`);
    if (!source.ok) return { ok: false, error: `tested asset ${artifact.assetId} is unavailable: ${source.error}` };
    if (source.sha256 !== artifact.sha256) return { ok: false, error: `tested asset ${artifact.name} changed after QA` };
    const uploaded = await api.upload(manifest.repository, releaseId, artifact.name, source.bytes);
    if (!uploaded.ok) return { ok: false, error: `asset upload is incomplete; retry safely: ${uploaded.reason}` };
    const verified = await downloadAndHash(api, `${prefix}/releases/assets/${uploaded.value.id}`);
    if (!verified.ok || verified.sha256 !== artifact.sha256) return { ok: false, error: `uploaded asset ${artifact.name} failed byte verification; retry safely` };
  }
  const recordName = 'release-qa-record.json';
  const recordBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const recordHash = createHash('sha256').update(recordBytes).digest('hex');
  const priorRecord = existing.get(recordName);
  if (priorRecord) {
    if (typeof priorRecord.id !== 'number') return { ok: false, error: 'publication record has no verifiable id' };
    const stored = await downloadAndHash(api, `${prefix}/releases/assets/${priorRecord.id}`);
    if (!stored.ok || stored.sha256 !== recordHash) return { ok: false, error: 'publication record differs from approved manifest' };
  } else {
    if (release.draft !== true) return { ok: false, error: 'published release is missing its QA record; repair required' };
    const stored = await api.upload(manifest.repository, releaseId, recordName, recordBytes);
    if (!stored.ok) return { ok: false, error: `publication record upload is incomplete; retry safely: ${stored.reason}` };
    const verified = await downloadAndHash(api, `${prefix}/releases/assets/${stored.value.id}`);
    if (!verified.ok || verified.sha256 !== recordHash) return { ok: false, error: 'publication record failed byte verification; retry safely' };
  }
  if (beforePublish && !await beforePublish()) return { ok: false, error: 'live QA or merge identity changed before publication' };
  if (release.draft === true) {
    const published = await api.patch(`${prefix}/releases/${releaseId}`, { draft: false });
    if (!published.ok) return { ok: false, error: `publication state is uncertain; retry safely: ${published.reason}` };
  }
  return { ok: true, releaseId, retried };
}

export interface MergeApi extends Pick<PublishApi, 'get' | 'list' | 'upload' | 'download'> { put(path: string, body: unknown): Promise<ApiResult<unknown>>; }
export type MergeResult = { ok: true; sha: string; reviewedBody: string; notesAssetId: number; alreadyMerged: boolean } | { ok: false; error: string };

/** Requests only GitHub's normal merge endpoint with its expected-head guard, then rereads uncertain outcomes. */
export async function mergeReleasePr(repository: string, pr: number, expectedHead: string, api: MergeApi = new GhTransport(), releaseNotesMarker = 'release-notes'): Promise<MergeResult> {
  if (!repoName.test(repository) || !Number.isSafeInteger(pr) || pr <= 0 || !sha.test(expectedHead)) return { ok: false, error: 'invalid merge identity' };
  const path = `repos/${repository}/pulls/${pr}`;
  const current = await api.get(path);
  const pull = current.ok ? asRecord(current.value) : undefined;
  const head = asRecord(pull?.head);
  if (!current.ok || !pull || head?.sha !== expectedHead) return { ok: false, error: 'PR head could not be verified; no merge attempted' };
  if (pull.merged === true) return { ok: false, error: 'PR is already merged; its reviewed notes must come from the merge event or a saved snapshot' };
  if (pull.state !== 'open') return { ok: false, error: 'PR is not open' };
  if (typeof pull.body !== 'string') return { ok: false, error: 'reviewed PR body is unavailable' };
  const notes = readManagedSection(pull.body, releaseNotesMarker);
  if (!notes.ok || !notes.content.trim()) return { ok: false, error: 'reviewed release notes are missing or ambiguous' };
  const reviewedBody = pull.body;
  const before = await api.get(path);
  const beforePull = asRecord(before.ok ? before.value : undefined);
  if (beforePull?.state !== 'open' || asRecord(beforePull.head)?.sha !== expectedHead || beforePull.body !== reviewedBody) return { ok: false, error: 'PR head or release notes changed before merge' };
  const releases = await api.list(`repos/${repository}/releases?per_page=100`);
  const draft = releases.ok ? releases.value.map(asRecord).find((item) => item?.draft === true && item.name === `QA PR #${pr}`) : undefined;
  if (!Number.isSafeInteger(draft?.id)) return { ok: false, error: 'candidate draft release is unavailable for notes snapshot' };
  const releaseId = draft?.id as number;
  const releaseResult = await api.get(`repos/${repository}/releases/${releaseId}`);
  const release = asRecord(releaseResult.ok ? releaseResult.value : undefined);
  const releaseAssets = Array.isArray(release?.assets) ? release.assets.map(asRecord) : [];
  const candidateAsset = releaseAssets.find((asset) => asset?.name === 'candidate.json');
  if (release?.draft !== true || release.name !== `QA PR #${pr}` || !Number.isSafeInteger(candidateAsset?.id) || (candidateAsset?.id as number) <= 0) return { ok: false, error: 'active candidate release is unavailable for notes snapshot' };
  const selected = await downloadAndHash(api, `repos/${repository}/releases/assets/${candidateAsset?.id}`);
  if (!selected.ok) return { ok: false, error: 'active candidate manifest could not be read before merge' };
  let candidateRecord: unknown;
  try { candidateRecord = JSON.parse(selected.bytes.toString('utf8')) as unknown; }
  catch { return { ok: false, error: 'active candidate manifest is malformed' }; }
  const activeCandidate = parseCandidate(candidateRecord);
  if (!activeCandidate.ok || activeCandidate.value.pullRequest !== pr || activeCandidate.value.sourceSha !== expectedHead ||
      activeCandidate.value.artifacts.some((artifact) => artifact.name === `qa-merge-notes-${expectedHead}.json` || artifact.name === 'release-qa-record.json')) {
    return { ok: false, error: 'active candidate does not match the PR head or uses reserved asset names' };
  }
  const notesName = `qa-merge-notes-${expectedHead}.json`;
  const notesBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, pullRequest: pr, headSha: expectedHead, body: reviewedBody }));
  const notesHash = createHash('sha256').update(notesBytes).digest('hex');
  const prior = releaseAssets.find((asset) => asset?.name === notesName);
  let notesAssetId: number;
  if (prior) {
    if (!Number.isSafeInteger(prior.id)) return { ok: false, error: 'saved notes snapshot has invalid identity' };
    notesAssetId = prior.id as number;
    const downloaded = await downloadAndHash(api, `repos/${repository}/releases/assets/${notesAssetId}`);
    if (!downloaded.ok || downloaded.sha256 !== notesHash) return { ok: false, error: 'saved notes snapshot differs from reviewed PR body' };
  } else {
    const uploaded = await api.upload(repository, releaseId, notesName, notesBytes);
    if (!uploaded.ok || uploaded.value.state !== 'uploaded') return { ok: false, error: 'reviewed notes snapshot could not be uploaded' };
    notesAssetId = uploaded.value.id;
    const downloaded = await downloadAndHash(api, `repos/${repository}/releases/assets/${notesAssetId}`);
    if (!downloaded.ok || downloaded.sha256 !== notesHash) return { ok: false, error: 'reviewed notes snapshot failed verification' };
  }
  const finalBefore = await api.get(path);
  const finalPull = asRecord(finalBefore.ok ? finalBefore.value : undefined);
  if (finalPull?.state !== 'open' || asRecord(finalPull.head)?.sha !== expectedHead || finalPull.body !== reviewedBody) return { ok: false, error: 'PR changed while saving reviewed notes' };
  const merged = await api.put(`${path}/merge`, { sha: expectedHead, merge_method: 'merge' });
  const fresh = await api.get(path);
  const after = fresh.ok ? asRecord(fresh.value) : undefined;
  if (after?.merged === true && asRecord(after.head)?.sha === expectedHead && typeof after.merge_commit_sha === 'string' && sha.test(after.merge_commit_sha)) return { ok: true, sha: after.merge_commit_sha, reviewedBody, notesAssetId, alreadyMerged: false };
  if (!merged.ok) return { ok: false, error: `merge outcome is unconfirmed; reread PR before retry: ${merged.reason}` };
  return { ok: false, error: 'GitHub did not confirm the expected head was merged' };
}

function asRecord(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }

/** Follows lightweight and annotated tag objects to the actual commit, with a bounded chain. */
export async function resolveTagCommit(api: Pick<GateApi, 'get'>, prefix: string, reference: unknown): Promise<string | undefined> {
  let object = asRecord(asRecord(reference)?.object);
  for (let depth = 0; depth < 5; depth++) {
    if (object?.type === 'commit') return typeof object.sha === 'string' && sha.test(object.sha) ? object.sha : undefined;
    if (object?.type !== 'tag' || typeof object.sha !== 'string' || !sha.test(object.sha)) return undefined;
    const tag = await api.get(`${prefix}/git/tags/${object.sha}`);
    if (!tag.ok) return undefined;
    object = asRecord(asRecord(tag.value)?.object);
  }
  return undefined;
}

async function downloadAndHash(api: Pick<PublishApi, 'download'>, path: string): Promise<{ ok: true; bytes: Buffer; sha256: string } | { ok: false; error: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'release-qa-publish-'));
  try {
    const file = join(directory, 'asset');
    const result = await api.download(path, file);
    if (!result.ok) return { ok: false, error: result.reason };
    const bytes = await readFile(file);
    return { ok: true, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch { return { ok: false, error: 'download or hash failed' }; }
  finally { await rm(directory, { recursive: true, force: true }); }
}
