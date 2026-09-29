// Feasibility probe 2: Electron's own chromedriver (electron-chromedriver, the build matching the Electron release)
// driven by the repository's pinned WebdriverIO `remote()` with no service. Prints one JSON object of observations.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { remote } from 'webdriverio';

const app = resolve(process.argv[2]);
const chromedriver = resolve('node_modules/electron-chromedriver/bin/chromedriver.exe');
const ps = (script) => execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
const pids = (text) => text.split(/\s+/).filter(Boolean).map(Number);
const running = () => pids(ps(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant() -eq '${app.toLowerCase()}' } | ForEach-Object { $_.ProcessId }`));
const tree = (root) => {
  const pairs = ps(`Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }`).split(/\r?\n/).filter(Boolean).map((l) => l.trim().split(/\s+/));
  const found = new Map(); const pending = [String(root)];
  while (pending.length) { const cur = pending.pop(); for (const [pid, parent, name] of pairs) if (parent === cur && !found.has(pid)) { found.set(pid, name); pending.push(pid); } }
  return Object.fromEntries(found);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userData = mkdtempSync(join(tmpdir(), 'rqa-electron-'));
const out = { before: running(), chromedriverVersion: execFileSync(chromedriver, ['--version'], { encoding: 'utf8' }).trim() };
const driver = spawn(chromedriver, ['--port=9515'], { stdio: 'ignore', windowsHide: true });
const session = () => remote({
  hostname: '127.0.0.1', port: 9515, path: '/', logLevel: 'error',
  capabilities: { 'goog:chromeOptions': { binary: app, args: [`--user-data-dir=${userData}`] } },
});
try {
  await sleep(1500);
  const t0 = Date.now();
  let browser = await session();
  out.startMs = Date.now() - t0;
  out.driverTree = tree(driver.pid);
  out.appPids = running();
  out.title = await browser.getTitle();
  await (await browser.$('#setting-input')).setValue('hello');
  await (await browser.$('#save-button')).click();
  await browser.waitUntil(async () => (await (await browser.$('#saved-value')).getText()) === 'hello', { timeout: 5000 });
  out.screenshotBytes = (await browser.saveScreenshot(join(userData, 'shot.png'))).length;
  out.settingOnDisk = existsSync(join(userData, 'setting.txt')) ? readFileSync(join(userData, 'setting.txt'), 'utf8') : null;
  const t1 = Date.now();
  await browser.deleteSession();
  while (running().length && Date.now() - t1 < 15000) await sleep(100);
  out.exitAfterDeleteSessionMs = Date.now() - t1;
  out.afterDelete = running();
  browser = await session();
  out.shownAfterRestart = await (await browser.$('#saved-value')).getText();
  // What is left if the driver dies without ending the session (the runner's crash case)?
  const appBefore = running();
  process.kill(driver.pid);
  await sleep(2500);
  out.appAliveAfterDriverKilled = running().filter((p) => appBefore.includes(p));
  for (const p of running()) try { process.kill(p); } catch {}
  await sleep(1000);
  out.afterManualKill = running();
} catch (error) {
  out.error = String(error?.stack ?? error).split('\n').slice(0, 6).join('\n');
  for (const p of running()) try { process.kill(p); } catch {}
} finally {
  try { process.kill(driver.pid); } catch {}
  await sleep(1500);
  try { rmSync(userData, { recursive: true, force: true }); } catch (e) { out.cleanupError = String(e.message); }
}
console.log(JSON.stringify(out, null, 2));
process.exit(0);
