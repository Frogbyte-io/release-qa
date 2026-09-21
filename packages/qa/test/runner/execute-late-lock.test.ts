// A lock acquired by prerequisites that were cut off must not outlive the run, or nothing could use the root again.
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { executeScenario } from '../../src/runner/execute.ts';
import { acquireTestRoot } from '../../src/runner/resources.ts';
import { arrange, scenarioOf } from '../fixtures/execution.ts';
import { cleanUpProcessesAndRoots, eventually } from '../fixtures/processes.ts';

vi.setConfig({ testTimeout: 30_000 });

const slow = vi.hoisted(() => ({ delayMs: 0, onAcquired: undefined as (() => void) | undefined }));

vi.mock('../../src/runner/resources.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/runner/resources.ts')>();
  return {
    ...real,
    acquireTestRoot: async (root: string) => {
      await new Promise((resolve) => setTimeout(resolve, slow.delayMs));
      const lock = await real.acquireTestRoot(root);
      slow.onAcquired?.();
      return lock;
    },
  };
});

afterEach(async () => {
  slow.delayMs = 0;
  slow.onAcquired = undefined;
  await cleanUpProcessesAndRoots();
});

test('a lock taken after the prerequisites were cut off is given straight back', async () => {
  const { context, testRoot } = await arrange({ timeouts: { phaseMs: 40, stepsMs: 2000, cleanupMs: 2000 } });
  const lockFile = join(testRoot, '.release-qa-lock.json');
  const exists = () => stat(lockFile).then(() => true, () => false);
  slow.delayMs = 250; // the disk is slow: the deadline passes before the lock is taken
  const lateAcquisition = new Promise<void>((resolve) => { slow.onAcquired = resolve; });

  const result = await executeScenario(context, scenarioOf());
  expect(result).toMatchObject({ outcome: 'interrupted', reason: 'timeout' });

  // Wait for the lock to actually be taken, then for it to be handed back; a check made before the late acquisition
  // would find no lock either way and prove nothing.
  await lateAcquisition;
  await eventually(async () => !(await exists()));
  slow.delayMs = 0;
  const lock = await acquireTestRoot(testRoot);
  expect(lock.ok).toBe(true);
  if (lock.ok) await lock.release();
});
