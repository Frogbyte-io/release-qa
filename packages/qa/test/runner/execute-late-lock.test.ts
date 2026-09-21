// A lock acquired by prerequisites that were cut off must not outlive the run, or nothing could use the root again.
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { executeScenario } from '../../src/runner/execute.ts';
import { acquireTestRoot } from '../../src/runner/resources.ts';
import { arrange, scenarioOf, sleep } from '../fixtures/execution.ts';
import { cleanUpProcessesAndRoots } from '../fixtures/processes.ts';

const slow = vi.hoisted(() => ({ delayMs: 0 }));

vi.mock('../../src/runner/resources.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/runner/resources.ts')>();
  return {
    ...real,
    acquireTestRoot: async (root: string) => {
      await new Promise((resolve) => setTimeout(resolve, slow.delayMs));
      return real.acquireTestRoot(root);
    },
  };
});

afterEach(async () => {
  slow.delayMs = 0;
  await cleanUpProcessesAndRoots();
});

test('a lock taken after the prerequisites were cut off is given straight back', async () => {
  const { context, testRoot } = await arrange({ timeouts: { phaseMs: 40, stepsMs: 2000, cleanupMs: 2000 } });
  slow.delayMs = 250; // the disk is slow: the deadline passes before the lock is taken

  const result = await executeScenario(context, scenarioOf());
  expect(result).toMatchObject({ outcome: 'interrupted', reason: 'timeout' });

  await sleep(600);
  const lockFile = join(testRoot, '.release-qa-lock.json');
  expect(await stat(lockFile).then(() => true, () => false)).toBe(false);
  slow.delayMs = 0;
  const lock = await acquireTestRoot(testRoot);
  expect(lock.ok).toBe(true);
  if (lock.ok) await lock.release();
});
