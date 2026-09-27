import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { loadConsumer } from '../../src/cli/consumer.ts';
import { loadProject } from '../../src/cli/project.ts';
import { selectPlan } from '../../src/cli/plan.ts';
import type { RunContext } from '../../src/runner/execute.ts';
import { writeConsumer } from '../fixtures/consumer.ts';
import { cleanUpProcessesAndRoots, eventually, isAlive, startUnrelatedProcess } from '../fixtures/processes.ts';

afterEach(cleanUpProcessesAndRoots);

async function planFor(projectPath: string, profile: string) {
  const loaded = await loadProject(projectPath);
  if (!loaded.ok) throw new Error(loaded.error);
  const plan = selectPlan(loaded.project, profile, 'release');
  if (!plan.ok) throw new Error(plan.error);
  return { project: loaded.project, plan };
}

const failure = async (...args: Parameters<typeof loadConsumer>): Promise<string> => {
  const result = await loadConsumer(...args);
  if (result.ok) throw new Error('expected loading to fail');
  return result.error;
};

describe('loading a consumer project\'s code', () => {
  test('binds each automated requirement to the scenario with the same id, in plan order', async () => {
    const consumer = await writeConsumer({ scenarios: { startup: 'pass', persistence: 'pass' } });
    const { project, plan } = await planFor(consumer.projectPath, consumer.profile);

    const result = await loadConsumer(consumer.projectPath, project, plan.automated);

    if (!result.ok) throw new Error(result.error);
    try {
      expect(result.scenarios.map((s) => [s.id, s.requirement.key])).toEqual([
        ['startup', `${consumer.profile}/startup`],
        ['persistence', `${consumer.profile}/persistence`],
      ]);
      expect(typeof result.lifecycle.install).toBe('function');
    } finally {
      await result.close();
    }
  });

  test('a requirement no scenario file defines is refused before anything runs, naming it', async () => {
    const consumer = await writeConsumer({ scenarios: { persistence: 'pass' } });
    const { project, plan } = await planFor(consumer.projectPath, consumer.profile);
    const missing = { ...plan.automated[0]!, key: `${consumer.profile}/uninstall` as const };
    expect(await failure(consumer.projectPath, project, [...plan.automated, missing])).toContain('uninstall');
  });

  test('a lifecycle module without a complete lifecycle export is refused, naming what is missing', async () => {
    const consumer = await writeConsumer({ scenarios: { persistence: 'pass' } });
    await writeFile(join(consumer.dir, 'qa', 'lifecycle.ts'), 'export const lifecycle = { install: async () => {} };');
    const { project, plan } = await planFor(consumer.projectPath, consumer.profile);
    expect(await failure(consumer.projectPath, project, plan.automated)).toMatch(/reset/);
  });

  test('a scenario file without a scenarios array is refused', async () => {
    const consumer = await writeConsumer({ scenarios: { persistence: 'pass' } });
    await writeFile(join(consumer.dir, 'qa', 'scenarios.ts'), 'export const something = 1;');
    const { project, plan } = await planFor(consumer.projectPath, consumer.profile);
    expect(await failure(consumer.projectPath, project, plan.automated)).toMatch(/scenarios/);
  });

  test('two scenario files defining the same id are refused: which one runs would be ambiguous', async () => {
    const consumer = await writeConsumer({ scenarios: { persistence: 'pass' } });
    await writeFile(join(consumer.dir, 'qa', 'again.ts'), "export const scenarios = [{ id: 'persistence', steps: async () => {} }];");
    const { project, plan } = await planFor(consumer.projectPath, consumer.profile);
    const withTwoFiles = { ...project, scenarioFiles: ['scenarios.ts', 'again.ts'] };
    expect(await failure(consumer.projectPath, withTwoFiles, plan.automated)).toMatch(/persistence.*more than once/);
  });

  test('a module that throws while loading is a refusal with its message, not a crash', async () => {
    const consumer = await writeConsumer({ scenarios: { persistence: 'pass' } });
    await writeFile(join(consumer.dir, 'qa', 'lifecycle.ts'), "throw new Error('cannot find the installer tool');");
    const { project, plan } = await planFor(consumer.projectPath, consumer.profile);
    expect(await failure(consumer.projectPath, project, plan.automated)).toContain('cannot find the installer tool');
  });
});

describe('module shapes that throw while being inspected', () => {
  test('a lifecycle whose hook is a throwing getter is a refusal, not a crash', async () => {
    const consumer = await writeConsumer({ scenarios: { persistence: 'pass' } });
    await writeFile(join(consumer.dir, 'qa', 'lifecycle.ts'), "export const lifecycle = { get install() { throw new Error('getter exploded'); } };");
    const { project, plan } = await planFor(consumer.projectPath, consumer.profile);
    expect(await failure(consumer.projectPath, project, plan.automated)).toContain('getter exploded');
  });

  test('a scenario definition whose id is a throwing getter is a refusal, not a crash', async () => {
    const consumer = await writeConsumer({ scenarios: { persistence: 'pass' } });
    await writeFile(join(consumer.dir, 'qa', 'scenarios.ts'), "export const scenarios = [{ get id() { throw new Error('id exploded'); }, steps: async () => {} }];");
    const { project, plan } = await planFor(consumer.projectPath, consumer.profile);
    expect(await failure(consumer.projectPath, project, plan.automated)).toContain('id exploded');
  });
});

test('cancelling while the parent is starting a helper stops it before cleanup continues', async () => {
  const consumer = await writeConsumer({ scenarios: { persistence: 'pass' } });
  await writeFile(join(consumer.dir, 'qa', 'scenarios.ts'), `export const scenarios = [{ id: 'persistence', steps: async (ctx) => {
  await ctx.spawn('helper', process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
} }];`);
  const { project, plan } = await planFor(consumer.projectPath, consumer.profile);
  const loaded = await loadConsumer(consumer.projectPath, project, plan.automated);
  if (!loaded.ok) throw new Error(loaded.error);
  let started!: () => void;
  let release!: () => void;
  const spawnStarted = new Promise<void>((resolve) => { started = resolve; });
  const allowSpawnToReturn = new Promise<void>((resolve) => { release = resolve; });
  const controller = new AbortController();
  const helper = startUnrelatedProcess();
  const context: RunContext = {
    candidate: { id: 'local' }, profile: project.profiles[0]!, testRoot: consumer.dir, signal: controller.signal,
    own: async () => undefined,
    spawn: async () => { started(); await allowSpawnToReturn; return helper; },
    waitFor: async () => undefined,
  };
  try {
    const running = loaded.scenarios[0]!.steps(context);
    await spawnStarted;
    controller.abort();
    release();
    await expect(running).rejects.toThrow();
    await eventually(() => !isAlive(helper.pid as number));
  } finally {
    release();
    await loaded.close();
  }
});
