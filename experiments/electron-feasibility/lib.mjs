// What the two probes share: reading which processes run from the packaged app, and writing what was observed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { homedir, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = dirname(fileURLToPath(import.meta.url));
export const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const ps = (script) => execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
const pidsIn = (text) => text.split(/\s+/).filter(Boolean).map(Number);

/** Pids of the processes running from exactly this executable (Electron runs all its processes from one). */
export function running(executable) {
  const target = resolve(executable);
  if (process.platform === 'win32') {
    return pidsIn(ps(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant() -eq '${target.toLowerCase().replace(/'/g, "''")}' } | ForEach-Object { $_.ProcessId }`));
  }
  // The path is a positional argument, never part of the script, so no character in it is interpreted by the shell.
  const script = 'for p in /proc/[0-9]*; do [ "$(readlink "$p/exe" 2>/dev/null)" = "$1" ] && basename "$p"; done; true';
  return pidsIn(execFileSync('sh', ['-c', script, 'sh', target], { encoding: 'utf8' }));
}

/** "pid parent name", where the name may contain spaces. */
const splitRecord = (line) => {
  const [pid, parent, ...name] = line.trim().split(/\s+/);
  return [pid, parent, name.join(' ')];
};

/** Pids of every process below `root`, with the executable name of each. */
export function tree(root) {
  const pairs = process.platform === 'win32'
    ? ps('Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }').split(/\r?\n/).filter(Boolean).map(splitRecord)
    : execFileSync('ps', ['-eo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).split('\n').filter(Boolean).map(splitRecord);
  const found = {};
  const pending = [String(root)];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const [pid, parent, name] of pairs) {
      if (parent === current && found[pid] === undefined) {
        found[pid] = name;
        pending.push(pid);
      }
    }
  }
  return found;
}

export function stop(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
  }
}

/** The versions and machine every observation was made on. */
export function environment(packageDir) {
  const electron = JSON.parse(readFileSync(join(packageDir, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
  return { os: `${platform()} ${release()}`, node: process.version, electron, webdriverio: JSON.parse(readFileSync(join(here, 'node_modules', 'webdriverio', 'package.json'), 'utf8')).version };
}

/** Writes the observations as JSON, with the account's home directory replaced so the file can be committed. */
export function writeEvidence(name, observations) {
  const home = homedir();
  const forms = [home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\')];
  let text = `${JSON.stringify(observations, null, 2)}\n`;
  for (const form of forms) text = text.split(form).join('%USERPROFILE%');
  mkdirSync(join(here, 'evidence'), { recursive: true });
  writeFileSync(join(here, 'evidence', name), text);
  console.log(text);
}

/** A local port nothing listens on right now. */
export function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/** Resolves once something accepts connections on the port; rejects after `timeoutMs`. */
export async function waitForPort(port, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const open = await new Promise((resolveOpen) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolveOpen(true); });
      socket.once('error', () => resolveOpen(false));
    });
    if (open) return;
    await sleep(100);
  }
  throw new Error(`nothing listened on port ${port} within ${timeoutMs} ms`);
}
