import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EXIT, main, resumeHint } from '../../src/cli/main.ts';
import { writeConsumer } from '../fixtures/consumer.ts';
import { cleanUpProcessesAndRoots, eventually, hostOs, hostProfile } from '../fixtures/processes.ts';

// Reading a process's identity starts PowerShell on Windows, which can take seconds on a busy CI runner.
vi.setConfig({ testTimeout: 30_000 });
afterEach(cleanUpProcessesAndRoots);

const dirs: string[] = [];
afterEach(async () => {
  await Promise.allSettled(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const dir = await import('node:fs/promises').then((fs) => fs.mkdtemp(join(tmpdir(), 'qa-cli-main-')));
  dirs.push(dir);
  return dir;
}

function io(): { log: string[]; error: string[]; sink: { log: (s: string) => void; error: (s: string) => void } } {
  const log: string[] = [];
  const error: string[] = [];
  return { log, error, sink: { log: (s) => log.push(s), error: (s) => error.push(s) } };
}

const validProject = {
  schemaVersion: 1,
  projectId: 'sample',
  releaseBranch: 'main',
  profiles: [{ ...hostProfile(), id: 'here' }],
  requirements: [{ key: 'here/persistence', mode: 'automated', title: 'Persists data across restarts', capabilities: [] }],
  suites: [],
  scenarioFiles: [],
  lifecycleModule: 'lifecycle.ts',
  workflows: { prepare: 'a.yml', gate: 'b.yml', publish: 'c.yml' },
  markers: { releaseNotes: 'release-notes', qa: 'qa' },
};

describe('bad usage', () => {
  test('no command is exit 3 with a message on stderr, nothing on stdout', async () => {
    const out = io();
    const code = await main([], out.sink);
    expect(code).toBe(EXIT.infrastructure);
    expect(out.log).toEqual([]);
    expect(out.error.join(' ')).toMatch(/doctor/);
  });

  test('an unknown command is exit 3', async () => {
    const out = io();
    expect(await main(['launch'], out.sink)).toBe(EXIT.infrastructure);
  });

  test('a malformed invocation with --json still gets a JSON error on stderr, not plain text', async () => {
    const out = io();
    const code = await main(['doctor', '--project', 'p.json', '--profile', 'w', '--nope', '--json'], out.sink);
    expect(code).toBe(EXIT.infrastructure);
    expect(out.log).toEqual([]);
    const printed = JSON.parse(out.error.join('')) as { ok: boolean; error: string; issues: unknown[] };
    expect(printed).toMatchObject({ ok: false, error: expect.stringContaining('nope') });
    // issues is always present in JSON error output, even empty, so a consumer can key on it unconditionally.
    expect(printed.issues).toEqual([]);
  });
});

describe('doctor', () => {
  test('a missing project file is exit 3', async () => {
    const out = io();
    const dir = await makeDir();
    const code = await main(['doctor', '--project', join(dir, 'nope.json'), '--profile', 'here'], out.sink);
    expect(code).toBe(EXIT.infrastructure);
    expect(out.error.join(' ')).toContain('nope.json');
  });

  test('a missing project file with --json still includes issues, empty, alongside the read error', async () => {
    const out = io();
    const dir = await makeDir();
    await main(['doctor', '--project', join(dir, 'nope.json'), '--profile', 'here', '--json'], out.sink);
    const printed = JSON.parse(out.error.join('')) as { issues: unknown[] };
    expect(printed.issues).toEqual([]);
  });

  test('an unsupported profile is exit 3, naming the profiles the project does declare', async () => {
    const out = io();
    const dir = await makeDir();
    const path = join(dir, 'project.json');
    await writeFile(path, JSON.stringify(validProject));
    const code = await main(['doctor', '--project', path, '--profile', 'nowhere'], out.sink);
    expect(code).toBe(EXIT.infrastructure);
    expect(out.error.join(' ')).toContain('here');
  });

  test('a machine matching the profile is exit 0 and prints readiness', async () => {
    const out = io();
    const dir = await makeDir();
    const path = join(dir, 'project.json');
    await writeFile(path, JSON.stringify(validProject));
    const code = await main(['doctor', '--project', path, '--profile', 'here', '--json'], out.sink);
    expect(code).toBe(EXIT.ok);
    const printed = JSON.parse(out.log.join('')) as { ok: boolean };
    expect(printed.ok).toBe(true);
  });

  test('a profile this machine does not match is exit 2, not 0 or 1', async () => {
    const out = io();
    const dir = await makeDir();
    const path = join(dir, 'project.json');
    const other = hostOs() === 'windows' ? 'linux' : 'windows';
    await writeFile(
      path,
      JSON.stringify({
        ...validProject,
        profiles: [{ id: 'there', os: other, arch: 'x86_64' }],
        requirements: [{ key: 'there/persistence', mode: 'automated', title: 'Persists data across restarts', capabilities: [] }],
      }),
    );
    const code = await main(['doctor', '--project', path, '--profile', 'there', '--json'], out.sink);
    expect(code).toBe(EXIT.missingPrerequisite);
  });
});

describe('designate and status', () => {
  test('designating then checking status round-trips, defaulting the root to .release-qa under the given directory', async () => {
    const out = io();
    const dir = await makeDir();
    expect(await main(['designate'], out.sink, () => dir)).toBe(EXIT.ok);
    const statusOut = io();
    expect(await main(['status', '--json'], statusOut.sink, () => dir)).toBe(EXIT.ok);
    const report = JSON.parse(statusOut.log.join('')) as { designated: boolean; root: string };
    expect(report.designated).toBe(true);
    // status reports the resolved path, which is not always byte-identical to the path given (e.g. an 8.3 short
    // name in the temp path on some Windows machines), though both name the same directory.
    expect(report.root).toBe(await realpath(join(dir, '.release-qa')));
  });

  test('an explicit --root overrides the default', async () => {
    const out = io();
    const dir = await makeDir();
    const explicit = join(dir, 'somewhere-else');
    await mkdir(explicit);
    expect(await main(['designate', '--root', explicit], out.sink, () => dir)).toBe(EXIT.ok);
    const statusOut = io();
    await main(['status', '--root', explicit, '--json'], statusOut.sink, () => dir);
    expect((JSON.parse(statusOut.log.join('')) as { root: string }).root).toBe(await realpath(explicit));
  });

  test('status on an undesignated root is exit 0: it reports a fact, it is not itself a failure', async () => {
    const out = io();
    const dir = await makeDir();
    expect(await main(['status'], out.sink, () => dir)).toBe(EXIT.ok);
    expect(out.log.join(' ')).toContain('designated: false');
  });
});

describe('run, resume and reset', () => {
  async function designated(consumerDir: string): Promise<void> {
    const out = io();
    expect(await main(['designate'], out.sink, () => consumerDir)).toBe(EXIT.ok);
  }
  const runArgs = (consumer: Awaited<ReturnType<typeof writeConsumer>>) => ['run', '--project', consumer.projectPath, '--candidate', consumer.candidatePath, '--profile', consumer.profile, '--suite', 'release'];

  test('a passing run exits 0 and prints its summary; root and state default to .release-qa under the directory', async () => {
    const consumer = await writeConsumer({ scenarios: { persistence: 'pass' } });
    await designated(consumer.dir);
    const out = io();

    const code = await main([...runArgs(consumer), '--json'], out.sink, () => consumer.dir);

    expect(code).toBe(EXIT.ok);
    const summary = JSON.parse(out.log.join('')) as { runId: string; results: Array<{ outcome: string }> };
    expect(summary.results.map((r) => r.outcome)).toEqual(['passed']);
    expect(await realpath(join(consumer.dir, '.release-qa', 'runs', summary.runId))).toBeTruthy();
  });

  test('the run id is announced on stderr as soon as the run exists, so it can be resumed even if the process dies', async () => {
    const consumer = await writeConsumer({ scenarios: { persistence: 'pass' } });
    await designated(consumer.dir);
    const order: string[] = [];
    const sink = { log: (line: string) => order.push(`out:${line}`), error: (line: string) => order.push(`err:${line}`) };
    await main([...runArgs(consumer), '--json'], sink, () => consumer.dir);
    const { runId } = JSON.parse(order.find((l) => l.startsWith('out:'))!.slice(4)) as { runId: string };
    const announcement = order.findIndex((l) => l.startsWith('err:') && l.includes(runId));
    expect(announcement).toBeGreaterThanOrEqual(0);
    expect(announcement).toBeLessThan(order.findIndex((l) => l.startsWith('out:')));
  });

  test('the resume hint names a custom --state, so copying it after a crash finds the run', async () => {
    const consumer = await writeConsumer({ scenarios: { persistence: 'pass' } });
    await designated(consumer.dir);
    const out = io();
    await main([...runArgs(consumer), '--state', 'elsewhere'], out.sink, () => consumer.dir);
    const hint = out.error.find((line) => line.includes('resume --run')) ?? '';
    expect(hint).toContain('--state');
    expect(hint).toContain(join(consumer.dir, 'elsewhere'));
  });

  test('a failing scenario makes the run exit 1', async () => {
    const consumer = await writeConsumer({ scenarios: { persistence: 'fail' } });
    await designated(consumer.dir);
    expect(await main(runArgs(consumer), io().sink, () => consumer.dir)).toBe(EXIT.scenarioFailure);
  });

  test('a manual requirement left over makes the run exit 2', async () => {
    const consumer = await writeConsumer({ scenarios: { persistence: 'pass' }, manual: ['audio'] });
    await designated(consumer.dir);
    expect(await main(runArgs(consumer), io().sink, () => consumer.dir)).toBe(EXIT.missingPrerequisite);
  });

  test('a candidate that does not verify exits 3 before anything runs', async () => {
    const consumer = await writeConsumer({ scenarios: { persistence: 'pass' } });
    await designated(consumer.dir);
    await writeFile(join(consumer.dir, 'setup.bin'), 'tampered');
    const out = io();
    expect(await main([...runArgs(consumer), '--json'], out.sink, () => consumer.dir)).toBe(EXIT.infrastructure);
    expect((JSON.parse(out.error.join('')) as { error: string }).error).toContain('does not match');
  });

  test('cancelling through the signal exits 3, and resume then finishes the run', async () => {
    const consumer = await writeConsumer({ scenarios: { startup: 'pass', persistence: 'hang' } });
    await designated(consumer.dir);
    const controller = new AbortController();
    const out = io();
    const running = main([...runArgs(consumer), '--json'], out.sink, () => consumer.dir, controller.signal);
    try {
      await eventually(async () => (await readFile(consumer.logPath, 'utf8').catch(() => '')).includes('steps:persistence'));
    } finally {
      // Even if the wait above fails, cancel the run and let it finish, so the failure is that assertion, not a timeout.
      controller.abort();
    }
    expect(await running).toBe(EXIT.infrastructure);
    const { runId } = JSON.parse(out.log.join('')) as { runId: string };

    await rm(consumer.holdPath);
    const resumed = io();
    expect(await main(['resume', '--run', runId, '--json'], resumed.sink, () => consumer.dir)).toBe(EXIT.ok);
    const summary = JSON.parse(resumed.log.join('')) as { results: Array<{ outcome: string; carried?: boolean }> };
    expect(summary.results.map((r) => [r.outcome, r.carried ?? false])).toEqual([['passed', true], ['passed', false]]);
  });

  test('resuming a run that does not exist exits 3', async () => {
    const consumer = await writeConsumer({ scenarios: { persistence: 'pass' } });
    expect(await main(['resume', '--run', 'run-nope'], io().sink, () => consumer.dir)).toBe(EXIT.infrastructure);
  });

  test('reset on a clean designated root exits 0; on an undesignated one, 3', async () => {
    const consumer = await writeConsumer({ scenarios: { persistence: 'pass' } });
    expect(await main(['reset'], io().sink, () => consumer.dir)).toBe(EXIT.infrastructure);
    await designated(consumer.dir);
    expect(await main(['reset'], io().sink, () => consumer.dir)).toBe(EXIT.ok);
  });
});

describe('the resume hint', () => {
  test('a plain state directory is written as it is', () => {
    expect(resumeHint('run-1', String.raw`C:\qa\runs`)).toBe(String.raw`resume --run run-1 --state C:\qa\runs`);
    expect(resumeHint('run-1', '/srv/qa/runs')).toBe('resume --run run-1 --state /srv/qa/runs');
  });

  test('without a custom state directory there is nothing to add', () => {
    expect(resumeHint('run-1', undefined)).toBe('resume --run run-1');
  });

  // Single quotes are literal in both bash and PowerShell, so nothing inside them is expanded or substituted.
  test.each([[String.raw`C:\My QA\runs`], ['/tmp/$HOME/runs'], ['/tmp/`id`/runs'], ['/tmp/a"b/runs']])('%s is single-quoted so it pastes safely', (dir) => {
    expect(resumeHint('run-1', dir)).toBe(`resume --run run-1 --state '${dir}'`);
  });

  test('a path containing a single quote is not put into a command at all, but still named', () => {
    const hint = resumeHint('run-1', "/tmp/it's/runs");
    expect(hint).not.toMatch(/--state '/);
    expect(hint).toContain("/tmp/it's/runs");
    expect(hint).toContain('resume --run run-1');
  });
});
