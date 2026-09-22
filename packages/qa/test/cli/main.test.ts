import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { EXIT, main } from '../../src/cli/main.ts';
import { hostOs } from '../fixtures/processes.ts';

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
  profiles: [{ id: 'here', os: hostOs(), arch: 'x86_64' }],
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
});

describe('doctor', () => {
  test('a missing project file is exit 3', async () => {
    const out = io();
    const dir = await makeDir();
    const code = await main(['doctor', '--project', join(dir, 'nope.json'), '--profile', 'here'], out.sink);
    expect(code).toBe(EXIT.infrastructure);
    expect(out.error.join(' ')).toContain('nope.json');
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
    expect(report.root).toBe(join(dir, '.release-qa'));
  });

  test('an explicit --root overrides the default', async () => {
    const out = io();
    const dir = await makeDir();
    const explicit = join(dir, 'somewhere-else');
    await mkdir(explicit);
    expect(await main(['designate', '--root', explicit], out.sink, () => dir)).toBe(EXIT.ok);
    const statusOut = io();
    await main(['status', '--root', explicit, '--json'], statusOut.sink, () => dir);
    expect((JSON.parse(statusOut.log.join('')) as { root: string }).root).toBe(explicit);
  });

  test('status on an undesignated root is exit 0: it reports a fact, it is not itself a failure', async () => {
    const out = io();
    const dir = await makeDir();
    expect(await main(['status'], out.sink, () => dir)).toBe(EXIT.ok);
    expect(out.log.join(' ')).toContain('designated: false');
  });
});
