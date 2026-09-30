import type { BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Saves the window's own pixels for UI review: the repositories view, the release view of the first pull request, its Run page and its Manual check page.
 * Actions are disabled while a recorded snapshot is shown, so the Run page is captured before any action (no checkout,
 * Review and run disabled) and the Manual check page as it actually loads from a snapshot: its read is refused.
 * Only an unpackaged build started with RELEASE_QA_CAPTURE_DIR does this (see index.ts); it reads the window, never GitHub.
 */
export async function captureViews(window: BrowserWindow, directory: string, prefix: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const save = async (name: string): Promise<void> => {
    await pause(400);
    await writeFile(join(directory, `${prefix}-${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  await pause(1200);
  await save('repositories');
  await window.webContents.executeJavaScript(`document.querySelector('[data-test^="open-"]')?.click()`);
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
