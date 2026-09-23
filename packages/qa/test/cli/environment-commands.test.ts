import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { runDesignate, runReset, runStatus } from '../../src/cli/environment-commands.ts';
import { acquireTestRoot, markDirty, readDirty, readLedger, recordOwned, spawnOwned } from '../../src/runner/resources.ts';
import { cleanUpProcessesAndRoots, makeTempDir, makeTestRoot, trackProcess } from '../fixtures/processes.ts';

// Reading a process's identity starts PowerShell on Windows, which can take seconds on a busy CI runner.
vi.setConfig({ testTimeout: 30_000 });
afterEach(cleanUpProcessesAndRoots);

describe('designate', () => {
  test('marks a fresh directory as a test root', async () => {
    const root = await makeTestRoot(false);
    const result = await runDesignate(root);
    expect(result).toEqual({ ok: true, root });
    expect((await runStatus(root)).ok).toBe(true);
  });

  // A throwaway "home" (never the real one): a wrong implementation would write into it, and that is exactly the
  // mistake this test exists to catch, without any risk to the machine actually running the suite.
  test('refuses the home directory, and reports why, instead of throwing', async () => {
    const home = await makeTempDir('qa-cli-home-');
    const result = await runDesignate(home, { home });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/unsafe/i);
  });
});

describe('status', () => {
  test('an undesignated directory is reported as such, not as an error', async () => {
    const root = await makeTestRoot(false);
    const result = await runStatus(root);
    expect(result).toEqual({ ok: true, report: { root, designated: false, reason: 'missing-marker', owned: [] } });
  });

  test('a designated, clean, empty root is reported clean', async () => {
    const root = await makeTestRoot();
    const result = await runStatus(root);
    // checkTestRoot reports the resolved path, which on some machines (e.g. an 8.3 short name in the temp path)
    // is not byte-identical to the path this test created the directory with, though both name the same directory.
    expect(result).toEqual({ ok: true, report: { root: await realpath(root), designated: true, owned: [] } });
  });

  test('reports what the root owns', async () => {
    const root = await makeTestRoot();
    const child = await spawnOwned(root, 'helper', process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    trackProcess(child);
    const result = await runStatus(root);
    if (!result.ok) throw new Error(result.error);
    expect(result.report.owned).toHaveLength(1);
  });

  test('reports why the environment is dirty', async () => {
    const root = await makeTestRoot();
    await markDirty(root, 'a previous run left the app installed');
    const result = await runStatus(root);
    expect(result).toEqual({ ok: true, report: { root: await realpath(root), designated: true, dirty: 'a previous run left the app installed', owned: [] } });
  });

  test('an unreadable ledger is a command error, not a silently empty report', async () => {
    const root = await makeTestRoot();
    await mkdir(join(root, '.release-qa-owned.json'));
    const result = await runStatus(root);
    expect(result.ok).toBe(false);
  });

  test('a directory that is not a directory at all is reported, not thrown', async () => {
    const root = await makeTestRoot();
    const file = join(root, 'not-a-root');
    await writeFile(file, 'x');
    const result = await runStatus(file);
    expect(result).toEqual({ ok: true, report: { root: file, designated: false, reason: 'not-a-directory', owned: [] } });
  });
});

describe('reset', () => {
  test('reaps what an earlier run left owned and clears the dirty marker', async () => {
    const root = await makeTestRoot();
    const leftover = join(root, 'installed-app');
    await mkdir(leftover);
    await recordOwned(root, { kind: 'path', path: leftover, label: 'installed app' });
    await markDirty(root, 'a run crashed');

    const result = await runReset(root);

    expect(result).toEqual({ ok: true, root: await realpath(root), failures: [] });
    expect(await readDirty(root)).toBeUndefined();
    expect(await readLedger(root)).toEqual([]);
    expect(await stat(leftover).then(() => true, () => false)).toBe(false);
  });

  test('reports what it could not clean, and leaves the environment dirty', async () => {
    const root = await makeTestRoot();
    const outside = await makeTempDir('qa-outside-');
    await recordOwned(root, { kind: 'path', path: outside, label: 'not really ours' });
    await markDirty(root, 'a run crashed');

    const result = await runReset(root);

    expect(result.ok && result.failures.join(' ')).toMatch(/not really ours.*outside-test-root/);
    expect(await readDirty(root)).toBeDefined();
    expect(await stat(outside).then(() => true, () => false)).toBe(true);
  });

  test('refuses a directory that is not a designated test root, touching nothing', async () => {
    const root = await makeTestRoot(false);
    const result = await runReset(root);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('missing-marker');
  });

  test('refuses while a run holds the root, so it cannot reap resources out from under it', async () => {
    const root = await makeTestRoot();
    const lock = await acquireTestRoot(root);
    try {
      const result = await runReset(root);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toContain(String(process.pid));
    } finally {
      if (lock.ok) await lock.release();
    }
  });
});

describe('the root check itself failing', () => {
  // Torn down here rather than at the end of the test, so a failed assertion cannot leave the mock registered and
  // confusingly break whatever test happens to run after this one.
  afterEach(async () => {
    vi.doUnmock('../../src/runner/resources.ts');
    vi.resetModules();
  });

  test('a root removed between the existence check and resolving it is a command error, not a thrown exception', async () => {
    // checkTestRoot can throw (not return a TestRootCheck) if the directory is removed in that narrow window; this
    // is the only way to exercise that path deterministically rather than racing the real filesystem for it.
    vi.doMock('../../src/runner/resources.ts', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/runner/resources.ts')>();
      return { ...real, checkTestRoot: async () => { throw new Error('ENOENT: no longer there'); } };
    });
    vi.resetModules();
    const { runStatus: runStatusWithBrokenCheck } = await import('../../src/cli/environment-commands.ts');

    const result = await runStatusWithBrokenCheck(await makeTestRoot());

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('no longer there');
  });
});
