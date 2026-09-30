import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listManualRuns, MAX_NOTES_LENGTH, readManualRun, recordManualCheck, syncManualRun, type ManualCheckInput } from '../../src/cli/manual.ts';
import { loadCandidateProgress, type SyncApi, type SyncAsset } from '../../src/github/sync.ts';
import { evaluate } from '../../src/model/evaluate.ts';
import type { EnvironmentProfile } from '../../src/model/project.ts';
import { parseReport } from '../../src/model/result.ts';
import type { EnvironmentProbes } from '../../src/runner/environment.ts';
import { readRun } from '../../src/runner/journal.ts';
import { artifact, candidate, requirement } from '../fixtures/records.ts';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const temp = async (): Promise<string> => { const dir = await mkdtemp(join(tmpdir(), 'qa-manual-')); dirs.push(dir); return dir; };

// The recording refuses a machine that is not the profile's kind, so the profile is the one of the machine running the test.
const OS = process.platform === 'win32' ? 'windows' : 'linux';
const profile = { id: OS, os: OS, arch: 'x86_64' } as EnvironmentProfile;
const probes: EnvironmentProbes = { display: async () => true, audio: async () => false, describeDisplay: async () => ({ kind: 'real', detail: 'test' }) };
const manual = requirement({ key: `${OS}/device-feel`, mode: 'manual', title: 'Sliders feel right', capabilities: ['hardware'] });
const theCandidate = candidate({ artifacts: [artifact({ profile: OS })] });
const runnable = process.arch === 'x64' ? describe : describe.skip;

class MemoryApi implements SyncApi {
  assets: Array<SyncAsset & { bytes: Buffer }> = [];
  actor = 'tester-a';
  failAtUpload: number | undefined;
  uploadCount = 0;
  async get(path: string) { return path.includes('/permission') ? { ok: true as const, value: { permission: 'write' } } : { ok: false as const, reason: 'not-found' as const }; }
  async list() { return { ok: true as const, value: this.assets.map(({ bytes: _bytes, ...asset }) => asset) }; }
  async download(path: string, destination: string) {
    const asset = this.assets.find((item) => item.id === Number(path.split('/').at(-1)));
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
  failDispatch = false;
  async dispatchReconciliation() { return this.failDispatch ? { ok: false as const, reason: 'HTTP 403' } : { ok: true as const, value: true as const }; }
}

async function setup(overrides: Partial<ManualCheckInput> = {}, api = new MemoryApi()) {
  const stateDir = await temp();
  const source = await temp();
  await writeFile(join(source, 'slider.png'), 'pixels');
  const input: ManualCheckInput = {
    stateDir, repository: 'team/app', pullRequest: 7, releaseId: 50, candidate: theCandidate, profile, requirement: manual,
    outcome: 'passed', notes: 'Dragged every slider with the device; each followed.', evidence: [join(source, 'slider.png')], api, probes, ...overrides,
  };
  return { input, api, stateDir, source };
}

runnable('recording a manual check', () => {
  test('writes a journal, evidence inside the run, and a report the evaluator counts like an automated one', async () => {
    const { input, stateDir } = await setup();
    const result = await recordManualCheck(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const state = await readRun(result.runDirectory);
    expect(state.events.map((event) => event.type)).toEqual(['run-started', 'attempt-recorded']);
    expect(state.missingEvidence).toEqual([]);
    expect(state.attempts).toEqual(result.report.attempts);
    const [attempt] = result.report.attempts;
    expect(attempt?.evidence[0]).toMatch(/\/notes\.md$/);
    expect(attempt?.evidence).toHaveLength(2);
    expect(await readFile(join(result.runDirectory, attempt!.evidence[0]!), 'utf8')).toBe('Dragged every slider with the device; each followed.\n');
    expect(await readFile(join(result.runDirectory, attempt!.evidence[1]!), 'utf8')).toBe('pixels');
    expect(parseReport(result.report, { candidate: theCandidate }).ok).toBe(true);
    expect(await readdir(stateDir)).toContain(result.runId);

    const decision = evaluate({
      candidate: theCandidate, currentHeadSha: theCandidate.sourceSha, currentBaseSha: theCandidate.baseSha, required: [manual], profiles: [profile],
      reports: [{ report: result.report, provenance: { uploader: result.report.actor, uploadedAt: '', assetId: 1 } }], exceptions: [], retryResolutions: [],
    });
    expect(decision.readiness).toBe('passed');
    expect(decision.acceptedReportIds).toEqual([result.runId]);
  });

  test('a failed or blocked result is counted by the evaluator as what it is', async () => {
    for (const [outcome, code] of [['failed', 'unresolved-failure'], ['blocked', 'not-passed']] as const) {
      const { input } = await setup({ outcome });
      const result = await recordManualCheck(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const decision = evaluate({
        candidate: theCandidate, currentHeadSha: theCandidate.sourceSha, currentBaseSha: theCandidate.baseSha, required: [manual], profiles: [profile],
        reports: [{ report: result.report, provenance: { uploader: result.report.actor, uploadedAt: '', assetId: 1 } }], exceptions: [], retryResolutions: [],
      });
      expect(decision.readiness).toBe('blocked');
      expect(decision.reasons[0]?.code).toBe(code);
    }
  });

  test('notes are required, and nothing is left behind when they are missing', async () => {
    for (const notes of ['', '   \n  ', 'x'.repeat(MAX_NOTES_LENGTH + 1), 'bad\u0007bell']) {
      const { input, stateDir } = await setup({ notes });
      const result = await recordManualCheck(input);
      expect(result.ok).toBe(false);
      expect(await readdir(stateDir)).toEqual([]);
    }
    const { input } = await setup({ notes: '' });
    expect(await recordManualCheck(input)).toEqual({ ok: false, error: expect.stringContaining('Notes are required') });
  });

  test('at least one readable evidence file is required', async () => {
    const none = await setup({ evidence: [] });
    expect(await recordManualCheck(none.input)).toEqual({ ok: false, error: expect.stringContaining('at least one evidence file') });
    const missing = await setup();
    expect((await recordManualCheck({ ...missing.input, evidence: [join(missing.source, 'gone.png')] })).ok).toBe(false);
    await writeFile(join(missing.source, 'empty.png'), '');
    expect((await recordManualCheck({ ...missing.input, evidence: [join(missing.source, 'empty.png')] })).ok).toBe(false);
    expect(await readdir(missing.stateDir)).toEqual([]);
  });

  test('the reporter is the signed-in GitHub user; there is no way to name one', async () => {
    const api = new MemoryApi();
    api.actor = 'someone-else';
    const { input } = await setup({}, api);
    expect('actor' in input).toBe(false);
    const result = await recordManualCheck(input);
    expect(result.ok && result.report.actor).toBe('someone-else');
    const signedOut = await setup({ api: { currentUser: async () => ({ ok: false, reason: 'logged-out' }) } });
    expect(await recordManualCheck(signedOut.input)).toEqual({ ok: false, error: expect.stringContaining('gh auth login') });
    expect(await readdir(signedOut.stateDir)).toEqual([]);
  });

  test('refuses an automated requirement, another profile, a candidate without the profile, and a machine of the wrong kind', async () => {
    const cases: Array<[Partial<ManualCheckInput>, string]> = [
      [{ requirement: { ...manual, mode: 'automated' } }, 'not a manual check'],
      [{ requirement: { ...manual, key: 'other/device-feel' } }, 'profile'],
      [{ candidate: candidate({ artifacts: [artifact({ profile: 'elsewhere' })] }) }, 'no windows build'.replace('windows', OS)],
      [{ profile: { ...profile, os: OS === 'windows' ? 'linux' : 'windows' } }, 'cannot record'],
    ];
    for (const [overrides, text] of cases) {
      const { input } = await setup(overrides);
      const result = await recordManualCheck(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(text);
    }
  });

  test('evidence names are made safe and cannot leave the run', async () => {
    const { input, source } = await setup();
    await writeFile(join(source, 'we ird (1) [x].png'), 'a');
    await writeFile(join(source, 'con'), 'b');
    const result = await recordManualCheck({ ...input, evidence: [join(source, 'we ird (1) [x].png'), join(source, 'con')] });
    expect(result.ok).toBe(true);
    if (result.ok) for (const path of result.report.attempts[0]!.evidence) expect(path).toMatch(/^evidence\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
  });
});

runnable('syncing a recorded manual check', () => {
  test('is unsynced until uploaded, then counted from the release like any report', async () => {
    const { input, stateDir, api } = await setup();
    const recorded = await recordManualCheck(input);
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect((await readManualRun(stateDir, recorded.runId))?.synced).toBe(false);
    expect((await listManualRuns(stateDir)).map((run) => [run.runId, run.synced])).toEqual([[recorded.runId, false]]);

    expect((await syncManualRun(stateDir, recorded.runId, api)).ok).toBe(true);
    expect((await readManualRun(stateDir, recorded.runId))?.synced).toBe(true);
    const progress = await loadCandidateProgress('team/app', 50, theCandidate.id, api);
    expect(progress.ok && progress.value.reports.map((item) => [item.report.id, item.uploader])).toEqual([[recorded.runId, 'tester-a']]);
    if (!progress.ok) return;
    const decision = evaluate({
      candidate: theCandidate, currentHeadSha: theCandidate.sourceSha, currentBaseSha: theCandidate.baseSha, required: [manual], profiles: [profile],
      reports: progress.value.reports.map(({ report, uploader, assetId }) => ({ report, provenance: { uploader, uploadedAt: '', assetId } })), exceptions: [], retryResolutions: [],
    });
    expect(decision.readiness).toBe('passed');
  });

  test('a failed upload keeps the local result unsynced, and a retry finishes it', async () => {
    const { input, stateDir, api } = await setup();
    api.failAtUpload = 2;
    const recorded = await recordManualCheck(input);
    if (!recorded.ok) throw new Error(recorded.error);
    const failed = await syncManualRun(stateDir, recorded.runId, api);
    expect(failed.ok).toBe(false);
    const kept = await readManualRun(stateDir, recorded.runId);
    expect(kept).toMatchObject({ synced: false, outcome: 'passed' });
    expect((await readRun(recorded.runDirectory)).missingEvidence).toEqual([]);
    expect((await syncManualRun(stateDir, recorded.runId, api)).ok).toBe(true);
    expect((await readManualRun(stateDir, recorded.runId))?.synced).toBe(true);
  });

  test('a failed reconciliation dispatch is not synced, and a retry that gets through is', async () => {
    const { input, stateDir, api } = await setup();
    const recorded = await recordManualCheck(input);
    if (!recorded.ok) throw new Error(recorded.error);
    api.failDispatch = true;
    const failed = await syncManualRun(stateDir, recorded.runId, api);
    expect(failed).toEqual({ ok: false, error: expect.stringContaining('reconciliation dispatch failed') });
    // The uploads were acknowledged locally, but the result must not claim a sync that did not finish.
    expect((await readRun(recorded.runDirectory)).pending).toEqual([]);
    expect((await readManualRun(stateDir, recorded.runId))?.synced).toBe(false);
    api.failDispatch = false;
    expect((await syncManualRun(stateDir, recorded.runId, api)).ok).toBe(true);
    expect((await readManualRun(stateDir, recorded.runId))?.synced).toBe(true);
  });

  test('two uploads of one result at once are not both run', async () => {
    const { input, stateDir, api } = await setup();
    const recorded = await recordManualCheck(input);
    if (!recorded.ok) throw new Error(recorded.error);
    const [first, second] = await Promise.all([syncManualRun(stateDir, recorded.runId, api), syncManualRun(stateDir, recorded.runId, api)]);
    expect([first.ok, second.ok].sort()).toEqual([false, true]);
    expect((await readManualRun(stateDir, recorded.runId))?.synced).toBe(true);
  });

  test('a result whose meta names another requirement or a bad release is not read back', async () => {
    const { input, stateDir } = await setup();
    const recorded = await recordManualCheck(input);
    if (!recorded.ok) throw new Error(recorded.error);
    const path = join(recorded.runDirectory, 'manual.json');
    const meta = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...meta, requirement: `${OS}/other` }));
    expect(await readManualRun(stateDir, recorded.runId)).toBeUndefined();
    await writeFile(path, JSON.stringify({ ...meta, releaseId: '50' }));
    expect(await readManualRun(stateDir, recorded.runId)).toBeUndefined();
  });

  test('a different signed-in user cannot upload someone else\'s recorded result', async () => {
    const { input, stateDir, api } = await setup();
    const recorded = await recordManualCheck(input);
    if (!recorded.ok) throw new Error(recorded.error);
    api.actor = 'tester-b';
    const result = await syncManualRun(stateDir, recorded.runId, api);
    expect(result).toEqual({ ok: false, error: expect.stringContaining('does not match') });
    expect(api.assets).toEqual([]);
    expect((await readManualRun(stateDir, recorded.runId))?.synced).toBe(false);
  });

  test('an id that is not a recorded manual result is refused, and a tampered journal is not uploaded', async () => {
    const { input, stateDir, api } = await setup();
    expect((await syncManualRun(stateDir, '../../etc', api)).ok).toBe(false);
    expect((await syncManualRun(stateDir, 'manual-20260101T000000Z-abcdef', api)).ok).toBe(false);
    const recorded = await recordManualCheck(input);
    if (!recorded.ok) throw new Error(recorded.error);
    await rm(join(recorded.runDirectory, recorded.report.attempts[0]!.evidence[1]!));
    const result = await syncManualRun(stateDir, recorded.runId, api);
    expect(result.ok).toBe(false);
    expect(api.assets).toEqual([]);
  });
});
