import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequirementKey } from '../../src/model/requirement.ts';
import type { Report } from '../../src/model/result.ts';
import type { RunEvent } from '../../src/runner/events.ts';
import { objectSha256, parseSyncedReportManifest } from '../../src/github/reports.ts';
import { claimStatus, handoffPlan, loadCandidateProgress, reconcileRelease, syncRun, type CandidateProgress, type SyncApi, type SyncAsset } from '../../src/github/sync.ts';
import { report as makeReport } from '../fixtures/records.ts';
import { readRun } from '../../src/runner/journal.ts';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

class MemoryApi implements SyncApi {
  assets: Array<SyncAsset & { bytes: Buffer }> = [];
  actor = 'tester-a';
  failAtUpload: number | undefined;
  uploadCount = 0;
  role = 'write';
  async get(path: string) { return path.includes('/permission') ? { ok: true as const, value: { permission: this.role } } : { ok: false as const, reason: 'not-found' }; }
  async list() { return { ok: true as const, value: this.assets.map(({ bytes: _bytes, ...asset }) => asset) }; }
  async download(path: string, destination: string) {
    const id = Number(path.split('/').at(-1));
    const asset = this.assets.find((item) => item.id === id);
    if (!asset) return { ok: false as const, reason: 'not-found' };
    await writeFile(destination, asset.bytes);
    return { ok: true as const, value: true as const };
  }
  async upload(_repository: string, _releaseId: number, name: string, content: Buffer) {
    this.uploadCount++;
    if (this.failAtUpload === this.uploadCount) return { ok: false as const, reason: 'HTTP 429' };
    const asset = { id: this.assets.length + 1, name, uploader: { login: this.actor }, state: 'uploaded', bytes: content };
    this.assets.push(asset);
    return { ok: true as const, value: asset };
  }
  async currentUser() { return { ok: true as const, value: this.actor }; }
  async dispatchReconciliation() { return { ok: true as const, value: true as const }; }
}

async function createRun(api: MemoryApi, runId: string, actor: string, attemptId: string, requirement: RequirementKey, authenticatedAs = actor, evidence: string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), 'qa-sync-')); dirs.push(directory);
  await mkdir(join(directory, 'evidence'));
  for (const path of evidence) await writeFile(join(directory, path), `evidence:${path}`);
  const events: RunEvent[] = [
    { schemaVersion: 1, id: `${runId}-start`, recordedAt: '2026-09-28T10:00:00Z', type: 'run-started', data: { runId, candidateId: 'cand-0001', profile: requirement.split('/')[0]!, machineId: `machine-${actor}` } },
    { schemaVersion: 1, id: `${runId}-attempt`, prev: `${runId}-start`, recordedAt: '2026-09-28T10:10:00Z', type: 'attempt-recorded', data: { attempt: { id: attemptId, requirement, outcome: 'passed', evidence } } },
  ];
  await writeFile(join(directory, 'events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  const report: Report = { schemaVersion: 1, id: runId, candidateId: 'cand-0001', policyDigest: 'a'.repeat(64), testRevision: '4'.repeat(40), profile: requirement.split('/')[0]!, actor, machineId: `machine-${actor}`, environment: { os: requirement.split('/')[0]!, osVersion: '1', arch: 'x86_64', capabilities: [], toolVersion: '1' }, attempts: [{ id: attemptId, requirement, outcome: 'passed', evidence }] };
  api.actor = authenticatedAs;
  return syncRun({ repository: 'team/app', releaseId: 7, runId, runDirectory: directory, report, api });
}

describe('GitHub report synchronization', () => {
  test('two machines contribute independent requirements and duplicate attempts remain visible', async () => {
    const api = new MemoryApi();
    expect((await createRun(api, 'run-a', 'tester-a', 'attempt-shared', 'windows/persistence')).ok).toBe(true);
    expect((await readRun(dirs.at(-1)!)).pending).toEqual([]);
    expect((await createRun(api, 'run-b', 'tester-b', 'attempt-shared', 'linux/persistence')).ok).toBe(true);
    const progress = await loadCandidateProgress('team/app', 7, 'cand-0001', api);
    expect(progress.ok).toBe(true);
    if (progress.ok) {
      expect(progress.value.reports.map((item) => item.uploader)).toEqual(['tester-a', 'tester-b']);
      expect(progress.value.duplicateAttempts).toEqual([{ attemptId: 'attempt-shared', reports: ['run-a', 'run-b'] }]);
    }
    const rebuilt = await reconcileRelease('team/app', 7, api);
    expect(rebuilt.ok && rebuilt.value[0]?.reports).toHaveLength(2);
  });

  test('429 leaves no committed report; replay after recovery is idempotent', async () => {
    const api = new MemoryApi();
    api.failAtUpload = 2;
    const first = await createRun(api, 'run-replay', 'tester-a', 'attempt-replay', 'windows/persistence');
    expect(first.ok).toBe(false);
    expect(api.assets.some((asset) => asset.name.startsWith('qa-report-'))).toBe(false);
    expect(api.assets.length).toBe(1);
    const second = await createRun(api, 'run-replay', 'tester-a', 'attempt-replay', 'windows/persistence');
    expect(second.ok).toBe(true);
    expect((await readRun(dirs.at(-1)!)).pending).toEqual([]);
    const third = await createRun(api, 'run-replay', 'tester-a', 'attempt-replay', 'windows/persistence');
    expect(third.ok).toBe(true);
    expect(api.assets.filter((asset) => asset.name.startsWith('qa-report-'))).toHaveLength(1);
  });

  test('report actor cannot differ from authenticated uploader; an untrusted role does not count', async () => {
    const api = new MemoryApi();
    const result = await createRun(api, 'run-actor', 'forged', 'attempt-actor', 'windows/persistence', 'trusted-uploader');
    expect(result.ok).toBe(false);
    expect(api.assets).toHaveLength(0);
  });

  test('partial objects without a manifest are invisible and a malformed evidence digest is rejected', async () => {
    const api = new MemoryApi();
    api.assets.push({ id: 1, name: 'qa-event-run-start.json', uploader: { login: 'tester-a' }, state: 'uploaded', bytes: Buffer.from('{}') });
    const progress = await loadCandidateProgress('team/app', 7, 'cand-0001', api);
    expect(progress.ok && progress.value.reports).toEqual([]);
    const invalid = parseSyncedReportManifest({ schemaVersion: 1, kind: 'release-qa-report', report: {}, events: [], evidence: [{ name: 'evidence/a', sha256: objectSha256('wrong') }] });
    expect(invalid.ok).toBe(false);
  });

  test('evidence is verified before a report can contribute to progress', async () => {
    const api = new MemoryApi();
    expect((await createRun(api, 'run-evidence', 'tester-a', 'attempt-evidence', 'windows/persistence', 'tester-a', ['evidence/proof.png'])).ok).toBe(true);
    const evidence = api.assets.find((asset) => asset.name.startsWith('qa-evidence-'))!;
    evidence.bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'release-qa-evidence', reportId: 'run-evidence', path: 'evidence/proof.png', sha256: '0'.repeat(64), contentBase64: '' }));
    const progress = await loadCandidateProgress('team/app', 7, 'cand-0001', api);
    expect(progress.ok && progress.value.reports).toHaveLength(0);
    expect(progress.ok && progress.value.incomplete).toContain('qa-report-run-evidence.json');
  });

  test('read-only uploaders cannot contribute and claims persist with verified actor identity', async () => {
    const api = new MemoryApi();
    await createRun(api, 'run-readonly', 'tester-a', 'attempt-readonly', 'windows/persistence');
    api.role = 'read';
    const excluded = await loadCandidateProgress('team/app', 7, 'cand-0001', api);
    expect(excluded.ok && excluded.value.reports).toHaveLength(0);
    api.role = 'write';
    const claim = { id: 'claim-persist', candidateId: 'cand-0001', requirement: 'windows/persistence', machineId: 'lab-2', actor: 'tester-b', action: 'takeover' as const, recordedAt: '2026-09-28T12:00:00Z', staleAfterMs: 60_000 };
    api.actor = 'tester-b';
    const { recordScenarioClaim } = await import('../../src/github/sync.ts');
    expect((await recordScenarioClaim('team/app', 7, claim, api)).ok).toBe(true);
    const progress = await loadCandidateProgress('team/app', 7, 'cand-0001', api);
    expect(progress.ok && progress.value.claims).toEqual([claim]);
  });

  test('takeover status stays advisory and records stale ownership history', () => {
    const claims = [{ id: 'claim-a', candidateId: 'cand-0001', requirement: 'windows/persistence', machineId: 'old', actor: 'tester-a', action: 'claim' as const, recordedAt: '2026-09-28T10:00:00Z', staleAfterMs: 1000 }, { id: 'claim-b', candidateId: 'cand-0001', requirement: 'windows/persistence', machineId: 'new', actor: 'tester-b', action: 'takeover' as const, recordedAt: '2026-09-28T10:01:00Z', staleAfterMs: 1000 }];
    const status = claimStatus(claims, 'cand-0001', 'windows/persistence', Date.parse('2026-09-28T10:02:00Z'));
    expect(status.owner?.machineId).toBe('new');
    expect(status.stale).toBe(true);
    expect(status.history).toHaveLength(2);
  });

  test('handoff keeps completed independent requirements and restarts unfinished stateful setup', () => {
    const progress: CandidateProgress = { candidateId: 'cand-0001', incomplete: [], duplicateAttempts: [], claims: [], reports: [
      { report: makeReport({ id: 'done', attempts: [{ id: 'a', requirement: 'linux/persistence', outcome: 'passed', evidence: [] }] }), uploader: 'a', assetId: 1, events: [] },
      { report: makeReport({ id: 'working', attempts: [] }), uploader: 'b', assetId: 2, events: [{ schemaVersion: 1, id: 'started', recordedAt: '2026-09-28T10:00:00Z', type: 'checkpoint', data: { name: 'scenario-started', requirement: 'windows/persistence' } }] },
    ] };
    expect(handoffPlan(progress).completedRequirements).toEqual(['linux/persistence']);
    expect(handoffPlan(progress).restartSetupRequirements).toEqual(['windows/persistence']);
  });
});
