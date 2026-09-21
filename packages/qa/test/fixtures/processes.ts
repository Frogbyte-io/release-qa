// Helpers for tests that need real processes. Every process started here is killed after the test, and none
// of them is ever handed to the code under test unless a test does so on purpose.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnvironmentProfile } from '../../src/model/project.ts';
import { designateTestRoot } from '../../src/runner/resources.ts';

const started: ChildProcess[] = [];
const roots: string[] = [];

/** A process unrelated to the runner, standing in for someone's real application. */
export function startUnrelatedProcess(script = 'setInterval(() => {}, 1000)'): ChildProcess {
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
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
  for (const child of started) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  started.length = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
}

export const hostOs = (): 'windows' | 'linux' => (process.platform === 'win32' ? 'windows' : 'linux');

/** The profile of the machine the tests are running on. */
export const hostProfile = (): EnvironmentProfile => ({ id: hostOs(), os: hostOs(), arch: 'x86_64' });
