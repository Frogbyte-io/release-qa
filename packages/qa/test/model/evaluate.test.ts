import { describe, expect, test } from 'vitest';
import { evaluate, type EvaluationInput, type RetryResolution } from '../../src/model/evaluate.ts';
import type { Attempt, Outcome } from '../../src/model/result.ts';
import { artifact, authorized, candidate, eligible, requirement } from '../fixtures/records.ts';

const persistence = requirement({ key: 'windows/persistence' });
const deviceFeel = requirement({ key: 'windows/device-feel', mode: 'manual', title: 'Sliders feel right' });
const linuxPersistence = requirement({ key: 'linux/persistence' });
const REQUIRED = [persistence, deviceFeel, linuxPersistence];

function attempt(id: string, key: Attempt['requirement'], outcome: Outcome, extra: Partial<Attempt> = {}): Attempt {
  return { id, requirement: key, outcome, evidence: [], ...extra };
}

const linuxEnvironment = { os: 'linux', osVersion: '24.04', arch: 'x86_64', capabilities: ['display'], toolVersion: '0.0.0' };

/** The two machines of a complete matrix: one Windows tester, one Linux tester. */
const windowsReport = () =>
  eligible({
    id: 'report-win',
    machineId: 'lab-win-01',
    attempts: [attempt('a-win-persist', 'windows/persistence', 'passed'), attempt('a-win-feel', 'windows/device-feel', 'passed')],
  });
const linuxReport = () =>
  eligible({
    id: 'report-linux',
    profile: 'linux',
    actor: 'tester2',
    machineId: 'lab-linux-01',
    environment: linuxEnvironment,
    attempts: [attempt('a-lin-persist', 'linux/persistence', 'passed')],
  });

function input(overrides: Partial<EvaluationInput> = {}): EvaluationInput {
  const c = candidate();
  return {
    candidate: c,
    currentHeadSha: c.sourceSha,
    currentBaseSha: c.baseSha,
    required: REQUIRED,
    reports: [windowsReport(), linuxReport()],
    exceptions: [],
    retryResolutions: [],
    ...overrides,
  };
}

describe('the decision', () => {
  test('missing manual evidence blocks readiness', () => {
    const selected = candidate();
    const result = evaluate({
      candidate: selected,
      currentHeadSha: selected.sourceSha,
      currentBaseSha: selected.baseSha,
      required: [requirement({ key: 'windows/device-feel', mode: 'manual' })],
      reports: [],
      exceptions: [],
      retryResolutions: [],
    });
    expect(result.readiness).toBe('blocked');
    expect(result.reasons).toContainEqual({ code: 'missing-result', requirement: 'windows/device-feel' });
  });

  test('a complete two-machine matrix passes', () => {
    const result = evaluate(input());
    expect(result.readiness).toBe('passed');
    expect(result.reasons).toEqual([]);
    expect(result.acceptedReportIds).toEqual(['report-linux', 'report-win']);
    expect(result.exceptionIds).toEqual([]);
  });

  test('a missing Linux result blocks even when Windows is complete', () => {
    const result = evaluate(input({ reports: [windowsReport()] }));
    expect(result.readiness).toBe('blocked');
    expect(result.reasons).toEqual([{ code: 'missing-result', requirement: 'linux/persistence' }]);
  });

  test('a requirement for a profile the candidate has no artifact for cannot be met', () => {
    const windowsOnly = candidate({ artifacts: [artifact()] });
    const result = evaluate(input({ candidate: windowsOnly, currentHeadSha: windowsOnly.sourceSha, currentBaseSha: windowsOnly.baseSha, reports: [windowsReport()] }));
    expect(result.readiness).toBe('blocked');
    expect(result.reasons).toEqual([{ code: 'no-artifact-for-profile', requirement: 'linux/persistence' }]);
  });

  test('attempts that never passed are reported with their outcomes', () => {
    const blockedFeel = eligible({ id: 'report-win', attempts: [attempt('a1', 'windows/persistence', 'passed'), attempt('a2', 'windows/device-feel', 'blocked'), attempt('a3', 'windows/device-feel', 'interrupted')] });
    const result = evaluate(input({ reports: [blockedFeel, linuxReport()] }));
    expect(result.readiness).toBe('blocked');
    expect(result.reasons).toEqual([{ code: 'not-passed', requirement: 'windows/device-feel', outcomes: ['blocked', 'interrupted'] }]);
  });

  test('a passing attempt without the capability the requirement needs does not count', () => {
    const needsHardware = requirement({ key: 'windows/device-feel', mode: 'manual', capabilities: ['hardware'] });
    const result = evaluate(input({ required: [persistence, needsHardware, linuxPersistence] }));
    expect(result.readiness).toBe('blocked');
    expect(result.reasons).toEqual([{ code: 'capability-missing', requirement: 'windows/device-feel', missing: ['hardware'] }]);
  });
});

describe('a newer head, base or candidate', () => {
  test('a new head blocks whatever the reports say', () => {
    const c = candidate();
    const result = evaluate(input({ currentHeadSha: '9'.repeat(40) }));
    expect(result.readiness).toBe('blocked');
    expect(result.reasons).toContainEqual({ code: 'head-changed', expected: c.sourceSha, actual: '9'.repeat(40) });
  });

  test('a changed base blocks whatever the reports say', () => {
    const c = candidate();
    const result = evaluate(input({ currentBaseSha: '8'.repeat(40) }));
    expect(result.readiness).toBe('blocked');
    expect(result.reasons).toContainEqual({ code: 'base-changed', expected: c.baseSha, actual: '8'.repeat(40) });
  });

  test('results for a previous candidate arriving late are set aside and change nothing', () => {
    const persistenceOnly = eligible({ id: 'report-win', attempts: [attempt('a1', 'windows/persistence', 'passed')] });
    const late = eligible({ id: 'report-old', candidateId: 'cand-0000', attempts: [attempt('a-old', 'windows/device-feel', 'passed')] });
    const result = evaluate(input({ reports: [persistenceOnly, late, linuxReport()] }));
    expect(result.readiness).toBe('blocked');
    expect(result.reasons).toEqual([{ code: 'missing-result', requirement: 'windows/device-feel' }]);
    expect(result.ignored).toContainEqual({ kind: 'report', id: 'report-old', reason: 'other-candidate' });
    expect(result.acceptedReportIds).not.toContain('report-old');
  });

  test('a report made against a different policy is set aside', () => {
    const stale = eligible({ id: 'report-win', policyDigest: 'd'.repeat(64) });
    const result = evaluate(input({ reports: [stale, linuxReport()] }));
    expect(result.ignored).toContainEqual({ kind: 'report', id: 'report-win', reason: 'policy-mismatch' });
    expect(result.readiness).toBe('blocked');
  });

  test('a report made against different tests is set aside', () => {
    const stale = eligible({ id: 'report-win', testRevision: '9'.repeat(40) });
    const result = evaluate(input({ reports: [stale, linuxReport()] }));
    expect(result.ignored).toContainEqual({ kind: 'report', id: 'report-win', reason: 'test-revision-mismatch' });
    expect(result.readiness).toBe('blocked');
  });

  test('a report for a profile the candidate does not support is set aside', () => {
    const macReport = eligible({ id: 'report-mac', profile: 'macos', attempts: [attempt('a-mac', 'macos/persistence', 'passed')] });
    const result = evaluate(input({ reports: [windowsReport(), linuxReport(), macReport] }));
    expect(result.readiness).toBe('passed');
    expect(result.ignored).toContainEqual({ kind: 'report', id: 'report-mac', reason: 'unsupported-profile' });
    expect(result.acceptedReportIds).not.toContain('report-mac');
  });

  test("a report measured on the wrong operating system for its profile is set aside", () => {
    const profiles = [
      { id: 'windows', os: 'windows', arch: 'x86_64' },
      { id: 'linux', os: 'linux', arch: 'x86_64' },
    ] as const;
    const wrongOs = eligible({ ...linuxReport().report, id: 'report-linux', environment: { ...linuxEnvironment, os: 'windows' } });
    const result = evaluate(input({ profiles, reports: [windowsReport(), wrongOs] }));
    expect(result.ignored).toContainEqual({ kind: 'report', id: 'report-linux', reason: 'environment-mismatch' });
    expect(result.reasons).toEqual([{ code: 'missing-result', requirement: 'linux/persistence' }]);
  });

  test('a profile the candidate ships but the caller did not define is reported as undefined, not unsupported', () => {
    const profiles = [{ id: 'windows', os: 'windows', arch: 'x86_64' }] as const;
    const result = evaluate(input({ profiles, reports: [windowsReport(), linuxReport()] }));
    expect(result.ignored).toContainEqual({ kind: 'report', id: 'report-linux', reason: 'profile-not-defined' });
    expect(result.ignored).not.toContainEqual({ kind: 'report', id: 'report-linux', reason: 'unsupported-profile' });
    expect(result.reasons).toEqual([{ code: 'missing-result', requirement: 'linux/persistence' }]);
  });

  test('a report claiming to be from someone other than its verified uploader is set aside', () => {
    const forged = eligible({ id: 'report-win', actor: 'maintainer' }, { uploader: 'someone-else' });
    const result = evaluate(input({ reports: [forged, linuxReport()] }));
    expect(result.ignored).toContainEqual({ kind: 'report', id: 'report-win', reason: 'unverified-reporter' });
    expect(result.readiness).toBe('blocked');
  });
});

describe('replays, concurrent testers and offline uploads', () => {
  test('the same report delivered twice counts once', () => {
    const result = evaluate(input({ reports: [windowsReport(), windowsReport(), linuxReport()] }));
    expect(result.readiness).toBe('passed');
    expect(result.acceptedReportIds).toEqual(['report-linux', 'report-win']);
    expect(result.ignored).toContainEqual({ kind: 'report', id: 'report-win', reason: 'duplicate-replay' });
  });

  test('one report id with two different contents is an error and neither copy counts', () => {
    const tampered = eligible({ id: 'report-win', machineId: 'lab-win-01', attempts: [attempt('a-win-persist', 'windows/persistence', 'failed'), attempt('a-win-feel', 'windows/device-feel', 'passed')] });
    const result = evaluate(input({ reports: [windowsReport(), tampered, linuxReport()] }));
    expect(result.readiness).toBe('blocked');
    expect(result.reasons).toContainEqual({ code: 'conflicting-report-id', reportId: 'report-win' });
    expect(result.acceptedReportIds).toEqual(['report-linux']);
    expect(result.ignored.filter((i) => i.id === 'report-win')).toEqual([
      { kind: 'report', id: 'report-win', reason: 'conflicting-report-id' },
      { kind: 'report', id: 'report-win', reason: 'conflicting-report-id' },
    ]);
  });

  test('a late upload from an offline tester still counts, whatever its timestamp says', () => {
    const late = eligible({ id: 'report-linux', profile: 'linux', actor: 'tester2', environment: linuxEnvironment, attempts: [attempt('a-lin-persist', 'linux/persistence', 'passed')] }, { uploadedAt: '2026-01-01T00:00:00Z' });
    expect(evaluate(input({ reports: [windowsReport(), late] })).readiness).toBe('passed');
  });

  test('two testers finishing different requirements are combined', () => {
    const first = eligible({ id: 'report-a', actor: 'alice', machineId: 'lab-win-01', attempts: [attempt('a1', 'windows/persistence', 'passed')] });
    const second = eligible({ id: 'report-b', actor: 'bob', machineId: 'lab-win-02', attempts: [attempt('b1', 'windows/device-feel', 'passed')] });
    const result = evaluate(input({ reports: [first, second, linuxReport()] }));
    expect(result.readiness).toBe('passed');
    expect(result.acceptedReportIds).toEqual(['report-a', 'report-b', 'report-linux']);
  });

  test('the order reports arrive in, and their upload times, do not change the decision', () => {
    const reports = [windowsReport(), linuxReport()];
    const forward = evaluate(input({ reports }));
    const backward = evaluate(input({ reports: [...reports].reverse().map((r, i) => ({ ...r, provenance: { ...r.provenance, uploadedAt: `2026-0${i + 1}-01T00:00:00Z` } })) }));
    expect(forward.readiness).toBe('passed');
    expect(forward.acceptedReportIds).toEqual(['report-linux', 'report-win']);
    expect(backward).toEqual(forward);
  });
});

describe('failures and retries', () => {
  const failedThenPassed = (retry: Partial<Attempt> = {}) => [
    eligible({ id: 'report-win', attempts: [attempt('a-win-persist', 'windows/persistence', 'failed'), attempt('a-win-feel', 'windows/device-feel', 'passed')] }),
    eligible({ id: 'report-win-2', actor: 'bob', machineId: 'lab-win-02', attempts: [attempt('a-win-persist-2', 'windows/persistence', 'passed', retry)] }),
    linuxReport(),
  ];
  const resolution: RetryResolution = { failedAttemptId: 'a-win-persist', passingAttemptId: 'a-win-persist-2', acknowledgedBy: 'maintainer' };

  test('a failed attempt blocks readiness', () => {
    const result = evaluate(input({ reports: [eligible({ id: 'report-win', attempts: [attempt('a-win-persist', 'windows/persistence', 'failed'), attempt('a-win-feel', 'windows/device-feel', 'passed')] }), linuxReport()] }));
    expect(result.readiness).toBe('blocked');
    expect(result.reasons).toEqual([{ code: 'unresolved-failure', requirement: 'windows/persistence', attemptId: 'a-win-persist', reportId: 'report-win' }]);
  });

  test('an unrelated passing attempt on another machine cannot erase a failure', () => {
    const result = evaluate(input({ reports: failedThenPassed(), retryResolutions: [] }));
    expect(result.readiness).toBe('blocked');
    expect(result.reasons).toEqual([{ code: 'unresolved-failure', requirement: 'windows/persistence', attemptId: 'a-win-persist', reportId: 'report-win' }]);
  });

  test('a retry that names the failure but was never acknowledged still blocks', () => {
    const result = evaluate(input({ reports: failedThenPassed({ retryOf: 'a-win-persist' }), retryResolutions: [] }));
    expect(result.readiness).toBe('blocked');
    expect(result.reasons).toContainEqual({ code: 'unresolved-failure', requirement: 'windows/persistence', attemptId: 'a-win-persist', reportId: 'report-win' });
  });

  test('an acknowledgement for an attempt that is not recorded as a retry of the failure still blocks', () => {
    const result = evaluate(input({ reports: failedThenPassed(), retryResolutions: [resolution] }));
    expect(result.readiness).toBe('blocked');
    expect(result.reasons).toContainEqual({ code: 'unresolved-failure', requirement: 'windows/persistence', attemptId: 'a-win-persist', reportId: 'report-win' });
  });

  test('a recorded retry plus an acknowledgement resolves the failure', () => {
    const result = evaluate(input({ reports: failedThenPassed({ retryOf: 'a-win-persist' }), retryResolutions: [resolution] }));
    expect(result.readiness).toBe('passed');
    expect(result.reasons).toEqual([]);
    expect(result.acceptedReportIds).toEqual(['report-linux', 'report-win', 'report-win-2']);
  });

  test('a retry that passes on a machine without the required capability does not resolve the failure', () => {
    const needsHardware = requirement({ key: 'windows/persistence', capabilities: ['hardware'] });
    const environment = (capabilities: string[]) => ({ os: 'windows', osVersion: '10.0.26200', arch: 'x86_64', capabilities, toolVersion: '0.0.0' });
    const reportsFor = (retryCapabilities: string[]) => [
      eligible({ id: 'report-win', environment: environment(['display', 'hardware']), attempts: [attempt('a-win-persist', 'windows/persistence', 'failed'), attempt('a-win-feel', 'windows/device-feel', 'passed')] }),
      eligible({ id: 'report-win-2', actor: 'bob', machineId: 'lab-win-02', environment: environment(retryCapabilities), attempts: [attempt('a-win-persist-2', 'windows/persistence', 'passed', { retryOf: 'a-win-persist' })] }),
      linuxReport(),
    ];
    const args = { required: [needsHardware, deviceFeel, linuxPersistence], retryResolutions: [resolution] };

    expect(evaluate(input({ ...args, reports: reportsFor(['display', 'hardware']) })).readiness).toBe('passed');

    const result = evaluate(input({ ...args, reports: reportsFor(['display']) }));
    expect(result.readiness).toBe('blocked');
    expect(result.reasons).toEqual([{ code: 'unresolved-failure', requirement: 'windows/persistence', attemptId: 'a-win-persist', reportId: 'report-win' }]);
  });

  test('an acknowledgement resolves only the failure it names', () => {
    const twoFailures = [
      eligible({ id: 'report-win', attempts: [attempt('a-win-persist', 'windows/persistence', 'failed'), attempt('a-win-persist-b', 'windows/persistence', 'failed'), attempt('a-win-feel', 'windows/device-feel', 'passed')] }),
      eligible({ id: 'report-win-2', actor: 'bob', machineId: 'lab-win-02', attempts: [attempt('a-win-persist-2', 'windows/persistence', 'passed', { retryOf: 'a-win-persist' })] }),
      linuxReport(),
    ];
    const result = evaluate(input({ reports: twoFailures, retryResolutions: [resolution] }));
    expect(result.readiness).toBe('blocked');
    expect(result.reasons).toEqual([{ code: 'unresolved-failure', requirement: 'windows/persistence', attemptId: 'a-win-persist-b', reportId: 'report-win' }]);
  });

  test('a failure in a report that is set aside does not block, and is still listed as ignored', () => {
    const oldFailure = eligible({ id: 'report-old', candidateId: 'cand-0000', attempts: [attempt('a-old', 'windows/persistence', 'failed')] });
    const result = evaluate(input({ reports: [oldFailure, windowsReport(), linuxReport()] }));
    expect(result.readiness).toBe('passed');
    expect(result.ignored).toContainEqual({ kind: 'report', id: 'report-old', reason: 'other-candidate' });
  });
});

describe('exceptions', () => {
  test('an authorized exception yields approved-with-exceptions, never passed', () => {
    const result = evaluate(input({ reports: [eligible({ id: 'report-win', attempts: [attempt('a1', 'windows/persistence', 'passed')] }), linuxReport()], exceptions: [authorized()] }));
    expect(result.readiness).toBe('approved-with-exceptions');
    expect(result.reasons).toEqual([]);
    expect(result.exceptionIds).toEqual(['exception-0001']);
    expect(result.excused).toEqual([{ reason: { code: 'missing-result', requirement: 'windows/device-feel' }, exceptionId: 'exception-0001' }]);
  });

  test('an exception can excuse a failed requirement, and it stays visible', () => {
    const failed = eligible({ id: 'report-win', attempts: [attempt('a1', 'windows/persistence', 'failed'), attempt('a2', 'windows/device-feel', 'passed')] });
    const result = evaluate(input({ reports: [failed, linuxReport()], exceptions: [authorized({ requirements: ['windows/persistence'] })] }));
    expect(result.readiness).toBe('approved-with-exceptions');
    expect(result.excused).toEqual([{ reason: { code: 'unresolved-failure', requirement: 'windows/persistence', attemptId: 'a1', reportId: 'report-win' }, exceptionId: 'exception-0001' }]);
  });

  test('an exception from someone who may not approve is set aside', () => {
    const result = evaluate(input({ reports: [windowsReport()], exceptions: [authorized({ requirements: ['linux/persistence'] }, false)] }));
    expect(result.readiness).toBe('blocked');
    expect(result.reasons).toEqual([{ code: 'missing-result', requirement: 'linux/persistence' }]);
    expect(result.ignored).toContainEqual({ kind: 'exception', id: 'exception-0001', reason: 'unauthorized-exception' });
    expect(result.exceptionIds).toEqual([]);
  });

  test('an exception granted for another candidate is set aside', () => {
    const result = evaluate(input({ reports: [windowsReport()], exceptions: [authorized({ candidateId: 'cand-0000', requirements: ['linux/persistence'] })] }));
    expect(result.readiness).toBe('blocked');
    expect(result.ignored).toContainEqual({ kind: 'exception', id: 'exception-0001', reason: 'other-candidate' });
  });

  test('an exception cannot excuse a moved head', () => {
    const result = evaluate(input({ currentHeadSha: '9'.repeat(40), reports: [windowsReport()], exceptions: [authorized({ requirements: ['linux/persistence'] })] }));
    expect(result.readiness).toBe('blocked');
    expect(result.reasons).toContainEqual(expect.objectContaining({ code: 'head-changed' }));
  });

  test('an exception cannot excuse a report id conflict', () => {
    const tampered = eligible({ id: 'report-win', attempts: [attempt('x', 'windows/persistence', 'failed')] });
    const result = evaluate(input({ reports: [windowsReport(), tampered, linuxReport()], exceptions: [authorized({ requirements: ['windows/persistence', 'windows/device-feel'] })] }));
    expect(result.readiness).toBe('blocked');
    expect(result.reasons).toContainEqual({ code: 'conflicting-report-id', reportId: 'report-win' });
  });

  test('an exception covering one of two unmet requirements leaves the other blocking', () => {
    const result = evaluate(input({ reports: [], exceptions: [authorized({ requirements: ['windows/device-feel'] })] }));
    expect(result.readiness).toBe('blocked');
    expect(result.reasons).toEqual([
      { code: 'missing-result', requirement: 'windows/persistence' },
      { code: 'missing-result', requirement: 'linux/persistence' },
    ]);
    expect(result.excused).toEqual([{ reason: { code: 'missing-result', requirement: 'windows/device-feel' }, exceptionId: 'exception-0001' }]);
  });

  test('when two exceptions cover the same requirement the lowest id is recorded, whatever the arrival order', () => {
    const missingFeel = [eligible({ id: 'report-win', attempts: [attempt('a1', 'windows/persistence', 'passed')] }), linuxReport()];
    const earlier = authorized({ id: 'exception-a' });
    const later = authorized({ id: 'exception-b' });
    const one = evaluate(input({ reports: missingFeel, exceptions: [later, earlier] }));
    const other = evaluate(input({ reports: missingFeel, exceptions: [earlier, later] }));
    expect(one.readiness).toBe('approved-with-exceptions');
    expect(one.exceptionIds).toEqual(['exception-a']);
    expect(one.excused).toEqual([{ reason: { code: 'missing-result', requirement: 'windows/device-feel' }, exceptionId: 'exception-a' }]);
    expect(other).toEqual(one);
  });

  test('an exception nobody needed is not applied and the result stays passed', () => {
    const result = evaluate(input({ exceptions: [authorized()] }));
    expect(result.readiness).toBe('passed');
    expect(result.exceptionIds).toEqual([]);
    expect(result.excused).toEqual([]);
  });
});

describe('purity', () => {
  test('does not modify its input', () => {
    const deepFreeze = <T>(value: T): T => {
      if (typeof value === 'object' && value !== null) {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
      }
      return value;
    };
    // Reports arrive out of order and exceptions are present, so an implementation that sorts or edits in place fails.
    const frozen = deepFreeze(input({ reports: [linuxReport(), windowsReport()], exceptions: [authorized()], retryResolutions: [{ failedAttemptId: 'x', passingAttemptId: 'y', acknowledgedBy: 'maintainer' }] }));
    let result: ReturnType<typeof evaluate> | undefined;
    expect(() => { result = evaluate(frozen); }).not.toThrow();
    expect(result?.readiness).toBe('passed');
  });

  test('returns the same evaluation for the same input, every time', () => {
    const args = input({ reports: [windowsReport()] });
    const first = evaluate(args);
    expect(first.reasons).toEqual([{ code: 'missing-result', requirement: 'linux/persistence' }]);
    expect(evaluate(args)).toEqual(first);
  });
});
