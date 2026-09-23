import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { remote } from 'webdriverio';
import type { RunContext } from '../runner/execute.ts';
import { processIdentity } from '../runner/resources.ts';
import { childrenOf, portInUse, processesRunning, waitForPort } from './os.ts';

/**
 * Drives an unchanged, installed Tauri application through the WebDriver chain proven in Stage 0 (see
 * docs/decisions/native-automation.md): WebdriverIO's `remote()` talks to an external `tauri-driver`, which starts the
 * platform's native driver (Microsoft Edge WebDriver on Windows, WebKitWebDriver on Linux), which launches the app.
 *
 * Everything that chain starts is owned by the run: tauri-driver through `ctx.spawn`, and the native driver and the
 * application (which the run did not spawn itself) found by parent and by exact executable path and recorded with
 * `ctx.own`, so the runner's cleanup reaps them even if a hook does not. Nothing is ever matched by name.
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

export class TauriApp {
  readonly #ctx: RunContext;
  readonly #options: Required<Omit<TauriAppOptions, 'tauriDriver'>> & { tauriDriver: string };
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
   * Starts tauri-driver and opens a session, which launches the application. Refuses to start while the application
   * is already running (nothing about that instance would be the run's) or while something holds the driver's ports.
   */
  static async start(ctx: RunContext, options: TauriAppOptions): Promise<TauriApp> {
    const app = new TauriApp(ctx, options);
    const { application, nativeDriver, port } = app.#options;
    // A wrong path is a configuration mistake; say so at once instead of letting tauri-driver fail to start it.
    if (isAbsolute(nativeDriver) && !existsSync(nativeDriver)) throw new Error(`the native driver ${nativeDriver} does not exist`);
    const running = await processesRunning(application);
    if (running.length > 0) throw new Error(`${application} is already running (pid ${running.join(', ')}); a run can only drive an instance it started`);
    for (const p of [port, port + 1]) if (await portInUse(p)) throw new Error(`something is already listening on port ${p}`);

    const driver = await ctx.spawn('tauri-driver', app.#options.tauriDriver, ['--native-driver', nativeDriver, '--port', String(port), '--native-port', String(port + 1)], { stdio: 'ignore' });
    // A driver that cannot start exits at once; report that, rather than waiting out the whole start timeout.
    const exited = new Promise<never>((_, reject) => {
      const fail = (code: number | null, signal: NodeJS.Signals | null): void => reject(new Error(`tauri-driver exited (${code ?? signal}) before it listened on port ${port}`));
      // It may already be gone: spawning waits to record the process, and a driver that cannot start exits at once.
      if (driver.exitCode !== null || driver.signalCode !== null) fail(driver.exitCode, driver.signalCode);
      else driver.once('exit', fail);
    });
    exited.catch(() => undefined); // it also exits normally later, when the run's cleanup stops it
    await Promise.race([waitForPort(port, app.#options.startTimeoutMs), exited]);
    // The native driver is tauri-driver's child, not the run's; own it so it cannot outlive the run.
    await app.#own(await childrenOf(driver.pid as number), 'native driver');
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
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
      running = await processesRunning(this.#options.application);
    }
    if (running.length > 0) throw new Error(`${this.#options.application} was still running ${this.#options.exitTimeoutMs} ms after its session ended (pid ${running.join(', ')})`);
  }

  async #open(): Promise<void> {
    this.#browser = await remote({
      hostname: '127.0.0.1',
      port: this.#options.port,
      path: '/',
      logLevel: 'warn',
      connectionRetryTimeout: this.#options.startTimeoutMs,
      capabilities: { 'tauri:options': { application: this.#options.application } } as WebdriverIO.Capabilities,
    });
    await this.#own(await processesRunning(this.#options.application), 'application');
  }

  async #own(pids: readonly number[], label: string): Promise<void> {
    for (const pid of pids) {
      const identity = await processIdentity(pid);
      // A process that already exited needs no owning; one that is alive but unidentifiable cannot be owned safely.
      if (identity !== undefined) await this.#ctx.own({ kind: 'process', pid, identity, label });
    }
  }
}
