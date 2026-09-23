// Writes a real consumer project to a scratch directory: qa/project.json, a lifecycle module and a scenario file,
// all loadable both by the test worker and by plain `node` (so the CLI executable can run them too). Scenario and
// hook bodies are plain JavaScript in .ts files, which is valid TypeScript and needs no type stripping to speak of.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostProfile, makeTempDir } from './processes.ts';

/**
 * What a scenario's steps do: pass, fail an assertion, throw, kill the whole process, or `hang`: wait for cancellation
 * for as long as the consumer's `holdPath` file exists, and pass once it has been removed.
 */
export type Behaviour = 'pass' | 'fail' | 'throw' | 'hang' | 'crash';

const STEPS: Record<Behaviour, string> = {
  pass: 'async () => {}',
  fail: "async () => { assert.fail('the saved value was not shown after restart'); }",
  throw: "async () => { throw new Error('the driver went away'); }",
  // An already-aborted signal never fires 'abort' again, so that case must reject straight away.
  hang: "(ctx) => !existsSync(HOLD) ? Promise.resolve() : ctx.signal.aborted ? Promise.reject(ctx.signal.reason) : new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true }))",
  crash: "async () => { process.exit(70); }",
};

export interface ConsumerOptions {
  /** Scenario id to behaviour, for the host profile. Each becomes an automated requirement in suite "release". */
  scenarios: Record<string, Behaviour>;
  /** Manual requirements for the host profile, also in suite "release". */
  manual?: string[];
  /** A scenario id (also listed in `scenarios`) that kills the process the first time it runs and passes afterwards. */
  crashOnce?: string;
}

export interface Consumer {
  dir: string;
  projectPath: string;
  candidatePath: string;
  /** Every hook and scenario call appends `<phase> <artifact path>` here. */
  logPath: string;
  /** While this file exists, `hang` scenarios wait for cancellation. Remove it to let them pass. */
  holdPath: string;
  profile: string;
  artifactBytes: string;
}

export async function writeConsumer(options: ConsumerOptions): Promise<Consumer> {
  // A typo here would otherwise surface as an obscure error deep in generation, or silently test something else.
  for (const [id, behaviour] of Object.entries(options.scenarios)) {
    if (!Object.hasOwn(STEPS, behaviour)) throw new Error(`writeConsumer: scenario "${id}" has unknown behaviour "${behaviour}"`);
  }
  if (options.crashOnce !== undefined && !Object.hasOwn(options.scenarios, options.crashOnce)) {
    throw new Error(`writeConsumer: crashOnce "${options.crashOnce}" is not one of the scenarios`);
  }
  const dir = await makeTempDir('qa-consumer-');
  const qa = join(dir, 'qa');
  await mkdir(qa, { recursive: true });
  const profile = hostProfile();
  const logPath = join(dir, 'calls.log');
  const ids = Object.keys(options.scenarios);
  const manual = options.manual ?? [];

  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  await writeFile(
    join(qa, 'project.json'),
    JSON.stringify({
      schemaVersion: 1,
      projectId: 'consumer',
      releaseBranch: 'main',
      profiles: [profile],
      requirements: [
        ...ids.map((id) => ({ key: `${profile.id}/${id}`, mode: 'automated', title: id, capabilities: [] })),
        ...manual.map((id) => ({ key: `${profile.id}/${id}`, mode: 'manual', title: id, capabilities: [] })),
      ],
      suites: [{ id: 'release', requirements: [...ids, ...manual].map((id) => `${profile.id}/${id}`) }],
      scenarioFiles: ['scenarios.ts'],
      lifecycleModule: 'lifecycle.ts',
      workflows: { prepare: 'qa-prepare.yml', gate: 'qa-gate.yml', publish: 'qa-publish.yml' },
      markers: { releaseNotes: 'release-notes', qa: 'qa' },
    }),
  );

  const log = (phase: string) => `appendFileSync(${JSON.stringify(logPath)}, \`${phase} \${ctx.artifact ? ctx.artifact.path : '-'}\\n\`)`;
  await writeFile(
    join(qa, 'lifecycle.ts'),
    [
      "import { appendFileSync } from 'node:fs';",
      'export const lifecycle = {',
      ...['install', 'reset', 'launch', 'cleanup'].map((phase) => `  ${phase}: async (ctx) => { ${log(phase)}; },`),
      '};',
    ].join('\n'),
  );

  const crashMarker = join(dir, 'crashed-once');
  const holdPath = join(dir, 'hold');
  await writeFile(holdPath, 'x');
  await writeFile(
    join(qa, 'scenarios.ts'),
    [
      "import assert from 'node:assert';",
      "import { appendFileSync, existsSync, writeFileSync } from 'node:fs';",
      'export const scenarios = [',
      ...ids.map((id) => {
        const behaviour = options.crashOnce === id
          ? `async () => { if (!existsSync(${JSON.stringify(crashMarker)})) { writeFileSync(${JSON.stringify(crashMarker)}, 'x'); process.exit(70); } }`
          : STEPS[options.scenarios[id] as Behaviour].replace('HOLD', JSON.stringify(holdPath));
        return `  { id: ${JSON.stringify(id)}, steps: async (ctx) => { ${log(`steps:${id}`)}; return (${behaviour})(ctx); } },`;
      }),
      '];',
    ].join('\n'),
  );

  const artifactBytes = 'installer bytes';
  await writeFile(join(dir, 'setup.bin'), artifactBytes);
  const candidatePath = join(dir, 'candidate.json');
  await writeFile(
    candidatePath,
    JSON.stringify({
      schemaVersion: 1,
      id: 'local-1',
      artifacts: [{ profile: profile.id, name: 'setup.bin', path: 'setup.bin', sha256: createHash('sha256').update(artifactBytes).digest('hex') }],
    }),
  );

  return { dir, projectPath: join(qa, 'project.json'), candidatePath, logPath, holdPath, profile: profile.id, artifactBytes };
}
