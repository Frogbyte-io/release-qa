// Behaviours found by review of the first version of the resource code. Each one is a way that cleanup or
// ownership could touch, or fail to stop, the wrong process.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { acquireTestRoot, cleanupOwnedResources, processIdentity, readLedger, recordOwned, spawnOwned } from '../../src/runner/resources.ts';
import { cleanUpProcessesAndRoots, eventually, isAlive, makeTestRoot, startUnrelatedProcess, trackProcess } from '../fixtures/processes.ts';

afterEach(cleanUpProcessesAndRoots);

const sleeper = ['-e', 'setInterval(() => {}, 1000)'];
const exists = (path: string) => stat(path).then(() => true, () => false);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const owner = async (root: string) => JSON.parse(await readFile(join(root, '.release-qa-lock.json'), 'utf8')) as { pid: number };

describe('forcing a process that ignores the polite request', () => {
  // The polite request has no effect here (the seam records it and does nothing), as if the process ignored it.
  const fakeKill = () => {
    const signals: string[] = [];
    return { signals, kill: (_pid: number, signal?: NodeJS.Signals) => { signals.push(signal ?? 'SIGTERM'); } };
  };

  test('never force-kills a pid that now belongs to another process', async () => {
    const root = await makeTestRoot();
    const stranger = startUnrelatedProcess();
    await recordOwned(root, { kind: 'process', pid: stranger.pid as number, identity: 'original', label: 'gone' });
    const { signals, kill } = fakeKill();
    let lookups = 0;

    const result = await cleanupOwnedResources(root, { graceMs: 100, escalate: true, kill, identityOf: async () => (++lookups === 1 ? 'original' : 'someone-else') });

    expect(signals).toEqual(['SIGTERM']);
    expect(isAlive(stranger.pid as number)).toBe(true);
    expect(result.failures).toEqual([]);
    expect(await readLedger(root)).toEqual([]);
  });

  test('force-kills when the very same process is still there after the grace period', async () => {
    const root = await makeTestRoot();
    const child = startUnrelatedProcess();
    await recordOwned(root, { kind: 'process', pid: child.pid as number, identity: 'original', label: 'stubborn' });
    const { signals, kill } = fakeKill();

    const result = await cleanupOwnedResources(root, { graceMs: 100, escalate: true, kill, identityOf: async () => 'original' });

    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    // The fake signals do nothing, so the process is honestly reported as still running.
    expect(result.failures.map((f) => f.reason)).toEqual(['still-running']);
    expect(await readLedger(root)).toHaveLength(1);
  });

  test('leaves a process alone, and reports it, when it cannot be re-identified before escalating', async () => {
    const root = await makeTestRoot();
    const child = startUnrelatedProcess();
    await recordOwned(root, { kind: 'process', pid: child.pid as number, identity: 'original', label: 'stubborn' });
    const { signals, kill } = fakeKill();
    let lookups = 0;

    const result = await cleanupOwnedResources(root, { graceMs: 100, escalate: true, kill, identityOf: async () => (++lookups === 1 ? 'original' : undefined) });

    expect(signals).toEqual(['SIGTERM']);
    expect(result.failures.map((f) => f.reason)).toEqual(['identity-unknown']);
    expect(isAlive(child.pid as number)).toBe(true);
  });

  test('does not escalate at all where the operating system has no polite request', async () => {
    const root = await makeTestRoot();
    const child = startUnrelatedProcess();
    await recordOwned(root, { kind: 'process', pid: child.pid as number, identity: 'original', label: 'x' });
    const { signals, kill } = fakeKill();
    const result = await cleanupOwnedResources(root, { graceMs: 100, escalate: false, kill, identityOf: async () => 'original' });
    expect(signals).toEqual(['SIGTERM']);
    expect(result.failures.map((f) => f.reason)).toEqual(['still-running']);
  });
});

describe('a signal that fails', () => {
  test('is a failure while the process is still alive, not a successful cleanup', async () => {
    const root = await makeTestRoot();
    const child = await spawnOwned(root, 'helper', process.execPath, sleeper, { stdio: 'ignore' });
    trackProcess(child);
    const denied = () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); };

    const result = await cleanupOwnedResources(root, { graceMs: 100, kill: denied });

    expect(result.failures.map((f) => f.reason)).toEqual(['still-running']);
    expect(isAlive(child.pid as number)).toBe(true);
    expect(await readLedger(root)).toHaveLength(1);
  });

  test('is fine when the process turned out to be gone already', async () => {
    const root = await makeTestRoot();
    const child = await spawnOwned(root, 'helper', process.execPath, sleeper, { stdio: 'ignore' });
    trackProcess(child);
    const gone = () => {
      child.kill('SIGKILL');
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    };
    await eventually(() => true);
    const result = await cleanupOwnedResources(root, { graceMs: 1000, kill: gone });
    expect(result.failures).toEqual([]);
    expect(await readLedger(root)).toEqual([]);
  });
});

describe('spawnOwned', () => {
  test('does not leave the child running when the ledger cannot be written', async () => {
    const root = await makeTestRoot();
    const pidFile = join(root, 'pid.txt');
    // A directory where the ledger file belongs makes every ledger read or write fail.
    await mkdir(join(root, '.release-qa-owned.json'));
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;

    await expect(spawnOwned(root, 'helper', process.execPath, ['-e', script], { stdio: 'ignore' })).rejects.toThrow();

    // The child either never got as far as writing its pid (already stopped) or must be stopped now.
    await wait(1500);
    if (await exists(pidFile)) {
      const pid = Number(await readFile(pidFile, 'utf8'));
      await eventually(() => !isAlive(pid), 5000);
    }
  });

  test('a command that exits at once is not an error, and is not recorded as owned', async () => {
    const root = await makeTestRoot();
    const spawned = await Promise.all(Array.from({ length: 8 }, () => spawnOwned(root, 'quick', process.execPath, ['-e', '0'], { stdio: 'ignore' }).then((c) => trackProcess(c), (error: unknown) => error)));
    const errors = spawned.filter((entry) => entry instanceof Error);
    expect(errors).toEqual([]);
    // Whatever was recorded, cleanup must be able to finish without failures.
    expect((await cleanupOwnedResources(root, { graceMs: 200 })).failures).toEqual([]);
  });
});

describe('the test root lock', () => {
  test('refuses a second owner while the first holds the root, and hands it over after release', async () => {
    const root = await makeTestRoot();
    const first = await acquireTestRoot(root);
    expect(first.ok).toBe(true);

    const second = await acquireTestRoot(root);
    expect(second.ok).toBe(false);
    expect(!second.ok && second.heldBy).toContain(String(process.pid));

    if (first.ok) await first.release();
    const third = await acquireTestRoot(root);
    expect(third.ok).toBe(true);
    if (third.ok) await third.release();
  });

  test('takes over a lock left by a process that no longer exists', async () => {
    const root = await makeTestRoot();
    const dead = startUnrelatedProcess();
    const pid = dead.pid as number;
    const identity = await processIdentity(pid);
    dead.kill('SIGKILL');
    await eventually(() => !isAlive(pid));
    await writeFile(join(root, '.release-qa-lock.json'), JSON.stringify({ pid, identity }));

    const lock = await acquireTestRoot(root);

    expect(lock.ok).toBe(true);
    expect((await owner(root)).pid).toBe(process.pid); // the stale lock was replaced by ours
    if (lock.ok) await lock.release();
  });

  test('takes over a lock whose pid now belongs to a different process', async () => {
    const root = await makeTestRoot();
    const stranger = startUnrelatedProcess();
    await writeFile(join(root, '.release-qa-lock.json'), JSON.stringify({ pid: stranger.pid, identity: 'the-original-owner' }));
    const lock = await acquireTestRoot(root);
    expect(lock.ok).toBe(true);
    expect((await owner(root)).pid).toBe(process.pid);
    if (lock.ok) await lock.release();
  });

  test('respects a lock held by a live process with a matching identity', async () => {
    const root = await makeTestRoot();
    const other = startUnrelatedProcess();
    const identity = await processIdentity(other.pid as number);
    await writeFile(join(root, '.release-qa-lock.json'), JSON.stringify({ pid: other.pid, identity }));

    const lock = await acquireTestRoot(root);

    expect(lock.ok).toBe(false);
    expect(!lock.ok && lock.heldBy).toContain(String(other.pid));
  });

  test('treats a lock file it cannot understand as held, never as free', async () => {
    const root = await makeTestRoot();
    await writeFile(join(root, '.release-qa-lock.json'), 'not json');
    const lock = await acquireTestRoot(root);
    expect(lock.ok).toBe(false);
  });

  test('releasing does not remove a lock that someone else has since taken over', async () => {
    const root = await makeTestRoot();
    const lock = await acquireTestRoot(root);
    expect(lock.ok).toBe(true);
    expect((await owner(root)).pid).toBe(process.pid);
    await writeFile(join(root, '.release-qa-lock.json'), JSON.stringify({ pid: 1, identity: 'someone-else' }));
    if (lock.ok) await lock.release();
    expect(JSON.parse(await readFile(join(root, '.release-qa-lock.json'), 'utf8'))).toEqual({ pid: 1, identity: 'someone-else' });
  });

  test('a released lock leaves no file behind', async () => {
    const root = await makeTestRoot();
    const lock = await acquireTestRoot(root);
    expect(await exists(join(root, '.release-qa-lock.json'))).toBe(true);
    if (lock.ok) await lock.release();
    expect(await exists(join(root, '.release-qa-lock.json'))).toBe(false);
  });
});
