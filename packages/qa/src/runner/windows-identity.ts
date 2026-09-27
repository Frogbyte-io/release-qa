import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

// Get-Process is cheap after PowerShell has started. Keep a session only while lookups are in flight or nearby.
const LOOKUP_SCRIPT = `
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $parts = $line.Split(',')
  if ($parts.Length -ne 2) { continue }
  $requestId = $parts[0]
  try {
    $targetProcessId = [int]$parts[1]
    $targetProcess = Get-Process -Id $targetProcessId -ErrorAction Stop
    if ($targetProcess.HasExited) { throw 'process exited' }
    $started = $targetProcess.StartTime.ToFileTimeUtc()
    if ($targetProcess.HasExited) { throw 'process exited' }
    [Console]::Out.WriteLine("$requestId,$started")
  } catch {
    [Console]::Out.WriteLine("$requestId,")
  }
}`;

type Session = {
  child: ChildProcess;
  pending: Map<number, (identity: string | undefined) => void>;
  nextId: number;
  idle?: NodeJS.Timeout;
  fail(): void;
};

let active: Session | undefined;

function startSession(): Session {
  const child = spawn('powershell', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(LOOKUP_SCRIPT, 'utf16le').toString('base64'),
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const session: Session = {
    child,
    pending: new Map(),
    nextId: 0,
    fail() {
      if (active === session) active = undefined;
      clearTimeout(session.idle);
      for (const resolve of session.pending.values()) resolve(undefined);
      session.pending.clear();
      child.kill();
    },
  };
  const lines = createInterface({ input: child.stdout! });
  lines.on('line', (line) => {
    const reply = /^(\d+),(\d*)$/.exec(line);
    if (reply === null) return;
    const id = Number(reply[1]);
    const resolve = session.pending.get(id);
    if (resolve === undefined) return;
    session.pending.delete(id);
    resolve(reply[2] === '' ? undefined : `win32:${reply[2]}`);
    if (session.pending.size === 0) {
      session.idle = setTimeout(() => {
        if (active === session) active = undefined;
        child.stdin?.end();
        child.kill();
      }, 1000);
    }
  });
  child.once('error', () => session.fail());
  child.once('exit', () => session.fail());
  child.stdin?.on('error', () => session.fail());
  active = session;
  return session;
}

/** A missing or unreadable start time is never guessed: cleanup must then leave the process alone. */
export function windowsProcessIdentity(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(undefined);
  const session = active ?? startSession();
  clearTimeout(session.idle);
  return new Promise((resolve) => {
    const id = ++session.nextId;
    const timeout = setTimeout(() => session.fail(), 10_000);
    session.pending.set(id, (identity) => {
      clearTimeout(timeout);
      resolve(identity);
    });
    try {
      if (session.child.stdin === null) session.fail();
      else session.child.stdin.write(`${id},${pid}\n`);
    } catch {
      session.fail();
    }
  });
}
