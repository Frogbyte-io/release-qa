import { execFile } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { resolve } from 'node:path';

// What a driver adapter needs to know about the machine to own what it starts indirectly: the application a WebDriver
// session launches, and the native driver behind tauri-driver, are not children the runner spawned itself.

function output(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolveOutput, rejectOutput) => {
    execFile(command, [...args], { timeout: 30_000, windowsHide: true }, (error, stdout) => (error ? rejectOutput(error) : resolveOutput(stdout)));
  });
}

const fold = (path: string): string => (process.platform === 'win32' ? path.toLowerCase() : path);
const pidsIn = (text: string): number[] => text.split(/\s+/).filter(Boolean).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
/** For a PowerShell single-quoted string, where the only special character is the single quote itself. */
const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** Pids of the processes running from exactly this executable. Never matches by name: two copies elsewhere differ. */
export async function processesRunning(executable: string): Promise<number[]> {
  const target = fold(resolve(executable));
  if (process.platform === 'win32') {
    const script = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant() -eq ${psQuote(target)} } | ForEach-Object { $_.ProcessId }`;
    return pidsIn(await output('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]));
  }
  const pids: number[] = [];
  for (const entry of await readdir('/proc').catch(() => [] as string[])) {
    if (!/^\d+$/.test(entry)) continue;
    const exe = await readlink(`/proc/${entry}/exe`).catch(() => undefined);
    if (exe !== undefined && fold(exe) === target) pids.push(Number(entry));
  }
  return pids;
}

/** Pids of the processes whose parent is `pid`. */
export async function childrenOf(pid: number): Promise<number[]> {
  if (process.platform === 'win32') {
    return pidsIn(await output('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${Math.trunc(pid)}').ProcessId`]));
  }
  const children: number[] = [];
  for (const entry of await readdir('/proc').catch(() => [] as string[])) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = await readFile(`/proc/${entry}/stat`, 'utf8').catch(() => undefined);
    // "pid (comm) state ppid ..." where comm may contain spaces and parentheses; the fields start after the last ")".
    const parent = stat === undefined ? undefined : Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    if (parent === pid) children.push(Number(entry));
  }
  return children;
}

/** Whether something accepts connections on this local port. */
export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolvePort(true); });
    socket.once('error', () => resolvePort(false));
  });
}

/** Resolves once something listens on the port; rejects, naming it, if nothing does within `timeoutMs`. */
export async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await portInUse(port)) return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
  throw new Error(`nothing listened on port ${port} within ${timeoutMs} ms`);
}
