import type { Evaluation, Reason } from '@frogbyte-io/release-qa/model';
import type { AccountView, DashboardSnapshot } from '../shared/contract.ts';

/** Words for what the shared evaluator returned. Nothing here decides readiness; it only phrases the evaluator's result. */
export const READINESS_LABEL: Record<Evaluation['readiness'], string> = {
  blocked: 'Blocked',
  passed: 'Passed',
  'approved-with-exceptions': 'Approved with exceptions',
};

export function reasonText(reason: Reason): string {
  switch (reason.code) {
    case 'head-changed': return `The pull request head changed from ${reason.expected} to ${reason.actual}`;
    case 'base-changed': return `The target branch changed from ${reason.expected} to ${reason.actual}`;
    case 'conflicting-report-id': return `Conflicting report ID ${reason.reportId}`;
    case 'no-artifact-for-profile': return `${reason.requirement} has no candidate artifact`;
    case 'capability-missing': return `${reason.requirement} needs ${reason.missing.join(', ')}`;
    case 'missing-result': return `${reason.requirement} has no passing result`;
    case 'not-passed': return `${reason.requirement}: ${reason.outcomes.join(', ')}`;
    case 'unresolved-failure': return `${reason.requirement} has an unresolved failure (${reason.attemptId} in ${reason.reportId})`;
  }
}

/** The requirement a reason is about, when it is about one; head and base changes concern the whole candidate. */
export const reasonRequirement = (reason: Reason): string | undefined => ('requirement' in reason ? reason.requirement : undefined);

/** The environment profile is the part of a requirement key before the slash. */
export const environmentOf = (requirement: string): string => requirement.slice(0, requirement.indexOf('/'));

export interface EnvironmentGroup { environment: string; reasons: Reason[] }

/** Groups reasons under the environment they concern, keeping candidate-wide reasons together under `all environments`. */
export function groupByEnvironment(reasons: readonly Reason[]): EnvironmentGroup[] {
  const groups = new Map<string, Reason[]>();
  for (const reason of reasons) {
    const requirement = reasonRequirement(reason);
    const key = requirement === undefined ? 'all environments' : environmentOf(requirement);
    groups.set(key, [...(groups.get(key) ?? []), reason]);
  }
  return [...groups].map(([environment, list]) => ({ environment, reasons: list }));
}

export const ROLE_NOTE = 'Read-only access: you can review everything here, but not run, sync or merge.';

export function accountText(account: AccountView): string {
  return account.status === 'signed-in' ? `Signed in as ${account.login}` : 'Not signed in to GitHub';
}

/** Human wording for the reasons the transport gives when a repository or GitHub cannot be read. */
export function problemText(reason: string): string {
  switch (reason) {
    case 'logged-out': return 'GitHub sign-in has expired. Run "gh auth login", then refresh.';
    case 'missing-scope': return 'The GitHub token lacks a needed permission scope.';
    case 'insufficient-role': return 'Your account cannot read this repository.';
    case 'organization-rejected': return 'The organization has not approved this sign-in (SSO or OAuth restriction).';
    case 'not-found': return 'The repository was not found, or you have no access to it.';
    case 'network-error': return 'GitHub could not be reached.';
    default: return reason;
  }
}

export const isEmpty = (snapshot: DashboardSnapshot): boolean => snapshot.projects.length === 0 && snapshot.problems.length === 0;
