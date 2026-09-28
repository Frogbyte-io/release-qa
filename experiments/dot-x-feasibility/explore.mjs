// Launches a Dot X build through tauri-driver and Microsoft Edge WebDriver and records what the main window shows,
// to find the elements a scenario would drive. Nothing is clicked. Usage:
//
//   node explore.mjs <Dot X.exe> <msedgedriver.exe> <output dir>
//
// Everything it starts is stopped by the pid it captured; nothing is matched by name.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { remote } from 'webdriverio';

const [app, nativeDriver, out] = process.argv.slice(2);
if (!app || !nativeDriver || !out) throw new Error('usage: node explore.mjs <Dot X.exe> <msedgedriver.exe> <output dir>');
mkdirSync(out, { recursive: true });
const PORT = 4444;

const listening = (port) => new Promise((resolve) => {
  const socket = connect(port, '127.0.0.1');
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const driver = spawn('tauri-driver', ['--native-driver', nativeDriver, '--port', String(PORT), '--native-port', String(PORT + 1)], { stdio: 'ignore', windowsHide: true });
let browser;
try {
  for (let i = 0; i < 100 && !(await listening(PORT)); i++) await sleep(100);
  browser = await remote({
    hostname: '127.0.0.1', port: PORT, path: '/', logLevel: 'warn', connectionRetryTimeout: 60_000,
    capabilities: { 'tauri:options': { application: app } },
  });
  // The app loads its stores and device list after the page appears.
  await sleep(8000);
  writeFileSync(join(out, 'title.txt'), `${await browser.getTitle()}\n${await browser.getUrl()}\n`);
  writeFileSync(join(out, 'page.html'), await browser.getPageSource());
  await browser.saveScreenshot(join(out, 'main.png'));
  const handles = await browser.getWindowHandles();
  writeFileSync(join(out, 'windows.json'), JSON.stringify(handles, null, 2));
  console.log(`title: ${await browser.getTitle()}; windows: ${handles.length}`);
} finally {
  await browser?.deleteSession().catch(() => undefined);
  driver.kill();
}
