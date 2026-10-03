import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Report } from '../model/result.ts';
import { canonical } from '../model/canonical.ts';
import { eventDigest, type RunEvent } from '../runner/events.ts';
import { appendEvent, readRun } from '../runner/journal.ts';
import { parseReport } from '../model/result.ts';
import { WORKFLOW_NOT_FOUND } from './transport.ts';
import { parseSyncedEvidenceRecord, parseSyncedEventRecord, parseSyncedReportManifest, objectSha256, type SyncedObjectRef } from './reports.ts';

export interface SyncAsset { id: number; name: string; uploader?: { login?: string }; state?: string; createdAt?: string; }
export type SyncApiResult<T> = { ok: true; value: T } | { ok: false; reason: string };
export interface SyncApi {
  get(path: string): Promise<SyncApiResult<unknown>>;
  list(path: string): Promise<SyncApiResult<unknown[]>>;
  download(path: string, destination: string): Promise<SyncApiResult<true>>;
  upload(repository: string, releaseId: number, name: string, content: Buffer): Promise<SyncApiResult<SyncAsset>>;
  currentUser(): Promise<SyncApiResult<string>>;
  dispatchReconciliation(repository: string, releaseId: number): Promise<SyncApiResult<true>>;
}

export interface SyncRunInput {
  repository: string;
  releaseId: number;
  runId: string;
  runDirectory: string;
  report: Report;
  api: SyncApi;
}
/** `notice` is set when the upload is complete but something optional did not happen; it is never a reason to retry. */
export type SyncRunResult = { ok: true; reportId: string; uploaded: number; notice?: string } | { ok: false; error: string };

export interface CandidateProgress {
  candidateId: string;
  reports: Array<{ report: Report; uploader: string; assetId: number; events: RunEvent[] }>;
  incomplete: string[];
  duplicateAttempts: Array<{ attemptId: string; reports: string[] }>;
  claims: ScenarioClaim[];
}

export interface HandoffPlan {
  completedRequirements: string[];
  restartSetupRequirements: string[];
  duplicateAttempts: CandidateProgress['duplicateAttempts'];
}

export interface ScenarioClaim {
  id: string;
  candidateId: string;
  requirement: string;
  machineId: string;
  actor: string;
  action: 'claim' | 'takeover' | 'release';
  recordedAt: string;
  /** GitHub asset creation time; unlike the workstation clock, this orders concurrent and delayed claim uploads. */
  uploadedAt?: string;
  staleAfterMs: number;
}

const apiPath = (repository: string, releaseId: number): string => `repos/${repository}/releases/${releaseId}/assets?per_page=100`;

/** Upload evidence and events independently; the manifest is the final commit marker. Replays reuse immutable names. */
export async function syncRun(input: SyncRunInput): Promise<SyncRunResult> {
  try {
    if (!Number.isSafeInteger(input.releaseId) || input.releaseId <= 0 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)) return { ok: false, error: 'invalid repository or release ID' };
    if (input.report.id !== input.runId) return { ok: false, error: 'report ID must match the run ID' };
    const validatedReport = parseReport(input.report);
    if (!validatedReport.ok) return { ok: false, error: `invalid report: ${validatedReport.error.message}` };
    const identity = await input.api.currentUser();
    if (!identity.ok) return { ok: false, error: `cannot verify upload identity: ${identity.reason}` };
    if (input.report.actor !== identity.value) return { ok: false, error: 'report actor does not match the authenticated uploader' };
    const state = await readRun(resolve(input.runDirectory));
    const events: RunEvent[] = state.events;
    if (!state.exists || state.truncated || state.corrupt.length || state.conflicts.length || state.missingPredecessors.length || state.cyclic.length || state.missingEvidence.length) return { ok: false, error: 'run journal is incomplete or inconsistent' };
    const started = events.find((event) => event.type === 'run-started');
    if (!started || started.type !== 'run-started' || started.data.runId !== input.runId || started.data.candidateId !== input.report.candidateId || started.data.profile !== input.report.profile || started.data.machineId !== input.report.machineId) return { ok: false, error: 'run journal does not match the report' };
    const attemptEvents = events.filter((event): event is Extract<RunEvent, { type: 'attempt-recorded' }> => event.type === 'attempt-recorded');
    const eventAttempts = new Map(attemptEvents.map((event) => [event.data.attempt.id, event.data.attempt]));
    if (eventAttempts.size !== attemptEvents.length || eventAttempts.size !== input.report.attempts.length || input.report.attempts.some((attempt) => canonical(eventAttempts.get(attempt.id)) !== canonical(attempt))) return { ok: false, error: 'report attempts do not match the journal' };
    const assets = await listAssets(input);
    if (!assets.ok) return { ok: false, error: `cannot list release assets: ${assets.reason}` };
    const uploaded: Array<{ name: string; data: Buffer }> = [];
    const evidenceRefs: SyncedObjectRef[] = [];
    for (const path of [...new Set(input.report.attempts.flatMap((attempt) => attempt.evidence))]) {
      const root = await realpath(input.runDirectory);
      const filePath = await realpath(resolve(root, path));
      const rel = relative(root, filePath);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return { ok: false, error: 'evidence path escapes the run directory' };
      const bytes = await readFile(filePath);
      const name = `qa-evidence-${encodeURIComponent(input.runId)}-${objectSha256(path).slice(0, 16)}.json`;
      const record = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'release-qa-evidence', reportId: input.runId, path, sha256: objectSha256(bytes), contentBase64: bytes.toString('base64') }));
      uploaded.push({ name, data: record });
      evidenceRefs.push({ name, path, sha256: objectSha256(record) });
    }
    const eventRefs: SyncedObjectRef[] = [];
    const publishedEvents = events.filter((event) => event.type !== 'upload-acknowledged');
    for (const event of publishedEvents) {
      const name = `qa-event-${objectSha256(input.runId).slice(0, 16)}-${objectSha256(event.id).slice(0, 32)}.json`;
      const data = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'release-qa-event', event }));
      uploaded.push({ name, data });
      eventRefs.push({ name, sha256: objectSha256(data) });
    }
    for (const object of uploaded) {
      const result = await putImmutable(input, assets.value, object.name, object.data);
      if (!result.ok) return result;
    }
    const manifestName = `qa-report-${encodeURIComponent(input.runId)}.json`;
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'release-qa-report', report: input.report, events: eventRefs, evidence: evidenceRefs }));
    const commit = await putImmutable(input, assets.value, manifestName, manifest);
    if (!commit.ok) return commit;
    const verified = await loadCandidateProgress(input.repository, input.releaseId, input.report.candidateId, input.api);
    if (!verified.ok || !verified.value.reports.some((entry) => entry.report.id === input.report.id && entry.uploader === identity.value)) {
      return { ok: false, error: 'upload is stored but not yet verified as shared; local events remain pending for replay' };
    }
    const afterUpload = await readRun(resolve(input.runDirectory));
    let previous = afterUpload.events.at(-1)?.id;
    const pending = new Set(afterUpload.pending);
    for (const event of publishedEvents) {
      if (!pending.has(event.id)) continue;
      const ack: RunEvent = {
        schemaVersion: 1,
        id: `upload-ack-${objectSha256(event.id).slice(0, 32)}`,
        ...(previous === undefined ? {} : { prev: previous }),
        recordedAt: new Date().toISOString(),
        type: 'upload-acknowledged',
        data: { eventId: event.id, digest: eventDigest(event) },
      };
      const appended = await appendEvent(input.runDirectory, ack);
      if (!appended.ok) return { ok: false, error: `upload is shared but local acknowledgement could not be saved: ${appended.error.message}` };
      previous = ack.id;
    }
    const dispatched = await input.api.dispatchReconciliation(input.repository, input.releaseId);
    // Reconciliation only writes a step summary (reconcile-cli.ts); the merge gate reads the uploaded report itself, and the
    // commit status is refreshed by the gate workflow on pull request events, not by this. A 404 to the dispatch itself
    // (the workflow is missing, or the token cannot see it) will not change on retry, so the verified upload is reported as
    // done with a note. Any other failure, including a failed repository lookup, may be temporary and is still retried.
    if (!dispatched.ok && dispatched.reason === WORKFLOW_NOT_FOUND) {
      return { ok: true, reportId: input.report.id, uploaded: uploaded.length + 1, notice: `qa-reconcile.yml was not found or is not accessible in ${input.repository}, so no reconciliation summary was requested. The upload itself is complete and verified. This does not refresh the pull request's release-qa status; that is updated by the repository's gate workflow when the pull request is next evaluated` };
    }
    if (!dispatched.ok) return { ok: false, error: `upload completed; reconciliation dispatch failed and should be retried: ${dispatched.reason}` };
    return { ok: true, reportId: input.report.id, uploaded: uploaded.length + 1 };
  } catch {
    return { ok: false, error: 'run could not be synced; local journal and evidence were preserved for replay' };
  }
}

/** Reconstructs progress from all committed manifests. Incomplete uploads remain diagnostic-only. */
export async function loadCandidateProgress(repository: string, releaseId: number, candidateId: string, api: SyncApi, releaseAssets?: unknown[]): Promise<SyncApiResult<CandidateProgress>> {
  const assetsResult = releaseAssets === undefined
    ? await api.list(apiPath(repository, releaseId))
    : { ok: true as const, value: releaseAssets };
  if (!assetsResult.ok) return assetsResult;
  const assets = assetsResult.value.map(asAsset).filter((asset): asset is SyncAsset => asset !== undefined);
  const byName = new Map(assets.map((asset) => [asset.name, asset]));
  const reports: CandidateProgress['reports'] = [];
  const incomplete: string[] = [];
  for (const asset of assets.filter((item) => item.name.startsWith('qa-report-') && item.state === 'uploaded')) {
    const loaded = await readAsset(repository, asset, api);
    if (!loaded.ok) { incomplete.push(asset.name); continue; }
    let json: unknown;
    try { json = JSON.parse(loaded.value.toString('utf8')) as unknown; } catch { incomplete.push(asset.name); continue; }
    const parsed = parseSyncedReportManifest(json);
    if (!parsed.ok || parsed.value.report.candidateId !== candidateId) continue;
    if (!asset.uploader?.login) { incomplete.push(asset.name); continue; }
    const events: RunEvent[] = [];
    let complete = true;
    for (const ref of parsed.value.events) {
      const eventAsset = byName.get(ref.name);
      if (!eventAsset || eventAsset.state !== 'uploaded' || eventAsset.uploader?.login !== asset.uploader.login) { complete = false; break; }
      const bytes = await readAsset(repository, eventAsset, api);
      if (!bytes.ok || objectSha256(bytes.value) !== ref.sha256) { complete = false; break; }
      let json: unknown;
      try { json = JSON.parse(bytes.value.toString('utf8')) as unknown; } catch { complete = false; break; }
      const record = parseSyncedEventRecord(json);
      if (!record.ok) { complete = false; break; }
      events.push(record.value.event);
    }
    for (const ref of parsed.value.evidence) {
      const evidenceAsset = byName.get(ref.name);
      if (!evidenceAsset || evidenceAsset.state !== 'uploaded' || evidenceAsset.uploader?.login !== asset.uploader.login) { complete = false; break; }
      const bytes = await readAsset(repository, evidenceAsset, api);
      if (!bytes.ok || objectSha256(bytes.value) !== ref.sha256) { complete = false; break; }
      let json: unknown;
      try { json = JSON.parse(bytes.value.toString('utf8')) as unknown; } catch { complete = false; break; }
      const evidence = parseSyncedEvidenceRecord(json);
      if (!evidence.ok || evidence.value.reportId !== parsed.value.report.id || evidence.value.path !== ref.path) { complete = false; break; }
    }
    const starts = events.filter((event) => event.type === 'run-started');
    const recordedAttempts = new Map(events.flatMap((event) => event.type === 'attempt-recorded' ? [[event.data.attempt.id, event.data.attempt] as const] : []));
    if (!complete || !eventsFormOneRun(events) || starts.length !== 1 || starts[0]?.type !== 'run-started' || starts[0].data.candidateId !== candidateId ||
        starts[0].data.runId !== parsed.value.report.id || starts[0].data.profile !== parsed.value.report.profile ||
        starts[0].data.machineId !== parsed.value.report.machineId || recordedAttempts.size !== parsed.value.report.attempts.length ||
        parsed.value.report.attempts.some((attempt) => canonical(recordedAttempts.get(attempt.id)) !== canonical(attempt))) { incomplete.push(asset.name); continue; }
    const permission = await api.get(`repos/${repository}/collaborators/${encodeURIComponent(asset.uploader.login)}/permission`);
    if (!permission.ok) { incomplete.push(asset.name); continue; }
    const role = (permission.value as { permission?: unknown })?.permission;
    if (!['write', 'maintain', 'admin'].includes(String(role))) continue;
    if (parsed.value.report.actor !== asset.uploader.login) continue;
    reports.push({ report: parsed.value.report, uploader: asset.uploader.login, assetId: asset.id, events });
  }
  const claims: ScenarioClaim[] = [];
  for (const asset of assets.filter((item) => item.name.startsWith('qa-claim-') && item.state === 'uploaded')) {
    const bytes = await readAsset(repository, asset, api);
    if (!bytes.ok || !asset.uploader?.login) continue;
    try {
      const claim = JSON.parse(bytes.value.toString('utf8')) as ScenarioClaim;
      if (claim.candidateId !== candidateId || claim.actor !== asset.uploader.login || !isScenarioClaim(claim)) continue;
      const permission = await api.get(`repos/${repository}/collaborators/${encodeURIComponent(asset.uploader.login)}/permission`);
      const role = permission.ok ? (permission.value as { permission?: unknown })?.permission : undefined;
      if (['write', 'maintain', 'admin'].includes(String(role))) claims.push({ ...claim, ...(asset.createdAt ? { uploadedAt: asset.createdAt } : {}) });
    } catch { /* malformed claim records are ignored */ }
  }
  return { ok: true, value: { candidateId, reports, incomplete, duplicateAttempts: duplicateAttempts(reports), claims } };
}

/** Claims are history only; taking over never locks a machine or suppresses a competing result. */
export async function recordScenarioClaim(repository: string, releaseId: number, claim: ScenarioClaim, api: SyncApi): Promise<SyncApiResult<true>> {
  const identity = await api.currentUser();
  if (!identity.ok || !isScenarioClaim(claim) || claim.actor !== identity.value) return { ok: false, reason: 'claim identity or shape is invalid' };
  const name = `qa-claim-${encodeURIComponent(claim.id)}.json`;
  const listed = await api.list(apiPath(repository, releaseId));
  if (!listed.ok) return listed;
  const existing = listed.value.map(asAsset).find((asset) => asset?.name === name);
  const bytes = Buffer.from(JSON.stringify(claim));
  if (existing) {
    const prior = await readAsset(repository, existing, api);
    return prior.ok && prior.value.equals(bytes) ? api.dispatchReconciliation(repository, releaseId) : { ok: false, reason: 'claim ID already exists with different content' };
  }
  const uploaded = await api.upload(repository, releaseId, name, bytes);
  if (!uploaded.ok) return uploaded;
  return api.dispatchReconciliation(repository, releaseId);
}

/** Coordinator entry point: rebuilds every candidate from a fresh full release-asset listing. */
export async function reconcileRelease(repository: string, releaseId: number, api: SyncApi): Promise<SyncApiResult<CandidateProgress[]>> {
  const listed = await api.list(apiPath(repository, releaseId));
  if (!listed.ok) return listed;
  const ids = new Set<string>();
  for (const raw of listed.value) {
    const asset = asAsset(raw);
    if (!asset?.name.startsWith('qa-report-')) continue;
    const bytes = await readAsset(repository, asset, api);
    if (!bytes.ok) continue;
    try {
      const parsed = parseSyncedReportManifest(JSON.parse(bytes.value.toString('utf8')) as unknown);
      if (parsed.ok) ids.add(parsed.value.report.candidateId);
    } catch { /* incomplete manifests never contribute */ }
  }
  const progress: CandidateProgress[] = [];
  for (const candidateId of [...ids].sort()) {
    const result = await loadCandidateProgress(repository, releaseId, candidateId, api);
    if (!result.ok) return result;
    progress.push(result.value);
  }
  return { ok: true, value: progress };
}

/** Claims are advisory history; callers must always display overlapping attempts and allow takeover. */
export function claimStatus(claims: readonly ScenarioClaim[], candidateId: string, requirement: string, now = Date.now()): { owner?: ScenarioClaim; stale: boolean; history: ScenarioClaim[] } {
  const history = claims.filter((claim) => claim.candidateId === candidateId && claim.requirement === requirement).sort((a, b) => (a.uploadedAt ?? a.recordedAt).localeCompare(b.uploadedAt ?? b.recordedAt));
  const latest = history.at(-1);
  const owner = latest?.action === 'release' ? undefined : latest;
  return { ...(owner === undefined ? {} : { owner }), stale: owner !== undefined && now - Date.parse(owner.recordedAt) > owner.staleAfterMs, history };
}

/** Completed independent work is retained; a started stateful scenario without a result restarts from setup. */
export function handoffPlan(progress: CandidateProgress): HandoffPlan {
  const completed = new Set<string>();
  const started = new Set<string>();
  for (const { report, events } of progress.reports) {
    for (const attempt of report.attempts) if (attempt.outcome === 'passed') completed.add(attempt.requirement);
    for (const event of events) if (event.type === 'checkpoint' && event.data.name === 'scenario-started' && event.data.requirement) started.add(event.data.requirement);
  }
  return {
    completedRequirements: [...completed].sort(),
    restartSetupRequirements: [...started].filter((key) => !completed.has(key)).sort(),
    duplicateAttempts: progress.duplicateAttempts,
  };
}

function isScenarioClaim(value: ScenarioClaim): boolean {
  return typeof value.id === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(value.id) && typeof value.candidateId === 'string' &&
    typeof value.requirement === 'string' && /^[a-z0-9_-]+\/[a-z0-9_-]+$/.test(value.requirement) && typeof value.machineId === 'string' &&
    typeof value.actor === 'string' && ['claim', 'takeover', 'release'].includes(value.action) &&
    !Number.isNaN(Date.parse(value.recordedAt)) && Number.isSafeInteger(value.staleAfterMs) && value.staleAfterMs > 0;
}

function eventsFormOneRun(events: readonly RunEvent[]): boolean {
  const byId = new Map<string, RunEvent>();
  const childrenByParent = new Map<string, number>();
  for (const event of events) {
    if (byId.has(event.id)) return false;
    byId.set(event.id, event);
    if (event.prev !== undefined) childrenByParent.set(event.prev, (childrenByParent.get(event.prev) ?? 0) + 1);
  }
  if ([...childrenByParent.values()].some((count) => count > 1)) return false;
  const roots = events.filter((event) => event.prev === undefined);
  if (roots.length !== 1 || roots[0]?.type !== 'run-started') return false;
  const reachable = new Set<string>([roots[0].id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const event of events) if (event.prev !== undefined && reachable.has(event.prev) && !reachable.has(event.id)) { reachable.add(event.id); grew = true; }
  }
  return reachable.size === events.length && events.every((event) => event.prev === undefined || byId.has(event.prev));
}

function duplicateAttempts(reports: CandidateProgress['reports']): CandidateProgress['duplicateAttempts'] {
  const ids = new Map<string, Set<string>>();
  for (const { report } of reports) for (const attempt of report.attempts) {
    const grouped = ids.get(attempt.id) ?? new Set<string>(); grouped.add(report.id); ids.set(attempt.id, grouped);
  }
  return [...ids].filter(([, reportIds]) => reportIds.size > 1).map(([attemptId, reportIds]) => ({ attemptId, reports: [...reportIds].sort() }));
}

async function listAssets(input: SyncRunInput): Promise<SyncApiResult<SyncAsset[]>> {
  const response = await input.api.list(apiPath(input.repository, input.releaseId));
  if (!response.ok) return response;
  return { ok: true, value: response.value.map(asAsset).filter((asset): asset is SyncAsset => asset !== undefined) };
}

async function putImmutable(input: SyncRunInput, assets: SyncAsset[], name: string, data: Buffer): Promise<SyncRunResult> {
  const existing = assets.find((asset) => asset.name === name);
  if (existing) {
    const current = await readAsset(input.repository, existing, input.api);
    return current.ok && current.value.equals(data) ? { ok: true, reportId: input.report.id, uploaded: 0 } : { ok: false, error: `immutable upload name already exists with different content: ${name}` };
  }
  const uploaded = await input.api.upload(input.repository, input.releaseId, name, data);
  if (!uploaded.ok) return { ok: false, error: `upload ${basename(name)} failed: ${uploaded.reason}` };
  assets.push(uploaded.value);
  return { ok: true, reportId: input.report.id, uploaded: 1 };
}

async function readAsset(repository: string, asset: SyncAsset, api: SyncApi): Promise<SyncApiResult<Buffer>> {
  const path = `repos/${repository}/releases/assets/${asset.id}`;
  const directory = await mkdtemp(join(tmpdir(), 'release-qa-asset-'));
  const destination = join(directory, 'asset.json');
  try {
    const result = await api.download(path, destination);
    if (!result.ok) return result;
    if ((await stat(destination)).size > 50 * 1024 * 1024) return { ok: false, reason: 'network-error' };
    return { ok: true, value: await readFile(destination) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function asAsset(value: unknown): SyncAsset | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const asset = value as Record<string, unknown>;
  if (!Number.isSafeInteger(asset.id) || typeof asset.name !== 'string') return undefined;
  const uploader = asset.uploader !== null && typeof asset.uploader === 'object' ? (asset.uploader as { login?: unknown }) : undefined;
  return { id: asset.id as number, name: asset.name, ...(typeof asset.state === 'string' ? { state: asset.state } : {}), ...(typeof asset.created_at === 'string' ? { createdAt: asset.created_at } : {}), ...(typeof uploader?.login === 'string' ? { uploader: { login: uploader.login } } : {}) };
}
