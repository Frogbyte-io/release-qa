import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { remote } from 'webdriverio';
import type { RunContext } from '../runner/execute.ts';
import { descendantsOf, portInUse, processesRunning, waitForPort } from './os.ts';
import { sleep, takeOver, type TakeOverChecks } from './ownership.ts';

export { takeOver, type TakeOverChecks };

/**
 * Drives an unchanged, installed Tauri application through the WebDriver chain proven in Stage 0 (see
 * docs/decisions/native-automation.md): WebdriverIO's `remote()` talks to an external `tauri-driver`, which starts the
 * platform's native driver (Microsoft Edge WebDriver on Windows, WebKitWebDriver on Linux), which launches the app.
 *
 * Everything that chain starts is owned by the run. tauri-driver is started through `ctx.spawn`. The native driver and
 * the application are not the run's own children, so they are found as descendants of that tauri-driver (the app is
 * the native driver's child, measured on Windows and Linux) and recorded with `ctx.own`; the runner's cleanup then
 * reaps them even if a hook does not. Nothing is ever matched by name, and an instance of the same executable that
 * someone else started is never taken for the run's.
 */
export interface TauriAppOptions {
  /** Absolute path of the installed application executable. */
  application: string;
  /** Absolute path of msedgedriver.exe (Windows) or WebKitWebDriver (Linux), matching the installed webview. */
  nativeDriver: string;
  /** The tauri-driver command; default `tauri-driver` from PATH. */
  tauriDriver?: string;
  /** tauri-driver's port; the native driver gets the next one. Default 4444. */
  port?: number;
  /** How long tauri-driver and a new session may take to come up. Default 60 s. */
  startTimeoutMs?: number;
  /** How long the application may take to exit after its session ends. Default 10 s. */
  exitTimeoutMs?: number;
  /** How long to wait before each screenshot, so it shows what the page shows. Default 500 ms. */
  screenshotSettleMs?: number;
}

export type Browser = Awaited<ReturnType<typeof remote>>;

const DEFAULT_PORT = 4444;

export class TauriApp {
  /** The context of the phase that opened the current session; the application it launched is owned through it. */
  #ctx: RunContext;
  readonly #options: Required<Omit<TauriAppOptions, 'tauriDriver'>> & { tauriDriver: string };
  #driverPid = 0;
  #browser: Browser | undefined;
  readonly #checks: TakeOverChecks = { stillMine: async (pid) => (await descendantsOf(this.#driverPid)).includes(pid) };

  private constructor(ctx: RunContext, options: TauriAppOptions) {
    this.#ctx = ctx;
    this.#options = {
      application: options.application,
      nativeDriver: options.nativeDriver,
      tauriDriver: options.tauriDriver ?? 'tauri-driver',
      port: options.port ?? DEFAULT_PORT,
      startTimeoutMs: options.startTimeoutMs ?? 60_000,
      exitTimeoutMs: options.exitTimeoutMs ?? 10_000,
      screenshotSettleMs: options.screenshotSettleMs ?? 500,
    };
  }

  /**
   * Starts tauri-driver and opens a session, which launches the application. Configuration mistakes are reported
   * before anything starts; so are an application that is already running (that instance would not be the run's) and
   * ports something else holds.
   */
  static async start(ctx: RunContext, options: TauriAppOptions): Promise<TauriApp> {
    const app = new TauriApp(ctx, options);
    const { application, nativeDriver, port } = app.#options;
    if (isAbsolute(nativeDriver) && !existsSync(nativeDriver)) throw new Error(`the native driver ${nativeDriver} does not exist`);
    const running = await processesRunning(application);
    if (running.length > 0) throw new Error(`${application} is already running (pid ${running.join(', ')}); a run can only drive an instance it started`);
    for (const p of [port, port + 1]) if (await portInUse(p)) throw new Error(`something is already listening on port ${p}`);

    const driver = await ctx.spawn('tauri-driver', app.#options.tauriDriver, ['--native-driver', nativeDriver, '--port', String(port), '--native-port', String(port + 1)], { stdio: 'ignore' });
    app.#driverPid = driver.pid as number;
    // A driver that cannot start exits at once: stop waiting for its port then, and say why.
    const listening = new AbortController();
    const exited = (code: number | null, signal: NodeJS.Signals | null): void => listening.abort(new Error(`tauri-driver exited (${code ?? signal}) before it listened on port ${port}`));
    // It may already be gone: spawning waits to record the process, and a driver that cannot start exits at once.
    if (driver.exitCode !== null || driver.signalCode !== null) exited(driver.exitCode, driver.signalCode);
    else driver.once('exit', exited);
    try {
      await waitForPort(port, app.#options.startTimeoutMs, listening.signal);
    } finally {
      driver.off('exit', exited);
    }
    // The native driver is tauri-driver's child, not the run's; own it so it cannot outlive the run.
    await takeOver(ctx, await descendantsOf(app.#driverPid), 'native driver', app.#checks);
    await app.#open();
    return app;
  }

  /** The live session. Throws once the application has been closed. */
  get browser(): Browser {
    if (this.#browser === undefined) throw new Error('the application is not running: it was closed or never started');
    return this.#browser;
  }

  /**
   * Saves a PNG of the application's page to `path` (from `ctx.evidence`) and returns its SHA-256. It shows the webview
   * only: no desktop, other windows or window frame. It first waits `screenshotSettleMs`, because on Linux WebKitGTK
   * can capture a frame from before the page's last change (Stage 0, native-automation finding 4); even so, a
   * screenshot is a record of what was seen, never the proof of state, which stays with the scenario's assertions.
   */
  async screenshot(path: string): Promise<string> {
    const browser = this.browser;
    await sleep(this.#options.screenshotSettleMs);
    return createHash('sha256').update(await browser.saveScreenshot(path)).digest('hex');
  }

  /**
   * Ends the session and waits for the application to exit, then launches it again. `ctx` is the calling phase's own
   * context: the new instance is owned through it, since the context `start` was given belongs to a phase that has
   * ended and can no longer take ownership of anything.
   */
  async restart(ctx: RunContext): Promise<void> {
    await this.close();
    this.#ctx = ctx;
    await this.#open();
  }

  /**
   * Ends the session and waits until no process runs from the application's executable. An application that does
   * not exit is reported as an error; it stays owned, so the runner's cleanup still stops it.
   */
  async close(): Promise<void> {
    const browser = this.#browser;
    this.#browser = undefined;
    if (browser === undefined) return;
    await browser.deleteSession();
    const end = Date.now() + this.#options.exitTimeoutMs;
    let running = await processesRunning(this.#options.application);
    while (running.length > 0 && Date.now() < end) {
      await sleep(250);
      running = await processesRunning(this.#options.application);
    }
    if (running.length > 0) throw new Error(`${this.#options.application} was still running ${this.#options.exitTimeoutMs} ms after its session ended (pid ${running.join(', ')})`);
  }

  /**
   * Opens a session. Whatever `remote()` does, the application it launched is taken over afterwards: a session that
   * fails after launching the app must not leave it running unowned.
   */
  async #open(): Promise<void> {
    let failure: unknown;
    try {
      this.#browser = await remote({
        hostname: '127.0.0.1',
        port: this.#options.port,
        path: '/',
        logLevel: 'warn',
        connectionRetryTimeout: this.#options.startTimeoutMs,
        capabilities: { 'tauri:options': { application: this.#options.application } } as WebdriverIO.Capabilities,
      });
    } catch (error) {
      failure = error;
    }
    try {
      // The run's instances are the ones below its own tauri-driver, never others started from the same executable.
      const mine = new Set(await descendantsOf(this.#driverPid));
      const launched = (await processesRunning(this.#options.application)).filter((pid) => mine.has(pid));
      // A session that is up with no application below the driver chain would leave the app unowned without a word.
      if (failure === undefined && launched.length === 0) {
        failure = new Error(`the session started, but no ${this.#options.application} was found below this run's tauri-driver, so it could not be owned`);
      }
      await takeOver(this.#ctx, launched, 'application', this.#checks);
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined && this.#browser !== undefined) {
      // A session whose application could not be owned is ended, so the app it launched closes.
      await this.#browser.deleteSession().catch(() => undefined);
    }
    if (failure !== undefined) {
      this.#browser = undefined;
      throw failure;
    }
  }
}
