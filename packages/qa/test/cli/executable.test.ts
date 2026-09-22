// Proves the CLI genuinely runs as `node packages/qa/src/cli/main.ts ...`, with no build step, from another process
// (not just imported as a module inside the test worker) — the thing test/no-build.test.ts proves for the package
// as a whole, exercised here specifically through the paths the plan calls out: malformed args and an unsupported
// profile. "Missing candidate" and "cancellation" apply to `run`, which this build does not implement yet.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test } from 'vitest';
import { EXIT } from '../../src/cli/main.ts';
import { hostOs } from '../fixtures/processes.ts';

const run = promisify(execFile);
const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli', 'main.ts');

const dirs: string[] = [];
afterEach(async () => {
  await Promise.allSettled(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function run_(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [cliPath, ...args]);
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout: string; stderr: string; code: number };
    return { stdout: failure.stdout, stderr: failure.stderr, code: failure.code };
  }
}

describe('the CLI executable', () => {
  test('malformed args: no command at all prints usage on stderr and exits 3, printing nothing on stdout', async () => {
    const result = await run_();
    expect(result.code).toBe(EXIT.infrastructure);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/doctor/);
  });

  test('malformed args: an unknown flag exits 3 naming it', async () => {
    const result = await run_('doctor', '--project', 'x', '--profile', 'y', '--nope', 'z');
    expect(result.code).toBe(EXIT.infrastructure);
    expect(result.stderr).toContain('nope');
  });

  test('an unsupported profile exits 3 and names the profiles the project does declare', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-cli-exe-'));
    dirs.push(dir);
    const path = join(dir, 'project.json');
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        projectId: 'sample',
        releaseBranch: 'main',
        profiles: [{ id: 'here', os: hostOs(), arch: 'x86_64' }],
        requirements: [{ key: 'here/persistence', mode: 'automated', title: 'Persists data across restarts', capabilities: [] }],
        suites: [],
        scenarioFiles: [],
        lifecycleModule: 'lifecycle.ts',
        workflows: { prepare: 'a.yml', gate: 'b.yml', publish: 'c.yml' },
        markers: { releaseNotes: 'release-notes', qa: 'qa' },
      }),
    );

    const result = await run_('doctor', '--project', path, '--profile', 'nowhere', '--json');

    expect(result.code).toBe(EXIT.infrastructure);
    expect(result.stderr).toContain('here');
  });

  test('a machine matching the profile exits 0 with a JSON report on stdout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-cli-exe-'));
    dirs.push(dir);
    const path = join(dir, 'project.json');
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        projectId: 'sample',
        releaseBranch: 'main',
        profiles: [{ id: 'here', os: hostOs(), arch: 'x86_64' }],
        requirements: [{ key: 'here/persistence', mode: 'automated', title: 'Persists data across restarts', capabilities: [] }],
        suites: [],
        scenarioFiles: [],
        lifecycleModule: 'lifecycle.ts',
        workflows: { prepare: 'a.yml', gate: 'b.yml', publish: 'c.yml' },
        markers: { releaseNotes: 'release-notes', qa: 'qa' },
      }),
    );

    const result = await run_('doctor', '--project', path, '--profile', 'here', '--json');

    expect(result.code).toBe(EXIT.ok);
    expect(result.stderr).toBe('');
    const printed = JSON.parse(result.stdout) as { ok: boolean; profile: string };
    expect(printed).toMatchObject({ ok: true, profile: 'here' });
  });
});
