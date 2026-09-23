// Proves the CLI genuinely runs as `node packages/qa/src/cli/main.ts ...`, with no build step, from another process
// (not just imported as a module inside the test worker) — the thing test/no-build.test.ts proves for the package
// as a whole, exercised here through the paths the plan calls out: malformed args, an unsupported profile, a missing
// candidate and cancellation, plus a genuine crash in the middle of a scenario followed by `resume`.
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EXIT } from '../../src/cli/main.ts';
import { readRun } from '../../src/runner/journal.ts';
import { writeConsumer, type Consumer } from '../fixtures/consumer.ts';
import { cleanUpProcessesAndRoots, eventually, hostOs, trackProcess } from '../fixtures/processes.ts';

// Each case starts a Node process, and reading a process's identity starts PowerShell on Windows.
vi.setConfig({ testTimeout: 60_000 });
afterEach(cleanUpProcessesAndRoots);

const run = promisify(execFile);
const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli', 'main.ts');

const dirs: string[] = [];
afterEach(async () => {
  await Promise.allSettled(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function run_(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return runIn(process.cwd(), ...args);
}

async function runIn(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [cliPath, ...args], { cwd });
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

describe('running a suite through the executable', () => {
  const runArgs = (consumer: Consumer): string[] => ['run', '--project', consumer.projectPath, '--candidate', consumer.candidatePath, '--profile', consumer.profile, '--suite', 'release'];

  test('a missing candidate manifest exits 3 before anything runs', async () => {
    const consumer = await writeConsumer({ scenarios: { persistence: 'pass' } });
    expect((await runIn(consumer.dir, 'designate')).code).toBe(EXIT.ok);
    await rm(consumer.candidatePath);
    const result = await runIn(consumer.dir, ...runArgs(consumer));
    expect(result.code).toBe(EXIT.infrastructure);
    expect(result.stderr).toContain('candidate.json');
    expect(await readFile(consumer.logPath, 'utf8').catch(() => '')).toBe('');
  });

  test('a process that dies in the middle of a scenario leaves a run that resume completes, with the crash on record', async () => {
    const consumer = await writeConsumer({ scenarios: { startup: 'pass', persistence: 'pass' }, crashOnce: 'persistence' });
    expect((await runIn(consumer.dir, 'designate')).code).toBe(EXIT.ok);

    const crashed = await runIn(consumer.dir, ...runArgs(consumer));
    expect(crashed.code).toBe(70); // the scenario itself killed the process
    const runId = /run (\S+) started/.exec(crashed.stderr)?.[1];
    expect(runId).toBeDefined();

    const resumed = await runIn(consumer.dir, 'resume', '--run', runId as string, '--json');

    expect(resumed.code).toBe(EXIT.ok);
    const summary = JSON.parse(resumed.stdout) as { results: Array<{ requirement: string; outcome: string; carried?: boolean }> };
    expect(summary.results.map((r) => [r.requirement.split('/')[1], r.outcome, r.carried ?? false])).toEqual([
      ['startup', 'passed', true],
      ['persistence', 'passed', false],
    ]);
    const attempts = (await readRun(join(consumer.dir, '.release-qa', 'runs', runId as string))).attempts.filter((a) => a.requirement.endsWith('/persistence'));
    expect(attempts.map((a) => a.outcome)).toEqual(['interrupted', 'passed']);
    expect(attempts[1]?.retryOf).toBe(attempts[0]?.id);
  });

  // Node on Windows cannot deliver SIGINT to another process (kill() terminates it outright); a console Ctrl+C
  // does reach the handler there, but cannot be sent from a test. Linux CI exercises the real signal path.
  test.skipIf(process.platform === 'win32')('SIGINT cancels the running scenario, cleans up, and exits 3 with a summary', async () => {
    const consumer = await writeConsumer({ scenarios: { persistence: 'hang', uninstall: 'pass' } });
    expect((await runIn(consumer.dir, 'designate')).code).toBe(EXIT.ok);
    const child = trackProcess(spawn(process.execPath, [cliPath, ...runArgs(consumer), '--json'], { cwd: consumer.dir, stdio: ['ignore', 'pipe', 'pipe'] }));
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    // 'close', not 'exit': only then are the output streams flushed, so the summary is complete.
    const exited = new Promise<number | null>((resolveExit) => child.on('close', (code) => resolveExit(code)));

    await eventually(async () => (await readFile(consumer.logPath, 'utf8').catch(() => '')).includes('steps:persistence'), 30_000);
    child.kill('SIGINT');

    expect(await exited).toBe(EXIT.infrastructure);
    const summary = JSON.parse(stdout) as { results: Array<{ outcome: string }> };
    expect(summary.results.map((r) => r.outcome)).toEqual(['cancelled', 'not-run']);
    expect((await readFile(consumer.logPath, 'utf8')).trim().split('\n').at(-1)).toMatch(/^cleanup /);
  });
});
