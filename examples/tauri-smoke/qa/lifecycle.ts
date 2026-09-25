// The sample's lifecycle for `release-qa run`. Everything it creates is owned by the run or undone by cleanup:
// - Windows: the NSIS installer runs silently into the test root (`/S /D=<dir>`). Outside that directory it adds an
//   uninstall entry, Start Menu and Desktop shortcuts (all removed by its uninstaller) and a remembered-directory
//   registry key (which the uninstaller leaves, so cleanup removes it).
// - Linux: the .deb is unpacked into the test root with `dpkg-deb -x`, so no root access is needed and nothing is
//   installed system-wide. The binary is the packaged one byte for byte; the package manager's own steps and desktop
//   integration are not exercised.
// The app's data directory is wherever the app puts it; reset and cleanup remove exactly that directory.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { TauriApp } from '../../../packages/qa/src/drivers/tauri.ts';
import type { Lifecycle, RunContext } from '../../../packages/qa/src/runner/execute.ts';
import {
  app,
  deleteRegistryKey,
  executable,
  installDir,
  nativeDriver,
  recoverInstallerTraces,
  registryKeyExists,
  REMEMBERED_DIR_KEY,
  removeData,
  runToEnd,
  UNINSTALL_KEY,
  VENDOR_KEY,
  windows,
} from './app.ts';

async function install(ctx: RunContext): Promise<void> {
  if (ctx.artifact === undefined) throw new Error('this lifecycle installs the candidate artifact, and the run has none');
  // An install this run did not make cannot be owned, and installing over it would take over its entries; what an
  // earlier run in this same root left behind after dying is recognised by where it points, and removed.
  if (windows) await recoverInstallerTraces(ctx);
  const dir = installDir(ctx);
  // Files already there are not this run's: owning the directory would let cleanup delete them.
  if (existsSync(dir)) throw new Error(`${dir} already exists and is not this run's; remove it before running`);
  await ctx.own({ kind: 'path', path: dir, label: 'installed app' });
  if (windows) await runToEnd(ctx, 'installer', ctx.artifact.path, ['/S', `/D=${dir}`]);
  else await runToEnd(ctx, 'unpack', 'dpkg-deb', ['-x', ctx.artifact.path, dir]);
  if (!existsSync(executable(ctx))) throw new Error(`the installer finished but ${executable(ctx)} does not exist`);
}

async function reset(): Promise<void> {
  await removeData();
}

async function launch(ctx: RunContext): Promise<void> {
  app.session = await TauriApp.start(ctx, {
    application: executable(ctx),
    nativeDriver: nativeDriver(),
    ...(process.env.RELEASE_QA_TAURI_DRIVER ? { tauriDriver: process.env.RELEASE_QA_TAURI_DRIVER } : {}),
  });
}

/** Undoes everything install and the app did. Every step runs even if an earlier one failed; failures are reported together. */
async function cleanup(ctx: RunContext): Promise<void> {
  const failures: string[] = [];
  const attempt = async (what: string, step: () => Promise<void>): Promise<void> => {
    try {
      await step();
    } catch (error) {
      failures.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  await attempt('closing the app', async () => {
    const running = app.session;
    app.session = undefined;
    await running?.close();
  });
  if (windows) {
    const uninstaller = join(installDir(ctx), 'uninstall.exe');
    // `_?=` makes the NSIS uninstaller run in place and finish before returning, instead of relaunching from %TEMP%.
    if (existsSync(uninstaller)) await attempt('uninstalling', () => runToEnd(ctx, 'uninstaller', uninstaller, ['/S', `_?=${installDir(ctx)}`]));
    await attempt('removing the remembered install directory', () => deleteRegistryKey(REMEMBERED_DIR_KEY));
    await attempt('removing the vendor registry key if nothing else is in it', async () => {
      if (await registryKeyIsEmpty(VENDOR_KEY)) await deleteRegistryKey(VENDOR_KEY);
    });
    await attempt('checking the uninstall entry is gone', async () => {
      if (await registryKeyExists(UNINSTALL_KEY)) throw new Error(`${UNINSTALL_KEY} is still there`);
    });
  }
  await attempt('removing the app data', removeData);
  if (failures.length > 0) throw new Error(failures.join('; '));
}

/**
 * True when the key exists and has neither values nor subkeys. Measured: `reg query` prints nothing for an empty key, one
 * line per subkey, and the key's own name followed by its values when it has values.
 */
function registryKeyIsEmpty(key: string): Promise<boolean> {
  return new Promise((resolveQuery) =>
    execFile('reg', ['query', key], { windowsHide: true }, (error, stdout) => {
      if (error !== null) return resolveQuery(false);
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      resolveQuery(lines.length === 0);
    }),
  );
}

export const lifecycle: Lifecycle = { install, reset: () => reset(), launch, cleanup };
