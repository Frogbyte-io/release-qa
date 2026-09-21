import assert from 'node:assert';
import { getEventListeners } from 'node:events';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { AssertionFailure, executeScenario, type ExecutionContext, type Lifecycle, type Scenario, type ScenarioEvent } from '../../src/runner/execute.ts';
import { readDirty, readLedger, resetDirtyEnvironment, spawnOwned } from '../../src/runner/resources.ts';
import { candidate, requirement } from '../fixtures/records.ts';
import { cleanUpProcessesAndRoots, eventually, hostOs, hostProfile, isAlive, makeTempDir, makeTestRoot, startUnrelatedProcess } from '../fixtures/processes.ts';

afterEach(cleanUpProcessesAndRoots);

const sleeper = ['-e', 'setInterval(() => {}, 1000)'];
const never = () => new Promise<void>(() => {});

function lifecycleOf(calls: string[], overrides: Partial<Lifecycle> = {}): Lifecycle {
  const record = (name: string) => async () => { calls.push(name); };
  return { install: record('install'), reset: record('reset'), launch: record('launch'), cleanup: record('cleanup'), ...overrides };
}

async function arrange(overrides: Partial<ExecutionContext> = {}) {
  const testRoot = await makeTestRoot();
  const calls: string[] = [];
  const events: ScenarioEvent[] = [];
  const controller = new AbortController();
  const context: ExecutionContext = {
    candidate: candidate(),
    profile: hostProfile(),
    testRoot,
    signal: controller.signal,
    emit: (event) => { events.push(event); },
    lifecycle: lifecycleOf(calls),
    probes: { display: async () => true, audio: async () => true },
    timeouts: { phaseMs: 2000, stepsMs: 2000, cleanupMs: 2000 },
    ...overrides,
  };
  return { testRoot, calls, events, controller, context };
}

const scenarioOf = (overrides: Partial<Scenario> = {}): Scenario => ({
  id: 'persistence',
  requirement: requirement({ key: `${hostOs()}/persistence` }),
  steps: async () => {},
  ...overrides,
});
const started = (events: readonly ScenarioEvent[]) => events.filter((e) => e.status === 'started').map((e) => e.phase);

describe('a passing run', () => {
  test('runs the phases in order, emits an event for each, and cleans up', async () => {
    const { context, calls, events } = await arrange();
    const result = await executeScenario(context, scenarioOf({ setup: async () => { calls.push('setup'); }, steps: async () => { calls.push('steps'); } }));

    expect(result).toMatchObject({ outcome: 'passed', cleanup: { ok: true, failures: [] }, leftover: [] });
    expect(result.reason).toBeUndefined();
    expect(calls).toEqual(['install', 'reset', 'launch', 'setup', 'steps', 'cleanup']);
    expect(started(events)).toEqual(['prerequisites', 'install', 'reset', 'launch', 'setup', 'steps', 'cleanup']);
    expect(events.filter((e) => e.status !== 'started').map((e) => e.status)).toEqual(Array(7).fill('finished'));
    expect(result.environment?.os).toBe(hostOs());
  });

  test('skips the setup phase, and its events, when the scenario has none', async () => {
    const { context, events } = await arrange();
    await executeScenario(context, scenarioOf());
    expect(started(events)).toContain('steps');
    expect(started(events)).not.toContain('setup');
  });
});

describe('blocked: prerequisites that are not met', () => {
  test('refuses to run anywhere that was not explicitly designated as a test environment', async () => {
    const undesignated = await makeTestRoot(false);
    const { context, calls } = await arrange({ testRoot: undesignated });
    const result = await executeScenario(context, scenarioOf());
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'not-a-test-environment' });
    expect(calls).toEqual([]);
  });

  test('is blocked without installing anything when the display the scenario needs is missing', async () => {
    const { context, calls, events } = await arrange({ probes: { display: async () => false, audio: async () => true } });
    const result = await executeScenario(context, scenarioOf({ requirement: requirement({ key: `${hostOs()}/persistence`, capabilities: ['display'] }) }));
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'capability-missing', missing: ['display'] });
    expect(calls).toEqual([]);
    expect(started(events)).toEqual(['prerequisites']);
    expect(events.at(-1)).toMatchObject({ phase: 'prerequisites', status: 'failed' });
  });

  test('is blocked when the audio capability the scenario needs is missing', async () => {
    const { context, calls } = await arrange({ probes: { display: async () => true, audio: async () => false } });
    const result = await executeScenario(context, scenarioOf({ requirement: requirement({ key: `${hostOs()}/persistence`, capabilities: ['audio'] }) }));
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'capability-missing', missing: ['audio'] });
    expect(calls).toEqual([]);
  });

  test('lists every missing capability, sorted', async () => {
    const { context } = await arrange({ probes: { display: async () => false, audio: async () => false } });
    const result = await executeScenario(context, scenarioOf({ requirement: requirement({ key: `${hostOs()}/persistence`, capabilities: ['display', 'audio'] }) }));
    expect(result.missing).toEqual(['audio', 'display']);
  });

  test('does not need a capability the scenario never asked for', async () => {
    const { context } = await arrange({ probes: { display: async () => false, audio: async () => false } });
    expect((await executeScenario(context, scenarioOf())).outcome).toBe('passed');
  });

  test('is blocked when the machine is not what the profile asks for', async () => {
    const other = { ...hostProfile(), os: hostOs() === 'windows' ? ('linux' as const) : ('windows' as const) };
    const { context, calls } = await arrange({ profile: other });
    const result = await executeScenario(context, scenarioOf());
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'wrong-environment' });
    expect(calls).toEqual([]);
  });
});

describe('a dirty environment', () => {
  test('refuses the next run while a process from an earlier run is still owned, and leaves that process alone', async () => {
    const { context, calls, testRoot } = await arrange();
    const leftover = await spawnOwned(testRoot, 'earlier helper', process.execPath, sleeper, { stdio: 'ignore' });

    const refused = await executeScenario(context, scenarioOf());

    expect(refused).toMatchObject({ outcome: 'blocked', reason: 'dirty-environment' });
    expect(calls).toEqual([]);
    expect(isAlive(leftover.pid as number)).toBe(true);
  });

  test('accepts runs again once the environment has been reset', async () => {
    const { context, testRoot } = await arrange();
    const leftover = await spawnOwned(testRoot, 'earlier helper', process.execPath, sleeper, { stdio: 'ignore' });
    expect((await executeScenario(context, scenarioOf())).outcome).toBe('blocked');

    await resetDirtyEnvironment(testRoot, { graceMs: 300 });
    await eventually(() => !isAlive(leftover.pid as number));

    expect((await executeScenario(context, scenarioOf())).outcome).toBe('passed');
  });

  test('a failed cleanup hook leaves the environment marked dirty, so the next run is refused', async () => {
    const calls: string[] = [];
    const { context, testRoot } = await arrange({ lifecycle: lifecycleOf(calls, { cleanup: async () => { throw new Error('uninstaller crashed'); } }) });

    const first = await executeScenario(context, scenarioOf());

    expect(first.outcome).toBe('passed');
    expect(first.cleanup.ok).toBe(false);
    expect(first.cleanup.failures.join(' ')).toContain('uninstaller crashed');
    expect(await readDirty(testRoot)).toContain('cleanup');
    expect((await executeScenario(context, scenarioOf())).reason).toBe('dirty-environment');

    await resetDirtyEnvironment(testRoot);
    expect(await readDirty(testRoot)).toBeUndefined();
  });

  test('a cleanup hook that hangs is cut off and also leaves the environment dirty', async () => {
    const { context, testRoot } = await arrange({ lifecycle: lifecycleOf([], { cleanup: never }), timeouts: { phaseMs: 2000, stepsMs: 2000, cleanupMs: 100 } });
    const result = await executeScenario(context, scenarioOf());
    expect(result.cleanup.ok).toBe(false);
    expect(result.cleanup.failures.join(' ')).toMatch(/timed out/);
    expect(await readDirty(testRoot)).toBeDefined();
  });
});

describe('failed: only an assertion says the candidate misbehaved', () => {
  test('an assertion failure in the steps is a failed result, and cleanup still runs', async () => {
    const { context, calls } = await arrange();
    const result = await executeScenario(context, scenarioOf({ steps: async () => { throw new AssertionFailure('saved value was not shown after restart'); } }));
    expect(result).toMatchObject({ outcome: 'failed', reason: 'assertion-failed', detail: 'saved value was not shown after restart' });
    expect(calls.at(-1)).toBe('cleanup');
  });

  test("node's own assertion errors count as assertion failures", async () => {
    const { context } = await arrange();
    const result = await executeScenario(context, scenarioOf({ steps: async () => { assert.strictEqual(1, 2); } }));
    expect(result).toMatchObject({ outcome: 'failed', reason: 'assertion-failed' });
  });

  test('an assertion failure raised by a lifecycle hook is also a failure of the candidate', async () => {
    const calls: string[] = [];
    const { context, events } = await arrange({ lifecycle: lifecycleOf(calls, { launch: async () => { throw new AssertionFailure('the window never appeared'); } }) });
    const result = await executeScenario(context, scenarioOf());
    expect(result).toMatchObject({ outcome: 'failed', reason: 'assertion-failed' });
    expect(started(events)).not.toContain('steps');
  });

  test('waitFor that runs out of time is an assertion failure naming what it waited for', async () => {
    const { context } = await arrange();
    const result = await executeScenario(context, scenarioOf({ steps: (ctx) => ctx.waitFor(() => false, { timeoutMs: 60, intervalMs: 10, description: 'the saved value to appear' }) }));
    expect(result).toMatchObject({ outcome: 'failed', reason: 'assertion-failed' });
    expect(result.detail).toContain('the saved value to appear');
  });

  test('waiting through many polls does not pile up abort listeners on the signal', async () => {
    // Timer resolution is coarse on Windows, so allow generously more time than 30 polls can take.
    const { context } = await arrange({ timeouts: { phaseMs: 2000, stepsMs: 20000, cleanupMs: 2000 } });
    let listeners = Number.POSITIVE_INFINITY;
    let polls = 0;
    const result = await executeScenario(context, scenarioOf({
      steps: async (ctx) => {
        await ctx.waitFor(() => ++polls > 30, { timeoutMs: 15000, intervalMs: 1 });
        listeners = getEventListeners(ctx.signal, 'abort').length;
      },
    }));
    expect(result.outcome).toBe('passed');
    expect(listeners).toBeLessThan(5);
  });

  test('waitFor returns as soon as the condition holds', async () => {
    const { context } = await arrange();
    let polls = 0;
    const result = await executeScenario(context, scenarioOf({ steps: (ctx) => ctx.waitFor(() => ++polls >= 3, { timeoutMs: 2000, intervalMs: 5 }) }));
    expect(result.outcome).toBe('passed');
    expect(polls).toBe(3);
  });
});

describe('interrupted: trouble that is not the candidate', () => {
  test('a launch that fails is an infrastructure interruption, not a failed candidate, and nothing after it runs', async () => {
    const calls: string[] = [];
    const { context, events } = await arrange({ lifecycle: lifecycleOf(calls, { launch: async () => { throw new Error('spawn ENOENT'); } }) });
    const result = await executeScenario(context, scenarioOf({ setup: async () => { calls.push('setup'); }, steps: async () => { calls.push('steps'); } }));

    expect(result).toMatchObject({ outcome: 'interrupted', reason: 'infrastructure-error' });
    expect(result.detail).toContain('spawn ENOENT');
    expect(calls).toEqual(['install', 'reset', 'cleanup']);
    // The record never claims a phase that did not happen.
    expect(started(events)).toEqual(['prerequisites', 'install', 'reset', 'launch', 'cleanup']);
    expect(events.filter((e) => e.phase === 'launch').map((e) => e.status)).toEqual(['started', 'failed']);
  });

  test('an ordinary error thrown by the steps is an interruption, not a verdict on the candidate', async () => {
    const { context } = await arrange();
    const result = await executeScenario(context, scenarioOf({ steps: async () => { throw new TypeError('cannot read properties of undefined'); } }));
    expect(result).toMatchObject({ outcome: 'interrupted', reason: 'infrastructure-error' });
  });

  test('steps that run out of time are interrupted, cleanup runs, and the run returns promptly', async () => {
    const { context, calls } = await arrange({ timeouts: { phaseMs: 2000, stepsMs: 80, cleanupMs: 2000 } });
    const began = Date.now();
    const result = await executeScenario(context, scenarioOf({ steps: never }));
    expect(result).toMatchObject({ outcome: 'interrupted', reason: 'timeout' });
    expect(Date.now() - began).toBeLessThan(1500);
    expect(calls.at(-1)).toBe('cleanup');
  });

  test('an event sink that fails stops the run and is reported, but cleanup still happens', async () => {
    const calls: string[] = [];
    const { context } = await arrange({
      lifecycle: lifecycleOf(calls),
      emit: (event) => { if (event.phase === 'launch' && event.status === 'started') throw new Error('disk full'); },
    });
    const result = await executeScenario(context, scenarioOf());
    expect(result).toMatchObject({ outcome: 'interrupted', reason: 'infrastructure-error' });
    expect(result.detail).toMatch(/event sink/);
    expect(result.detail).toContain('disk full');
    expect(calls).toContain('cleanup');
  });
});

describe('cancelled', () => {
  test('cancelling during install stops the run there and still cleans up, with a signal that is not itself cancelled', async () => {
    const calls: string[] = [];
    let cleanupSawCancellation: boolean | undefined;
    const { context, controller } = await arrange({
      lifecycle: lifecycleOf(calls, { cleanup: async (ctx) => { calls.push('cleanup'); cleanupSawCancellation = ctx.signal.aborted; }, install: (ctx) => new Promise<void>((_, reject) => { calls.push('install'); ctx.signal.addEventListener('abort', () => reject(new Error('stopped'))); }) }),
    });
    const running = executeScenario(context, scenarioOf());
    await eventually(() => calls.includes('install'));
    controller.abort();

    const result = await running;

    expect(result).toMatchObject({ outcome: 'cancelled', reason: 'cancelled' });
    expect(calls).toEqual(['install', 'cleanup']);
    expect(cleanupSawCancellation).toBe(false);
    expect(result.cleanup.ok).toBe(true);
  });

  test('a hook that ignores cancellation cannot keep the run waiting', async () => {
    const calls: string[] = [];
    const { context, controller } = await arrange({ lifecycle: lifecycleOf(calls, { install: () => { calls.push('install'); return never(); } }) });
    const running = executeScenario(context, scenarioOf());
    await eventually(() => calls.includes('install'));
    controller.abort();
    expect((await running).outcome).toBe('cancelled');
    expect(calls.at(-1)).toBe('cleanup');
  });

  test('a run cancelled before it starts touches nothing', async () => {
    const { context, calls, controller, events } = await arrange();
    controller.abort();
    const result = await executeScenario(context, scenarioOf());
    expect(result).toMatchObject({ outcome: 'cancelled', reason: 'cancelled' });
    expect(calls).toEqual([]);
    expect(events).toEqual([]);
  });

  test('cancelling while waiting in the steps ends the wait as a cancellation', async () => {
    const { context, controller, calls } = await arrange();
    const running = executeScenario(context, scenarioOf({ steps: async (ctx) => { calls.push('waiting'); await ctx.waitFor(() => false, { timeoutMs: 5000, intervalMs: 10 }); } }));
    await eventually(() => calls.includes('waiting'));
    controller.abort();
    expect((await running).outcome).toBe('cancelled');
  });
});

describe('owning only what the run created', () => {
  test('stops a process the scenario spawned even if the cleanup hook forgot it, and leaves an unrelated process alone', async () => {
    const { context, testRoot } = await arrange();
    const unrelated = startUnrelatedProcess();
    let spawnedPid = 0;

    const result = await executeScenario(context, scenarioOf({
      steps: async (ctx) => {
        const child = await ctx.spawn('helper', process.execPath, sleeper, { stdio: 'ignore' });
        spawnedPid = child.pid as number;
      },
    }));

    expect(result.outcome).toBe('passed');
    await eventually(() => !isAlive(spawnedPid));
    expect(isAlive(unrelated.pid as number)).toBe(true);
    expect(await readLedger(testRoot)).toEqual([]);
  });

  test('reaps what the run owned even when the steps failed', async () => {
    const { context } = await arrange();
    let spawnedPid = 0;
    const result = await executeScenario(context, scenarioOf({
      steps: async (ctx) => {
        spawnedPid = (await ctx.spawn('helper', process.execPath, sleeper, { stdio: 'ignore' })).pid as number;
        throw new AssertionFailure('boom');
      },
    }));
    expect(result.outcome).toBe('failed');
    await eventually(() => !isAlive(spawnedPid));
  });

  test('a resource that cannot be safely removed is reported as left over and keeps the environment dirty', async () => {
    const { context, testRoot } = await arrange();
    const outside = startUnrelatedProcess();
    // A throwaway directory outside the test root: never a real one, in case the code under test is wrong.
    const notOurs = await makeTempDir('qa-not-ours-');
    await writeFile(join(notOurs, 'precious.txt'), 'keep me');
    const result = await executeScenario(context, scenarioOf({
      steps: async (ctx) => {
        // Claiming a path outside the test root: cleanup must refuse to remove it.
        await ctx.own({ kind: 'path', path: notOurs, label: 'not ours to delete' });
      },
    }));
    expect(result.leftover.map((l) => l.reason)).toEqual(['outside-test-root']);
    expect(result.cleanup.ok).toBe(false);
    expect(await readDirty(testRoot)).toBeDefined();
    expect(isAlive(outside.pid as number)).toBe(true);
    expect(await readFile(join(notOurs, 'precious.txt'), 'utf8')).toBe('keep me');
    await rm(notOurs, { recursive: true, force: true });
  });
});
