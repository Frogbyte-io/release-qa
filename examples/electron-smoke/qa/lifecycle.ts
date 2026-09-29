// The Electron sample's lifecycle for `release-qa run`. The package is an archive of the packaged app (a .zip on
// Windows, a .tar.gz on Linux), unpacked into the test root: nothing is installed, and nothing is written outside the
// test root, because the run pins the app's data directory there too. Cleanup closes the app; the runner removes
// what the run owns.
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ElectronApp } from '../../../packages/qa/src/drivers/electron.ts';
import type { Lifecycle, RunContext } from '../../../packages/qa/src/runner/execute.ts';
import { app, chromedriver, dataDir, executable, installDir, removeData, runToEnd, windows } from './app.ts';

// Windows' own tar.exe reads zip; it is named by path because a GNU tar earlier on PATH (Git for Windows) does not.
const tar = windows ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe') : 'tar';

async function install(ctx: RunContext): Promise<void> {
  if (ctx.artifact === undefined) throw new Error('this lifecycle unpacks the candidate artifact, and the run has none');
  const dir = installDir(ctx);
  // Files already there are not this run's: owning the directory would let cleanup delete them.
  if (existsSync(dir)) throw new Error(`${dir} already exists and is not this run's; remove it before running`);
  await ctx.own({ kind: 'path', path: dir, label: 'unpacked app' });
  await mkdir(dir, { recursive: true });
  await runToEnd(ctx, 'unpack', tar, [windows ? '-xf' : '-xzf', ctx.artifact.path, '-C', dir]);
  if (!existsSync(executable(ctx))) throw new Error(`the archive was unpacked but ${executable(ctx)} does not exist`);
}

async function reset(ctx: RunContext): Promise<void> {
  await removeData(ctx);
}

async function launch(ctx: RunContext): Promise<void> {
  // The data directory is the run's from the moment the app can create it.
  await ctx.own({ kind: 'path', path: dataDir(ctx), label: 'app data' });
  app.session = await ElectronApp.start(ctx, {
    application: executable(ctx),
    chromedriver: chromedriver(),
    userDataDir: dataDir(ctx),
    // Electron refuses to start as root with Chromium's sandbox on (measured on Ubuntu 24.04 in WSL2). The sandbox is
    // only turned off when the machine's owner asks for it.
    appArgs: !windows && process.env.RELEASE_QA_ELECTRON_NO_SANDBOX === '1' ? ['--no-sandbox'] : [],
  });
}

async function cleanup(ctx: RunContext): Promise<void> {
  const running = app.session;
  app.session = undefined;
  try {
    await running?.close();
  } finally {
    await removeData(ctx);
  }
}

export const lifecycle: Lifecycle = { install, reset, launch, cleanup };
