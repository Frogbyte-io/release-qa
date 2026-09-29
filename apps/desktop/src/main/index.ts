import { app, BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GhTransport } from '@frogbyte-io/release-qa';
import { CHANNELS, type DashboardSnapshot } from '../shared/contract.ts';
import { loadDashboard, type SnapshotCache } from './qa-commands.ts';
import { mergePullRequest, parsePullRef, prepareReleaseCandidate, previewMerge, pullRequestUrl } from './release-actions.ts';

// The window is untrusted: it renders text that repositories and pull requests wrote. It gets no Node, no GitHub
// credentials and no subprocesses; it can only ask this process for the commands in CHANNELS.
const rendererFile = join(import.meta.dirname, '..', 'renderer', 'index.html');
const rendererUrl = pathToFileURL(rendererFile).href;

/** Bump when `DashboardSnapshot` changes shape, so an older cache file is ignored rather than drawn. */
const CACHE_VERSION = 1;

function fileCache(): SnapshotCache {
  const file = join(app.getPath('userData'), 'dashboard-cache.json');
  return {
    // The file carries the version of the shape it holds; a file from another build is treated as absent.
    read: async () => {
      const stored = JSON.parse(await readFile(file, 'utf8')) as { version?: unknown; snapshot?: unknown };
      return stored.version === CACHE_VERSION ? (stored.snapshot as DashboardSnapshot) : undefined;
    },
    // Written beside and renamed, so a crash mid-write never leaves a cut-off file where the last good copy was.
    write: async (snapshot) => { await writeFile(`${file}.tmp`, JSON.stringify({ version: CACHE_VERSION, snapshot })); await rename(`${file}.tmp`, file); },
  };
}

/** `RELEASE_QA_DASHBOARD_FIXTURE` shows a recorded snapshot instead of reading GitHub; it works only in an unpackaged build. */
const recordedSnapshot = (): string | undefined => (app.isPackaged ? undefined : process.env.RELEASE_QA_DASHBOARD_FIXTURE);

async function currentSnapshot(cache: SnapshotCache, api: GhTransport): Promise<DashboardSnapshot> {
  const fixture = recordedSnapshot();
  if (fixture !== undefined) return JSON.parse(await readFile(fixture, 'utf8')) as DashboardSnapshot;
  return loadDashboard({ api, cache });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    show: false,
    title: 'Release QA',
    webPreferences: {
      preload: join(import.meta.dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.once('ready-to-show', () => window.show());
  // The window shows one local page. Anything that would leave it opens in the browser, and only if it is a GitHub link.
  window.webContents.on('will-navigate', (event, url) => { if (url !== rendererUrl) event.preventDefault(); });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/github\.com\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  void window.loadFile(rendererFile);
  return window;
}

/** A message is honoured only from the dashboard page itself. */
const fromDashboard = (event: IpcMainInvokeEvent): boolean => event.senderFrame?.url === rendererUrl;

app.whenReady().then(() => {
  const cache = fileCache();
  const api = new GhTransport();
  // Every handler answers only the dashboard page, and every argument is validated again on this side (release-actions.ts).
  const handle = <T>(channel: string, run: (input: unknown) => Promise<T>): void => {
    ipcMain.handle(channel, async (event, input: unknown) => {
      if (!fromDashboard(event)) throw new Error('untrusted sender');
      return run(input);
    });
  };
  // A recorded snapshot is not GitHub: while one is shown, nothing may act on the live account by the names in it.
  const recorded = recordedSnapshot() !== undefined;
  const notWhileRecorded = { ok: false as const, error: 'Actions are disabled while a recorded snapshot is shown.' };
  handle(CHANNELS.loadDashboard, () => currentSnapshot(cache, api));
  handle(CHANNELS.prepareCandidate, async (input) => (recorded ? notWhileRecorded : prepareReleaseCandidate(input, { api })));
  handle(CHANNELS.previewMerge, async (input) => (recorded ? notWhileRecorded : previewMerge(input, { api })));
  handle(CHANNELS.mergePullRequest, async (input) => (recorded ? notWhileRecorded : mergePullRequest(input, { api })));
  handle(CHANNELS.openPullRequest, async (input) => {
    if (recorded) return notWhileRecorded;
    const target = parsePullRef(input);
    if (target === undefined) return { ok: false as const, error: 'That is not a valid pull request.' };
    await shell.openExternal(pullRequestUrl(target.repository, target.number));
    return { ok: true as const, message: 'Opened in your browser.' };
  });
  const window = createWindow();
  const capture = process.env.RELEASE_QA_CAPTURE_DIR;
  if (capture !== undefined && !app.isPackaged) {
    window.webContents.once('did-finish-load', () => {
      import('./capture.ts')
        .then(({ captureViews }) => captureViews(window, capture, process.env.RELEASE_QA_CAPTURE_PREFIX ?? 'window'))
        .then(() => app.exit(0), (error: unknown) => { console.error('capture failed:', error); app.exit(1); });
    });
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
