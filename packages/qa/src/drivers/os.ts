import { execFile } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { resolve } from 'node:path';

// What a driver adapter needs to know about the machine to own what it starts indirectly: the application a WebDriver
// session launches, and the native driver behind tauri-driver, are not children the runner spawned itself.
//
// These fail closed: a process list that cannot be read is an error, never an empty list, because "nothing is
// running" is exactly what would let the adapter drive, or leave behind, an instance that is not the run's.

function output(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolveOutput, rejectOutput) => {
    execFile(command, [...args], { timeout: 30_000, windowsHide: true }, (error, stdout) => (error ? rejectOutput(error) : resolveOutput(stdout)));
  });
}

const fold = (path: string): string => (process.platform === 'win32' ? path.toLowerCase() : path);
const pidsIn = (text: string): number[] => text.split(/\s+/).filter(Boolean).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
/** For a PowerShell single-quoted string, where the only special character is the single quote itself. */
const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

/** Every pid in /proc. Not being able to list it is an error, not an empty machine. */
async function procPids(): Promise<number[]> {
  return (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry)).map(Number);
}

/**
 * Reads something about one process from /proc. A process that exited between listing and reading, or that belongs to
 * another user, yields undefined: neither can be one this run started, since those run as this user and are readable.
 * Anything else is an error.
 */
async function procRead<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(errorCode(error) ?? '')) return undefined;
    throw error;
  }
}

/** Pids of the processes running from exactly this executable. Never matches by name: two copies elsewhere differ. */
export async function processesRunning(executable: string): Promise<number[]> {
  const target = fold(resolve(executable));
  if (process.platform === 'win32') {
    const script = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant() -eq ${psQuote(target)} } | ForEach-Object { $_.ProcessId }`;
    return pidsIn(await output('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]));
  }
  const pids: number[] = [];
  for (const pid of await procPids()) {
    const exe = await procRead(() => readlink(`/proc/${pid}/exe`));
    if (exe !== undefined && fold(exe) === target) pids.push(pid);
  }
  return pids;
}

/** Every process's parent, as [pid, parent] pairs. */
async function parents(): Promise<Array<[number, number]>> {
  if (process.platform === 'win32') {
    const text = await output('powershell', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"]);
    return text.split(/\r?\n/).map((line) => pidsIn(line)).filter((pair): pair is [number, number] => pair.length === 2);
  }
  const pairs: Array<[number, number]> = [];
  for (const pid of await procPids()) {
    const stat = await procRead(() => readFile(`/proc/${pid}/stat`, 'utf8'));
    // "pid (comm) state ppid ..." where comm may contain spaces and parentheses; the fields start after the last ")".
    if (stat !== undefined) pairs.push([pid, Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])]);
  }
  return pairs;
}

/** Pids of the processes whose parent is `pid`. */
export async function childrenOf(pid: number): Promise<number[]> {
  return (await parents()).filter(([, parent]) => parent === pid).map(([child]) => child);
}

/** Pids of every process below `pid`: its children, their children, and so on. */
export async function descendantsOf(pid: number): Promise<number[]> {
  const pairs = await parents();
  const found = new Set<number>();
  const pending = [pid];
  while (pending.length > 0) {
    const current = pending.pop() as number;
    for (const [child, parent] of pairs) {
      // A pid reused as its own ancestor would loop; each process is visited once.
      if (parent === current && child !== pid && !found.has(child)) {
        found.add(child);
        pending.push(child);
      }
    }
  }
  return [...found];
}

/**
 * Whether something accepts connections on this local port. A connection attempt that neither succeeds nor fails
 * within `timeoutMs` (a dropped connection) counts as nothing listening.
 */
export function portInUse(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolvePort) => {
    const socket = connect(port, '127.0.0.1');
    const done = (inUse: boolean): void => {
      socket.destroy();
      resolvePort(inUse);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Resolves once something listens on the port; rejects, naming it, if nothing does within `timeoutMs`, and at once
 * with the abort reason when `signal` is aborted (e.g. because the process that should listen has exited).
 */
export async function waitForPort(port: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (signal?.aborted) throw signal.reason;
    if (await portInUse(port, Math.max(1, Math.min(2000, end - Date.now())))) return;
    await new Promise<void>((resolveSleep) => {
      const timer = setTimeout(done, 100);
      function done(): void {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolveSleep();
      }
      signal?.addEventListener('abort', done, { once: true });
    });
  }
  if (signal?.aborted) throw signal.reason;
  throw new Error(`nothing listened on port ${port} within ${timeoutMs} ms`);
}
