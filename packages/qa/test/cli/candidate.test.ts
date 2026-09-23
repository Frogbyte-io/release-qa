import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { loadCandidate } from '../../src/cli/candidate.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.allSettled(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const sha = (bytes: string): string => createHash('sha256').update(bytes).digest('hex');

async function manifestWith(files: Record<string, string>, artifacts: unknown[], id = 'local-1'): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'qa-cli-candidate-'));
  dirs.push(dir);
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), bytes);
  }
  const path = join(dir, 'candidate.json');
  await writeFile(path, JSON.stringify({ schemaVersion: 1, id, artifacts }));
  return { dir, path };
}

const loaded = async (...args: Parameters<typeof loadCandidate>) => {
  const result = await loadCandidate(...args);
  if (!result.ok) throw new Error(result.error);
  return result;
};
const failed = async (...args: Parameters<typeof loadCandidate>): Promise<string> => {
  const result = await loadCandidate(...args);
  if (result.ok) throw new Error('expected loading to fail');
  return result.error;
};

describe('loading a candidate for one profile', () => {
  test('picks the artifact for the profile, resolves it next to the manifest, and verifies its bytes', async () => {
    const { dir, path } = await manifestWith({ 'dist/setup.exe': 'installer bytes' }, [
      { profile: 'windows', name: 'setup.exe', path: 'dist/setup.exe', sha256: sha('installer bytes') },
      { profile: 'linux', name: 'app.deb', path: 'dist/app.deb', sha256: 'c'.repeat(64) },
    ]);

    const result = await loaded(path, 'windows');

    expect(result.candidate).toEqual({ id: 'local-1' });
    // Hooks get the file's real location, so nothing on the way can be swapped to point elsewhere afterwards.
    expect(result.artifact).toEqual({ name: 'setup.exe', path: await realpath(join(dir, 'dist', 'setup.exe')), sha256: sha('installer bytes') });
  });

  test('a file whose bytes do not match the manifest is refused, naming both hashes', async () => {
    const { path } = await manifestWith({ 'setup.exe': 'tampered' }, [{ profile: 'windows', name: 'setup.exe', path: 'setup.exe', sha256: sha('original') }]);
    const error = await failed(path, 'windows');
    expect(error).toContain(sha('original'));
    expect(error).toContain(sha('tampered'));
  });

  test('another profile\'s artifact is never hashed or used', async () => {
    // The linux file does not exist; loading for windows must not touch it.
    const { path } = await manifestWith({ 'setup.exe': 'x' }, [
      { profile: 'windows', name: 'setup.exe', path: 'setup.exe', sha256: sha('x') },
      { profile: 'linux', name: 'app.deb', path: 'missing/app.deb', sha256: 'c'.repeat(64) },
    ]);
    expect((await loadCandidate(path, 'windows')).ok).toBe(true);
  });

  test('a profile the manifest has no artifact for is refused, naming the profiles it does have', async () => {
    const { path } = await manifestWith({ 'setup.exe': 'x' }, [{ profile: 'windows', name: 'setup.exe', path: 'setup.exe', sha256: sha('x') }]);
    const error = await failed(path, 'linux');
    expect(error).toContain('linux');
    expect(error).toContain('windows');
  });

  test('a missing artifact file is refused', async () => {
    const { path } = await manifestWith({}, [{ profile: 'windows', name: 'setup.exe', path: 'setup.exe', sha256: sha('x') }]);
    expect(await failed(path, 'windows')).toContain('setup.exe');
  });

  test('a directory where the artifact should be is refused', async () => {
    const { dir, path } = await manifestWith({}, [{ profile: 'windows', name: 'setup.exe', path: 'setup.exe', sha256: sha('x') }]);
    await mkdir(join(dir, 'setup.exe'));
    expect(await failed(path, 'windows')).toMatch(/not a file/);
  });

  test.each([
    ['a missing manifest', null],
    ['a manifest that is not JSON', 'not json'],
    ['a manifest that fails validation', JSON.stringify({ schemaVersion: 1, id: 'x', artifacts: [] })],
  ])('%s is refused, not thrown', async (_label, content) => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-cli-candidate-'));
    dirs.push(dir);
    const path = join(dir, 'candidate.json');
    if (content !== null) await writeFile(path, content);
    expect((await loadCandidate(path, 'windows')).ok).toBe(false);
  });
});

describe('the artifact path cannot leave the manifest directory through a link', () => {
  test('a directory link pointing outside is refused, and the file behind it is not treated as the candidate', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'qa-cli-outside-'));
    dirs.push(outside);
    await writeFile(join(outside, 'setup.exe'), 'somebody else\'s file');
    const { dir, path } = await manifestWith({}, [{ profile: 'windows', name: 'setup.exe', path: 'dist/setup.exe', sha256: sha('somebody else\'s file') }]);
    await symlink(outside, join(dir, 'dist'), 'junction');

    const error = await failed(path, 'windows');

    expect(error).toMatch(/outside/);
  });
});

describe('the path hooks are given', () => {
  test('a link inside the manifest directory is resolved, so hooks get a path with no link left to swap', async () => {
    const { dir, path } = await manifestWith({ 'real-dist/setup.exe': 'x' }, [{ profile: 'windows', name: 'setup.exe', path: 'dist/setup.exe', sha256: sha('x') }]);
    await symlink(join(dir, 'real-dist'), join(dir, 'dist'), 'junction');
    const result = await loaded(path, 'windows');
    expect(result.artifact.path).toBe(await realpath(join(dir, 'real-dist', 'setup.exe')));
  });
});

describe('a real path that cannot be resolved', () => {
  afterEach(() => {
    vi.doUnmock('node:fs/promises');
    vi.resetModules();
  });

  test('is a refusal, not a thrown error', async () => {
    const { path } = await manifestWith({ 'setup.exe': 'x' }, [{ profile: 'windows', name: 'setup.exe', path: 'setup.exe', sha256: sha('x') }]);
    vi.doMock('node:fs/promises', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:fs/promises')>()), realpath: async () => { throw new Error('EACCES: resolving denied'); } }));
    vi.resetModules();
    const { loadCandidate: loadWithBrokenRealpath } = await import('../../src/cli/candidate.ts');
    const result = await loadWithBrokenRealpath(path, 'windows');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('resolving denied');
  });
});

describe('a link swapped while the artifact is being hashed', () => {
  afterEach(() => {
    vi.doUnmock('node:fs/promises');
    vi.resetModules();
  });

  test('is refused: the check before hashing would describe some other file', async () => {
    const { dir, path } = await manifestWith({ 'setup.exe': 'x' }, [{ profile: 'windows', name: 'setup.exe', path: 'setup.exe', sha256: sha('x') }]);
    const file = join(dir, 'setup.exe');
    let resolvedFile = 0;
    // The first resolution of the artifact sees the real file; the one after hashing sees it moved elsewhere.
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const real = await importOriginal<typeof import('node:fs/promises')>();
      return {
        ...real,
        realpath: async (target: string) => {
          const resolved = await real.realpath(target);
          if (target !== file) return resolved;
          resolvedFile += 1;
          return resolvedFile === 1 ? resolved : `${resolved}.swapped`;
        },
      };
    });
    vi.resetModules();
    const { loadCandidate: loadWithSwap } = await import('../../src/cli/candidate.ts');

    const result = await loadWithSwap(path, 'windows');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('changed location');
    expect(resolvedFile).toBe(2);
  });
});
