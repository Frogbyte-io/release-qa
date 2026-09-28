// The driver chain for the probe scripts: starts tauri-driver on ports nothing else holds, opens a session that launches
// the app, and on the way out ends the session and stops everything that session started. What it stops is only what
// it found below its own tauri-driver, identified by pid and start time; nothing is matched by name.
import { execFile, spawn } from 'node:child_process';
import { connect } from 'node:net';
import { remote } from 'webdriverio';

const PORT = 4444;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listening = (port) => new Promise((resolve) => {
  const socket = connect(port, '127.0.0.1');
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

/** Every process as { pid, parent, started } (Windows). */
function processes() {
  const script = "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToFileTimeUtc())\" }";
  return new Promise((resolve, reject) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30_000 }, (error, stdout) => {
    if (error) return reject(error);
    resolve(stdout.split(/\r?\n/).filter(Boolean).map((line) => { const [pid, parent, started] = line.trim().split(' '); return { pid: Number(pid), parent: Number(parent), started }; }));
  }));
}

async function descendantsOf(root) {
  const all = await processes();
  const found = [];
  let frontier = [root];
  while (frontier.length > 0) {
    const next = all.filter((p) => frontier.includes(p.parent) && !found.some((f) => f.pid === p.pid));
    found.push(...next);
    frontier = next.map((p) => p.pid);
  }
  return found;
}

/**
 * Starts tauri-driver and a session for `application`. Returns the browser and a `stop()` that must run however the
 * probe ends; it reports anything it could not stop. Ctrl+C runs the same `stop()` before exiting.
 */
export async function startSession(application, nativeDriver) {
  for (const port of [PORT, PORT + 1]) {
    if (await listening(port)) throw new Error(`something is already listening on port ${port}; refusing to drive an instance this probe did not start`);
  }
  const driver = spawn('tauri-driver', ['--native-driver', nativeDriver, '--port', String(PORT), '--native-port', String(PORT + 1)], { stdio: 'ignore', windowsHide: true });
  let exited = false;
  driver.once('exit', () => { exited = true; });
  driver.once('error', () => { exited = true; });
  const end = Date.now() + 10_000;
  while (!(await listening(PORT))) {
    if (exited) throw new Error('tauri-driver exited before it listened');
    if (Date.now() > end) { driver.kill(); throw new Error('tauri-driver did not listen within 10 s'); }
    await sleep(100);
  }

  let browser;
  let owned = [];
  let stopping;
  const stop = () => (stopping ??= (async () => {
    const problems = [];
    if (browser !== undefined) await browser.deleteSession().catch((error) => problems.push(`ending the session: ${error.message}`));
    // Ending the session closes the app; give what it started time to exit before stopping the rest.
    const deadline = Date.now() + 10_000;
    const alive = async () => {
      const now = await processes();
      return owned.filter((o) => now.some((p) => p.pid === o.pid && p.started === o.started));
    };
    while ((await alive()).length > 0 && Date.now() < deadline) await sleep(250);
    driver.kill();
    for (const p of await alive()) {
      if (p.pid === driver.pid) continue;
      try { process.kill(p.pid); problems.push(`pid ${p.pid} was still running after the session ended, so it was stopped`); } catch { /* already gone */ }
    }
    await sleep(500);
    const left = (await alive()).filter((p) => p.pid !== driver.pid);
    if (left.length > 0) problems.push(`still running: ${left.map((p) => p.pid).join(', ')}`);
    return problems;
  })());
  const onSignal = async () => {
    const problems = await stop();
    for (const problem of problems) console.error(problem);
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let failure;
  try {
    browser = await remote({
      hostname: '127.0.0.1', port: PORT, path: '/', logLevel: 'warn', connectionRetryTimeout: 60_000,
      capabilities: { 'tauri:options': { application } },
    });
  } catch (error) {
    failure = error;
  }
  // Whatever remote() did, everything below this driver is this probe's to stop.
  owned = await descendantsOf(driver.pid).catch(() => []);
  if (failure !== undefined) {
    await stop();
    throw failure;
  }
  return { browser, stop };
}
