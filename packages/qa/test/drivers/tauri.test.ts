// What the adapter decides before any WebDriver session exists. Driving a real app needs tauri-driver, a native driver
// and an installed application; that is exercised by the sample's real runs (see the setup guide), not here.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TauriApp } from '../../src/drivers/tauri.ts';
import { executeScenario } from '../../src/runner/execute.ts';
import { arrange, lifecycleOf, scenarioOf } from '../fixtures/execution.ts';
import { cleanUpProcessesAndRoots } from '../fixtures/processes.ts';

vi.setConfig({ testTimeout: 60_000 });
afterEach(cleanUpProcessesAndRoots);

async function launchWith(options: Parameters<typeof TauriApp.start>[1]) {
  const began = Date.now();
  const { context } = await arrange({
    lifecycle: lifecycleOf([], { launch: async (ctx) => { await TauriApp.start(ctx, options); } }),
    timeouts: { phaseMs: 30_000, stepsMs: 2000, cleanupMs: 20_000 },
  });
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
    expect(result.detail).toMatch(/tauri-driver exited/);
    expect(ms).toBeLessThan(15_000);
  });

  test('an application that is already running is refused: that instance would not be the run\'s', async () => {
    // This test's own Node process is running from process.execPath.
    const { result } = await launchWith({ application: process.execPath, nativeDriver: process.execPath, tauriDriver: process.execPath });
    expect(result.detail).toMatch(/already running/);
  });
});
