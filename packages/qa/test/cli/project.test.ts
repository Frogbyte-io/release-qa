import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'vitest';
import { loadProject } from '../../src/cli/project.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.allSettled(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const dir = await import('node:fs/promises').then((fs) => fs.mkdtemp(join(tmpdir(), 'qa-cli-project-')));
  dirs.push(dir);
  return dir;
}

const validProject = {
  schemaVersion: 1,
  projectId: 'sample',
  releaseBranch: 'main',
  profiles: [{ id: 'windows', os: 'windows', arch: 'x86_64' }],
  requirements: [{ key: 'windows/persistence', mode: 'automated', title: 'Persists data across restarts', capabilities: [] }],
  suites: [{ id: 'default', requirements: ['windows/persistence'] }],
  scenarioFiles: ['persistence.spec.ts'],
  lifecycleModule: 'lifecycle.ts',
  workflows: { prepare: 'qa-prepare.yml', gate: 'qa-gate.yml', publish: 'qa-publish.yml' },
  markers: { releaseNotes: 'release-notes', qa: 'qa' },
};

describe('loading a project file', () => {
  test('a valid file is parsed into a Project', async () => {
    const dir = await makeDir();
    const path = join(dir, 'project.json');
    await writeFile(path, JSON.stringify(validProject));

    const result = await loadProject(path);

    expect(result).toMatchObject({ ok: true, path });
    expect(result.ok && result.project.projectId).toBe('sample');
  });

  test('a missing file is a clear error, not a thrown exception', async () => {
    const dir = await makeDir();
    const result = await loadProject(join(dir, 'nope.json'));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('nope.json');
  });

  test('a file that is not JSON is a clear error naming the file', async () => {
    const dir = await makeDir();
    const path = join(dir, 'project.json');
    await writeFile(path, 'not json');
    const result = await loadProject(path);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(path);
  });

  test('a file that fails schema validation reports the issues, not just "invalid"', async () => {
    const dir = await makeDir();
    const path = join(dir, 'project.json');
    await writeFile(path, JSON.stringify({ ...validProject, profiles: [] }));
    const result = await loadProject(path);
    expect(result.ok).toBe(false);
    expect(!result.ok && (result.issues ?? []).some((i) => i.path === 'profiles')).toBe(true);
  });

  test('a directory instead of a file is a clear error, not a thrown exception', async () => {
    const dir = await makeDir();
    const asDir = join(dir, 'project.json');
    await mkdir(asDir);
    const result = await loadProject(asDir);
    expect(result.ok).toBe(false);
  });
});
