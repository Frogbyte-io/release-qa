// What the lifecycle and the scenario share: where the app goes, where its data lives, how to run a process to its
// end as something the run owns, and the one live session.
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ElectronApp } from '../../../packages/qa/src/drivers/electron.ts';
import type { RunContext } from '../../../packages/qa/src/runner/execute.ts';

export const windows = process.platform === 'win32';

/** Where the package is unpacked: inside the designated test root, so the run owns it and the runner can remove it. */
export const installDir = (ctx: RunContext): string => join(ctx.testRoot, 'electron-app');

/** The packaged executable, at the top of the unpacked package. */
export const executable = (ctx: RunContext): string => join(installDir(ctx), windows ? 'release-qa-electron-smoke.exe' : 'release-qa-electron-smoke');

/**
 * The app's data directory. The run pins it (`--user-data-dir`) inside the test root instead of leaving it at the
 * app's default (`%APPDATA%\release-qa-electron-smoke` or `~/.config/release-qa-electron-smoke`), so the run never
 * touches, and never depends on, data the machine's user has there.
 */
export const dataDir = (ctx: RunContext): string => join(ctx.testRoot, 'electron-user-data');

/** Where Save writes the value (see the sample's README). */
export const settingFile = (ctx: RunContext): string => join(dataDir(ctx), 'setting.txt');

/** Removes the app's data directory. */
export const removeData = (ctx: RunContext): Promise<void> => rm(dataDir(ctx), { recursive: true, force: true });

/** Runs a command as a process the run owns, and waits for it; a non-zero exit is an error naming the command. */
export async function runToEnd(ctx: RunContext, label: string, command: string, args: readonly string[]): Promise<void> {
  const child = await ctx.spawn(label, command, args, { stdio: 'ignore', windowsHide: true });
  const ended = await new Promise<string | number>((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) resolveExit(child.exitCode ?? `signal ${child.signalCode}`);
    else child.once('exit', (exitCode, signal) => resolveExit(exitCode ?? `signal ${signal}`));
  });
  if (ended !== 0) throw new Error(`${label} (${command}) exited with ${ended}`);
}

/**
 * The chromedriver built for the sample's Electron release, from the environment, else from the sample's own
 * `electron-chromedriver` install (its version is pinned to the Electron release, which is what makes it match).
 */
export function chromedriver(): string {
  const configured = process.env.RELEASE_QA_CHROMEDRIVER;
  if (configured !== undefined && configured !== '') return configured;
  const installed = join(import.meta.dirname, '..', 'node_modules', 'electron-chromedriver', 'bin', windows ? 'chromedriver.exe' : 'chromedriver');
  if (existsSync(installed)) return installed;
  throw new Error('chromedriver was not found: run `npm ci` in examples/electron-smoke, or set RELEASE_QA_CHROMEDRIVER to the chromedriver built for the packaged Electron release (see the setup guide)');
}

/** The live session, set by the lifecycle's launch hook and ended by its cleanup hook. */
export const app: { session: ElectronApp | undefined } = { session: undefined };

export function session(): ElectronApp {
  if (app.session === undefined) throw new Error('the app was not launched');
  return app.session;
}
