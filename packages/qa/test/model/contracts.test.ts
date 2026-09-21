import { describe, expect, test } from 'vitest';
import { parseCandidate } from '../../src/model/candidate.ts';
import { parseException } from '../../src/model/exception.ts';
import { parseProject } from '../../src/model/project.ts';
import { parseRequirement } from '../../src/model/requirement.ts';
import { parseReport, parseUploadProvenance } from '../../src/model/result.ts';
import type { ParseResult } from '../../src/model/validate.ts';
import { artifact, candidate, exception, project, report, requirement, SHA1 } from '../fixtures/records.ts';

/** `[path, code]` pairs of a failed parse; empty for a successful one. */
function issues(result: ParseResult<unknown>): Array<[string, string]> {
  return result.ok ? [] : result.error.issues.map((i) => [i.path, i.code]);
}
function expectValid(result: ParseResult<unknown>): void {
  expect(result.ok, `should have been accepted, got ${JSON.stringify(issues(result))}`).toBe(true);
}
function expectIssue(result: ParseResult<unknown>, path: string, code: string): void {
  expect(result.ok, 'the record should have been rejected').toBe(false);
  expect(issues(result)).toContainEqual([path, code]);
}
/** Overwrites a nested value on a deep copy, so a test can break exactly one field. */
function broken<T>(record: T, path: string, value: unknown): unknown {
  const copy = structuredClone(record) as Record<string, unknown>;
  const keys = path.split('.');
  let node: Record<string, unknown> = copy;
  for (const key of keys.slice(0, -1)) node = (Array.isArray(node) ? node[Number(key)] : node[key]) as Record<string, unknown>;
  const last = keys.at(-1) as string;
  if (value === undefined) delete node[last];
  else node[last] = value;
  return copy;
}

const parsers: Array<[string, (input: unknown) => ParseResult<unknown>, () => unknown]> = [
  ['candidate', (i) => parseCandidate(i), () => candidate()],
  ['project', (i) => parseProject(i), () => project()],
  ['report', (i) => parseReport(i), () => report()],
  ['exception', (i) => parseException(i), () => exception()],
];

describe.each(parsers)('%s: behaviour common to every record', (_name, parse, build) => {
  test('accepts a valid record and returns it unchanged', () => {
    const result = parse(build());
    expectValid(result);
    expect(result.ok && result.value).toEqual(build());
  });

  test.each([null, undefined, 'a string', 42, true, []])('rejects the non-object %j without throwing', (input) => {
    expectIssue(parse(input), '', 'invalid-type');
  });

  test.each([2, 0, '1', null])('rejects unknown schema version %j', (version) => {
    expectIssue(parse(broken(build(), 'schemaVersion', version)), 'schemaVersion', 'unknown-schema-version');
  });

  test('rejects a record with no schema version', () => {
    expectIssue(parse(broken(build(), 'schemaVersion', undefined)), 'schemaVersion', 'missing-field');
  });

  test('reports only the version problem for a future-schema record, whatever else it contains', () => {
    const result = parse({ schemaVersion: 2, somethingNew: { nested: true } });
    expect(issues(result)).toEqual([['schemaVersion', 'unknown-schema-version']]);
  });

  test('rejects fields it does not know', () => {
    expectIssue(parse({ ...(build() as object), surprise: 1 }), 'surprise', 'unknown-field');
  });

  // The contract is "never throws", so values that JSON.stringify or property access cannot handle must not escape.
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const hostile = new Proxy({}, { has: () => { throw new Error('boom'); }, get: () => { throw new Error('boom'); }, ownKeys: () => { throw new Error('boom'); } });
  test.each([
    ['a bigint', { schemaVersion: 1n }],
    ['a circular object', { schemaVersion: circular }],
  ])('names the unsupported version precisely when the schema version is %s', (_label, input) => {
    expect(() => parse(input)).not.toThrow();
    expectIssue(parse(input), 'schemaVersion', 'unknown-schema-version');
  });

  test('does not throw for an object that throws when it is read', () => {
    expect(() => parse(hostile)).not.toThrow();
    expectIssue(parse(hostile), '', 'invalid-type');
  });
});

describe('candidate', () => {
  test.each([
    ['sha256 in upper case', 'artifacts.0.sha256', 'B'.repeat(64), 'artifacts[0].sha256'],
    ['sha256 one character short', 'artifacts.0.sha256', 'b'.repeat(63), 'artifacts[0].sha256'],
    ['sha256 with an algorithm prefix', 'artifacts.0.sha256', `sha256:${'b'.repeat(64)}`, 'artifacts[0].sha256'],
    ['sha256 that is not hex', 'artifacts.0.sha256', 'g'.repeat(64), 'artifacts[0].sha256'],
    ['source commit that is abbreviated', 'sourceSha', '1234567', 'sourceSha'],
    ['base commit in upper case', 'baseSha', 'A'.repeat(40), 'baseSha'],
    ['tree that is a sha256', 'sourceTreeSha', 'a'.repeat(64), 'sourceTreeSha'],
    ['test revision that is empty', 'testRevision', '', 'testRevision'],
    ['policy digest that is a git sha', 'policyDigest', SHA1.tests, 'policyDigest'],
  ])('rejects a malformed hash: %s', (_label, path, value, issuePath) => {
    expectIssue(parseCandidate(broken(candidate(), path, value)), issuePath, 'malformed-hash');
  });

  test('rejects two artifacts with the same GitHub asset id', () => {
    const result = parseCandidate(candidate({ artifacts: [artifact(), artifact({ profile: 'linux', name: 'other.deb', actionsArtifactId: 999 })] }));
    expectIssue(result, 'artifacts[1].assetId', 'duplicate');
  });

  test('rejects two artifacts with the same profile and file name', () => {
    const result = parseCandidate(candidate({ artifacts: [artifact(), artifact({ assetId: 555, actionsArtifactId: 999 })] }));
    expectIssue(result, 'artifacts[1].name', 'duplicate');
  });

  test('accepts the same file name under two different profiles', () => {
    const result = parseCandidate(candidate({ artifacts: [artifact(), artifact({ profile: 'linux', assetId: 555, actionsArtifactId: 999 })] }));
    expectValid(result);
  });

  test.each([
    ['a parent directory', '../evil.exe'],
    ['a nested parent directory', 'a/../../evil.exe'],
    ['a forward slash', 'dir/setup.exe'],
    ['a backslash', 'dir\\setup.exe'],
    ['just dot dot', '..'],
    ['just a dot', '.'],
    ['a Windows drive prefix', 'C:evil.exe'],
    ['an NTFS alternate data stream', 'setup.exe:stream'],
    ['a NUL character', 'setup\u0000.exe'],
    ['a Windows reserved device name', 'CON'],
    ['a reserved device name with an extension', 'nul.txt'],
    ['a trailing dot', 'setup.exe.'],
    ['a trailing space', 'setup.exe '],
    ['a name longer than 255 characters', `${'a'.repeat(256)}.exe`],
  ])('rejects an artifact file name containing %s', (_label, name) => {
    expectIssue(parseCandidate(candidate({ artifacts: [artifact({ name })] })), 'artifacts[0].name', 'unsafe-path');
  });

  test.each(['<', '>', '"', '|', '?', '*'])('rejects an artifact file name containing the Windows-reserved character %j', (ch) => {
    expectIssue(parseCandidate(candidate({ artifacts: [artifact({ name: `setup${ch}.exe` })] })), 'artifacts[0].name', 'unsafe-path');
  });

  test('accepts an installer name with spaces, as produced by real packagers', () => {
    expectValid(parseCandidate(candidate({ artifacts: [artifact({ name: 'Release QA Smoke_0.1.0_x64-setup.exe' })] })));
  });

  test.each([['../workflow.yml'], ['/etc/workflow.yml'], ['.github\\workflows\\x.yml'], ['C:/x.yml'], ['a//b.yml']])(
    'rejects the unsafe build workflow path %j',
    (workflowPath) => {
      expectIssue(parseCandidate(candidate({ build: { workflowPath, runId: 1, attempt: 1 } })), 'build.workflowPath', 'unsafe-path');
    },
  );

  test('rejects an empty build workflow path', () => {
    expectIssue(parseCandidate(candidate({ build: { workflowPath: '', runId: 1, attempt: 1 } })), 'build.workflowPath', 'empty');
  });

  test.each(['', '   ', '\t'])('rejects the empty candidate id %j', (id) => {
    expectIssue(parseCandidate(candidate({ id })), 'id', 'empty');
  });

  test('rejects an id that could be used to escape a directory', () => {
    expectIssue(parseCandidate(candidate({ id: '../cand' })), 'id', 'malformed-id');
  });

  test('rejects a candidate with no artifacts', () => {
    expectIssue(parseCandidate(candidate({ artifacts: [] })), 'artifacts', 'empty');
  });

  test.each([
    ['zero', 0, 'out-of-range'],
    ['negative', -3, 'out-of-range'],
    ['fractional', 1.5, 'out-of-range'],
    ['a string', '7', 'invalid-type'],
    ['not a number', Number.NaN, 'invalid-type'],
  ])('rejects a pull request number that is %s', (_label, value, code) => {
    expectIssue(parseCandidate(broken(candidate(), 'pullRequest', value)), 'pullRequest', code);
  });

  test('reports every problem in one pass, not just the first', () => {
    const result = parseCandidate(candidate({ id: '', sourceSha: 'nope', pullRequest: 0 }));
    expect(issues(result)).toEqual(expect.arrayContaining([['id', 'empty'], ['sourceSha', 'malformed-hash'], ['pullRequest', 'out-of-range']]));
  });
});

describe('requirement', () => {
  test.each([['windows'], ['a/b/c'], ['/x'], ['x/'], ['Windows/Persistence'], ['win dows/x'], ['']])('rejects the malformed key %j', (key) => {
    expectIssue(parseRequirement(requirement({ key: key as never })), 'key', 'malformed-key');
  });

  test('rejects an unknown execution mode', () => {
    expectIssue(parseRequirement(broken(requirement(), 'mode', 'semi-automatic')), 'mode', 'invalid-value');
  });

  test('validates every slot of a sparse capabilities array', () => {
    expectIssue(parseRequirement(requirement({ capabilities: new Array<string>(2) })), 'capabilities[0]', 'invalid-type');
  });

  test('rejects an empty title', () => {
    expectIssue(parseRequirement(requirement({ title: '  ' })), 'title', 'empty');
  });

  test('accepts a valid requirement', () => {
    expectValid(parseRequirement(requirement()));
  });
});

describe('project', () => {
  test('rejects two profiles with the same id', () => {
    const p = project();
    expectIssue(parseProject({ ...p, profiles: [...p.profiles, p.profiles[0]] }), 'profiles[2].id', 'duplicate');
  });

  test('rejects two requirements with the same key', () => {
    const p = project();
    expectIssue(parseProject({ ...p, requirements: [...p.requirements, requirement()] }), 'requirements[3].key', 'duplicate');
  });

  test('rejects two suites with the same id', () => {
    const p = project();
    expectIssue(parseProject({ ...p, suites: [...p.suites, p.suites[0]] }), 'suites[2].id', 'duplicate');
  });

  test('rejects a suite that lists a requirement the project does not define', () => {
    const p = project();
    expectIssue(parseProject({ ...p, suites: [{ id: 'smoke', requirements: ['windows/missing'] }] }), 'suites[0].requirements[0]', 'unknown-reference');
  });

  test('rejects a requirement for a profile the project does not define', () => {
    const p = project();
    expectIssue(parseProject({ ...p, requirements: [requirement({ key: 'macos/persistence' })], suites: [] }), 'requirements[0].key', 'unknown-reference');
  });

  test('rejects a suite that lists the same requirement twice', () => {
    const p = project();
    expectIssue(parseProject({ ...p, suites: [{ id: 'smoke', requirements: ['windows/persistence', 'windows/persistence'] }] }), 'suites[0].requirements[1]', 'duplicate');
  });

  test.each([['../scenario.spec.ts'], ['/abs/scenario.spec.ts'], ['scenarios\\a.spec.ts'], ['scenarios/../../x.ts']])(
    'rejects the unsafe scenario file %j',
    (file) => {
      expectIssue(parseProject({ ...project(), scenarioFiles: [file] }), 'scenarioFiles[0]', 'unsafe-path');
    },
  );

  test('rejects an unsafe lifecycle module path', () => {
    expectIssue(parseProject({ ...project(), lifecycleModule: '../lifecycle.ts' }), 'lifecycleModule', 'unsafe-path');
  });

  test('rejects two markers with the same name', () => {
    expectIssue(parseProject({ ...project(), markers: { releaseNotes: 'qa', qa: 'qa' } }), 'markers.qa', 'duplicate');
  });

  test('rejects a workflow name that is a path', () => {
    expectIssue(parseProject({ ...project(), workflows: { ...project().workflows, gate: '../qa-gate.yml' } }), 'workflows.gate', 'unsafe-path');
  });

  test('rejects an unsupported operating system', () => {
    expectIssue(parseProject(broken(project(), 'profiles.0.os', 'macos')), 'profiles[0].os', 'invalid-value');
  });

  test.each([['feature branch'], ['a..b'], ['a//b'], ['-x'], ['x/']])('rejects the release branch %j', (releaseBranch) => {
    expectIssue(parseProject({ ...project(), releaseBranch }), 'releaseBranch', 'invalid-value');
  });

  test('rejects an empty release branch', () => {
    expectIssue(parseProject({ ...project(), releaseBranch: '' }), 'releaseBranch', 'empty');
  });
});

describe('report', () => {
  test('rejects two attempts with the same id', () => {
    const attempt = report().attempts[0]!;
    expectIssue(parseReport(report({ attempts: [attempt, { ...attempt }] })), 'attempts[1].id', 'duplicate');
  });

  test('rejects an attempt that is a retry of itself', () => {
    const attempt = report().attempts[0]!;
    expectIssue(parseReport(report({ attempts: [{ ...attempt, retryOf: attempt.id }] })), 'attempts[0].retryOf', 'invalid-value');
  });

  test('accepts a retry of an attempt that lives in another report', () => {
    const attempt = report().attempts[0]!;
    expectValid(parseReport(report({ attempts: [{ ...attempt, retryOf: 'attempt-from-elsewhere' }] })));
  });

  test('validates every slot of a sparse attempts array', () => {
    expectIssue(parseReport(report({ attempts: new Array(1) as never })), 'attempts[0]', 'invalid-type');
  });

  test('rejects a line break in a single-line text field, on any platform', () => {
    expectIssue(parseReport(report({ actor: 'x\ry' })), 'actor', 'invalid-characters');
    expectIssue(parseReport(report({ machineId: 'x\ny' })), 'machineId', 'invalid-characters');
  });

  test('rejects a report with no attempts', () => {
    expectIssue(parseReport(report({ attempts: [] })), 'attempts', 'empty');
  });

  test('rejects an attempt whose requirement belongs to a different profile than the report', () => {
    const attempt = { ...report().attempts[0]!, requirement: 'linux/persistence' as const };
    expectIssue(parseReport(report({ attempts: [attempt] })), 'attempts[0].requirement', 'mismatch');
  });

  test('rejects an outcome it does not know', () => {
    expectIssue(parseReport(broken(report(), 'attempts.0.outcome', 'kinda-passed')), 'attempts[0].outcome', 'invalid-value');
  });

  test.each([
    ['../secret.png'],
    ['/etc/passwd'],
    ['evidence\\a.png'],
    ['a/../../b.png'],
    ['evidence/trace:secret'], // NTFS alternate data stream
    ['evidence/CON/x.png'], // Windows device name as a directory
    ['evidence/nul.txt'],
    ['evidence/x./y.png'], // trailing dot in a directory
    ['evidence/x /y.png'], // trailing space in a directory
    ['evidence/a?b.png'],
    ['evidence/a*b.png'],
    ['evidence/a<b>.png'],
    ['evidence/a|b.png'],
    ['evidence/a"b.png'],
  ])('rejects the unsafe evidence path %j', (path) => {
    const attempt = { ...report().attempts[0]!, evidence: [path] };
    expectIssue(parseReport(report({ attempts: [attempt] })), 'attempts[0].evidence[0]', 'unsafe-path');
  });

  test('rejects a report with no measured environment', () => {
    expectIssue(parseReport(broken(report(), 'environment', undefined)), 'environment', 'missing-field');
  });

  test.each([['actor'], ['machineId']])('rejects an empty %s', (field) => {
    expectIssue(parseReport(broken(report(), field, '')), field, 'empty');
  });

  test('keeps the claimed actor as plain data', () => {
    const result = parseReport(report({ actor: 'someone-else' }));
    expect(result.ok && result.value.actor).toBe('someone-else');
  });

  describe('against a candidate', () => {
    test('accepts a report that belongs to the candidate', () => {
      expectValid(parseReport(report(), { candidate: candidate() }));
    });

    test('rejects a report for a different candidate', () => {
      expectIssue(parseReport(report({ candidateId: 'cand-9999' }), { candidate: candidate() }), 'candidateId', 'unknown-reference');
    });

    test('rejects a report for a profile the candidate has no artifact for', () => {
      const linuxOnly = candidate({ artifacts: [artifact({ profile: 'linux', name: 'x.deb' })] });
      expectIssue(parseReport(report(), { candidate: linuxOnly }), 'profile', 'unknown-reference');
    });

    test('rejects a report made against a different policy', () => {
      expectIssue(parseReport(report({ policyDigest: 'd'.repeat(64) }), { candidate: candidate() }), 'policyDigest', 'mismatch');
    });

    test('rejects a report made against different tests', () => {
      expectIssue(parseReport(report({ testRevision: '9'.repeat(40) }), { candidate: candidate() }), 'testRevision', 'mismatch');
    });

    test('rejects an attempt for a requirement outside the required set', () => {
      expectIssue(parseReport(report(), { requirements: ['windows/device-feel'] }), 'attempts[0].requirement', 'unknown-reference');
    });
  });
});

describe('exception', () => {
  test('rejects an exception that names no requirements', () => {
    expectIssue(parseException(exception({ requirements: [] })), 'requirements', 'empty');
  });

  test('rejects an exception that names a requirement twice', () => {
    expectIssue(parseException(exception({ requirements: ['windows/device-feel', 'windows/device-feel'] })), 'requirements[1]', 'duplicate');
  });

  test.each(['', '   '])('rejects the empty reason %j', (reason) => {
    expectIssue(parseException(exception({ reason })), 'reason', 'empty');
  });

  test.each([['yesterday'], ['2026-09-20'], ['2026-09-20T12:00:00'], ['2026-09-20T12:00:00+02:00'], ['2026-13-40T12:00:00Z']])(
    'rejects the malformed timestamp %j',
    (createdAt) => {
      expectIssue(parseException(exception({ createdAt })), 'createdAt', 'malformed-timestamp');
    },
  );

  test('accepts a multi-line reason with Windows or Unix line endings', () => {
    expectValid(parseException(exception({ reason: 'first line\r\nsecond line\nthird line' })));
  });

  test('accepts a timestamp with fractional seconds', () => {
    expectValid(parseException(exception({ createdAt: '2026-09-20T12:00:00.123Z' })));
  });

  test('rejects an exception for a different candidate than the one supplied', () => {
    expectIssue(parseException(exception({ candidateId: 'cand-9999' }), { candidate: candidate() }), 'candidateId', 'unknown-reference');
  });
});

describe('upload provenance', () => {
  const provenance = { uploader: 'octocat', uploadedAt: '2026-09-20T12:00:00Z', assetId: 42 };

  test('accepts valid provenance', () => {
    expectValid(parseUploadProvenance(provenance));
  });

  test('rejects a malformed upload time', () => {
    expectIssue(parseUploadProvenance({ ...provenance, uploadedAt: 'later' }), 'uploadedAt', 'malformed-timestamp');
  });

  test('rejects an empty uploader', () => {
    expectIssue(parseUploadProvenance({ ...provenance, uploader: '' }), 'uploader', 'empty');
  });
});
