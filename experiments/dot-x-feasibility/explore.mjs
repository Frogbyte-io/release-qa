// Launches a Dot X build through tauri-driver and Microsoft Edge WebDriver and records what the main window shows,
// to find the elements a scenario would drive. Nothing is clicked. Usage:
//
//   node explore.mjs <Dot X.exe> <msedgedriver.exe> <output dir>
//
// Everything it starts is stopped through driver.mjs; nothing is matched by name.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startSession } from './driver.mjs';

const [app, nativeDriver, out] = process.argv.slice(2);
if (!app || !nativeDriver || !out) throw new Error('usage: node explore.mjs <Dot X.exe> <msedgedriver.exe> <output dir>');
mkdirSync(out, { recursive: true });

const { browser, stop } = await startSession(app, nativeDriver);
try {
  // The app fills the page after it loads its stores; the five slot buttons are there once it has. A device is not
  // required to explore, so a missing one is noted rather than waited for.
  await browser.waitUntil(async () => (await browser.$$('button.rounded-full.w-24.h-12.mt-12')).length === 5, { timeout: 30_000, timeoutMsg: 'the slot buttons never appeared' });
  const connected = await browser.waitUntil(async () => (await (await browser.$('body')).getText()).includes('Connected'), { timeout: 10_000 }).then(() => true, () => false);
  writeFileSync(join(out, 'title.txt'), `${await browser.getTitle()}\n${await browser.getUrl()}\ndevice connected: ${connected}\n`);
  writeFileSync(join(out, 'page.html'), await browser.getPageSource());
  await browser.saveScreenshot(join(out, 'main.png'));
  const handles = await browser.getWindowHandles();
  writeFileSync(join(out, 'windows.json'), JSON.stringify(handles, null, 2));
  console.log(`title: ${await browser.getTitle()}; windows: ${handles.length}; device connected: ${connected}`);
} catch (error) {
  console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  const problems = await stop();
  for (const problem of problems) console.error(`cleanup: ${problem}`);
  if (problems.length > 0) process.exitCode = 1;
}
