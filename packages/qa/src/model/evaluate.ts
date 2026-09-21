import type { Candidate } from './candidate.ts';
import { canonical, compare } from './canonical.ts';
import type { Exception } from './exception.ts';
import type { EnvironmentProfile } from './project.ts';
import { profileOf, type Requirement, type RequirementKey } from './requirement.ts';
import type { Attempt, Outcome, Readiness, Report, UploadProvenance } from './result.ts';

/** A report together with the provenance the GitHub layer recorded when it stored the upload. */
export interface EligibleReport {
  report: Report;
  provenance: UploadProvenance;
}

/** An exception plus the outcome of the caller's check that its uploader may approve exceptions. */
export interface AuthorizedException {
  exception: Exception;
  authority: { login: string; authorized: boolean };
}

/** A person's explicit statement that a passing retry resolves an earlier failed attempt. */
export interface RetryResolution {
  failedAttemptId: string;
  passingAttemptId: string;
  acknowledgedBy: string;
}

export interface EvaluationInput {
  candidate: Candidate;
  currentHeadSha: string;
  currentBaseSha: string;
  required: readonly Requirement[];
  /** When given, a report's measured environment must match its profile's operating system and architecture. */
  profiles?: readonly EnvironmentProfile[];
  reports: readonly EligibleReport[];
  exceptions: readonly AuthorizedException[];
  retryResolutions: readonly RetryResolution[];
}

/** Why the candidate is not (fully) ready. Requirement-level reasons can be excused by an exception. */
export type Reason =
  | { code: 'head-changed'; expected: string; actual: string }
  | { code: 'base-changed'; expected: string; actual: string }
  | { code: 'conflicting-report-id'; reportId: string }
  | { code: 'no-artifact-for-profile'; requirement: RequirementKey }
  | { code: 'capability-missing'; requirement: RequirementKey; missing: string[] }
  | { code: 'missing-result'; requirement: RequirementKey }
  | { code: 'not-passed'; requirement: RequirementKey; outcomes: Outcome[] }
  | { code: 'unresolved-failure'; requirement: RequirementKey; attemptId: string; reportId: string };

export type IgnoredReason =
  | 'other-candidate'
  | 'policy-mismatch'
  | 'test-revision-mismatch'
  /** The candidate ships no artifact for the report's profile. */
  | 'unsupported-profile'
  /** The candidate ships the profile but the caller's `profiles` list has no entry for it: a gap on the caller's side. */
  | 'profile-not-defined'
  | 'environment-mismatch'
  | 'unverified-reporter'
  | 'duplicate-replay'
  | 'conflicting-report-id'
  | 'unauthorized-exception';

/** A record set aside from the decision. It is reported, never deleted, so history stays visible. */
export interface Ignored {
  kind: 'report' | 'exception';
  id: string;
  reason: IgnoredReason;
}

export interface Evaluation {
  readiness: Readiness;
  /** Blocking reasons; empty unless readiness is `blocked`. */
  reasons: Reason[];
  /** Reasons an exception excused, so an approval with exceptions still shows what was waived. */
  excused: Array<{ reason: Reason; exceptionId: string }>;
  acceptedReportIds: string[];
  exceptionIds: string[];
  ignored: Ignored[];
}

/** An attempt with the report it came from. */
interface Recorded {
  attempt: Attempt;
  report: Report;
}

/**
 * Decides whether a candidate may be released. Pure: it reads only its argument, never a clock, the network
 * or the filesystem, and it does not depend on the order or upload time of its inputs. The UI, the CLI, the
 * PR gate and the publisher all call this one function.
 */
export function evaluate(input: EvaluationInput): Evaluation {
  const ignored: Ignored[] = [];
  const blocking: Reason[] = [];

  if (input.currentHeadSha !== input.candidate.sourceSha) {
    blocking.push({ code: 'head-changed', expected: input.candidate.sourceSha, actual: input.currentHeadSha });
  }
  if (input.currentBaseSha !== input.candidate.baseSha) {
    blocking.push({ code: 'base-changed', expected: input.candidate.baseSha, actual: input.currentBaseSha });
  }

  const { accepted, conflicts } = selectReports(input, ignored);
  for (const reportId of conflicts) blocking.push({ code: 'conflicting-report-id', reportId });

  const recorded: Recorded[] = accepted.flatMap((report) => report.attempts.map((attempt) => ({ attempt, report })));
  const unmet = input.required.flatMap((requirement) => unmetReasons(input, requirement, recorded));

  const excusedBy = applyExceptions(input, unmet, ignored);
  const reasons = [...blocking, ...unmet.filter((reason) => !excusedBy.has(reason))];
  const excused = unmet.flatMap((reason) => {
    const exceptionId = excusedBy.get(reason);
    return exceptionId === undefined ? [] : [{ reason, exceptionId }];
  });

  return {
    readiness: reasons.length > 0 ? 'blocked' : excused.length > 0 ? 'approved-with-exceptions' : 'passed',
    reasons,
    excused,
    acceptedReportIds: accepted.map((report) => report.id).sort(),
    exceptionIds: [...new Set(excused.map((e) => e.exceptionId))].sort(),
    ignored: ignored.sort((a, b) => compare(a.kind, b.kind) || compare(a.id, b.id) || compare(a.reason, b.reason)),
  };
}

/** Keeps the reports that belong to this candidate and can be trusted, and lists everything else as ignored. */
function selectReports(input: EvaluationInput, ignored: Ignored[]): { accepted: Report[]; conflicts: string[] } {
  const { candidate } = input;
  const supportedProfiles = new Set(candidate.artifacts.map((a) => a.profile));
  const profileById = new Map((input.profiles ?? []).map((p) => [p.id, p]));

  // One report id must always mean the same content. Two different contents under one id is an integrity
  // error: neither copy is trusted, and the conflict itself blocks.
  const contentsById = new Map<string, Set<string>>();
  for (const { report } of input.reports) {
    const contents = contentsById.get(report.id) ?? new Set<string>();
    contents.add(canonical(report));
    contentsById.set(report.id, contents);
  }
  const conflicted = new Set([...contentsById].filter(([, contents]) => contents.size > 1).map(([id]) => id));

  const accepted = new Map<string, Report>();
  for (const { report, provenance } of input.reports) {
    const ignore = (reason: IgnoredReason): void => void ignored.push({ kind: 'report', id: report.id, reason });
    if (conflicted.has(report.id)) ignore('conflicting-report-id');
    else if (report.candidateId !== candidate.id) ignore('other-candidate');
    else if (report.policyDigest !== candidate.policyDigest) ignore('policy-mismatch');
    else if (report.testRevision !== candidate.testRevision) ignore('test-revision-mismatch');
    else if (!supportedProfiles.has(report.profile)) ignore('unsupported-profile');
    else if (input.profiles !== undefined && !profileById.has(report.profile)) ignore('profile-not-defined');
    else if (!environmentMatches(report, profileById.get(report.profile))) ignore('environment-mismatch');
    else if (report.actor !== provenance.uploader) ignore('unverified-reporter');
    else if (accepted.has(report.id)) ignore('duplicate-replay');
    else accepted.set(report.id, report);
  }
  return { accepted: [...accepted.values()], conflicts: [...conflicted].sort() };
}

function environmentMatches(report: Report, profile: EnvironmentProfile | undefined): boolean {
  return profile === undefined || (report.environment.os === profile.os && report.environment.arch === profile.arch);
}

/** Why one requirement is not met by the trusted attempts, or an empty list when it is. */
function unmetReasons(input: EvaluationInput, requirement: Requirement, recorded: readonly Recorded[]): Reason[] {
  const key = requirement.key;
  if (!input.candidate.artifacts.some((a) => a.profile === profileOf(key))) return [{ code: 'no-artifact-for-profile', requirement: key }];

  const attempts = recorded.filter((r) => r.attempt.requirement === key);
  const missingCapabilities = (r: Recorded): string[] => requirement.capabilities.filter((c) => !r.report.environment.capabilities.includes(c));
  const canCount = (r: Recorded): boolean => missingCapabilities(r).length === 0;

  // A failure is never lost. It stays until a passing retry that is recorded as a retry of it has been
  // explicitly acknowledged; an unrelated pass elsewhere does not clear it.
  const unresolved = attempts
    .filter((r) => r.attempt.outcome === 'failed')
    .filter((failure) => !isResolved(failure.attempt, attempts.filter(canCount), input.retryResolutions))
    .sort((a, b) => compare(a.attempt.id, b.attempt.id));
  if (unresolved.length > 0) {
    return unresolved.map((r): Reason => ({ code: 'unresolved-failure', requirement: key, attemptId: r.attempt.id, reportId: r.report.id }));
  }

  if (attempts.some((r) => r.attempt.outcome === 'passed' && canCount(r))) return [];
  if (attempts.length === 0) return [{ code: 'missing-result', requirement: key }];

  const uncounted = attempts.filter((r) => r.attempt.outcome === 'passed' && !canCount(r));
  if (uncounted.length > 0) {
    const missing = [...new Set(uncounted.flatMap(missingCapabilities))].sort();
    return [{ code: 'capability-missing', requirement: key, missing }];
  }
  return [{ code: 'not-passed', requirement: key, outcomes: [...new Set(attempts.map((r) => r.attempt.outcome))].sort() }];
}

function isResolved(failure: Attempt, passing: readonly Recorded[], resolutions: readonly RetryResolution[]): boolean {
  return resolutions.some(
    (resolution) =>
      resolution.failedAttemptId === failure.id &&
      passing.some((r) => r.attempt.id === resolution.passingAttemptId && r.attempt.outcome === 'passed' && r.attempt.retryOf === failure.id),
  );
}

/** Maps each excused reason to the exception that excuses it. Only requirement-level reasons can be excused. */
function applyExceptions(input: EvaluationInput, unmet: readonly Reason[], ignored: Ignored[]): Map<Reason, string> {
  const usable: Exception[] = [];
  for (const { exception, authority } of input.exceptions) {
    if (!authority.authorized) ignored.push({ kind: 'exception', id: exception.id, reason: 'unauthorized-exception' });
    else if (exception.candidateId !== input.candidate.id) ignored.push({ kind: 'exception', id: exception.id, reason: 'other-candidate' });
    else usable.push(exception);
  }
  usable.sort((a, b) => compare(a.id, b.id));

  const excusedBy = new Map<Reason, string>();
  for (const reason of unmet) {
    const covering = 'requirement' in reason ? usable.find((e) => e.requirements.includes(reason.requirement)) : undefined;
    if (covering !== undefined) excusedBy.set(reason, covering.id);
  }
  return excusedBy;
}
