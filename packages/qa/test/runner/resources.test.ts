import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  checkTestRoot,
  cleanupOwnedResources,
  designateTestRoot,
  markDirty,
  processIdentity,
  readDirty,
  readLedger,
  recordOwned,
  resetDirtyEnvironment,
  spawnOwned,
  TEST_ROOT_MARKER,
} from '../../src/runner/resources.ts';
import { cleanUpProcessesAndRoots, eventually, isAlive, makeTempDir, makeTestRoot, startUnrelatedProcess, trackProcess } from '../fixtures/processes.ts';

// Reading a process's identity starts PowerShell on Windows, which can take seconds on a busy CI runner.
vi.setConfig({ testTimeout: 30_000 });

afterEach(cleanUpProcessesAndRoots);

const exists = (path: string) => stat(path).then(() => true, () => false);
const sleeper = ['-e', 'setInterval(() => {}, 1000)'];

describe('designating a test root', () => {
  test('a designated directory is accepted and reported by its resolved path', async () => {
    const root = await makeTestRoot();
    const check = await checkTestRoot(root);
    expect(check.ok).toBe(true);
    expect(await readFile(join(root, TEST_ROOT_MARKER), 'utf8')).toContain('release-qa');
  });

  test('a directory nobody designated is refused, however harmless it looks', async () => {
    const root = await makeTestRoot(false);
    expect(await checkTestRoot(root)).toEqual({ ok: false, reason: 'missing-marker' });
    await designateTestRoot(root);
    expect((await checkTestRoot(root)).ok).toBe(true);
  });

  test.each([
    ['a file of the same name from another tool', JSON.stringify({ purpose: 'something-else' })],
    ['a marker that is not JSON', 'not json'],
    ['an empty marker', ''],
  ])('a marker holding %s does not designate a test root', async (_label, content) => {
    const root = await makeTestRoot(false);
    await writeFile(join(root, TEST_ROOT_MARKER), content);
    expect(await checkTestRoot(root)).toEqual({ ok: false, reason: 'missing-marker' });
  });

  test('a path that is not a directory is refused', async () => {
    const root = await makeTestRoot();
    const file = join(root, 'a-file');
    await writeFile(file, 'x');
    expect(await checkTestRoot(file)).toEqual({ ok: false, reason: 'not-a-directory' });
    expect(await checkTestRoot(join(root, 'missing'))).toEqual({ ok: false, reason: 'not-a-directory' });
  });

  // These tests never write into a real home directory: a wrong implementation would mark it, and that is
  // exactly the mistake they exist to catch. They use a throwaway "home" and only ever *read* the real one.
  test('the real home directory and the filesystem root are never a test root (read-only check)', async () => {
    expect(await checkTestRoot(homedir())).toEqual({ ok: false, reason: 'unsafe-root' });
    expect(await checkTestRoot(parse(tmpdir()).root)).toEqual({ ok: false, reason: 'unsafe-root' });
  });

  test('the home directory, and a directory that contains it, are never a test root, marker or not', async () => {
    const outer = await makeTempDir('qa-outer-');
    const home = join(outer, 'home');
    await mkdir(home);
    expect(await checkTestRoot(home, { home })).toEqual({ ok: false, reason: 'unsafe-root' });
    expect(await checkTestRoot(outer, { home })).toEqual({ ok: false, reason: 'unsafe-root' });
    // A directory inside the home directory is fine.
    const inside = join(home, 'qa-tests');
    await mkdir(inside);
    await designateTestRoot(inside, { home });
    expect((await checkTestRoot(inside, { home })).ok).toBe(true);
    await rm(outer, { recursive: true, force: true });
  });

  test('designating refuses to mark the home directory or a directory that contains it, and writes nothing', async () => {
    const outer = await makeTempDir('qa-outer-');
    const home = join(outer, 'home');
    await mkdir(home);
    await expect(designateTestRoot(home, { home })).rejects.toThrow(/unsafe/i);
    await expect(designateTestRoot(outer, { home })).rejects.toThrow(/unsafe/i);
    expect(await exists(join(home, TEST_ROOT_MARKER))).toBe(false);
    expect(await exists(join(outer, TEST_ROOT_MARKER))).toBe(false);
    await rm(outer, { recursive: true, force: true });
  });
});

describe('the ledger of owned resources', () => {
  test('a recorded resource is on disk before anything else can happen', async () => {
    const root = await makeTestRoot();
    await recordOwned(root, { kind: 'path', path: join(root, 'app'), label: 'install dir' });
    expect(await readLedger(root)).toEqual([{ kind: 'path', path: join(root, 'app'), label: 'install dir' }]);
  });

  test('an empty or missing ledger reads as empty', async () => {
    expect(await readLedger(await makeTestRoot())).toEqual([]);
  });

  test.each([
    ['a process without a pid', { kind: 'process', identity: 'x', label: 'p' }],
    ['a process without an identity', { kind: 'process', pid: 42, label: 'p' }],
    ['a path that is not a string', { kind: 'path', path: 7, label: 'p' }],
    ['an unknown kind', { kind: 'socket', label: 'p' }],
    ['something that is not an object', 'a string'],
  ])('a ledger holding %s is refused instead of being trusted', async (_label, entry) => {
    const root = await makeTestRoot();
    await writeFile(join(root, '.release-qa-owned.json'), JSON.stringify({ schemaVersion: 1, resources: [entry] }));
    await expect(readLedger(root)).rejects.toThrow(/ledger/);
  });

  test('a ledger that is unreadable is not silently treated as empty', async () => {
    const root = await makeTestRoot();
    await writeFile(join(root, '.release-qa-owned.json'), '{ not json');
    await expect(readLedger(root)).rejects.toThrow();
  });
});

describe('spawning owned processes', () => {
  test('records the process and its identity in the ledger before handing it back', async () => {
    const root = await makeTestRoot();
    const child = await spawnOwned(root, 'helper', process.execPath, sleeper, { stdio: 'ignore' });
    trackProcess(child);
    const [entry] = await readLedger(root);
    expect(entry).toMatchObject({ kind: 'process', pid: child.pid, label: 'helper' });
    expect(entry?.kind === 'process' && entry.identity.length).toBeGreaterThan(0);
    expect(isAlive(child.pid as number)).toBe(true);
  });

  test('the identity of a live process is stable and differs between processes', async () => {
    const a = startUnrelatedProcess();
    // A start time has the granularity of the operating system's clock (10 ms on Linux); two processes started in the
    // same tick share one, which is harmless because an identity is only ever compared under the same pid.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const b = startUnrelatedProcess();
    const first = await processIdentity(a.pid as number);
    expect(first).toBeDefined();
    expect(await processIdentity(a.pid as number)).toBe(first);
    expect(await processIdentity(b.pid as number)).not.toBe(first);
  });

  test('a process that does not exist has no identity', async () => {
    const child = startUnrelatedProcess();
    const pid = child.pid as number;
    expect(await processIdentity(pid)).toBeDefined();
    child.kill('SIGKILL');
    await eventually(() => !isAlive(pid));
    expect(await processIdentity(pid)).toBeUndefined();
  });
});

describe('cleaning up', () => {
  test('stops the processes it owns and leaves an unrelated process running', async () => {
    const root = await makeTestRoot();
    const owned = await spawnOwned(root, 'helper', process.execPath, sleeper, { stdio: 'ignore' });
    trackProcess(owned);
    const unrelated = startUnrelatedProcess();

    const result = await cleanupOwnedResources(root, { graceMs: 500 });

    expect(result.failures).toEqual([]);
    expect(result.removed).toHaveLength(1);
    await eventually(() => !isAlive(owned.pid as number));
    expect(isAlive(unrelated.pid as number)).toBe(true);
    expect(await readLedger(root)).toEqual([]);
  });

  test('never signals a process whose pid was reused by something else', async () => {
    const root = await makeTestRoot();
    const stranger = startUnrelatedProcess();
    // The ledger remembers a process that once had this pid; the pid now belongs to a stranger.
    await recordOwned(root, { kind: 'process', pid: stranger.pid as number, identity: 'the-original-process', label: 'gone' });
    expect(await readLedger(root)).toHaveLength(1);

    const result = await cleanupOwnedResources(root, { graceMs: 200 });

    expect(isAlive(stranger.pid as number)).toBe(true);
    expect(result.failures).toEqual([]);
    expect(await readLedger(root)).toEqual([]);
  });

  test('refuses to kill a live process it cannot identify, and keeps it on the ledger', async () => {
    const root = await makeTestRoot();
    const child = await spawnOwned(root, 'helper', process.execPath, sleeper, { stdio: 'ignore' });
    trackProcess(child);
    const result = await cleanupOwnedResources(root, { graceMs: 200, identityOf: async () => undefined });
    expect(isAlive(child.pid as number)).toBe(true);
    expect(result.failures.map((f) => f.reason)).toEqual(['identity-unknown']);
    expect(await readLedger(root)).toHaveLength(1);
  });

  test('a process that already exited is dropped from the ledger without a failure', async () => {
    const root = await makeTestRoot();
    const child = await spawnOwned(root, 'helper', process.execPath, sleeper, { stdio: 'ignore' });
    trackProcess(child);
    child.kill('SIGKILL');
    await eventually(() => !isAlive(child.pid as number));
    expect((await cleanupOwnedResources(root)).failures).toEqual([]);
    expect(await readLedger(root)).toEqual([]);
  });

  test.skipIf(process.platform === 'win32')('forces a process that ignores the polite request', async () => {
    const root = await makeTestRoot();
    const child = await spawnOwned(root, 'stubborn', process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
    trackProcess(child);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const result = await cleanupOwnedResources(root, { graceMs: 200 });
    expect(result.failures).toEqual([]);
    await eventually(() => !isAlive(child.pid as number));
  });

  test('removes directories and files it owns inside the test root', async () => {
    const root = await makeTestRoot();
    const dir = join(root, 'install');
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(join(dir, 'nested', 'app.exe'), 'x');
    const file = join(root, 'settings.json');
    await writeFile(file, '{}');
    await recordOwned(root, { kind: 'path', path: dir, label: 'install' });
    await recordOwned(root, { kind: 'path', path: file, label: 'settings' });

    const result = await cleanupOwnedResources(root);

    expect(result.failures).toEqual([]);
    expect(await exists(dir)).toBe(false);
    expect(await exists(file)).toBe(false);
    expect(await exists(root)).toBe(true);
    expect(await readLedger(root)).toEqual([]);
  });

  test('a path that is already gone is not a failure', async () => {
    const root = await makeTestRoot();
    await recordOwned(root, { kind: 'path', path: join(root, 'never-created'), label: 'x' });
    expect(await readLedger(root)).toHaveLength(1);
    expect((await cleanupOwnedResources(root)).failures).toEqual([]);
    expect(await readLedger(root)).toEqual([]);
  });

  test('refuses a path outside the test root and leaves it untouched', async () => {
    const root = await makeTestRoot();
    const outside = await makeTempDir('qa-outside-');
    await writeFile(join(outside, 'precious.txt'), 'keep me');
    await recordOwned(root, { kind: 'path', path: outside, label: 'wrong' });

    const result = await cleanupOwnedResources(root);

    expect(result.failures.map((f) => f.reason)).toEqual(['outside-test-root']);
    expect(await readFile(join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
    expect(await readLedger(root)).toHaveLength(1);
    await rm(outside, { recursive: true, force: true });
  });

  test('refuses to remove the test root itself', async () => {
    const root = await makeTestRoot();
    await recordOwned(root, { kind: 'path', path: root, label: 'the root' });
    const result = await cleanupOwnedResources(root);
    expect(result.failures.map((f) => f.reason)).toEqual(['is-test-root']);
    expect(await exists(join(root, TEST_ROOT_MARKER))).toBe(true);
  });

  test('refuses a path that reaches outside the root through ".."', async () => {
    const root = await makeTestRoot();
    const sibling = await makeTempDir('qa-sibling-');
    await writeFile(join(sibling, 'precious.txt'), 'keep me');
    await recordOwned(root, { kind: 'path', path: join(root, '..', sibling.split(/[\\/]/).pop() as string), label: 'sneaky' });
    const result = await cleanupOwnedResources(root);
    expect(result.failures.map((f) => f.reason)).toEqual(['outside-test-root']);
    expect(await readFile(join(sibling, 'precious.txt'), 'utf8')).toBe('keep me');
    await rm(sibling, { recursive: true, force: true });
  });

  test('refuses a directory inside the root that is really a link to somewhere else, and leaves the target alone', async () => {
    const root = await makeTestRoot();
    const target = await makeTempDir('qa-target-');
    await writeFile(join(target, 'precious.txt'), 'keep me');
    const link = join(root, 'looks-inside');
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    await recordOwned(root, { kind: 'path', path: link, label: 'link' });

    const result = await cleanupOwnedResources(root);

    expect(result.failures.map((f) => f.reason)).toEqual(['outside-test-root']);
    expect(await readFile(join(target, 'precious.txt'), 'utf8')).toBe('keep me');
    await rm(target, { recursive: true, force: true });
  });

  test('refuses a link even when it points at somewhere else inside the root, and leaves both alone', async () => {
    const root = await makeTestRoot();
    const target = join(root, 'real');
    await mkdir(target);
    await writeFile(join(target, 'keep.txt'), 'keep me');
    const link = join(root, 'alias');
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    await recordOwned(root, { kind: 'path', path: link, label: 'alias' });

    const result = await cleanupOwnedResources(root);

    expect(result.failures.map((f) => f.reason)).toEqual(['is-link']);
    expect(await readFile(join(target, 'keep.txt'), 'utf8')).toBe('keep me');
    expect(await exists(link)).toBe(true);
  });

  test('keeps only the resources it could not clean on the ledger', async () => {
    const root = await makeTestRoot();
    const fine = join(root, 'fine');
    await mkdir(fine);
    const outside = await makeTempDir('qa-outside-');
    await recordOwned(root, { kind: 'path', path: fine, label: 'fine' });
    await recordOwned(root, { kind: 'path', path: outside, label: 'outside' });

    const result = await cleanupOwnedResources(root);

    expect(result.removed.map((r) => r.label)).toEqual(['fine']);
    expect((await readLedger(root)).map((r) => r.label)).toEqual(['outside']);
    await rm(outside, { recursive: true, force: true });
  });
});

describe('a dirty environment', () => {
  test('is dirty when a marker says so, with the reason', async () => {
    const root = await makeTestRoot();
    expect(await readDirty(root)).toBeUndefined();
    await markDirty(root, 'cleanup hook failed');
    expect(await readDirty(root)).toBe('cleanup hook failed');
  });

  test('is cleaned by a reset: owned processes stop, the marker clears, the ledger empties', async () => {
    const root = await makeTestRoot();
    const child = await spawnOwned(root, 'helper', process.execPath, sleeper, { stdio: 'ignore' });
    trackProcess(child);
    await markDirty(root, 'runner crashed');

    const result = await resetDirtyEnvironment(root, { graceMs: 300 });

    expect(result.failures).toEqual([]);
    await eventually(() => !isAlive(child.pid as number));
    expect(await readDirty(root)).toBeUndefined();
    expect(await readLedger(root)).toEqual([]);
  });

  test('stays dirty when a reset could not clean everything', async () => {
    const root = await makeTestRoot();
    const outside = await makeTempDir('qa-outside-');
    await recordOwned(root, { kind: 'path', path: outside, label: 'outside' });
    await markDirty(root, 'x');

    const result = await resetDirtyEnvironment(root);

    expect(result.failures).toHaveLength(1);
    expect(await readDirty(root)).toBeDefined();
    await rm(outside, { recursive: true, force: true });
  });
});
