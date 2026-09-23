import { describe, expect, test } from 'vitest';
import { parseLocalCandidate } from '../../src/model/local-candidate.ts';

const valid = () => ({
  schemaVersion: 1,
  id: 'local-2026-09-23.1',
  artifacts: [
    { profile: 'windows', name: 'setup.exe', path: 'dist/setup.exe', sha256: 'b'.repeat(64) },
    { profile: 'linux', name: 'app.deb', path: 'dist/app.deb', sha256: 'c'.repeat(64) },
  ],
});

const issues = (input: unknown): string[] => {
  const result = parseLocalCandidate(input);
  if (result.ok) throw new Error('expected a validation failure');
  return result.error.issues.map((i) => `${i.path}:${i.code}`);
};

describe('a local candidate manifest', () => {
  test('a valid manifest is accepted as written', () => {
    expect(parseLocalCandidate(valid())).toEqual({ ok: true, value: valid() });
  });

  test('another schema version is refused without looking further', () => {
    expect(issues({ ...valid(), schemaVersion: 2 })).toEqual(['schemaVersion:unknown-schema-version']);
  });

  test('at least one artifact is required', () => {
    expect(issues({ ...valid(), artifacts: [] })).toContain('artifacts:empty');
  });

  test('two artifacts for the same profile are refused: which one to test would be ambiguous', () => {
    const [first] = valid().artifacts;
    expect(issues({ ...valid(), artifacts: [first, { ...first, name: 'other.exe' }] })).toContain('artifacts[1].profile:duplicate');
  });

  test.each([
    ['an absolute path', '/etc/passwd'],
    ['a path that climbs out of the manifest directory', '../outside/setup.exe'],
    ['a Windows drive path', 'C:/setup.exe'],
  ])('%s is refused', (_label, path) => {
    const [first] = valid().artifacts;
    expect(issues({ ...valid(), artifacts: [{ ...first, path }] })).toContain('artifacts[0].path:unsafe-path');
  });

  test('a malformed hash is refused', () => {
    const [first] = valid().artifacts;
    expect(issues({ ...valid(), artifacts: [{ ...first, sha256: 'B'.repeat(64) }] })).toContain('artifacts[0].sha256:malformed-hash');
  });

  test('an unknown field is refused rather than ignored', () => {
    expect(issues({ ...valid(), note: 'x' })).toContain('note:unknown-field');
  });
});
