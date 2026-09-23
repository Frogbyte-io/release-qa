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

describe('what an artifact entry must be', () => {
  const entry = (overrides: Record<string, unknown>) => ({ ...valid(), artifacts: [{ ...valid().artifacts[0], ...overrides }] });

  test.each([
    ['a non-object entry', { ...valid(), artifacts: ['setup.exe'] }, 'artifacts[0]:invalid-type'],
    ['a name that is a path', entry({ name: 'dist/setup.exe' }), 'artifacts[0].name:unsafe-path'],
    ['a Windows device name', entry({ name: 'CON' }), 'artifacts[0].name:unsafe-path'],
    ['an empty name', entry({ name: '' }), 'artifacts[0].name:empty'],
    ['an empty path', entry({ path: '' }), 'artifacts[0].path:empty'],
    ['an upper-case profile', entry({ profile: 'Windows' }), 'artifacts[0].profile:malformed-id'],
  ])('%s is refused', (_label, input, expected) => {
    expect(issues(input)).toContain(expected);
  });

  test.each([['id'], ['artifacts']])('a missing %s is refused', (field) => {
    const input: Record<string, unknown> = valid();
    delete input[field];
    expect(issues(input)).toContain(`${field}:missing-field`);
  });

  test.each([['profile'], ['name'], ['path'], ['sha256']])('an artifact without %s is refused', (field) => {
    const artifact: Record<string, unknown> = { ...valid().artifacts[0] };
    delete artifact[field];
    expect(issues({ ...valid(), artifacts: [artifact] })).toContain(`artifacts[0].${field}:missing-field`);
  });

  test.each([[null], ['a string'], [[]]])('%j is not a manifest at all', (input) => {
    expect(parseLocalCandidate(input).ok).toBe(false);
  });
});
