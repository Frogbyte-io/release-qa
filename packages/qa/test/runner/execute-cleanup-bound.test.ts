// Reaping what a run owns can take a long time (a grace period per process), so it is bounded like everything else.
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { executeScenario } from '../../src/runner/execute.ts';
import { readDirty, readLedger } from '../../src/runner/resources.ts';
import { arrange, never, scenarioOf } from '../fixtures/execution.ts';
import { cleanUpProcessesAndRoots } from '../fixtures/processes.ts';

vi.setConfig({ testTimeout: 30_000 });

const reaper = vi.hoisted(() => ({ hang: false }));

vi.mock('../../src/runner/resources.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/runner/resources.ts')>();
  return {
    ...real,
    cleanupOwnedResources: (...args: Parameters<typeof real.cleanupOwnedResources>) => (reaper.hang ? never().then(() => ({ removed: [], failures: [] })) : real.cleanupOwnedResources(...args)),
  };
});

afterEach(async () => {
  reaper.hang = false;
  await cleanUpProcessesAndRoots();
});

test('reaping owned resources that never finishes is cut off at the cleanup deadline and leaves the environment dirty', async () => {
  const { context, testRoot } = await arrange({ timeouts: { phaseMs: 2000, stepsMs: 2000, cleanupMs: 300 } });
  const owned = { kind: 'path', path: join(testRoot, 'left-behind'), label: 'left behind' } as const;
  reaper.hang = true;

  const began = Date.now();
  const result = await executeScenario(context, scenarioOf({ steps: (ctx) => ctx.own(owned) }));
  const elapsed = Date.now() - began;

  // The wait ended because the cleanup deadline passed: not sooner, and not at some much later limit.
  expect(elapsed).toBeGreaterThanOrEqual(250);
  expect(elapsed).toBeLessThan(1500);
  expect(result.outcome).toBe('passed'); // the candidate did nothing wrong; the environment is what is in doubt
  expect(result.cleanup.ok).toBe(false);
  expect(result.cleanup.failures.join(' ')).toMatch(/owned resources.*timed out/i);
  expect(await readDirty(testRoot)).toBeDefined();
  expect(await readLedger(testRoot)).toEqual([owned]); // what reaping did not get to is still on the ledger
});

test('reaping that finishes in time is unaffected', async () => {
  const { context } = await arrange({ timeouts: { phaseMs: 2000, stepsMs: 2000, cleanupMs: 2000 } });
  const result = await executeScenario(context, scenarioOf());
  expect(result).toMatchObject({ outcome: 'passed', cleanup: { ok: true, failures: [] } });
});
