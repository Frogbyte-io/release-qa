import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { remote } from 'webdriverio';
import type { RunContext } from '../runner/execute.ts';
import { processIdentity } from '../runner/resources.ts';
import { descendantsOf, portInUse, processesRunning, waitForPort } from './os.ts';

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
}

export type Browser = Awaited<ReturnType<typeof remote>>;

const DEFAULT_PORT = 4444;
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};
const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await sleep(50);
  }
  return !alive(pid);
}

/**
 * Makes processes the run started indirectly its own, so the runner reaps them. A process that can no longer be owned
 * (the phase that started it was cut off) or that is alive but cannot be identified is stopped instead, and this
 * throws: a process nobody owns must not be left running. One that exits while being identified needs nothing.
 */
export async function takeOver(
  ctx: Pick<RunContext, 'own'>,
  pids: readonly number[],
  label: string,
  identityOf: (pid: number) => Promise<string | undefined> = processIdentity,
): Promise<void> {
  const problems: string[] = [];
  const stop = async (pid: number, why: string): Promise<void> => {
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
    await goneWithin(pid, 5000);
    problems.push(`${label} ${pid} ${why}, so it was stopped`);
  };
  for (const pid of pids) {
    const identity = await identityOf(pid);
    if (identity === undefined) {
      if (!(await goneWithin(pid, 2000))) await stop(pid, 'could not be identified');
      continue;
    }
    try {
      await ctx.own({ kind: 'process', pid, identity, label });
    } catch (error) {
      await stop(pid, `could not be owned (${message(error)})`);
    }
  }
  if (problems.length > 0) throw new Error(problems.join('; '));
}

export class TauriApp {
  readonly #ctx: RunContext;
  readonly #options: Required<Omit<TauriAppOptions, 'tauriDriver'>> & { tauriDriver: string };
  #driverPid = 0;
  #browser: Browser | undefined;

  private constructor(ctx: RunContext, options: TauriAppOptions) {
    this.#ctx = ctx;
    this.#options = {
      application: options.application,
      nativeDriver: options.nativeDriver,
      tauriDriver: options.tauriDriver ?? 'tauri-driver',
      port: options.port ?? DEFAULT_PORT,
      startTimeoutMs: options.startTimeoutMs ?? 60_000,
      exitTimeoutMs: options.exitTimeoutMs ?? 10_000,
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
    await takeOver(ctx, await descendantsOf(app.#driverPid), 'native driver');
    await app.#open();
    return app;
  }

  /** The live session. Throws once the application has been closed. */
  get browser(): Browser {
    if (this.#browser === undefined) throw new Error('the application is not running: it was closed or never started');
    return this.#browser;
  }

  /** Ends the session and waits for the application to exit, then launches it again. */
  async restart(): Promise<void> {
    await this.close();
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
      await takeOver(this.#ctx, launched, 'application');
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
