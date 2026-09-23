// Helpers for tests that need real processes. Every process started here is killed after the test, and none
// of them is ever handed to the code under test unless a test does so on purpose.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { arch, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnvironmentProfile } from '../../src/model/project.ts';
import { designateTestRoot } from '../../src/runner/resources.ts';

const started: ChildProcess[] = [];
const roots: string[] = [];

/** A process unrelated to the runner, standing in for someone's real application. */
export function startUnrelatedProcess(script = 'setInterval(() => {}, 1000)'): ChildProcess {
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  // A failed spawn must fail one test, not crash the whole worker with an unhandled 'error' event.
  child.on('error', () => undefined);
  started.push(child);
  return child;
}

/** Registers a process started some other way (for example by spawnOwned) so it is stopped after the test. */
export function trackProcess<T extends ChildProcess>(child: T): T {
  child.on('error', () => undefined);
  started.push(child);
  return child;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 10000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition not met in time');
}

/** A fresh, explicitly designated test root under the OS temp directory. */
export async function makeTestRoot(designate = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'qa-root-'));
  roots.push(root);
  if (designate) await designateTestRoot(root);
  return root;
}

/** A scratch directory outside any test root. Removed after the test, even when the test fails. */
export async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

export async function cleanUpProcessesAndRoots(): Promise<void> {
  const children = started.splice(0);
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  // On Windows a child that is still exiting can hold a directory open, so wait for each to be gone first.
  await Promise.all(
    children.map((child) => (child.exitCode !== null || child.signalCode !== null ? undefined : new Promise<void>((resolve) => { child.once('exit', () => resolve()); setTimeout(resolve, 3000); }))),
  );
  // Every removal is attempted, whatever any other one does.
  await Promise.allSettled(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

export const hostOs = (): 'windows' | 'linux' => (process.platform === 'win32' ? 'windows' : 'linux');

/** The architecture name the runner reports for this machine (x64 is x86_64, arm64 is aarch64). */
export const hostArch = (): string => (arch() === 'x64' ? 'x86_64' : arch() === 'arm64' ? 'aarch64' : arch());

/** An architecture that is not this machine's, for tests of a mismatch. */
export const otherArch = (): string => (hostArch() === 'x86_64' ? 'aarch64' : 'x86_64');

/** The profile of the machine the tests are running on. */
export const hostProfile = (): EnvironmentProfile => ({ id: hostOs(), os: hostOs(), arch: hostArch() as EnvironmentProfile['arch'] });
