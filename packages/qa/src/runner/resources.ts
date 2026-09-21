import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, lstat, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, parse, resolve, sep } from 'node:path';
import { writeFileAtomic } from './journal.ts';

/** Something a run created and therefore may remove. Nothing else is ever touched. */
export type OwnedResource =
  | { kind: 'process'; pid: number; identity: string; label: string }
  | { kind: 'path'; path: string; label: string };

export const TEST_ROOT_MARKER = '.release-qa-test-root';
const LEDGER_FILE = '.release-qa-owned.json';
const DIRTY_FILE = '.release-qa-dirty.json';

export type TestRootCheck = { ok: true; root: string } | { ok: false; reason: 'not-a-directory' | 'unsafe-root' | 'missing-marker' };

export interface CleanupFailure {
  resource: OwnedResource;
  reason: 'outside-test-root' | 'is-test-root' | 'is-link' | 'identity-unknown' | 'still-running' | 'remove-failed';
  detail?: string;
}

export interface CleanupOptions {
  /** How long a process gets to exit after a polite request before it is forced. */
  graceMs?: number;
  /** Test seam: how a process is identified. */
  identityOf?: (pid: number) => Promise<string | undefined>;
  /** Test seam: how a process is signalled. */
  kill?: (pid: number, signal?: NodeJS.Signals) => void;
  /** Whether a process that ignores the polite request is forced. Defaults to true wherever the operating system has a polite request. */
  escalate?: boolean;
}

/** The same directory always has the same key, however it was spelled. */
function keyOf(root: string): string {
  try {
    return realpathSync.native(root);
  } catch {
    return resolve(root);
  }
}

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;
const fold = (path: string): string => (process.platform === 'win32' ? path.toLowerCase() : path);
const isInside = (root: string, path: string): boolean => fold(path).startsWith(fold(root) + sep);
const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** The home directory, the filesystem root and anything that contains the home directory are never a test root. */
async function isUnsafeRoot(real: string, homeDirectory: string): Promise<boolean> {
  const home = await realpath(homeDirectory).catch(() => resolve(homeDirectory));
  return parse(real).root === real || fold(real) === fold(home) || isInside(real, home);
}

/** Marks a directory as somewhere the runner may install, launch and delete. Nothing runs without this. */
export async function designateTestRoot(dir: string, options: { home?: string } = {}): Promise<void> {
  await mkdir(dir, { recursive: true });
  const real = await realpath(dir);
  if (await isUnsafeRoot(real, options.home ?? homedir())) throw new Error(`unsafe test root: ${real} is the filesystem root, the home directory or contains it`);
  await writeFileAtomic(join(real, TEST_ROOT_MARKER), `${JSON.stringify({ schemaVersion: 1, purpose: 'release-qa-test-environment' }, null, 2)}\n`);
}

/** `options.home` is a test seam: which directory counts as the home directory. */
export async function checkTestRoot(dir: string, options: { home?: string } = {}): Promise<TestRootCheck> {
  const info = await stat(dir).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) return { ok: false, reason: 'not-a-directory' };
  const real = await realpath(dir);
  if (await isUnsafeRoot(real, options.home ?? homedir())) return { ok: false, reason: 'unsafe-root' };
  const marker = await readFile(join(real, TEST_ROOT_MARKER), 'utf8').catch(() => undefined);
  let designated = false;
  try {
    designated = marker !== undefined && (JSON.parse(marker) as { purpose?: unknown }).purpose === 'release-qa-test-environment';
  } catch {
    designated = false;
  }
  return designated ? { ok: true, root: real } : { ok: false, reason: 'missing-marker' };
}

// ---------------------------------------------------------------------------------------------------------------
// The ledger: what this run owns, on disk before it is used, so a crash still leaves a record.

/** One writer at a time per root within this process; a run is the only writer of its test root. */
const queues = new Map<string, Promise<unknown>>();
function serialized<T>(root: string, work: () => Promise<T>): Promise<T> {
  const key = resolve(root);
  const next = (queues.get(key) ?? Promise.resolve()).then(work, work);
  queues.set(key, next.catch(() => undefined));
  return next;
}

export async function readLedger(root: string): Promise<OwnedResource[]> {
  let text: string;
  try {
    text = await readFile(join(root, LEDGER_FILE), 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
  // An unreadable ledger must never be mistaken for an empty one: that would forget what a crashed run owned.
  // Every entry is checked, because cleanup acts on these values and a malformed one must stop it, not steer it.
  const where = join(root, LEDGER_FILE);
  const parsed = JSON.parse(text) as { schemaVersion?: unknown; resources?: unknown };
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.resources)) throw new Error(`the ledger at ${where} is not a version 1 ledger`);
  parsed.resources.forEach((entry: unknown, index) => {
    if (!isOwnedResource(entry)) throw new Error(`the ledger at ${where} has a malformed entry at position ${index}`);
  });
  return parsed.resources as OwnedResource[];
}

function isOwnedResource(value: unknown): value is OwnedResource {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.label !== 'string') return false;
  if (entry.kind === 'process') return Number.isSafeInteger(entry.pid) && (entry.pid as number) > 0 && typeof entry.identity === 'string' && entry.identity !== '';
  return entry.kind === 'path' && typeof entry.path === 'string' && entry.path !== '';
}

async function writeLedger(root: string, resources: readonly OwnedResource[]): Promise<void> {
  await writeFileAtomic(join(root, LEDGER_FILE), `${JSON.stringify({ schemaVersion: 1, resources }, null, 2)}\n`);
}

export function recordOwned(root: string, resource: OwnedResource): Promise<void> {
  return serialized(root, async () => writeLedger(root, [...(await readLedger(root)), resource]));
}

// ---------------------------------------------------------------------------------------------------------------
// Processes

function output(command: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolveOutput) => {
    execFile(command, [...args], { timeout: 10000, windowsHide: true }, (error, stdout) => resolveOutput(error ? undefined : stdout.trim()));
  });
}

/**
 * Something that names one particular process for as long as it lives: its start time. A pid alone is not
 * enough, because the operating system reuses them. Returns undefined when the process does not exist or its
 * identity cannot be read, in which case nothing may be done to it.
 */
export async function processIdentity(pid: number): Promise<string | undefined> {
  if (process.platform === 'linux') {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => undefined);
    if (stat === undefined) return undefined;
    // "pid (comm) state ppid ..." where comm may contain spaces and parentheses; the fields start after the last ")".
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z') return undefined; // a zombie has already exited
    return fields[19] === undefined ? undefined : `linux:${fields[19]}`;
  }
  if (process.platform === 'win32') {
    const started = await output('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Math.trunc(pid)} -ErrorAction Stop).StartTime.ToFileTimeUtc()`]);
    return started === undefined || started === '' ? undefined : `win32:${started}`;
  }
  const started = await output('ps', ['-o', 'lstart=', '-p', String(Math.trunc(pid))]);
  return started === undefined || started === '' ? undefined : `${process.platform}:${started}`;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

/**
 * Starts a process and records it, with its identity, before handing it back. A child that has already exited has
 * nothing left to own and is returned without a record (its pid may even belong to someone else by now, so an
 * identity read after its exit is never trusted). If the record cannot be written the child is stopped.
 */
export async function spawnOwned(root: string, label: string, command: string, args: readonly string[], options: SpawnOptions = {}): Promise<ChildProcess> {
  const child = spawn(command, [...args], options);
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once('spawn', () => resolveSpawn());
    child.once('error', rejectSpawn);
  });
  const pid = child.pid as number;
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  const identity = await processIdentity(pid);
  const hasExited = (): boolean => exited || child.exitCode !== null || child.signalCode !== null;
  if (hasExited()) return child;
  if (identity === undefined) {
    // Alive but not identifiable: it cannot be owned safely, so it is not left running.
    child.kill('SIGKILL');
    throw new Error(`could not identify the process started for "${label}"; it was stopped`);
  }
  try {
    await recordOwned(root, { kind: 'process', pid, identity, label });
  } catch (error) {
    // An untracked child would outlive every cleanup, since cleanup only knows what the ledger lists.
    child.kill('SIGKILL');
    throw error;
  }
  return child;
}

async function cleanProcess(resource: Extract<OwnedResource, { kind: 'process' }>, options: Required<CleanupOptions>): Promise<CleanupFailure | undefined> {
  const { pid } = resource;
  if (!isAlive(pid)) return undefined;
  const now = await options.identityOf(pid);
  if (now === undefined) {
    // It may have exited while its identity was being read; otherwise it is alive and unidentifiable: hands off.
    return isAlive(pid) ? { resource, reason: 'identity-unknown' } : undefined;
  }
  if (now !== resource.identity) return undefined; // the pid was reused: the process this run owned is already gone

  const waitUntilGone = async (ms: number): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!isAlive(pid)) return true;
      await sleep(25);
    }
    return !isAlive(pid);
  };
  /** A signal that could not be delivered is only harmless if the process turned out to be gone anyway. */
  const send = async (signal?: NodeJS.Signals): Promise<boolean> => {
    try {
      options.kill(pid, signal);
      return true;
    } catch {
      return waitUntilGone(300);
    }
  };
  const stillRunning: CleanupFailure = { resource, reason: 'still-running' };

  if (!(await send())) return stillRunning; // polite on POSIX (SIGTERM); Windows has no polite form
  if (await waitUntilGone(options.graceMs)) return undefined;
  if (!options.escalate) return stillRunning;

  // Forcing is the dangerous step: during the grace period the process may have exited and its pid been reused,
  // so it is identified again immediately before, and only the very same process is ever forced.
  const again = await options.identityOf(pid);
  if (again === undefined) return isAlive(pid) ? { resource, reason: 'identity-unknown' } : undefined;
  if (again !== resource.identity) return undefined;
  if (!(await send('SIGKILL'))) return stillRunning;
  return (await waitUntilGone(2000)) ? undefined : stillRunning;
}

async function cleanPath(root: string, resource: Extract<OwnedResource, { kind: 'path' }>): Promise<CleanupFailure | undefined> {
  const path = resolve(resource.path);
  const link = await lstat(path).catch((error) => (errorCode(error) === 'ENOENT' ? undefined : Promise.reject(error)));
  if (link === undefined) return undefined; // already gone

  // Resolve every link on the way, then judge the real location. A path that merely looks inside the root
  // but leads out of it (through "..", a symlink or a junction) is refused, and its target is never touched.
  const [realRoot, real] = await Promise.all([realpath(root), realpath(path)]);
  if (fold(real) === fold(realRoot)) return { resource, reason: 'is-test-root' };
  if (!isInside(realRoot, real)) return { resource, reason: 'outside-test-root', detail: `${real} is not inside ${realRoot}` };
  // A link is not something this run creates for itself; removing one could be mistaken for removing its target.
  if (link.isSymbolicLink()) return { resource, reason: 'is-link', detail: `${path} is a link to ${real}` };
  try {
    await rm(path, { recursive: true, force: true });
    return undefined;
  } catch (error) {
    return { resource, reason: 'remove-failed', detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Removes what the ledger says this run owns, and only that. What it could not clean stays on the ledger, so the
 * environment stays dirty until it is dealt with.
 */
export function cleanupOwnedResources(root: string, options: CleanupOptions = {}): Promise<{ removed: OwnedResource[]; failures: CleanupFailure[] }> {
  const settings: Required<CleanupOptions> = {
    graceMs: options.graceMs ?? 5000,
    identityOf: options.identityOf ?? processIdentity,
    kill: options.kill ?? ((pid, signal) => void process.kill(pid, signal)),
    escalate: options.escalate ?? process.platform !== 'win32',
  };
  return serialized(root, async () => {
    const ledger = await readLedger(root);
    const removed: OwnedResource[] = [];
    const failures: CleanupFailure[] = [];
    for (const resource of ledger) {
      let failure: CleanupFailure | undefined;
      try {
        failure = resource.kind === 'process' ? await cleanProcess(resource, settings) : await cleanPath(root, resource);
      } catch (error) {
        failure = { resource, reason: 'remove-failed', detail: error instanceof Error ? error.message : String(error) };
      }
      if (failure === undefined) removed.push(resource);
      else failures.push(failure);
    }
    await writeLedger(root, failures.map((f) => f.resource));
    return { removed, failures };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Dirty environments

/** Dirty roots remembered by this process, so a marker that could not be written still keeps the root closed. */
const dirtyInMemory = new Map<string, string>();

/** Records that this environment must not be reused until it has been reset. */
export async function markDirty(root: string, reason: string): Promise<void> {
  dirtyInMemory.set(keyOf(root), reason); // first: even if the write below fails, this process will not reuse the root
  await writeFileAtomic(join(root, DIRTY_FILE), `${JSON.stringify({ schemaVersion: 1, reason }, null, 2)}\n`);
}

export async function readDirty(root: string): Promise<string | undefined> {
  const remembered = dirtyInMemory.get(keyOf(root));
  if (remembered !== undefined) return remembered;
  const text = await readFile(join(root, DIRTY_FILE), 'utf8').catch((error) => (errorCode(error) === 'ENOENT' ? undefined : Promise.reject(error)));
  if (text === undefined) return undefined;
  try {
    return String((JSON.parse(text) as { reason?: unknown }).reason ?? 'marked dirty');
  } catch {
    return 'marked dirty (the marker is unreadable)';
  }
}

/** Reaps everything the ledger owns and, only when that succeeds completely, clears the dirty marker. */
export async function resetDirtyEnvironment(root: string, options: CleanupOptions = {}): Promise<{ failures: CleanupFailure[] }> {
  const { failures } = await cleanupOwnedResources(root, options);
  if (failures.length === 0) {
    dirtyInMemory.delete(keyOf(root));
    await rm(join(root, DIRTY_FILE), { force: true });
  }
  return { failures };
}

export type RootLock = { ok: true; release(): Promise<void> } | { ok: false; heldBy: string };

const LOCK_FILE = '.release-qa-lock.json';
/** Roots this process holds, so a second run in the same process is refused without touching the disk. */
const heldHere = new Set<string>();
let ownIdentity: Promise<string | undefined> | undefined;
/** This process's own identity, read once: on Windows reading it costs a PowerShell start. A failed read is not kept. */
async function identityOfThisProcess(): Promise<string | undefined> {
  ownIdentity ??= processIdentity(process.pid);
  const identity = await ownIdentity;
  if (identity === undefined) ownIdentity = undefined;
  return identity;
}

/**
 * At most one run at a time may use a test root, or two runs would reset the environment under each other and
 * clean up each other's resources. The lock names its owner by pid and identity, so one left behind by a process
 * that has since exited (or whose pid was reused) is recognised as stale, while anything unreadable counts as held.
 */
export async function acquireTestRoot(root: string): Promise<RootLock> {
  const key = keyOf(root);
  if (heldHere.has(key)) return { ok: false, heldBy: `this process (pid ${process.pid})` };
  const path = join(root, LOCK_FILE);
  const mine = JSON.stringify({ pid: process.pid, identity: (await identityOfThisProcess()) ?? 'unknown' });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, mine, { flag: 'wx' });
      heldHere.add(key);
      return {
        ok: true,
        release: async () => {
          heldHere.delete(key);
          // Only remove a lock that is still ours; someone may have taken over a lock they judged stale.
          const current = await readFile(path, 'utf8').catch(() => undefined);
          if (current === mine) await rm(path, { force: true });
        },
      };
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }

    let holder: { pid: number; identity: string };
    try {
      holder = JSON.parse(await readFile(path, 'utf8')) as { pid: number; identity: string };
      if (!Number.isSafeInteger(holder.pid) || typeof holder.identity !== 'string') throw new Error('malformed');
    } catch {
      return { ok: false, heldBy: `a lock file that cannot be read (${path})` };
    }
    const identity = isAlive(holder.pid) ? await processIdentity(holder.pid) : undefined;
    const stale = !isAlive(holder.pid) || (identity !== undefined && identity !== holder.identity);
    if (!stale) return { ok: false, heldBy: `pid ${holder.pid}` };
    await rm(path, { force: true });
  }
  return { ok: false, heldBy: 'a lock that kept reappearing' };
}
