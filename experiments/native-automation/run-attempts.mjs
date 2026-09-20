// Task 0.1 experiment: drive an UNCHANGED packaged Tauri app through an external WebDriver
// (tauri-driver + the platform's native driver) and check persistence at the real filesystem boundary.
//
// Each attempt starts from a clean profile, then: launch -> type + Save -> read the file straight from
// disk -> end the session (app must exit) -> relaunch -> persisted value must be shown -> Clear ->
// relaunch -> value must be gone. A failed attempt stays failed; it is never replaced by a rerun.
//
// Env: APP_EXE (installed binary), NATIVE_DRIVER (msedgedriver.exe or WebKitWebDriver),
//      TAURI_DRIVER (default "tauri-driver"), COUNT (default 10), OUT (default output/<timestamp>).
import { remote } from 'webdriverio';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform, release, arch } from 'node:os';
import { join, sep } from 'node:path';
import net from 'node:net';

const IDENTIFIER = 'dev.frogbyte.releaseqa.smoke';
const need = (name) => { const v = process.env[name]; if (!v) { console.error(`${name} is required`); process.exit(2); } return v; };
const APP = need('APP_EXE');
const NATIVE_DRIVER = need('NATIVE_DRIVER');
const TAURI_DRIVER = process.env.TAURI_DRIVER ?? 'tauri-driver';
const COUNT = Number(process.env.COUNT ?? 10);
if (!Number.isInteger(COUNT) || COUNT < 1) { console.error(`COUNT must be a positive integer (got ${process.env.COUNT})`); process.exit(2); }
const OUT = process.env.OUT ?? join('output', new Date().toISOString().replace(/[:.]/g, '-'));
const PORT = 4444;
mkdirSync(OUT, { recursive: true });

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// WebKitGTK screenshots can lag the DOM by a frame (see docs/decisions/native-automation.md), so settle first.
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 500);

// Profile locations owned by this sample's unique identifier.
const dataRoots = platform() === 'win32'
  ? [process.env.APPDATA, process.env.LOCALAPPDATA]
  : [process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache')];
const profileDirs = dataRoots.map((root) => join(root, IDENTIFIER));
const settingFile = join(profileDirs[0], 'setting.txt');

function cleanProfile() {
  for (const dir of profileDirs) {
    // Only ever delete a directory named exactly after this sample's identifier.
    if (!dir.endsWith(`${sep}${IDENTIFIER}`) || dir.length <= IDENTIFIER.length + 3) throw new Error(`refusing to delete ${dir}`);
    rmSync(dir, { recursive: true, force: true });
  }
}

function appPids() {
  if (platform() === 'win32') {
    const filter = `ExecutablePath='${APP.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
    const out = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "${filter}").ProcessId`], { encoding: 'utf8' });
    return out.split(/\s+/).filter(Boolean).map(Number);
  }
  const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return out.split('\n').map((l) => l.trim()).filter((l) => l.split(/\s+/).slice(1).join(' ').startsWith(APP)).map((l) => Number(l.split(/\s+/)[0]));
}

const portOpen = (port) => new Promise((res) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); });

async function waitPort(port, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await portOpen(port)) return;
    await sleep(200);
  }
  throw new Error(`tauri-driver did not listen on ${port}`);
}

function startDriver(logPath) {
  const log = createWriteStream(logPath);
  const child = spawn(TAURI_DRIVER, ['--native-driver', NATIVE_DRIVER, '--port', String(PORT), '--native-port', String(PORT + 1)], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log); child.stderr.pipe(log);
  child.closed = new Promise((res) => child.on('close', res));
  return child;
}

// State the signal handler needs to clean up after an interrupted run.
const active = { driver: null, ownsApp: false };
function emergencyCleanup() {
  try { active.driver?.kill(); } catch { /* already gone */ }
  // Only ever touch app processes once the preflight proved none were running before this attempt.
  if (active.ownsApp) for (const pid of appPids()) { try { process.kill(pid); } catch { /* gone */ } }
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { emergencyCleanup(); process.exit(130); });

async function launch() {
  return remote({
    hostname: '127.0.0.1', port: PORT, path: '/', logLevel: 'warn', connectionRetryTimeout: 60000,
    capabilities: { 'tauri:options': { application: APP } },
  });
}

async function shot(browser, path) {
  await browser.pause(SETTLE_MS);
  await browser.saveScreenshot(path);
  return sha256(path);
}

async function endSession(browser, steps) {
  await browser.deleteSession();
  // The app process must exit when the session ends; poll rather than assume.
  let pids = [];
  for (let i = 0; i < 40; i++) { pids = appPids(); if (!pids.length) break; await sleep(250); }
  steps.push({ name: 'app process exited after session end', ok: pids.length === 0, detail: pids.length ? `still running: ${pids.join(',')}` : 'gone' });
  if (pids.length) throw new Error(`app still running after session end: ${pids.join(',')}`);
}

async function runAttempt(n, dir) {
  const steps = [];
  const shots = {};
  const t0 = Date.now();
  const value = `attempt-${n}-${randomUUID().slice(0, 8)} åäö ✓`;
  const step = async (name, fn) => {
    const s = Date.now();
    try { const detail = await fn(); steps.push({ name, ok: true, ms: Date.now() - s, detail }); }
    catch (e) { steps.push({ name, ok: false, ms: Date.now() - s, error: String(e.message ?? e) }); throw e; }
  };
  let driver;
  let browser;
  let error;
  try {
    // Preflight comes first: nothing is deleted or killed while an instance of the app is already running.
    await step('no app process before launch', async () => { const p = appPids(); if (p.length) throw new Error(`already running: ${p}`); });
    active.ownsApp = true;
    await step('clean profile', async () => { cleanProfile(); if (existsSync(profileDirs[0])) throw new Error('profile not clean'); });
    await step('driver port is free', async () => { if (await portOpen(PORT)) throw new Error(`something is already listening on ${PORT}`); });
    driver = active.driver = startDriver(join(dir, `attempt-${n}-driver.log`));
    await waitPort(PORT);

    await step('launch 1', async () => { browser = await launch(); await (await browser.$('#setting-input')).waitForExist({ timeout: 20000 }); });
    await step('type + Save shows value', async () => {
      await (await browser.$('#setting-input')).setValue(value);
      await (await browser.$('#save-button')).click();
      await browser.waitUntil(async () => (await (await browser.$('#saved-value')).getText()) === value, { timeout: 10000, timeoutMsg: 'saved value never shown' });
      shots[1] = await shot(browser, join(dir, `attempt-${n}-1-saved.png`));
    });
    await step('value on disk (independent read)', async () => {
      const disk = readFileSync(settingFile, 'utf8');
      if (disk !== value) throw new Error(`disk has ${JSON.stringify(disk)}`);
      return settingFile;
    });
    await step('end session 1', () => endSession(browser, steps));

    await step('launch 2 (restart) shows persisted value', async () => {
      browser = await launch();
      await (await browser.$('#saved-value')).waitForExist({ timeout: 20000 });
      await browser.waitUntil(async () => (await (await browser.$('#saved-value')).getText()) === value, { timeout: 10000, timeoutMsg: 'persisted value not shown after restart' });
      shots[2] = await shot(browser, join(dir, `attempt-${n}-2-restarted.png`));
    });
    await step('Clear removes value and file', async () => {
      await (await browser.$('#clear-button')).click();
      await browser.waitUntil(async () => (await (await browser.$('#saved-value')).getText()) === '', { timeout: 10000 });
      if (existsSync(settingFile)) throw new Error('setting file still on disk');
    });
    await step('end session 2', () => endSession(browser, steps));

    await step('launch 3 (restart) shows cleared state', async () => {
      browser = await launch();
      await (await browser.$('#saved-value')).waitForExist({ timeout: 20000 });
      const text = await (await browser.$('#saved-value')).getText();
      if (text !== '') throw new Error(`expected empty, got ${JSON.stringify(text)}`);
      shots[3] = await shot(browser, join(dir, `attempt-${n}-3-cleared.png`));
    });
    await step('screenshots are not stale (saved and restarted differ from cleared)', async () => {
      if (shots[1] === shots[3]) throw new Error('saved screenshot identical to cleared screenshot');
      if (shots[2] === shots[3]) throw new Error('restarted screenshot identical to cleared screenshot');
    });
    await step('end session 3', () => endSession(browser, steps));
  } catch (e) {
    error = String(e.message ?? e);
  } finally {
    const cleanup = [];
    try { if (browser?.sessionId) await browser.deleteSession(); } catch { /* session already gone */ }
    // Only processes launched from this exact installed path are considered, and only after the preflight
    // proved none existed before this attempt; never a name match.
    if (active.ownsApp) {
      for (const pid of appPids()) { try { process.kill(pid); cleanup.push(`killed leftover app pid ${pid}`); } catch { /* gone */ } }
    }
    if (driver) {
      driver.kill();
      // kill() is asynchronous: wait for the exit so the next attempt cannot reach this attempt's listener.
      const exited = await Promise.race([driver.closed.then(() => true), sleep(5000).then(() => false)]);
      cleanup.push(exited ? 'driver exited' : 'driver did not exit within 5 s');
    }
    active.driver = null; active.ownsApp = false;
    steps.push({ name: 'cleanup', ok: true, detail: cleanup.length ? cleanup.join('; ') : 'nothing left running' });
  }
  return { attempt: n, ok: !error, error, valueTried: value, totalMs: Date.now() - t0, steps };
}

function version(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8' }).trim().split('\n')[0]; } catch (e) { return `unavailable: ${e.message}`; }
}

// Resolve a command name to the file that would run; a path is returned unchanged.
function resolveExe(cmd) {
  if (/[\\/]/.test(cmd)) return cmd;
  try { return execFileSync(platform() === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' }).split(/\r?\n/)[0].trim() || cmd; } catch { return cmd; }
}
const hashIfFile = (p) => { try { return sha256(p); } catch { return 'unavailable'; } };

// e.g. "tauri-driver v2.0.6"; cargo prints "name vX.Y.Z:" headers, so the trailing colon is stripped.
function cargoInstalled(name) {
  try {
    const line = execFileSync('cargo', ['install', '--list'], { encoding: 'utf8' }).split('\n').find((l) => l.startsWith(`${name} `));
    return line ? line.replace(/:$/, '') : 'not listed by cargo install --list';
  } catch (e) { return `unavailable: ${e.message.split('\n')[0]}`; }
}

// The evergreen runtime registers per machine or, for per-user installs, under HKCU.
function webview2Version() {
  const guid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  const keys = [`HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${guid}`, `HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${guid}`, `HKCU\\Software\\Microsoft\\EdgeUpdate\\Clients\\${guid}`];
  for (const key of keys) {
    try {
      const m = execFileSync('reg', ['query', key, '/v', 'pv'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).match(/REG_SZ\s+(\S+)/);
      if (m) return m[1];
    } catch { /* key absent; try the next location */ }
  }
  return 'unknown';
}

const env = {
  when: new Date().toISOString(),
  os: `${platform()} ${release()} ${arch()}`,
  app: { path: APP, sha256: sha256(APP) },
  // The executables actually passed to startDriver, identified by resolved path and hash. The package
  // versions below are what the package managers report for them and are labelled as such.
  tauriDriver: {
    path: resolveExe(TAURI_DRIVER),
    sha256: hashIfFile(resolveExe(TAURI_DRIVER)),
    reportedVersion: cargoInstalled('tauri-driver'), // tauri-driver has no --version flag
  },
  nativeDriver: {
    path: NATIVE_DRIVER,
    sha256: hashIfFile(NATIVE_DRIVER),
    reportedVersion: platform() === 'linux'
      // WebKitWebDriver has no --version flag; report the owning Debian package instead.
      ? version('dpkg-query', ['-W', '-f=${Package} ${Version}', 'webkit2gtk-driver'])
      : version(NATIVE_DRIVER, ['--version']),
  },
  display: platform() === 'linux' ? process.env.DISPLAY ?? 'none' : 'interactive Windows session',
  webdriverio: JSON.parse(readFileSync('node_modules/webdriverio/package.json', 'utf8')).version,
  node: process.version,
  webview2: platform() === 'win32' ? webview2Version() : 'n/a',
};
writeFileSync(join(OUT, 'environment.json'), JSON.stringify(env, null, 2));
console.log(JSON.stringify(env, null, 2));

const results = [];
for (let n = 1; n <= COUNT; n++) {
  const r = await runAttempt(n, OUT);
  results.push(r);
  writeFileSync(join(OUT, `attempt-${n}.json`), JSON.stringify(r, null, 2));
  console.log(`attempt ${n}: ${r.ok ? 'PASS' : 'FAIL'} in ${r.totalMs} ms${r.error ? ` -- ${r.error}` : ''}`);
}
const passed = results.filter((r) => r.ok).length;
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ env, attempts: COUNT, passed, failed: COUNT - passed, results: results.map(({ attempt, ok, error, totalMs }) => ({ attempt, ok, error, totalMs })) }, null, 2));
console.log(`\n${passed}/${COUNT} attempts passed. Evidence: ${OUT}`);
process.exit(passed === COUNT ? 0 : 1);
