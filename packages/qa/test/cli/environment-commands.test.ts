import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { runDesignate, runStatus } from '../../src/cli/environment-commands.ts';
import { spawnOwned, markDirty } from '../../src/runner/resources.ts';
import { cleanUpProcessesAndRoots, makeTempDir, makeTestRoot, trackProcess } from '../fixtures/processes.ts';

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
    expect(result).toEqual({ ok: true, report: { root, designated: true, owned: [] } });
  });

  test('reports what the root owns', async () => {
    const root = await makeTestRoot();
    const child = await spawnOwned(root, 'helper', process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    trackProcess(child);
    const result = await runStatus(root);
    expect(result.ok && result.report.owned).toHaveLength(1);
  });

  test('reports why the environment is dirty', async () => {
    const root = await makeTestRoot();
    await markDirty(root, 'a previous run left the app installed');
    const result = await runStatus(root);
    expect(result).toEqual({ ok: true, report: { root, designated: true, dirty: 'a previous run left the app installed', owned: [] } });
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
