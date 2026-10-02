import type { BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface CaptureOptions {
  /** `<repository>-<number>` of the pull request whose release view to capture, e.g. `Frogbyte-io/sandbox-7`. Default: the first listed. */
  open?: string;
  /** How long to wait for the dashboard to finish reading before giving up. */
  loadTimeoutMs?: number;
}

/** Resolves once the page no longer shows its loading line; rejects if it still does after `timeoutMs`. */
export async function waitForLoaded(window: Pick<BrowserWindow, 'webContents'>, timeoutMs: number, poll = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const loading = await window.webContents.executeJavaScript(`document.querySelector('[data-test="loading"]') !== null`);
    if (loading !== true) return;
    if (Date.now() >= deadline) throw new Error(`the dashboard was still loading after ${timeoutMs} ms`);
    await pause(poll);
  }
}

/**
 * Saves the window's own pixels for UI review: the repositories view, the release view of the first pull request, its Run page and its Manual check page.
 * Actions are disabled while a recorded snapshot is shown, so the Run page is captured before any action (no checkout,
 * Review and run disabled) and the Manual check page as it actually loads from a snapshot: its read is refused.
 * Only an unpackaged build started with RELEASE_QA_CAPTURE_DIR does this (see index.ts). It photographs the window; with a
 * fixture the window shows a recorded snapshot, without one it shows what the app read from GitHub (see `waitForLoaded`).
 */
export async function captureViews(window: BrowserWindow, directory: string, prefix: string, options: CaptureOptions = {}): Promise<void> {
  await mkdir(directory, { recursive: true });
  const save = async (name: string): Promise<void> => {
    await pause(400);
    await writeFile(join(directory, `${prefix}-${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  await pause(1200);
  // A recorded snapshot is there at once; a live read of GitHub takes as long as the gate's calls do. A page still showing
  // "Loading" is not a view of anything, so the capture waits for the read to finish (or fails if it never does).
  await waitForLoaded(window, options.loadTimeoutMs ?? 180_000);
  await save('repositories');
  // Without a choice the first pull request is opened, which is right for a snapshot; a live account lists many.
  const open = options.open === undefined ? '[data-test^="open-"]' : `[data-test="open-${options.open}"]`;
  const opened = await window.webContents.executeJavaScript(`(() => { const button = document.querySelector(${JSON.stringify(open)}); button?.click(); return button !== null; })()`);
  if (opened !== true) throw new Error(`there is no pull request to open for ${open}; the repositories view did not list it`);
  await save('release');
  const click = (selector: string): Promise<unknown> => window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.click()`);
  await click('[data-test="nav-run"]');
  await save('run');
  await click('[data-test="run-back"]');
  await pause(400);
  // Only a snapshot that still lists a manual check has a Manual check page to reach; the passed one has none, and is not faked.
  const hasManualCheck = await window.webContents.executeJavaScript(`document.querySelector('[data-test^="open-manual-"]') !== null`);
  if (!hasManualCheck) return;
  await click('[data-test^="open-manual-"]');
  await pause(400);
  await window.webContents.executeJavaScript(`document.querySelector('[data-test="manual-check"]')?.scrollIntoView()`);
  await save('manual');
}
