import type { BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Saves the window's own pixels for UI review: the repositories view, then the release view of the first pull request.
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
}
