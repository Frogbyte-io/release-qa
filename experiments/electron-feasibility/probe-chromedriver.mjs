// Feasibility probe 2: Electron's own chromedriver (the `electron-chromedriver` package, built for the Electron
// release) driven by the repository's pinned WebdriverIO `remote()` with no service.
//
//   node probe-chromedriver.mjs <packaged executable> <evidence name> [--keep-env]
//
// It records what a Release QA adapter would depend on: how long a session takes, which processes the driver starts,
// whether the app persists data across a restart when its data directory is pinned, how the app ends when the session
// ends, and what is left if the driver dies first. `ELECTRON_RUN_AS_NODE` is removed from the environment the driver
// gets, unless --keep-env is given, to show what that variable does.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { remote } from 'webdriverio';
import { environment, here, running, sleep, stop, tree, writeEvidence } from './lib.mjs';

const app = resolve(process.argv[2]);
const name = process.argv[3];
const keepEnv = process.argv.includes('--keep-env');
const chromedriver = join(here, 'node_modules', 'electron-chromedriver', 'bin', process.platform === 'win32' ? 'chromedriver.exe' : 'chromedriver');
const env = { ...process.env };
if (!keepEnv) delete env.ELECTRON_RUN_AS_NODE;

const userData = mkdtempSync(join(tmpdir(), 'rqa-electron-'));
const out = {
  probe: 'chromedriver',
  environment: environment(join(here, '..', '..', 'examples', 'electron-smoke')),
  electronRunAsNodeInDriverEnvironment: env.ELECTRON_RUN_AS_NODE ?? null,
  chromedriver: execFileSync(chromedriver, ['--version'], { encoding: 'utf8' }).trim().split(' (')[0],
  runningBefore: running(app).length,
};
const driver = spawn(chromedriver, ['--port=9515'], { stdio: 'ignore', windowsHide: true, env });
const open = () =>
  remote({
    hostname: '127.0.0.1',
    port: 9515,
    path: '/',
    logLevel: 'error',
    // No browserName: with "chrome" ChromeDriver attaches to an empty about:blank page instead of the app's window.
    capabilities: { 'goog:loggingPrefs': { browser: 'ALL' }, 'goog:chromeOptions': { binary: app, args: [`--user-data-dir=${userData}`] } },
  });
try {
  await sleep(1500);
  const began = Date.now();
  let browser = await open();
  out.sessionStartMs = Date.now() - began;
  out.processesBelowDriver = Object.values(tree(driver.pid)).reduce((counts, exe) => ({ ...counts, [exe]: (counts[exe] ?? 0) + 1 }), {});
  out.appProcesses = running(app).length;
  out.title = await browser.getTitle();
  await browser.execute(() => console.error('renderer error for the probe'));
  out.consoleEntries = (await browser.getLogs('browser')).map((entry) => `${entry.level} ${entry.message}`);
  out.pageSourceBytes = (await browser.getPageSource()).length;
  await (await browser.$('#setting-input')).setValue('hello');
  await (await browser.$('#save-button')).click();
  await browser.waitUntil(async () => (await (await browser.$('#saved-value')).getText()) === 'hello', { timeout: 5000 });
  out.screenshotBytes = (await browser.saveScreenshot(join(userData, 'shot.png'))).length;
  out.settingOnDisk = existsSync(join(userData, 'setting.txt')) ? readFileSync(join(userData, 'setting.txt'), 'utf8') : null;

  const ending = Date.now();
  await browser.deleteSession();
  while (running(app).length > 0 && Date.now() - ending < 15000) await sleep(100);
  out.msUntilAppGoneAfterDeleteSession = Date.now() - ending;
  out.appProcessesAfterDeleteSession = running(app).length;

  browser = await open();
  out.shownAfterRestart = await (await browser.$('#saved-value')).getText();

  // The crash case: the driver dies without ending the session. What is left is what the runner has to own.
  const before = running(app);
  process.kill(driver.pid);
  await sleep(2500);
  out.appProcessesLeftWhenDriverKilled = running(app).filter((pid) => before.includes(pid)).length;
} catch (error) {
  out.error = String(error?.message ?? error).split('\n')[0];
} finally {
  const left = running(app);
  out.appProcessesStoppedByProbe = left.length;
  stop(left);
  try {
    process.kill(driver.pid);
  } catch {
    /* already gone */
  }
  await sleep(1500);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch (error) {
    out.cleanupError = String(error.message);
  }
}
writeEvidence(name, out);
process.exit(0);
