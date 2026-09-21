// Shared setup for tests that run scenarios through executeScenario.
import type { ExecutionContext, Lifecycle, Scenario, ScenarioEvent } from '../../src/runner/execute.ts';
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
