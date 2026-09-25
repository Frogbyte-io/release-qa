// What the adapter decides before any WebDriver session exists. Driving a real app needs tauri-driver, a native driver
// and an installed application; that is exercised by the sample's real runs (see the setup guide), not here.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { takeOver, TauriApp } from '../../src/drivers/tauri.ts';
import { processIdentity, type OwnedResource } from '../../src/runner/resources.ts';
import { executeScenario } from '../../src/runner/execute.ts';
import { arrange, lifecycleOf, scenarioOf } from '../fixtures/execution.ts';
import { cleanUpProcessesAndRoots, eventually, isAlive, trackProcess } from '../fixtures/processes.ts';

vi.setConfig({ testTimeout: 60_000 });
afterEach(cleanUpProcessesAndRoots);

async function launchWith(options: Parameters<typeof TauriApp.start>[1]) {
  const { context } = await arrange({
    lifecycle: lifecycleOf([], { launch: async (ctx) => { await TauriApp.start(ctx, options); } }),
    timeouts: { phaseMs: 30_000, stepsMs: 2000, cleanupMs: 20_000 },
  });
  const began = Date.now();
  const result = await executeScenario(context, scenarioOf());
  return { result, ms: Date.now() - began };
}

describe('starting the driver chain', () => {
  test('a native driver that does not exist is reported by its path, before anything is started', async () => {
    const { result, ms } = await launchWith({ application: process.execPath, nativeDriver: `${process.execPath}.missing`, startTimeoutMs: 20_000 });
    expect(result).toMatchObject({ outcome: 'interrupted', reason: 'infrastructure-error' });
    expect(result.detail).toContain(`${process.execPath}.missing`);
    expect(ms).toBeLessThan(15_000);
  });

  test('a tauri-driver that exits before listening is reported with its exit code, not after the full timeout', async () => {
    // Node rejects tauri-driver's arguments and exits at once: a driver that cannot start.
    const { result, ms } = await launchWith({ application: `${process.execPath}.not-running`, nativeDriver: process.execPath, tauriDriver: process.execPath, startTimeoutMs: 20_000 });
    expect(result).toMatchObject({ outcome: 'interrupted', reason: 'infrastructure-error' });
    expect(result.detail).toContain('tauri-driver exited (9)'); // Node's exit code for an unknown option
    expect(ms).toBeLessThan(15_000);
  });

  test('a port something else already listens on is refused, naming it, before tauri-driver is started', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const { result } = await launchWith({ application: `${process.execPath}.not-running`, nativeDriver: process.execPath, tauriDriver: process.execPath, port });
      expect(result.detail).toContain(`already listening on port ${port}`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('an application that is already running is refused: that instance would not be the run\'s', async () => {
    // This test's own Node process is running from process.execPath.
    const { result } = await launchWith({ application: process.execPath, nativeDriver: process.execPath, tauriDriver: process.execPath });
    expect(result.detail).toMatch(/already running/);
  });
});

describe('taking over what the driver chain started', () => {
  const sleeper = () => trackProcess(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }));
  const owned: OwnedResource[] = [];
  const ctx = (refuse = false) => ({ own: async (resource: OwnedResource) => { if (refuse) throw new Error('this run has been stopped'); owned.push(resource); } });
  afterEach(() => { owned.length = 0; });

  test('records each process with its identity, so the runner can reap it', async () => {
    const child = sleeper();
    await takeOver(ctx(), [child.pid as number], 'application');
    expect(owned).toEqual([{ kind: 'process', pid: child.pid, identity: await processIdentity(child.pid as number), label: 'application' }]);
  });

  test('a process the run can no longer own is stopped, and the start fails saying so', async () => {
    const child = sleeper();
    await expect(takeOver(ctx(true), [child.pid as number], 'application')).rejects.toThrow(/could not be owned.*stopped/);
    await eventually(() => !isAlive(child.pid as number));
  });

  test('a live process that cannot be identified is stopped, not silently left unowned', async () => {
    const child = sleeper();
    await expect(takeOver(ctx(), [child.pid as number], 'application', async () => undefined)).rejects.toThrow(/could not be identified.*stopped/);
    await eventually(() => !isAlive(child.pid as number));
    expect(owned).toEqual([]);
  });

  test('one that exits while being identified needs nothing', async () => {
    const child = sleeper();
    setTimeout(() => child.kill(), 200);
    await expect(takeOver(ctx(), [child.pid as number], 'application', async () => undefined)).resolves.toBeUndefined();
  });
});
