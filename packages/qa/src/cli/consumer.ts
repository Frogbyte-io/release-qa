import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Project } from '../model/project.ts';
import type { Requirement } from '../model/requirement.ts';
import type { Lifecycle, RunContext, Scenario } from '../runner/execute.ts';

export type LoadedConsumer = { ok: true; lifecycle: Lifecycle; scenarios: Scenario[] } | { ok: false; error: string };

interface ScenarioDefinition {
  id: string;
  setup?(ctx: RunContext): Promise<void>;
  steps(ctx: RunContext): Promise<void>;
}

const HOOKS = ['install', 'reset', 'launch', 'cleanup'] as const;
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Imports the project's lifecycle module and scenario files and binds each automated requirement to the scenario
 * whose id is the part of its key after the profile. This executes the project's code: the caller runs it only for
 * a project the user pointed the CLI at. Every problem is found before anything is installed. Never throws.
 */
export async function loadConsumer(projectPath: string, project: Project, requirements: readonly Requirement[]): Promise<LoadedConsumer> {
  // Inspecting what a module exports runs its code too (a getter can throw), so all of it is inside this boundary.
  try {
    return await inspectConsumer(projectPath, project, requirements);
  } catch (error) {
    return { ok: false, error: `could not read the project's lifecycle or scenarios: ${message(error)}` };
  }
}

async function inspectConsumer(projectPath: string, project: Project, requirements: readonly Requirement[]): Promise<LoadedConsumer> {
  const base = dirname(resolve(projectPath));
  const load = async (relative: string): Promise<{ ok: true; module: Record<string, unknown> } | { ok: false; error: string }> => {
    const path = resolve(base, ...relative.split('/'));
    try {
      return { ok: true, module: (await import(pathToFileURL(path).href)) as Record<string, unknown> };
    } catch (error) {
      return { ok: false, error: `could not load ${path}: ${message(error)}` };
    }
  };

  const lifecycleModule = await load(project.lifecycleModule);
  if (!lifecycleModule.ok) return lifecycleModule;
  const lifecycle = lifecycleModule.module.lifecycle as Record<string, unknown> | undefined;
  const missingHooks = HOOKS.filter((hook) => typeof lifecycle?.[hook] !== 'function');
  if (missingHooks.length > 0) {
    return { ok: false, error: `${project.lifecycleModule} must export \`lifecycle\` with ${HOOKS.join(', ')}; missing: ${missingHooks.join(', ')}` };
  }

  const definitions = new Map<string, ScenarioDefinition>();
  for (const file of project.scenarioFiles) {
    const loaded = await load(file);
    if (!loaded.ok) return loaded;
    const exported = loaded.module.scenarios;
    if (!Array.isArray(exported)) return { ok: false, error: `${file} must export \`scenarios\`, an array of { id, setup?, steps }` };
    for (const [index, value] of exported.entries()) {
      const definition = value as Partial<ScenarioDefinition> | null;
      if (typeof definition?.id !== 'string' || typeof definition.steps !== 'function' || (definition.setup !== undefined && typeof definition.setup !== 'function')) {
        return { ok: false, error: `${file}: scenarios[${index}] must have a string id, a steps function and optionally a setup function` };
      }
      if (definitions.has(definition.id)) return { ok: false, error: `scenario "${definition.id}" is defined more than once` };
      definitions.set(definition.id, definition as ScenarioDefinition);
    }
  }

  const scenarios: Scenario[] = [];
  const undefinedIds: string[] = [];
  for (const requirement of requirements) {
    const id = requirement.key.slice(requirement.key.indexOf('/') + 1);
    const definition = definitions.get(id);
    if (definition === undefined) {
      undefinedIds.push(requirement.key);
      continue;
    }
    scenarios.push({
      id,
      requirement,
      steps: (ctx) => definition.steps(ctx),
      ...(definition.setup === undefined ? {} : { setup: (ctx: RunContext) => (definition.setup as NonNullable<ScenarioDefinition['setup']>)(ctx) }),
    });
  }
  if (undefinedIds.length > 0) return { ok: false, error: `no scenario file defines: ${undefinedIds.join(', ')}` };

  const hooks = lifecycle as unknown as Lifecycle;
  return {
    ok: true,
    scenarios,
    lifecycle: { install: (ctx) => hooks.install(ctx), reset: (ctx) => hooks.reset(ctx), launch: (ctx) => hooks.launch(ctx), cleanup: (ctx) => hooks.cleanup(ctx) },
  };
}
