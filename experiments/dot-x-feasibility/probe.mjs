// Dot X first-flow feasibility probe (issue #21). Drives an unchanged Dot X build through tauri-driver and Microsoft
// Edge WebDriver, maps a fixture's audio session to a slider, and reads that session's volume independently of Dot X
// while a person moves the Decker's slider. Usage:
//
//   node probe.mjs map    <Dot X.exe> <msedgedriver.exe> <fixture pid> <out dir> [slot=4] [watch seconds=60]
//   node probe.mjs verify <Dot X.exe> <msedgedriver.exe> <fixture pid> <out dir> [slot=4] [watch seconds=60]
//
// `map` launches Dot X, maps the fixture's session to the slot, checks the mapping on screen and on disk, then records
// the fixture's volume while the slider is moved. `verify` launches Dot X again (a restart), checks the mapping is
// still there, records volume again, then removes the mapping and checks it is gone. Each mode ends its session, which
// closes the app; driver.mjs stops everything the session started. A watch window passes only if the readback saw the
// whole range (1.0, and 0 muted), so a run cannot pass without the slider having reached the fixture.
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startSession } from './driver.mjs';

const [mode, app, nativeDriver, fixturePid, out, slotArg = '4', watchArg = '60'] = process.argv.slice(2);
if (!['map', 'verify'].includes(mode) || !app || !nativeDriver || !fixturePid || !out) {
  throw new Error('usage: node probe.mjs map|verify <Dot X.exe> <msedgedriver.exe> <fixture pid> <out dir> [slot] [watch seconds]');
}
const slot = Number(slotArg) - 1;
const watchMs = Number(watchArg) * 1000;
const FIXTURE = 'rqa-audio-fixture';
const readbackExe = join(process.env.TEMP, 'dotx-probe', 'bin', 'rqa-volume-readback.exe');
const selectedAppsFile = join(process.env.APPDATA, 'com.dot-x.dev', 'selectedApps.json');
const dir = join(out, mode);
mkdirSync(dir, { recursive: true });
const log = (line) => { const text = `${new Date().toISOString()} ${line}`; console.log(text); appendFileSync(join(dir, 'log.txt'), `${text}\n`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readback = () => new Promise((resolve, reject) =>
  execFile(readbackExe, [fixturePid], { windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(JSON.parse(stdout)))));
const mappedOnDisk = () => readFileSync(selectedAppsFile, 'utf8').toLowerCase().includes(FIXTURE);

async function waitFor(what, condition, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await condition().catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const slotButton = async (browser) => (await browser.$$('button.rounded-full.w-24.h-12.mt-12'))[slot];

/**
 * Opens the slot's app picker and finds the fixture by search. Returns whether the fixture is ticked for this slot;
 * with `toggle`, clicks it first, which adds or removes the mapping. The picker is closed again either way.
 */
async function picker(browser, name, { toggle = false } = {}) {
  await (await slotButton(browser)).click();
  const search = await browser.$('input[placeholder="Search apps"]');
  await search.waitForDisplayed({ timeout: 10_000 });
  await search.setValue(FIXTURE);
  const entry = await browser.$(`//button[.//div[contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${FIXTURE}')]]`);
  await entry.waitForDisplayed({ timeout: 15_000 });
  if (toggle) {
    await entry.click();
    await sleep(500);
  }
  const ticked = await (await entry.$('input[type="checkbox"]')).isSelected();
  await browser.saveScreenshot(join(dir, `${name}.png`));
  // The picker's close button is the visible one of the modal close buttons.
  for (const close of await browser.$$('button.btn-circle.btn-ghost.absolute')) {
    if (await close.isDisplayed()) { await close.click(); break; }
  }
  await sleep(500);
  return ticked;
}

/** Records every change of the fixture's volume or mute state until the window ends. */
async function watchVolume(label) {
  log(`watching ${FIXTURE} (pid ${fixturePid}) volume for ${watchMs / 1000} s: ${label}`);
  const samples = [];
  let last = '';
  const end = Date.now() + watchMs;
  while (Date.now() < end) {
    const value = await readback();
    const text = JSON.stringify(value.sessions);
    if (text !== last) {
      samples.push({ at: new Date().toISOString(), sessions: value.sessions });
      log(`readback ${text}`);
      last = text;
    }
    await sleep(100);
  }
  writeFileSync(join(dir, 'readback.json'), `${JSON.stringify(samples, null, 2)}\n`);
  const seen = samples.flatMap((sample) => sample.sessions);
  if (!seen.some((v) => v.volume >= 0.99 && !v.muted) || !seen.some((v) => v.volume === 0 && v.muted)) {
    throw new Error('the readback never saw both the top (1.0) and the bottom (0, muted): the slider did not reach the fixture over its whole range');
  }
  return samples;
}

let session;
try {
  log(`launching ${app}`);
  session = await startSession(app, nativeDriver);
  const { browser } = session;
  await waitFor('the device to connect', async () => (await (await browser.$('body')).getText()).includes('Connected'));
  await waitFor('the slot buttons', async () => (await browser.$$('button.rounded-full.w-24.h-12.mt-12')).length === 5);
  log('connected');
  log(`initial readback ${JSON.stringify((await readback()).sessions)}`);

  if (mode === 'map') {
    if (mappedOnDisk()) throw new Error(`${FIXTURE} is already mapped in ${selectedAppsFile}`);
    const ticked = await picker(browser, 'picker-mapped', { toggle: true });
    log(`mapped: ticked for slot ${slot + 1}: ${ticked}; on disk: ${mappedOnDisk()}`);
    if (!ticked || !mappedOnDisk()) throw new Error('the mapping was not made');
    await watchVolume('move the slider to the bottom, then the top, then the middle');
  } else {
    const ticked = await picker(browser, 'picker-after-restart');
    log(`after restart: ticked for slot ${slot + 1}: ${ticked}; on disk: ${mappedOnDisk()}`);
    if (!ticked || !mappedOnDisk()) throw new Error('the mapping did not survive the restart');
    await watchVolume('move the slider again');
    const still = await picker(browser, 'picker-unmapped', { toggle: true });
    log(`unmapped: ticked for slot ${slot + 1}: ${still}; on disk: ${mappedOnDisk()}`);
    if (still || mappedOnDisk()) throw new Error('the removed mapping is still there');
  }
  log('ok');
} catch (error) {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  await session?.browser.saveScreenshot(join(dir, 'failure.png')).catch(() => undefined);
  process.exitCode = 1;
} finally {
  for (const problem of (await session?.stop()) ?? []) {
    log(`cleanup: ${problem}`);
    process.exitCode = 1;
  }
}
