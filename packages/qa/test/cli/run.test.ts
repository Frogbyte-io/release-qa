import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { exitCodeOf, resumeRun, startRun, type RequirementResult, type RunOptions, type RunSummary } from '../../src/cli/run.ts';
import { readRun } from '../../src/runner/journal.ts';
import { writeConsumer, type Behaviour, type Consumer } from '../fixtures/consumer.ts';
import { cleanUpProcessesAndRoots, makeTempDir, makeTestRoot } from '../fixtures/processes.ts';

// Reading a process's identity starts PowerShell on Windows, which can take seconds on a busy CI runner.
vi.setConfig({ testTimeout: 30_000 });
afterEach(cleanUpProcessesAndRoots);

const exists = (path: string) => stat(path).then(() => true, () => false);
const calls = async (consumer: Consumer): Promise<string[]> => (await readFile(consumer.logPath, 'utf8').catch(() => '')).split('\n').filter(Boolean);

async function setUp(scenarios: Record<string, Behaviour>, extra: { manual?: string[] } = {}) {
  const consumer = await writeConsumer({ scenarios, ...extra });
  const root = await makeTestRoot();
  const stateDir = join(await makeTempDir('qa-state-'), 'runs');
  const controller = new AbortController();
  const options: RunOptions = {
    stateDir,
    signal: controller.signal,
    probes: { display: async () => true, audio: async () => true },
  };
  const invocation = { project: consumer.projectPath, candidate: consumer.candidatePath, profile: consumer.profile, suite: 'release', root };
  return { consumer, root, stateDir, controller, options, invocation };
}

async function started(...args: Parameters<typeof startRun>): Promise<RunSummary> {
  const result = await startRun(...args);
  if (!result.ok) throw new Error(result.error);
  return result.summary;
}
async function resumed(...args: Parameters<typeof resumeRun>): Promise<RunSummary> {
  const result = await resumeRun(...args);
  if (!result.ok) throw new Error(result.error);
  return result.summary;
}
const outcomes = (summary: RunSummary) => Object.fromEntries(summary.results.map((r) => [r.requirement.split('/')[1], r.outcome]));

describe('starting a run', () => {
  test('runs every automated scenario, hands each hook the verified artifact, and records it all in the journal', async () => {
    const { consumer, stateDir, options, invocation } = await setUp({ startup: 'pass', persistence: 'pass' });

    const summary = await started(invocation, options);

    expect(summary.exitCode).toBe(0);
    expect(outcomes(summary)).toEqual({ startup: 'passed', persistence: 'passed' });
    const artifact = join(consumer.dir, 'setup.bin');
    expect(await calls(consumer)).toEqual([
      `install ${artifact}`, `reset ${artifact}`, `launch ${artifact}`, `steps:startup ${artifact}`, `cleanup ${artifact}`,
      `install ${artifact}`, `reset ${artifact}`, `launch ${artifact}`, `steps:persistence ${artifact}`, `cleanup ${artifact}`,
    ]);

    const state = await readRun(join(stateDir, summary.runId));
    expect(state.events.map((e) => e.type)).toEqual(['run-started', 'checkpoint', 'attempt-recorded', 'checkpoint', 'attempt-recorded']);
    expect(state.events[0]).toMatchObject({ data: { runId: summary.runId, candidateId: 'local-1', profile: consumer.profile } });
    expect(state.attempts.map((a) => [a.requirement, a.outcome])).toEqual([
      [`${consumer.profile}/startup`, 'passed'],
      [`${consumer.profile}/persistence`, 'passed'],
    ]);
    expect(await exists(join(stateDir, summary.runId, 'summary.json'))).toBe(true);
  });

  test('the machine id is a generated token, not the host name, and stays the same across runs', async () => {
    const { stateDir, options, invocation } = await setUp({ persistence: 'pass' });
    const first = await started(invocation, options);
    const second = await started(invocation, options);
    const machineOf = async (runId: string) => (await readRun(join(stateDir, runId))).events[0]?.data as { machineId: string };
    const machine = (await machineOf(first.runId)).machineId;
    expect(machine).toBe((await machineOf(second.runId)).machineId);
    expect(machine).not.toContain((await import('node:os')).hostname());
  });

  test('one scenario failing its assertion does not stop the others, and the run exits 1', async () => {
    const { options, invocation } = await setUp({ startup: 'fail', persistence: 'pass' });
    const summary = await started(invocation, options);
    expect(outcomes(summary)).toEqual({ startup: 'failed', persistence: 'passed' });
    expect(summary.exitCode).toBe(1);
  });

  test('a scenario that breaks without an assertion is interrupted, and the run exits 3', async () => {
    const { options, invocation } = await setUp({ persistence: 'throw' });
    const summary = await started(invocation, options);
    expect(outcomes(summary)).toEqual({ persistence: 'interrupted' });
    expect(summary.exitCode).toBe(3);
  });

  test('manual requirements are listed as work left, never run, and the run exits 2', async () => {
    const { consumer, stateDir, options, invocation } = await setUp({ persistence: 'pass' }, { manual: ['audio'] });
    const summary = await started(invocation, options);
    expect(outcomes(summary)).toEqual({ persistence: 'passed', audio: 'manual' });
    expect(summary.exitCode).toBe(2);
    expect((await readRun(join(stateDir, summary.runId))).attempts.map((a) => a.requirement)).toEqual([`${consumer.profile}/persistence`]);
  });

  test('a missing prerequisite blocks the scenario without installing anything, and the run exits 2', async () => {
    const { consumer, options, invocation } = await setUp({ persistence: 'pass' });
    const undesignated = await makeTempDir('qa-undesignated-');
    const summary = await started({ ...invocation, root: undesignated }, options);
    expect(outcomes(summary)).toEqual({ persistence: 'blocked' });
    expect(summary.exitCode).toBe(2);
    expect(await calls(consumer)).toEqual([]);
  });

  test('a candidate whose bytes changed is refused before anything is installed or recorded', async () => {
    const { consumer, stateDir, options, invocation } = await setUp({ persistence: 'pass' });
    await writeFile(join(consumer.dir, 'setup.bin'), 'tampered');
    const result = await startRun(invocation, options);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('does not match');
    expect(await calls(consumer)).toEqual([]);
    expect(await exists(stateDir)).toBe(false);
  });

  test('an unknown suite or profile is refused before anything is recorded', async () => {
    const { stateDir, options, invocation } = await setUp({ persistence: 'pass' });
    expect((await startRun({ ...invocation, suite: 'nightly' }, options)).ok).toBe(false);
    expect((await startRun({ ...invocation, profile: 'plan9' }, options)).ok).toBe(false);
    expect(await exists(stateDir)).toBe(false);
  });

  test('cancellation stops the running scenario, still cleans up, and starts nothing further; the run exits 3', async () => {
    const { consumer, controller, options, invocation } = await setUp({ startup: 'pass', persistence: 'hang', uninstall: 'pass' });
    const summary = await started(invocation, {
      ...options,
      onEvent: (event) => {
        if (event.scenario === 'persistence' && event.phase === 'steps' && event.status === 'started') controller.abort();
      },
    });
    expect(outcomes(summary)).toEqual({ startup: 'passed', persistence: 'cancelled', uninstall: 'not-run' });
    expect(summary.exitCode).toBe(3);
    const log = await calls(consumer);
    expect(log.at(-1)).toMatch(/^cleanup /);
    expect(log.some((line) => line.startsWith('steps:uninstall'))).toBe(false);
  });
});

describe('resuming a run', () => {
  test('carries passed and failed results forward and runs only what is unfinished, as retries', async () => {
    const { consumer, controller, stateDir, options, invocation } = await setUp({ startup: 'fail', persistence: 'hang', uninstall: 'pass' });
    const first = await started(invocation, {
      ...options,
      onEvent: (event) => {
        if (event.scenario === 'persistence' && event.phase === 'steps' && event.status === 'started') controller.abort();
      },
    });
    expect(outcomes(first)).toEqual({ startup: 'failed', persistence: 'cancelled', uninstall: 'not-run' });

    // The tester fixes whatever made it hang; the scenario now passes.
    await rm(consumer.holdPath);
    const logBefore = (await calls(consumer)).length;

    const summary = await resumed(first.runId, { ...options, signal: new AbortController().signal });

    expect(outcomes(summary)).toEqual({ startup: 'failed', persistence: 'passed', uninstall: 'passed' });
    expect(summary.results.find((r) => r.requirement.endsWith('/startup'))?.carried).toBe(true);
    expect(summary.exitCode).toBe(1); // the carried failure still counts
    expect((await calls(consumer)).slice(logBefore).filter((l) => l.startsWith('steps:')).map((l) => l.split(' ')[0])).toEqual(['steps:persistence', 'steps:uninstall']);

    const state = await readRun(join(stateDir, first.runId));
    const persistenceAttempts = state.attempts.filter((a) => a.requirement.endsWith('/persistence'));
    expect(persistenceAttempts.map((a) => a.outcome)).toEqual(['cancelled', 'passed']);
    expect(persistenceAttempts[1]?.retryOf).toBe(persistenceAttempts[0]?.id);
    expect(state.events.filter((e) => e.type === 'run-started')).toHaveLength(1);
  });

  test('a scenario that was started but never recorded (the process died) becomes an interrupted attempt before it is rerun', async () => {
    const { stateDir, options, invocation } = await setUp({ persistence: 'pass' });
    const first = await started(invocation, options);
    // Simulate a crash in a later session: a started checkpoint with no attempt after it.
    const runDir = join(stateDir, first.runId);
    const { appendEvent } = await import('../../src/runner/journal.ts');
    const before = await readRun(runDir);
    const last = before.events.at(-1)!;
    await appendEvent(runDir, { schemaVersion: 1, id: `${first.runId}.crash`, prev: last.id, recordedAt: '2026-09-23T10:00:00Z', type: 'checkpoint', data: { name: 'scenario-started', requirement: before.attempts[0]!.requirement } });

    const summary = await resumed(first.runId, options);

    const attempts = (await readRun(runDir)).attempts;
    expect(attempts.map((a) => a.outcome)).toEqual(['passed', 'interrupted', 'passed']);
    expect(attempts[2]?.retryOf).toBe(attempts[1]?.id);
    expect(outcomes(summary)).toEqual({ persistence: 'passed' });
  });

  test('an unknown run id is refused', async () => {
    const { options } = await setUp({ persistence: 'pass' });
    const result = await resumeRun('run-does-not-exist', options);
    expect(result.ok).toBe(false);
  });

  test('a candidate that changed since the run started is refused: it would be a different candidate', async () => {
    const { consumer, options, invocation } = await setUp({ persistence: 'throw' });
    const first = await started(invocation, options);
    await writeFile(join(consumer.dir, 'setup.bin'), 'rebuilt');
    const result = await resumeRun(first.runId, options);
    expect(result.ok).toBe(false);
  });

  test('a manifest that now names a different candidate is refused', async () => {
    const { consumer, options, invocation } = await setUp({ persistence: 'throw' });
    const first = await started(invocation, options);
    const manifest = JSON.parse(await readFile(consumer.candidatePath, 'utf8')) as { id: string };
    await writeFile(consumer.candidatePath, JSON.stringify({ ...manifest, id: 'local-2' }));
    const result = await resumeRun(first.runId, options);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/local-1.*local-2|local-2.*local-1/);
  });
});

describe('the run\'s exit code', () => {
  const r = (...outcomes: RequirementResult['outcome'][]): RequirementResult[] => outcomes.map((outcome, i) => ({ requirement: `windows/s${i}`, outcome }));

  test.each([
    [[], 0],
    [['passed', 'passed'], 0],
    [['passed', 'manual'], 2],
    [['blocked', 'passed'], 2],
    [['cancelled', 'blocked'], 3],
    [['not-run', 'manual'], 3],
    [['interrupted', 'passed'], 3],
    // A failure is a verdict on the candidate: it decides the code even when something else was left unfinished.
    [['interrupted', 'failed'], 1],
    [['failed', 'cancelled', 'not-run', 'blocked', 'manual'], 1],
  ] as Array<[RequirementResult['outcome'][], number]>)('%j exits %i', (outcomes, code) => {
    expect(exitCodeOf(r(...outcomes))).toBe(code);
  });

  test('a cleanup that failed leaves the environment dirty: 3, even when every scenario passed', () => {
    const dirty: RequirementResult = { requirement: 'windows/s0', outcome: 'passed', cleanup: { ok: false, failures: ['app: still-running'] } };
    expect(exitCodeOf([dirty])).toBe(3);
    expect(exitCodeOf([dirty, { requirement: 'windows/s1', outcome: 'blocked' }])).toBe(3);
    // ...but a failure still decides it.
    expect(exitCodeOf([dirty, { requirement: 'windows/s1', outcome: 'failed' }])).toBe(1);
  });
});

describe('resuming a run whose journal cannot be trusted', () => {
  test('a journal with two different events under one id is refused, and nothing runs', async () => {
    const { consumer, stateDir, options, invocation } = await setUp({ persistence: 'throw' });
    const first = await started(invocation, options);
    const log = join(stateDir, first.runId, 'events.jsonl');
    const [firstLine] = (await readFile(log, 'utf8')).split('\n');
    const tampered = JSON.parse(firstLine as string) as { data: { machineId: string } };
    tampered.data.machineId = 'machine-someone-else';
    await writeFile(log, `${await readFile(log, 'utf8')}${JSON.stringify(tampered)}\n`);
    const before = (await calls(consumer)).length;

    const result = await resumeRun(first.runId, options);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/inconsistent/);
    expect((await calls(consumer)).length).toBe(before);
  });
});

describe('review round 1', () => {
  test('resume refuses a manifest that keeps the id but now names different bytes: that is a different build', async () => {
    const { consumer, options, invocation } = await setUp({ persistence: 'throw' });
    const first = await started(invocation, options);
    const { createHash } = await import('node:crypto');
    await writeFile(join(consumer.dir, 'setup.bin'), 'rebuilt');
    const manifest = JSON.parse(await readFile(consumer.candidatePath, 'utf8')) as { artifacts: Array<{ sha256: string }> };
    manifest.artifacts[0]!.sha256 = createHash('sha256').update('rebuilt').digest('hex');
    await writeFile(consumer.candidatePath, JSON.stringify(manifest));
    const before = (await calls(consumer)).length;

    const result = await resumeRun(first.runId, options);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/different build|bytes/);
    expect((await calls(consumer)).length).toBe(before);
  });

  test('a journal that cannot be read at all is a refusal, not a thrown error', async () => {
    const { stateDir, options, invocation } = await setUp({ persistence: 'throw' });
    const first = await started(invocation, options);
    const log = join(stateDir, first.runId, 'events.jsonl');
    await rm(log);
    await (await import('node:fs/promises')).mkdir(log);
    const result = await resumeRun(first.runId, options);
    expect(result.ok).toBe(false);
  });
});
