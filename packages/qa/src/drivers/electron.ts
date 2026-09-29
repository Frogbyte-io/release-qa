import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { remote } from 'webdriverio';
import type { RunContext } from '../runner/execute.ts';
import { descendantsOf, portInUse, processesRunning, waitForPort } from './os.ts';
import { message, sleep, takeOver, type TakeOverChecks } from './ownership.ts';

/**
 * Drives an unchanged, packaged Electron application through Electron's own ChromeDriver (see
 * docs/decisions/electron-automation.md): WebdriverIO's `remote()` talks to an external `chromedriver`, which launches
 * the packaged executable and attaches to its window. No WebdriverIO service and no Node inspector are involved, so
 * the app can have the `RunAsNode` and `EnableNodeCliInspectArguments` fuses turned off, as hardened packages do.
 *
 * Everything that chain starts is owned by the run, as in `TauriApp`. chromedriver is started through `ctx.spawn`. The
 * application (Electron runs its main, GPU, network and renderer processes from one executable) is chromedriver's
 * child, not the run's, so it is found below that chromedriver and recorded with `ctx.own`; the runner's cleanup then
 * reaps it even if a hook does not. Nothing is ever matched by name alone, and an instance of the same executable that
 * someone else started is never taken for the run's.
 */
export interface ElectronAppOptions {
  /** Absolute path of the packaged application executable. */
  application: string;
  /** Path of the ChromeDriver built for the application's Electron release (the `electron-chromedriver` package). */
  chromedriver: string;
  /**
   * Absolute path of the directory the application keeps its data in (Electron's `userData`). ChromeDriver would
   * otherwise give every session a fresh temporary one, and nothing could persist across a restart. The caller owns and
   * removes it; keep it inside the test root.
   */
  userDataDir: string;
  /** Further command-line arguments for the application, e.g. `--no-sandbox` where the sandbox cannot start. */
  appArgs?: readonly string[];
  /** chromedriver's port. Default 9515. */
  port?: number;
  /** How long chromedriver and a new session may take to come up. Default 60 s. */
  startTimeoutMs?: number;
  /** How long the application may take to exit after its session ends. Default 10 s. */
  exitTimeoutMs?: number;
  /** How long to wait before each screenshot, so it shows what the page shows. Default 250 ms. */
  screenshotSettleMs?: number;
  /** Evidence file for chromedriver's own log, or false for none. Default `chromedriver.log`. */
  driverLog?: string | false;
}

export type Browser = Awaited<ReturnType<typeof remote>>;

/** One entry of the renderer's console, as ChromeDriver reports it. */
export interface ConsoleEntry {
  level: string;
  message: string;
  timestamp: number;
}

const DEFAULT_PORT = 9515;

/**
 * The environment an Electron app must be started in. `ELECTRON_RUN_AS_NODE` makes any Electron executable behave as
 * a plain Node.js interpreter (it answers every WebDriver launch with "bad option" and exits), and it is set in any
 * process started from another Electron app, such as the desktop dashboard or an Electron-based editor.
 */
export function cleanElectronEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const name of Object.keys(clean)) if (name.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete clean[name];
  return clean;
}

export class ElectronApp {
  /** The context of the phase that opened the current session; the application it launched is owned through it. */
  #ctx: RunContext;
  readonly #options: Required<Omit<ElectronAppOptions, 'appArgs' | 'driverLog'>> & { appArgs: readonly string[] };
  #driverPid = 0;
  #browser: Browser | undefined;
  readonly #checks: TakeOverChecks = { stillMine: async (pid) => (await descendantsOf(this.#driverPid)).includes(pid) };

  private constructor(ctx: RunContext, options: ElectronAppOptions) {
    this.#ctx = ctx;
    this.#options = {
      application: options.application,
      chromedriver: options.chromedriver,
      userDataDir: options.userDataDir,
      appArgs: options.appArgs ?? [],
      port: options.port ?? DEFAULT_PORT,
      startTimeoutMs: options.startTimeoutMs ?? 60_000,
      exitTimeoutMs: options.exitTimeoutMs ?? 10_000,
      screenshotSettleMs: options.screenshotSettleMs ?? 250,
    };
  }

  /**
   * Starts chromedriver and opens a session, which launches the application. Configuration mistakes are reported before
   * anything starts; so are an application that is already running (that instance would not be the run's) and a port
   * something else holds.
   */
  static async start(ctx: RunContext, options: ElectronAppOptions): Promise<ElectronApp> {
    const app = new ElectronApp(ctx, options);
    const { application, chromedriver, userDataDir, port } = app.#options;
    if (!isAbsolute(application)) throw new Error(`the application path ${application} is not absolute`);
    if (!existsSync(application)) throw new Error(`the application ${application} does not exist`);
    if (!isAbsolute(userDataDir)) throw new Error(`the user data directory ${userDataDir} is not absolute`);
    if (isAbsolute(chromedriver) && !existsSync(chromedriver)) throw new Error(`chromedriver ${chromedriver} does not exist`);
    const running = await processesRunning(application);
    if (running.length > 0) throw new Error(`${application} is already running (pid ${running.join(', ')}); a run can only drive an instance it started`);
    if (await portInUse(port)) throw new Error(`something is already listening on port ${port}`);

    const logName = options.driverLog === undefined ? 'chromedriver.log' : options.driverLog;
    // The log is best-effort evidence: a run that does not collect evidence, or a name already taken, still gets a driver.
    const logPath = logName === false ? undefined : await ctx.evidence(logName).catch(() => undefined);
    const args = [`--port=${port}`, ...(logPath === undefined ? [] : [`--log-path=${logPath}`])];
    const driver = await ctx.spawn('chromedriver', chromedriver, args, { stdio: 'ignore', windowsHide: true, env: cleanElectronEnv(process.env) });
    app.#driverPid = driver.pid as number;
    // A driver that cannot start exits at once: stop waiting for its port then, and say why.
    const listening = new AbortController();
    const exited = (code: number | null, signal: NodeJS.Signals | null): void => listening.abort(new Error(`chromedriver exited (${code ?? signal}) before it listened on port ${port}`));
    // It may already be gone: spawning waits to record the process, and a driver that cannot start exits at once.
    if (driver.exitCode !== null || driver.signalCode !== null) exited(driver.exitCode, driver.signalCode);
    else driver.once('exit', exited);
    try {
      await waitForPort(port, app.#options.startTimeoutMs, listening.signal);
    } finally {
      driver.off('exit', exited);
    }
    await app.#open();
    return app;
  }

  /** The live session. Throws once the application has been closed. */
  get browser(): Browser {
    if (this.#browser === undefined) throw new Error('the application is not running: it was closed or never started');
    return this.#browser;
  }

  /**
   * Saves a PNG of the application's page to `path` (from `ctx.evidence`) and returns its SHA-256. It shows the
   * renderer only: no desktop, other windows or window frame. It first waits `screenshotSettleMs`; even so, a
   * screenshot is a record of what was seen, never the proof of state, which stays with the scenario's assertions.
   */
  async screenshot(path: string): Promise<string> {
    const browser = this.browser;
    await sleep(this.#options.screenshotSettleMs);
    return createHash('sha256').update(await browser.saveScreenshot(path)).digest('hex');
  }

  /**
   * The renderer's console since the last call (ChromeDriver hands each entry out once). The main process's own
   * output is not reachable through WebDriver.
   */
  async consoleLog(): Promise<ConsoleEntry[]> {
    return (await this.browser.getLogs('browser')) as ConsoleEntry[];
  }

  /**
   * Saves what a person would want to see about a failure as evidence: a screenshot (`<name>.png`), the page's current DOM
   * (`<name>-dom.html`) and the renderer's console (`<name>-console.json`). Each piece is tried on its own, since a
   * session in trouble may still answer some questions; returns the file names saved and what could not be.
   */
  async captureFailureEvidence(ctx: Pick<RunContext, 'evidence'>, name: string): Promise<{ saved: string[]; failed: string[] }> {
    const saved: string[] = [];
    const failed: string[] = [];
    const attempt = async (file: string, write: (path: string) => Promise<unknown>): Promise<void> => {
      try {
        await write(await ctx.evidence(file));
        saved.push(file);
      } catch (error) {
        failed.push(`${file}: ${message(error)}`);
      }
    };
    await attempt(`${name}.png`, (path) => this.browser.saveScreenshot(path));
    await attempt(`${name}-dom.html`, async (path) => writeFile(path, await this.browser.getPageSource()));
    await attempt(`${name}-console.json`, async (path) => writeFile(path, `${JSON.stringify(await this.consoleLog(), null, 2)}\n`));
    return { saved, failed };
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
    const { application, userDataDir, appArgs, port, startTimeoutMs } = this.#options;
    let failure: unknown;
    try {
      this.#browser = await remote({
        hostname: '127.0.0.1',
        port,
        path: '/',
        logLevel: 'warn',
        connectionRetryTimeout: startTimeoutMs,
        // No `browserName`: with "chrome" ChromeDriver attaches to an empty about:blank page instead of the app's window.
        capabilities: {
          'goog:loggingPrefs': { browser: 'ALL' },
          'goog:chromeOptions': { binary: application, args: [`--user-data-dir=${userDataDir}`, ...appArgs] },
        } as WebdriverIO.Capabilities,
      });
    } catch (error) {
      failure = error;
    }
    try {
      // The run's instance is the one below its own chromedriver, never others started from the same executable.
      const mine = new Set(await descendantsOf(this.#driverPid));
      const launched = (await processesRunning(application)).filter((pid) => mine.has(pid));
      // A session that is up with no application below the driver would leave the app unowned without a word.
      if (failure === undefined && launched.length === 0) {
        failure = new Error(`the session started, but no ${application} was found below this run's chromedriver, so it could not be owned`);
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
