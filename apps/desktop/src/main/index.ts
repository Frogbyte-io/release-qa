import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GhTransport } from '@frogbyte-io/release-qa';
import { CHANNELS, EVENTS, type DashboardSnapshot, type RunStatus } from '../shared/contract.ts';
import { claimManual, EvidenceRegistry, loadManualCheck, pickEvidence, recordManual, syncManualResult, type ManualDeps } from './manual-checks.ts';
import { loadDashboard, type SnapshotCache } from './qa-commands.ts';
import { mergePullRequest, parsePullRef, prepareReleaseCandidate, previewMerge, pullRequestUrl } from './release-actions.ts';
import { listRemoteRuns, runOnLinux } from './remote-runs.ts';
import { cancelRunAction, chooseCheckout, getCheckout, listRunsAction, previewRun, RunSession, startRunAction, syncRunAction, type CheckoutStore, type RunDeps } from './run-actions.ts';

// The window is untrusted: it renders text that repositories and pull requests wrote. It gets no Node, no GitHub
// credentials and no subprocesses; it can only ask this process for the commands in CHANNELS.
const rendererFile = join(import.meta.dirname, '..', 'renderer', 'index.html');
const rendererUrl = pathToFileURL(rendererFile).href;

/** Bump when `DashboardSnapshot` changes shape, so an older cache file is ignored rather than drawn. */
const CACHE_VERSION = 2;

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

/** Which local folder is each repository's checkout. Only a folder the person picked in the dialog is ever written here. */
function fileCheckouts(): CheckoutStore {
  const file = join(app.getPath('userData'), 'checkouts.json');
  const read = async (): Promise<Record<string, string>> => {
    try {
      const stored = JSON.parse(await readFile(file, 'utf8')) as unknown;
      return stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, string>) : {};
    } catch {
      return {};
    }
  };
  return {
    get: async (repository) => {
      const path = (await read())[repository];
      return typeof path === 'string' && isAbsolute(path) ? path : undefined;
    },
    set: async (repository, path) => { await writeFile(`${file}.tmp`, JSON.stringify({ ...(await read()), [repository]: path })); await rename(`${file}.tmp`, file); },
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

// One app process per user: a second launch would otherwise be a second process with its own idea of the test root.
// The capture script runs from a scratch profile and must not collide with a dashboard the person has open.
const primary = process.env.RELEASE_QA_CAPTURE_DIR !== undefined || app.requestSingleInstanceLock();
if (!primary) app.quit();

void (primary ? app.whenReady() : new Promise<never>(() => undefined)).then(() => {
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
  handle(CHANNELS.runOnLinux, async (input) => (recorded ? notWhileRecorded : runOnLinux(input, { api })));
  handle(CHANNELS.listRemoteRuns, async (input) => (recorded ? notWhileRecorded : listRemoteRuns(input, { api })));
  handle(CHANNELS.openPullRequest, async (input) => {
    if (recorded) return notWhileRecorded;
    const target = parsePullRef(input);
    if (target === undefined) return { ok: false as const, error: 'That is not a valid pull request.' };
    await shell.openExternal(pullRequestUrl(target.repository, target.number));
    return { ok: true as const, message: 'Opened in your browser.' };
  });
  // Manual results live in the app's own data folder, one directory per result.
  const manual: ManualDeps = {
    api,
    stateDir: join(app.getPath('userData'), 'manual-runs'),
    evidence: new EvidenceRegistry(),
    // The dialog runs here, so the window only ever receives handles and names, never a path it could have made up.
    choose: async () => {
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const options = { title: 'Attach evidence', properties: ['openFile' as const, 'multiSelections' as const], filters: [{ name: 'Screenshots, photos, logs and recordings', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'webm', 'txt', 'log', 'json', 'md'] }, { name: 'All files', extensions: ['*'] }] };
      const picked = parent === undefined ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options);
      return picked.canceled ? [] : picked.filePaths;
    },
  };
  handle(CHANNELS.loadManualCheck, async (input) => (recorded ? notWhileRecorded : loadManualCheck(input, manual)));
  handle(CHANNELS.pickEvidence, async () => (recorded ? notWhileRecorded : pickEvidence(manual)));
  handle(CHANNELS.recordManualCheck, async (input) => (recorded ? notWhileRecorded : recordManual(input, manual)));
  handle(CHANNELS.syncManualResult, async (input) => (recorded ? notWhileRecorded : syncManualResult(input, manual)));
  handle(CHANNELS.claimManualCheck, async (input) => (recorded ? notWhileRecorded : claimManual(input, manual)));

  // The run lives here, not in a window: every window that is open is told when it changes, and one opened later asks.
  const session = new RunSession((status: RunStatus) => {
    for (const open of BrowserWindow.getAllWindows()) if (open.webContents.getURL() === rendererUrl) open.webContents.send(EVENTS.runStatus, status);
  });
  const runs: RunDeps = {
    api,
    session,
    checkouts: fileCheckouts(),
    candidatesDir: join(app.getPath('userData'), 'candidates'),
    // Built beside this file by scripts/build.mjs; the shared runner cannot find it from inside a bundle.
    consumerWorker: join(import.meta.dirname, 'consumer-worker.mjs'),
    chooseDirectory: async () => {
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const options = { title: 'Choose the local checkout of this repository', properties: ['openDirectory' as const] };
      const chosen = await (parent === undefined ? dialog.showOpenDialog(options) : dialog.showOpenDialog(parent, options));
      return chosen.canceled ? undefined : chosen.filePaths[0];
    },
  };
  handle(CHANNELS.getCheckout, async (input) => (recorded ? { status: 'none' as const } : getCheckout(input, runs)));
  handle(CHANNELS.chooseCheckout, async (input) => (recorded ? { status: 'none' as const } : chooseCheckout(input, runs)));
  handle(CHANNELS.previewRun, async (input) => (recorded ? notWhileRecorded : previewRun(input, runs)));
  handle(CHANNELS.startRun, async (input) => (recorded ? notWhileRecorded : startRunAction(input, runs)));
  handle(CHANNELS.cancelRun, async () => (recorded ? notWhileRecorded : cancelRunAction(runs)));
  handle(CHANNELS.getRunStatus, async () => session.current);
  handle(CHANNELS.listRuns, async (input) => (recorded ? { ok: true as const, runs: [] } : listRunsAction(input, runs)));
  handle(CHANNELS.syncRun, async (input) => (recorded ? notWhileRecorded : syncRunAction(input, runs)));

  const window = createWindow();
  const capture = process.env.RELEASE_QA_CAPTURE_DIR;
  if (capture !== undefined && !app.isPackaged) {
    window.webContents.once('did-finish-load', () => {
      import('./capture.ts')
        .then(({ captureViews }) => captureViews(window, capture, process.env.RELEASE_QA_CAPTURE_PREFIX ?? 'window', process.env.RELEASE_QA_CAPTURE_OPEN ? { open: process.env.RELEASE_QA_CAPTURE_OPEN } : {}))
        .then(() => app.exit(0), (error: unknown) => { console.error('capture failed:', error); app.exit(1); });
    });
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  // A run belongs to this process, not the window. Closing the last window must not end it: the app stays until the run
  // is over, and starting the app again (or activating it) opens a window that reattaches to the run's state.
  app.on('window-all-closed', () => {
    if (process.platform === 'darwin') return;
    if (!session.busy) { app.quit(); return; }
    void session.settled().then(() => { if (BrowserWindow.getAllWindows().length === 0) app.quit(); });
  });
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows();
    if (existing === undefined) createWindow();
    else { if (existing.isMinimized()) existing.restore(); existing.focus(); }
  });
});
