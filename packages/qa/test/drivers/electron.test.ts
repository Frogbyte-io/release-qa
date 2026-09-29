// What the adapter decides before any WebDriver session exists. Driving a real app needs Electron's chromedriver and a
// packaged application; that is exercised by the Electron sample's real runs (see the setup guide), not here.
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanElectronEnv, ElectronApp } from '../../src/drivers/electron.ts';
import { executeScenario } from '../../src/runner/execute.ts';
import { arrange, lifecycleOf, scenarioOf } from '../fixtures/execution.ts';
import { cleanUpProcessesAndRoots } from '../fixtures/processes.ts';

vi.setConfig({ testTimeout: 60_000 });
afterEach(cleanUpProcessesAndRoots);

// A file that exists and is not running from anywhere: it stands in for the packaged application.
const notRunning = import.meta.filename;
const userDataDir = join(import.meta.dirname, 'electron-user-data');

async function launchWith(options: Partial<Parameters<typeof ElectronApp.start>[1]>) {
  const { context } = await arrange({
    lifecycle: lifecycleOf([], { launch: async (ctx) => { await ElectronApp.start(ctx, { application: notRunning, chromedriver: process.execPath, userDataDir, ...options }); } }),
    timeouts: { phaseMs: 30_000, stepsMs: 2000, cleanupMs: 20_000 },
  });
  const began = Date.now();
  const result = await executeScenario(context, scenarioOf());
  return { result, ms: Date.now() - began };
}

describe('starting the driver chain', () => {
  test('an application that does not exist is reported by its path, before anything is started', async () => {
    const application = join(import.meta.dirname, 'no-such-app.exe');
    const { result, ms } = await launchWith({ application });
    expect(result).toMatchObject({ outcome: 'interrupted', reason: 'infrastructure-error' });
    expect(result.detail).toContain(`${application} does not exist`);
    expect(ms).toBeLessThan(15_000);
  });

  test('a relative application or user data path is refused: what runs must be what was meant', async () => {
    expect((await launchWith({ application: 'app.exe' })).result.detail).toContain('is not absolute');
    expect((await launchWith({ userDataDir: 'data' })).result.detail).toContain('user data directory data is not absolute');
  });

  test('a chromedriver that does not exist is reported by its path', async () => {
    const chromedriver = `${process.execPath}.missing`;
    const { result } = await launchWith({ chromedriver });
    expect(result.detail).toContain(`chromedriver ${chromedriver} does not exist`);
  });

  test('a chromedriver that exits before listening is reported with its exit code, not after the full timeout', async () => {
    // Node rejects chromedriver's arguments and exits at once: a driver that cannot start.
    const { result, ms } = await launchWith({ startTimeoutMs: 20_000 });
    expect(result).toMatchObject({ outcome: 'interrupted', reason: 'infrastructure-error' });
    expect(result.detail).toContain('chromedriver exited (9)'); // Node's exit code for an unknown option
    expect(ms).toBeLessThan(15_000);
  });

  test('a port something else already listens on is refused, naming it, before chromedriver is started', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const { result } = await launchWith({ port });
      expect(result.detail).toContain(`already listening on port ${port}`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('an application that is already running is refused: that instance would not be the run\'s', async () => {
    // This test's own Node process is running from process.execPath.
    const { result } = await launchWith({ application: process.execPath });
    expect(result.detail).toMatch(/already running/);
  });
});

describe('the environment an Electron app starts in', () => {
  test('ELECTRON_RUN_AS_NODE is removed, whatever its case, and nothing else is', () => {
    const clean = cleanElectronEnv({ ELECTRON_RUN_AS_NODE: '1', Electron_Run_As_Node: '1', PATH: '/bin', ELECTRON_ENABLE_LOGGING: '1' });
    expect(clean).toEqual({ PATH: '/bin', ELECTRON_ENABLE_LOGGING: '1' });
  });

  test('the environment it was given is not modified', () => {
    const env = { ELECTRON_RUN_AS_NODE: '1' };
    cleanElectronEnv(env);
    expect(env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  });
});
