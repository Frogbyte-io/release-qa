// What the lifecycle and the scenario share: where the app goes, where its data lives, how to run a process to its
// end as something the run owns, and the one live session.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { TauriApp } from '../../../packages/qa/src/drivers/tauri.ts';
import type { RunContext } from '../../../packages/qa/src/runner/execute.ts';

export const IDENTIFIER = 'dev.frogbyte.releaseqa.smoke';
export const PRODUCT = 'Release QA Smoke';
export const windows = process.platform === 'win32';

/** Where the app is installed: inside the designated test root, so the run owns it and the runner can remove it. */
export const installDir = (ctx: RunContext): string => join(ctx.testRoot, 'smoke-app');

/** The installed executable: NSIS puts it at the top of the install directory; the .deb unpacks it under usr/bin. */
export const executable = (ctx: RunContext): string =>
  windows ? join(installDir(ctx), 'release-qa-tauri-smoke.exe') : join(installDir(ctx), 'usr', 'bin', 'release-qa-tauri-smoke');

/** The app's own data directories. The app decides where these are, so they are outside the test root. */
export function dataDirs(): string[] {
  const roots = windows
    ? [process.env.APPDATA, process.env.LOCALAPPDATA]
    : [process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache')];
  return roots.flatMap((root) => (root === undefined || root === '' ? [] : [join(root, IDENTIFIER)]));
}

/** Where Save writes the value (see the sample's README). */
export const settingFile = (): string => join(dataDirs()[0] as string, 'setting.txt');

/** Removes the app's data directories. Only ever a directory named exactly after this sample's identifier. */
export async function removeData(): Promise<void> {
  for (const dir of dataDirs()) {
    if (!dir.endsWith(`${sep}${IDENTIFIER}`)) throw new Error(`refusing to delete ${dir}: not this sample's data directory`);
    await rm(dir, { recursive: true, force: true });
  }
}

/** Runs a command as a process the run owns, and waits for it; a non-zero exit is an error naming the command. */
export async function runToEnd(ctx: RunContext, label: string, command: string, args: readonly string[]): Promise<void> {
  const child = await ctx.spawn(label, command, args, { stdio: 'ignore', windowsHide: true });
  const code = await new Promise<number | null>((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) resolveExit(child.exitCode);
    else child.once('exit', (exitCode) => resolveExit(exitCode));
  });
  if (code !== 0) throw new Error(`${label} (${command}) exited with ${code}`);
}

/** Whether a registry key exists (Windows). */
export function registryKeyExists(key: string): Promise<boolean> {
  return new Promise((resolveQuery) => execFile('reg', ['query', key], { windowsHide: true }, (error) => resolveQuery(error === null)));
}

/** Deletes a registry key (Windows); a key that is already gone is fine. */
export async function deleteRegistryKey(key: string): Promise<void> {
  if (!(await registryKeyExists(key))) return;
  await new Promise<void>((resolveDelete, rejectDelete) =>
    execFile('reg', ['delete', key, '/f'], { windowsHide: true }, (error) => (error ? rejectDelete(error) : resolveDelete())),
  );
}

// What a per-user NSIS install creates outside its directory (measured on this sample; see the setup guide).
export const UNINSTALL_KEY = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT}`;
/** NSIS's remembered install directory. The uninstaller leaves it behind, so cleanup removes it. */
export const REMEMBERED_DIR_KEY = `HKCU\\Software\\frogbyte\\${PRODUCT}`;
export const VENDOR_KEY = 'HKCU\\Software\\frogbyte';

/** The native driver, from the environment: it must match the installed webview, so it is never guessed. */
export function nativeDriver(): string {
  const configured = process.env.RELEASE_QA_NATIVE_DRIVER;
  if (configured !== undefined && configured !== '') return configured;
  if (!windows && existsSync('/usr/bin/WebKitWebDriver')) return '/usr/bin/WebKitWebDriver';
  throw new Error('set RELEASE_QA_NATIVE_DRIVER to the msedgedriver.exe matching the installed WebView2 runtime (see the setup guide)');
}

/** The live session, set by the lifecycle's launch hook and ended by its cleanup hook. */
export const app: { session: TauriApp | undefined } = { session: undefined };

export function session(): TauriApp {
  if (app.session === undefined) throw new Error('the app was not launched');
  return app.session;
}
