import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildReport, isRunId, listRuns, reportForSync, resumeRun, startRun, type RunOptions } from '../../src/cli/run.ts';
import { parseReport } from '../../src/model/result.ts';
import { appendEvent, readRun } from '../../src/runner/journal.ts';
import { eventDigest } from '../../src/runner/events.ts';
import { writeConsumer, type Behaviour } from '../fixtures/consumer.ts';
import { cleanUpProcessesAndRoots, makeTempDir, makeTestRoot } from '../fixtures/processes.ts';

vi.setConfig({ testTimeout: 30_000 });
afterEach(cleanUpProcessesAndRoots);

const DIGEST = 'a'.repeat(64);
const REVISION = 'b'.repeat(40);

async function setUp(scenarios: Record<string, Behaviour>, extra: { manual?: string[] } = {}) {
  const consumer = await writeConsumer({ scenarios, ...extra });
  const root = await makeTestRoot();
  const stateDir = join(await makeTempDir('qa-state-'), 'runs');
  const controller = new AbortController();
  const options: RunOptions = { stateDir, signal: controller.signal, probes: { display: async () => true, audio: async () => true } };
  const invocation = { project: consumer.projectPath, candidate: consumer.candidatePath, profile: consumer.profile, suite: 'release', root };
  return { consumer, stateDir, controller, options, invocation };
}

describe('hosting the consumer process', () => {
  test('a host that bundles the package names the worker file, and the consumer never inherits ELECTRON_RUN_AS_NODE', async () => {
    const { consumer, options, invocation } = await setUp({ startup: 'pass' });
    const before = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = '1';
    try {
      const result = await startRun(invocation, { ...options, consumerWorker: fileURLToPath(new URL('../../src/cli/consumer-worker.ts', import.meta.url)) });
      expect(result.ok && result.summary.exitCode).toBe(0);
    } finally {
      if (before === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = before;
    }
    expect(await readFile(`${consumer.installedBytesPath}.env`, 'utf8')).toBe('unset');
  });

  test('a worker file that does not exist is a refusal before anything is installed', async () => {
    const { consumer, options, invocation } = await setUp({ startup: 'pass' });
    const result = await startRun(invocation, { ...options, consumerWorker: join(consumer.dir, 'missing-worker.ts') });
    expect(result.ok).toBe(false);
    expect(await readFile(consumer.logPath, 'utf8').catch(() => '')).toBe('');
  });
});

describe('run ids', () => {
  test('only directory names the runner made count, so an id cannot be a path', () => {
    expect(isRunId('run-20260930T101010Z-0a1b2c')).toBe(true);
    for (const bad of ['..', '../run-20260930T101010Z-0a1b2c', 'run-1', 'machine-id', '', undefined, 5]) expect(isRunId(bad)).toBe(false);
  });
});

describe('listing local runs', () => {
  test('lists nothing for a state directory that does not exist', async () => {
    expect(await listRuns(join(await makeTempDir('qa-none-'), 'missing'))).toEqual([]);
  });

  test('a finished run lists its results, is not resumable, and is not synced until events are acknowledged', async () => {
    const { consumer, stateDir, options, invocation } = await setUp({ startup: 'pass', persistence: 'fail' }, { manual: ['audio'] });
    const started = await startRun(invocation, options);
    expect(started.ok).toBe(true);
    const [listing] = await listRuns(stateDir);
    expect(listing).toMatchObject({ candidateId: 'local-1', profile: consumer.profile, suite: 'release', attempts: 2, resumable: false });
    expect(listing?.results.map((r) => [r.requirement.split('/')[1], r.outcome])).toEqual([['startup', 'passed'], ['persistence', 'failed'], ['audio', 'manual']]);
    // Nothing was uploaded, so every event is still pending: the "not synced" state.
    expect(listing?.pending).toBe((await readRun(join(stateDir, listing!.runId))).events.length);
    expect(listing?.pending).toBeGreaterThan(0);
    expect(listing?.problem).toBeUndefined();
  });

  test('a run cancelled part-way is resumable, shows what was never reached, and resuming makes it not resumable', async () => {
    const { consumer, stateDir, controller, options, invocation } = await setUp({ startup: 'pass', persistence: 'hang', uninstall: 'pass' });
    await startRun(invocation, { ...options, onEvent: (event) => { if (event.scenario === 'persistence' && event.phase === 'steps' && event.status === 'started') controller.abort(); } });
    const [cancelled] = await listRuns(stateDir);
    expect(cancelled?.resumable).toBe(true);
    expect(cancelled?.results.map((r) => [r.requirement.split('/')[1], r.outcome])).toEqual([['startup', 'passed'], ['persistence', 'cancelled'], ['uninstall', 'not-run']]);

    await rm(consumer.holdPath);
    const resumed = await resumeRun(cancelled!.runId, { ...options, signal: new AbortController().signal });
    expect(resumed.ok).toBe(true);
    const [after] = await listRuns(stateDir);
    expect(after?.resumable).toBe(false);
    expect(after?.results.every((r) => r.outcome === 'passed')).toBe(true);
  });

  test('a damaged journal is reported and is neither resumable nor trusted', async () => {
    const { stateDir, options, invocation } = await setUp({ startup: 'pass' });
    await startRun(invocation, options);
    const [listing] = await listRuns(stateDir);
    await writeFile(join(stateDir, listing!.runId, 'events.jsonl'), 'not json\n', { flag: 'a' });
    const [damaged] = await listRuns(stateDir);
    expect(damaged?.problem).toContain('journal is damaged');
    expect(damaged?.resumable).toBe(false);
  });

  test('a directory that is not a run, and a run whose project moved, do not break the listing', async () => {
    const { stateDir, options, invocation, consumer } = await setUp({ startup: 'pass' });
    await startRun(invocation, options);
    await mkdir(join(stateDir, 'not-a-run'), { recursive: true });
    await rm(consumer.projectPath);
    const runs = await listRuns(stateDir);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.problem).toContain('project file could not be read');
    expect(runs[0]?.resumable).toBe(false);
    expect(runs[0]?.results).toHaveLength(1);
  });
});

describe('the report an upload stands on', () => {
  test('is built from the journal, the digest and revision of the candidate, the uploader and the recorded environment', async () => {
    const { stateDir, options, invocation } = await setUp({ startup: 'pass' });
    await startRun(invocation, options);
    const [listing] = await listRuns(stateDir);
    const made = await reportForSync(stateDir, listing!.runId, { policyDigest: DIGEST, testRevision: REVISION, actor: 'maintainer' });
    if (!made.ok) throw new Error(made.error);
    expect(made.runDirectory).toBe(join(stateDir, listing!.runId));
    expect(made.report).toMatchObject({ id: listing!.runId, candidateId: 'local-1', policyDigest: DIGEST, testRevision: REVISION, actor: 'maintainer', profile: listing!.profile });
    expect(made.report.attempts).toEqual((await readRun(made.runDirectory)).attempts);
    // The environment the session measured is kept with the run, not invented later.
    expect(JSON.parse(await readFile(join(made.runDirectory, 'environment.json'), 'utf8'))).toEqual(made.report.environment);
    expect(made.report.environment.os).not.toBe('not measured in this session');
    expect(parseReport(made.report).ok).toBe(true);
  });

  test('a run blocked before anything was measured still yields a valid report that says the environment was not measured', async () => {
    const { consumer, stateDir, options, invocation } = await setUp({ startup: 'pass' });
    const result = await startRun({ ...invocation, root: await makeTempDir('qa-undesignated-') }, options);
    expect(result.ok && result.summary.results[0]?.outcome).toBe('blocked');
    const [listing] = await listRuns(stateDir);
    const made = await reportForSync(stateDir, listing!.runId, { policyDigest: DIGEST, testRevision: REVISION, actor: 'maintainer' });
    if (!made.ok) throw new Error(made.error);
    expect(made.report.environment.os).toBe('not measured');
    expect(parseReport(made.report).ok).toBe(true);
    expect(await readFile(consumer.logPath, 'utf8').catch(() => '')).toBe('');
  });

  test('is refused for a run with no attempt, a bad id, or no such run', async () => {
    const { stateDir, options, invocation } = await setUp({ persistence: 'hang' });
    const controller = new AbortController();
    controller.abort();
    await startRun(invocation, { ...options, signal: controller.signal });
    const [listing] = await listRuns(stateDir);
    const meta = { policyDigest: DIGEST, testRevision: REVISION, actor: 'maintainer' };
    const none = await reportForSync(stateDir, listing!.runId, meta);
    expect(!none.ok && none.error).toContain('no attempt');
    expect((await reportForSync(stateDir, '../x', meta)).ok).toBe(false);
    expect((await reportForSync(stateDir, 'run-20260930T101010Z-000000', meta)).ok).toBe(false);
  });

  test('a run stops being pending once its events are acknowledged', async () => {
    const { stateDir, options, invocation } = await setUp({ startup: 'pass' });
    await startRun(invocation, options);
    const [listing] = await listRuns(stateDir);
    const runDir = join(stateDir, listing!.runId);
    let previous = (await readRun(runDir)).events.at(-1)?.id;
    for (const event of (await readRun(runDir)).events) {
      const ack = { schemaVersion: 1 as const, id: `ack-${event.id}`, ...(previous === undefined ? {} : { prev: previous }), recordedAt: '2026-09-30T10:00:00Z', type: 'upload-acknowledged' as const, data: { eventId: event.id, digest: eventDigest(event) } };
      expect((await appendEvent(runDir, ack)).ok).toBe(true);
      previous = ack.id;
    }
    expect((await listRuns(stateDir))[0]?.pending).toBe(0);
  });
});

describe('buildReport', () => {
  test('says the environment was not measured rather than inventing one', () => {
    const report = buildReport({ exists: true, events: [], attempts: [], truncated: null, corrupt: [], conflicts: [], missingPredecessors: [], cyclic: [], pending: [], synced: [], ackMismatches: [], orphanAcks: [], missingEvidence: [] }, { candidateId: 'c', profile: 'windows', policyDigest: DIGEST, testRevision: REVISION, actor: 'me', environment: undefined });
    expect(report.environment.os).toBe('not measured in this session');
    expect(report.id).toBe('unknown run');
  });
});
