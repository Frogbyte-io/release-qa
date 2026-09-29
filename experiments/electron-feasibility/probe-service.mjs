// Feasibility probe 1: the supported WebdriverIO Electron integration (`@wdio/electron-service`, standalone mode)
// against a packaged app.
//
//   node probe-service.mjs <packaged executable> <evidence name>
//
// It records what the service needs and does: which webdriverio it loads, how long a session takes, where the app keeps
// its data, and whether its main-process API (`browser.electron.execute`) works. It refuses to start if the app already
// runs, ends the session even when a step fails, and afterwards stops only processes it started, saying how many.
import { startWdioSession, cleanupWdioSession } from '@wdio/electron-service';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { environment, here, running, sleep, stop, writeEvidence } from './lib.mjs';

const app = resolve(process.argv[2]);
const name = process.argv[3];
const existing = running(app);
if (existing.length > 0) {
  console.error(`${app} is already running (pid ${existing.join(', ')}); this probe only drives an instance it started`);
  process.exit(1);
}
const out = {
  probe: '@wdio/electron-service',
  environment: environment(join(here, '..', '..', 'examples', 'electron-smoke')),
  service: JSON.parse(readFileSync(join(here, 'node_modules', '@wdio', 'electron-service', 'package.json'), 'utf8')).version,
  webdriverioLoadedByTheService: JSON.parse(readFileSync(join(here, 'node_modules', '@wdio', 'electron-service', 'node_modules', 'webdriverio', 'package.json'), 'utf8')).version,
  electronRunAsNodeInEnvironment: process.env.ELECTRON_RUN_AS_NODE ?? null,
  runningBefore: 0,
};
mkdirSync(join(here, 'output'), { recursive: true });
const began = Date.now();
let browser;
try {
  browser = await startWdioSession([{ browserName: 'electron', 'wdio:electronServiceOptions': { appBinaryPath: app } }]);
  out.sessionStartMs = Date.now() - began;
  out.title = await browser.getTitle();
  out.appProcesses = running(app).length;
  await (await browser.$('#setting-input')).setValue('hello');
  await (await browser.$('#save-button')).click();
  await browser.waitUntil(async () => (await (await browser.$('#saved-value')).getText()) === 'hello', { timeout: 5000 });
  out.shown = await (await browser.$('#saved-value')).getText();
  out.screenshotBytes = (await browser.saveScreenshot(join(here, 'output', 'service.png'))).length;
  // Where the app keeps its data in this session: the service does not pin it.
  out.userDataDir = await browser.electron.execute((electron) => electron.app.getPath('userData')).catch((error) => `unavailable: ${String(error.message).split('\n')[0]}`);
} catch (error) {
  out.error = String(error?.message ?? error).split('\n')[0];
  out.errorAfterSessionStartMs = Date.now() - began;
} finally {
  // The service's own teardown, whatever happened above; a session that never started has nothing to end.
  if (browser !== undefined) {
    await cleanupWdioSession(browser).catch(() => undefined);
    await browser.deleteSession().catch(() => undefined);
    await sleep(3000);
  }
  // Everything running from the app now was started by this probe (it refused to start otherwise).
  const left = running(app);
  out.appProcessesLeftBehind = left.length;
  stop(left);
}
writeEvidence(name, out);
process.exit(0);
