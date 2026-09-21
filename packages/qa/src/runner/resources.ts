import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdir, lstat, readFile, realpath, rm, stat } from 'node:fs/promises';
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

/** Starts a process and records it, with its identity, before handing it back. */
export async function spawnOwned(root: string, label: string, command: string, args: readonly string[], options: SpawnOptions = {}): Promise<ChildProcess> {
  const child = spawn(command, [...args], options);
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once('spawn', () => resolveSpawn());
    child.once('error', rejectSpawn);
  });
  const pid = child.pid as number;
  const identity = await processIdentity(pid);
  if (identity === undefined) {
    // A process that cannot be identified cannot be owned safely, so it is not left running.
    child.kill('SIGKILL');
    throw new Error(`could not identify the process started for "${label}"; it was stopped`);
  }
  await recordOwned(root, { kind: 'process', pid, identity, label });
  return child;
}

async function cleanProcess(resource: Extract<OwnedResource, { kind: 'process' }>, options: Required<CleanupOptions>): Promise<CleanupFailure | undefined> {
  if (!isAlive(resource.pid)) return undefined;
  const now = await options.identityOf(resource.pid);
  if (now === undefined) {
    // It may have exited while its identity was being read; otherwise it is alive and unidentifiable: hands off.
    return isAlive(resource.pid) ? { resource, reason: 'identity-unknown' } : undefined;
  }
  if (now !== resource.identity) return undefined; // the pid was reused: the process this run owned is already gone

  const waitUntilGone = async (ms: number): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!isAlive(resource.pid)) return true;
      await sleep(25);
    }
    return !isAlive(resource.pid);
  };
  try {
    process.kill(resource.pid); // polite on POSIX (SIGTERM); Windows has no polite form
  } catch {
    return undefined;
  }
  if (await waitUntilGone(options.graceMs)) return undefined;
  if (process.platform !== 'win32') {
    try {
      process.kill(resource.pid, 'SIGKILL');
    } catch {
      return undefined;
    }
    if (await waitUntilGone(2000)) return undefined;
  }
  return { resource, reason: 'still-running' };
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
  const settings: Required<CleanupOptions> = { graceMs: options.graceMs ?? 5000, identityOf: options.identityOf ?? processIdentity };
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

/** Records that this environment must not be reused until it has been reset. */
export async function markDirty(root: string, reason: string): Promise<void> {
  await writeFileAtomic(join(root, DIRTY_FILE), `${JSON.stringify({ schemaVersion: 1, reason }, null, 2)}\n`);
}

export async function readDirty(root: string): Promise<string | undefined> {
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
  if (failures.length === 0) await rm(join(root, DIRTY_FILE), { force: true });
  return { failures };
}
