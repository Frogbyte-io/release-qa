// Shared setup for tests that run scenarios through executeScenario.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionContext, Lifecycle, Scenario, ScenarioEvent } from '../../src/runner/execute.ts';
import { acquireTestRoot } from '../../src/runner/resources.ts';
import { candidate, requirement } from './records.ts';
import { hostOs, hostProfile, makeTestRoot } from './processes.ts';

export const never = (): Promise<void> => new Promise<void>(() => {});
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function lifecycleOf(calls: string[], overrides: Partial<Lifecycle> = {}): Lifecycle {
  const record = (name: string) => async () => { calls.push(name); };
  return { install: record('install'), reset: record('reset'), launch: record('launch'), cleanup: record('cleanup'), ...overrides };
}

export async function arrange(overrides: Partial<ExecutionContext> = {}) {
  const testRoot = await makeTestRoot();
  // The first lock in a process reads its own identity, which on Windows starts PowerShell and can take seconds on a
  // busy machine. Do that here, outside any deadline, so tests with short deadlines measure the code, not the machine.
  // A lookup that fails (on Windows it gives up after 10 s) is not cached, so the run would repeat it inside its 2 s
  // prerequisites deadline and time out before any hook ran. Warm up until the identity is known, twice at most (the
  // tests allow 30 s).
  for (let attempt = 0; attempt < 2; attempt++) {
    const warmUp = await acquireTestRoot(testRoot);
    if (!warmUp.ok) break;
    const lock = JSON.parse(await readFile(join(testRoot, '.release-qa-lock.json'), 'utf8')) as { identity: string };
    await warmUp.release();
    if (lock.identity !== 'unknown') break;
  }
  const calls: string[] = [];
  const events: ScenarioEvent[] = [];
  const controller = new AbortController();
  const context: ExecutionContext = {
    candidate: candidate(),
    profile: hostProfile(),
    testRoot,
    signal: controller.signal,
    emit: (event) => { events.push(event); },
    lifecycle: lifecycleOf(calls),
    probes: { display: async () => true, audio: async () => true },
    timeouts: { phaseMs: 2000, stepsMs: 2000, cleanupMs: 2000 },
    ...overrides,
  };
  return { testRoot, calls, events, controller, context };
}

export const scenarioOf = (overrides: Partial<Scenario> = {}): Scenario => ({
  id: 'persistence',
  requirement: requirement({ key: `${hostOs()}/persistence` }),
  steps: async () => {},
  ...overrides,
});

export const started = (events: readonly ScenarioEvent[]) => events.filter((e) => e.status === 'started').map((e) => e.phase);
