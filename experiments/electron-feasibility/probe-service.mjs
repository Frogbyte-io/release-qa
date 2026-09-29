// Feasibility probe 1: the supported WebdriverIO Electron integration (@wdio/electron-service, standalone mode)
// against a packaged app. Prints one JSON object of what was observed.
import { startWdioSession, cleanupWdioSession } from '@wdio/electron-service';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const app = resolve(process.argv[2]);
const running = () =>
  execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant() -eq '${app.toLowerCase().replace(/'/g, "''")}' } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8' }).split(/\s+/).filter(Boolean);
const t0 = Date.now();
const out = { before: running() };
try {
  const browser = await startWdioSession([{ browserName: 'electron', 'wdio:electronServiceOptions': { appBinaryPath: app } }]);
  out.startMs = Date.now() - t0;
  out.title = await browser.getTitle();
  out.during = running();
  out.userData = await browser.electron.execute((electron) => electron.app.getPath('userData'));
  await (await browser.$('#setting-input')).setValue('hello');
  await (await browser.$('#save-button')).click();
  await browser.waitUntil(async () => (await (await browser.$('#saved-value')).getText()) === 'hello', { timeout: 5000 });
  out.shown = await (await browser.$('#saved-value')).getText();
  out.screenshotBytes = (await browser.saveScreenshot('output/service.png')).length;
  await cleanupWdioSession(browser);
  await browser.deleteSession();
  await new Promise((r) => setTimeout(r, 3000));
  out.after = running();
} catch (error) {
  out.error = String(error?.stack ?? error).split('\n').slice(0, 8).join('\n');
  out.after = running();
}
console.log(JSON.stringify(out, null, 2));
process.exit(0);
