// Behaviours found by review of the first version of the executor: ways a run could hang, leak, or reuse an
// environment that was not properly cleaned.
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { executeScenario } from '../../src/runner/execute.ts';
import { processIdentity, readDirty, readLedger } from '../../src/runner/resources.ts';
import { arrange, lifecycleOf, never, scenarioOf, sleep } from '../fixtures/execution.ts';
import { cleanUpProcessesAndRoots, eventually, isAlive, makeTempDir, startUnrelatedProcess } from '../fixtures/processes.ts';

// Reading a process's identity starts PowerShell on Windows, which can take seconds on a busy CI runner.
vi.setConfig({ testTimeout: 30_000 });

afterEach(cleanUpProcessesAndRoots);

const exists = (path: string) => stat(path).then(() => true, () => false);

describe('fail closed: an environment that may be dirty is never reused', () => {
  test('when the dirty marker cannot be written, this process still refuses the next run', async () => {
    const { context, testRoot } = await arrange({
      lifecycle: lifecycleOf([], {
        // A directory where the marker file belongs makes writing the marker fail. It appears mid-run: a marker
        // that is unreadable before the run starts is refused earlier, as a dirty environment.
        install: async (ctx) => { await mkdir(join(ctx.testRoot, '.release-qa-dirty.json')); },
        cleanup: async () => { throw new Error('uninstaller crashed'); },
      }),
    });

    const first = await executeScenario(context, scenarioOf());

    expect(first.cleanup.ok).toBe(false);
    expect(first.cleanup.failures.join(' ')).toContain('could not mark the environment dirty');
    await rm(join(testRoot, '.release-qa-dirty.json'), { recursive: true });
    expect(await readDirty(testRoot)).toBeDefined(); // remembered in memory even though it never reached the disk

    const second = await executeScenario(context, scenarioOf());
    expect(second).toMatchObject({ outcome: 'blocked', reason: 'dirty-environment' });
  });
});

describe('a record that cannot be read', () => {
  test.each([
    ['the ledger of owned resources', '.release-qa-owned.json'],
    ['the dirty marker', '.release-qa-dirty.json'],
  ])('%s blocks the run instead of being treated as empty', async (_label, name) => {
    const calls: string[] = [];
    const { context, testRoot } = await arrange({ lifecycle: lifecycleOf(calls) });
    await mkdir(join(testRoot, name)); // a directory where the file belongs cannot be read as one
    const result = await executeScenario(context, scenarioOf());
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'dirty-environment' });
    expect(calls).toEqual([]);
  });
});

describe('waitFor', () => {
  test('gives up on a condition that never answers, as an assertion failure naming what it waited for', async () => {
    const { context } = await arrange();
    const began = Date.now();
    const result = await executeScenario(context, scenarioOf({ steps: (ctx) => ctx.waitFor(() => never().then(() => true), { timeoutMs: 80, description: 'the app to answer' }) }));
    expect(result).toMatchObject({ outcome: 'failed', reason: 'assertion-failed' });
    expect(result.detail).toContain('the app to answer');
    expect(Date.now() - began).toBeLessThan(1500);
  });

  test('treats a condition that only answers after the deadline as a timeout, not a success', async () => {
    const { context } = await arrange();
    const late = () => sleep(250).then(() => true);
    const result = await executeScenario(context, scenarioOf({ steps: (ctx) => ctx.waitFor(late, { timeoutMs: 60, description: 'a late answer' }) }));
    expect(result).toMatchObject({ outcome: 'failed', reason: 'assertion-failed' });
  });

  test('a condition that never answers does not hold up cancellation', async () => {
    const { context, controller } = await arrange();
    const running = executeScenario(context, scenarioOf({ steps: (ctx) => ctx.waitFor(() => never().then(() => true), { timeoutMs: 60_000 }) }));
    await sleep(80);
    const began = Date.now();
    controller.abort();
    const result = await running;
    expect(result.outcome).toBe('cancelled');
    expect(Date.now() - began).toBeLessThan(1500);
    // The wait stopped by itself, so the step is not an abandoned hook and the environment is not dirty.
    expect(result.cleanup).toEqual({ ok: true, failures: [] });
  });

  test('does not turn an error thrown by the condition into a timeout', async () => {
    const { context } = await arrange();
    const result = await executeScenario(context, scenarioOf({ steps: (ctx) => ctx.waitFor(() => { throw new TypeError('the driver is gone'); }, { timeoutMs: 500 }) }));
    expect(result).toMatchObject({ outcome: 'interrupted', reason: 'infrastructure-error' });
    expect(result.detail).toContain('the driver is gone');
  });
});

describe('every wait is bounded, including prerequisites and the event sink', () => {
  test('a probe that never answers is cut off by the phase deadline', async () => {
    const { context, calls } = await arrange({ probes: { display: async () => true, audio: never as unknown as () => Promise<boolean> }, timeouts: { phaseMs: 80, stepsMs: 2000, cleanupMs: 2000 } });
    const result = await executeScenario(context, scenarioOf());
    expect(result).toMatchObject({ outcome: 'interrupted', reason: 'timeout' });
    expect(result.detail).toContain('prerequisites');
    expect(calls).toEqual([]);
  });

  test('a probe that never answers does not block cancellation', async () => {
    const { context, controller } = await arrange({ probes: { display: async () => true, audio: never as unknown as () => Promise<boolean> } });
    const running = executeScenario(context, scenarioOf());
    await sleep(50);
    controller.abort();
    expect((await running).outcome).toBe('cancelled');
  });

  test('an event sink that never answers is cut off, the run stops, and cleanup still happens', async () => {
    const calls: string[] = [];
    const { context } = await arrange({
      lifecycle: lifecycleOf(calls),
      emit: (event) => (event.phase === 'install' && event.status === 'started' ? never() : undefined),
      // Shared with prerequisites: enough room to reach install on a loaded machine, where the sink then hangs.
      timeouts: { phaseMs: 300, stepsMs: 2000, cleanupMs: 2000 },
    });
    const result = await executeScenario(context, scenarioOf());
    expect(result).toMatchObject({ outcome: 'interrupted', reason: 'infrastructure-error' });
    expect(result.detail).toMatch(/event sink/);
    expect(calls).toContain('cleanup');
  });

  test('once the sink has failed it is not used again, not even to report the failure or the cleanup', async () => {
    const seen: string[] = [];
    const { context } = await arrange({
      emit: (event) => {
        seen.push(`${event.phase}:${event.status}`);
        if (event.phase === 'install' && event.status === 'started') throw new Error('sink is gone');
      },
    });
    const result = await executeScenario(context, scenarioOf());
    expect(result).toMatchObject({ outcome: 'interrupted', reason: 'infrastructure-error' });
    expect(seen.at(-1)).toBe('install:started');
    expect(seen.some((entry) => entry.startsWith('cleanup'))).toBe(false);
  });

  test('a failing event sink during cleanup is reported in the result and leaves the environment dirty', async () => {
    const { context, testRoot } = await arrange({ emit: (event) => { if (event.phase === 'cleanup') throw new Error('sink is full'); } });
    const result = await executeScenario(context, scenarioOf());
    expect(result.outcome).toBe('passed');
    expect(result.cleanup.ok).toBe(false);
    expect(result.cleanup.failures.join(' ')).toMatch(/event sink/);
    expect(await readDirty(testRoot)).toBeDefined();
  });
});

describe('hooks that outlive their phase', () => {
  test('a hook that ignores cancellation and never finishes leaves the environment dirty', async () => {
    const calls: string[] = [];
    const { context, controller, testRoot } = await arrange({
      lifecycle: lifecycleOf(calls, { install: () => { calls.push('install'); return never(); } }),
      timeouts: { phaseMs: 2000, stepsMs: 2000, cleanupMs: 2000, abandonedGraceMs: 50 },
    });
    const running = executeScenario(context, scenarioOf());
    await eventually(() => calls.includes('install'));
    controller.abort();

    const result = await running;

    expect(result.outcome).toBe('cancelled');
    expect(result.cleanup.ok).toBe(false);
    expect(result.cleanup.failures.join(' ')).toMatch(/install.*(abandoned|still running)/i);
    expect(await readDirty(testRoot)).toBeDefined();
    // The first run's signal is spent, so the next run gets its own.
    expect((await executeScenario({ ...context, signal: new AbortController().signal }, scenarioOf())).reason).toBe('dirty-environment');
  });

  // The phase budget is shared with prerequisites, so it must leave room to reach install on a loaded machine;
  // otherwise prerequisites time out instead and this passes without testing an install being cut off at all.
  test('a hook that stops soon after being cut off does not dirty the environment', async () => {
    const { context } = await arrange({
      lifecycle: lifecycleOf([], { install: () => sleep(900) }),
      timeouts: { phaseMs: 300, stepsMs: 2000, cleanupMs: 2000, abandonedGraceMs: 3000 },
    });
    const result = await executeScenario(context, scenarioOf());
    expect(result).toMatchObject({ outcome: 'interrupted', reason: 'timeout' });
    expect(result.detail).toContain('install');
    expect(result.cleanup.ok).toBe(true);
  });

  // The hook waits for its own phase signal to abort, rather than for a fixed sleep to elapse, and the cutoff is the
  // phase's own deadline (not an outer cancellation) so these still cover a hook actually outliving its phase. The
  // deadline itself is 300 ms, not the original 30 ms: prerequisites shares the same budget (idle cost measured at
  // 1-4 ms), and 30 ms left far too little margin for a loaded or slow CI machine to complete prerequisites and
  // enter install before the deadline fired, which is exactly what made these two tests flaky on Windows CI.
  test('a late spawn from a hook that was cut off is refused and starts nothing', async () => {
    let refused: unknown;
    const calls: string[] = [];
    // The child would write this file if it were ever allowed to run; it lives in a scratch directory, never the repo.
    const markerFile = join(await makeTempDir('qa-late-'), 'late-spawn-marker');
    const { context, testRoot } = await arrange({
      lifecycle: lifecycleOf(calls, {
        install: async (ctx) => {
          calls.push('install');
          await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
          try {
            await ctx.spawn('late', process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(markerFile)}, 'x'); setInterval(() => {}, 1000)`], { stdio: 'ignore' });
          } catch (error) {
            refused = error;
          }
        },
      }),
      timeouts: { phaseMs: 300, stepsMs: 2000, cleanupMs: 2000, abandonedGraceMs: 400 },
    });

    const result = await executeScenario(context, scenarioOf());

    expect(calls).toContain('install'); // reached the phase whose deadline is under test, not cut off earlier
    expect(result).toMatchObject({ outcome: 'interrupted', reason: 'timeout' });
    expect(refused).toBeInstanceOf(Error);
    expect(String((refused as Error).message)).toMatch(/stopped|no longer/i);
    expect(await readLedger(testRoot)).toEqual([]);
    expect(await exists(markerFile)).toBe(false);
  });

  test('a late claim of ownership from a hook that was cut off is refused', async () => {
    let refused: unknown;
    let root = '';
    const calls: string[] = [];
    const { context, testRoot } = await arrange({
      lifecycle: lifecycleOf(calls, {
        install: async (ctx) => {
          calls.push('install');
          await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
          try {
            await ctx.own({ kind: 'path', path: join(root, 'late'), label: 'late' });
          } catch (error) {
            refused = error;
          }
        },
      }),
      timeouts: { phaseMs: 300, stepsMs: 2000, cleanupMs: 2000, abandonedGraceMs: 400 },
    });
    root = testRoot;
    const result = await executeScenario(context, scenarioOf());
    expect(calls).toContain('install');
    expect(result).toMatchObject({ outcome: 'interrupted', reason: 'timeout' });
    expect(refused).toBeInstanceOf(Error);
    expect(await readLedger(testRoot)).toEqual([]);
  });
});

describe('one run at a time per test root', () => {
  test('a second run on a root that is in use is refused, and the first is unaffected', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { context } = await arrange({ lifecycle: lifecycleOf(calls) });
    const first = executeScenario(context, scenarioOf({ steps: async () => { calls.push('first-steps'); await gate; } }));
    await eventually(() => calls.includes('first-steps'));

    const second = await executeScenario(context, scenarioOf());

    expect(second).toMatchObject({ outcome: 'blocked', reason: 'environment-busy' });
    expect(second.detail).toContain(String(process.pid));
    expect(calls.filter((c) => c === 'install')).toHaveLength(1);

    release();
    expect((await first).outcome).toBe('passed');
    expect((await executeScenario(context, scenarioOf())).outcome).toBe('passed');
  });

  test.each([
    ['fails', () => scenarioOf({ steps: async () => { throw new Error('boom'); } })],
    ['is blocked', () => scenarioOf()],
  ])('the root is free again after a run that %s', async (label) => {
    const { context } = await arrange(label === 'is blocked' ? { probes: { display: async () => false, audio: async () => false } } : {});
    const requirementNeedingDisplay = scenarioOf({ requirement: { ...scenarioOf().requirement, capabilities: label === 'is blocked' ? ['display'] : [] } });
    await executeScenario(context, label === 'is blocked' ? requirementNeedingDisplay : scenarioOf({ steps: async () => { throw new Error('boom'); } }));
    const again = await executeScenario({ ...context, probes: { display: async () => true, audio: async () => true } }, scenarioOf());
    expect(again.outcome).toBe('passed');
  });

  test('the root is free again after a cancelled run', async () => {
    const { context, controller } = await arrange();
    const running = executeScenario(context, scenarioOf({ steps: (ctx) => ctx.waitFor(() => false, { timeoutMs: 5000, intervalMs: 10 }) }));
    await sleep(80);
    controller.abort();
    expect((await running).outcome).toBe('cancelled');
    expect((await executeScenario({ ...context, signal: new AbortController().signal }, scenarioOf())).outcome).toBe('passed');
  });

  test('a lock left by a process that is gone does not block a run', async () => {
    const { context, testRoot } = await arrange();
    const dead = startUnrelatedProcess();
    const pid = dead.pid as number;
    const identity = await processIdentity(pid);
    dead.kill('SIGKILL');
    await eventually(() => !isAlive(pid));
    await writeFile(join(testRoot, '.release-qa-lock.json'), JSON.stringify({ pid, identity }));
    expect((await executeScenario(context, scenarioOf())).outcome).toBe('passed');
  });
});

