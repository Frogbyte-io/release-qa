// Feasibility probe 1: the supported WebdriverIO Electron integration (`@wdio/electron-service`, standalone mode)
// against a packaged app.
//
//   node probe-service.mjs <packaged executable> <evidence name>
//
// It records what the service needs and does: which webdriverio it loads, how long a session takes, where the app keeps
// its data, and whether its main-process API (`browser.electron.execute`) works. It stops anything the probe left
// running and says how many processes that was.
import { startWdioSession, cleanupWdioSession } from '@wdio/electron-service';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { environment, here, running, sleep, stop, writeEvidence } from './lib.mjs';

const app = resolve(process.argv[2]);
const name = process.argv[3];
const out = {
  probe: '@wdio/electron-service',
  environment: environment(join(here, '..', '..', 'examples', 'electron-smoke')),
  service: JSON.parse(readFileSync(join(here, 'node_modules', '@wdio', 'electron-service', 'package.json'), 'utf8')).version,
  webdriverioLoadedByTheService: JSON.parse(readFileSync(join(here, 'node_modules', '@wdio', 'electron-service', 'node_modules', 'webdriverio', 'package.json'), 'utf8')).version,
  electronRunAsNodeInEnvironment: process.env.ELECTRON_RUN_AS_NODE ?? null,
  runningBefore: running(app).length,
};
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
  await cleanupWdioSession(browser);
  await browser.deleteSession();
  await sleep(3000);
} catch (error) {
  out.error = String(error?.message ?? error).split('\n')[0];
  out.errorAfterSessionStartMs = Date.now() - began;
} finally {
  const left = running(app);
  out.appProcessesLeftBehind = left.length;
  stop(left);
}
writeEvidence(name, out);
process.exit(0);
