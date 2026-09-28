import type { Evaluation, Reason } from '../model/evaluate.ts';

export interface ReleaseIntentPolicy {
  releaseBranchPrefix: string;
  releaseLabel: string;
  releaseFiles: readonly string[];
}

export interface PullRequestSignals {
  branch: string;
  labels: readonly string[];
  files: readonly string[];
}

export { evaluatePullRequest, type GateApi, type PullRequestGateEvaluation, type PullRequestGateResult } from './pull-request-gate.ts';

/** Uses independent branch, label, and changed-file signals so removing one label cannot bypass release QA. */
export function hasReleaseIntent(pr: PullRequestSignals, policy: ReleaseIntentPolicy): string[] {
  const reasons: string[] = [];
  if (pr.branch.startsWith(policy.releaseBranchPrefix)) reasons.push('release branch');
  if (pr.labels.includes(policy.releaseLabel)) reasons.push('release label');
  const files = pr.files.filter((file) => policy.releaseFiles.includes(file));
  if (files.length > 0) reasons.push(`release file changed: ${files.join(', ')}`);
  return reasons;
}

const safe = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');

function describe(reason: Reason): string {
  switch (reason.code) {
    case 'head-changed': return `PR head changed from ${safe(reason.expected)} to ${safe(reason.actual)}`;
    case 'base-changed': return `Target branch changed from ${safe(reason.expected)} to ${safe(reason.actual)}`;
    case 'conflicting-report-id': return `Conflicting report ID ${safe(reason.reportId)}`;
    case 'no-artifact-for-profile': return `${safe(reason.requirement)} has no candidate artifact`;
    case 'capability-missing': return `${safe(reason.requirement)} lacks ${reason.missing.map(safe).join(', ')}`;
    case 'missing-result': return `${safe(reason.requirement)} has no passing result`;
    case 'not-passed': return `${safe(reason.requirement)}: ${reason.outcomes.map(safe).join(', ')}`;
    case 'unresolved-failure': return `${safe(reason.requirement)} has unresolved failure ${safe(reason.attemptId)} in ${safe(reason.reportId)}`;
  }
}

/** PR-facing view of the same evaluator result used by the gate; this text never grants readiness itself. */
export function renderQaSection(evaluation: Evaluation): string {
  const status = evaluation.readiness === 'blocked' ? 'Blocked' : evaluation.readiness === 'approved-with-exceptions' ? 'Approved with exceptions' : 'Passed';
  const count = evaluation.acceptedReportIds.length;
  const lines = [`**QA: ${status}**`, `${count} accepted report${count === 1 ? '' : 's'}.`];
  if (evaluation.reasons.length > 0) lines.push('', 'Blocking reasons:', ...evaluation.reasons.map((reason) => `- ${describe(reason)}`));
  if (evaluation.excused.length > 0) lines.push('', 'Approved exceptions:', ...evaluation.excused.map(({ reason, exceptionId }) => `- ${describe(reason)} (exception ${safe(exceptionId)})`));
  if (evaluation.ignored.length > 0) lines.push('', 'Ignored records:', ...evaluation.ignored.map(({ kind, id, reason }) => `- ${safe(kind)} ${safe(id)}: ${safe(reason)}`));
  return lines.join('\n');
}
