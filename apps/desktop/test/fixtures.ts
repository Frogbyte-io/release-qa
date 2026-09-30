import type { Evaluation } from '@frogbyte-io/release-qa/model';
import type { ActionResult, DashboardSnapshot, MergePreviewResult, ProjectView, PullRequestView, QaBridge } from '../src/shared/contract.ts';

export const evaluation = (changes: Partial<Evaluation> = {}): Evaluation => ({
  readiness: 'passed', reasons: [], excused: [], acceptedReportIds: [], exceptionIds: [], ignored: [], ...changes,
});

export function pull(changes: Partial<PullRequestView> = {}): PullRequestView {
  return {
    number: 7,
    title: 'Release 1.2.0',
    author: 'maintainer',
    url: 'https://github.com/acme/app/pull/7',
    headRef: 'release/1.2.0',
    headSha: 'a'.repeat(40),
    draft: false,
    releaseIntent: ['release branch'],
    gate: { status: 'evaluated', evaluation: evaluation({ readiness: 'blocked', reasons: [{ code: 'missing-result', requirement: 'windows/persistence' }] }), candidateId: 'cand-1', candidateReleaseId: 50 },
    ...changes,
  };
}

export function projectView(changes: Partial<ProjectView> = {}): ProjectView {
  return {
    repository: 'acme/app',
    projectId: 'app',
    releaseBranch: 'main',
    role: 'maintain',
    readOnly: false,
    profiles: ['windows', 'linux'],
    requirements: [
      { key: 'windows/persistence', title: 'Mapping persists', mode: 'automated', profile: 'windows' },
      { key: 'windows/device-feel', title: 'Sliders feel right', mode: 'manual', profile: 'windows' },
    ],
    pullRequests: { status: 'ok', items: [pull()] },
    history: { status: 'ok', releases: [{ tag: 'v1.1.0', name: 'v1.1.0', publishedAt: '2026-09-01T10:00:00Z', url: 'https://github.com/acme/app/releases/tag/v1.1.0', qa: 'recorded' }] },
    ...changes,
  };
}

export function snapshot(changes: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return { loadedAt: '2026-09-29T12:00:00.000Z', stale: false, account: { status: 'signed-in', login: 'maintainer' }, projects: [projectView()], problems: [], ...changes };
}

/** A bridge whose every call is recorded and answered from `overrides`; anything a test did not expect to be called fails it. */
export function fakeBridge(overrides: Partial<QaBridge> = {}): QaBridge & { calls: Array<{ name: string; args: unknown[] }> } {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const unexpected = (name: string) => async (): Promise<never> => { throw new Error(`unexpected call to ${name}`); };
  const record = <T extends (...args: never[]) => unknown>(name: string, fn: T | undefined): T => ((...args: unknown[]) => { calls.push({ name, args }); return (fn ?? unexpected(name))(...(args as never[])); }) as unknown as T;
  return {
    calls,
    loadDashboard: record('loadDashboard', overrides.loadDashboard ?? (async () => snapshot())),
    prepareCandidate: record('prepareCandidate', overrides.prepareCandidate),
    previewMerge: record('previewMerge', overrides.previewMerge),
    mergePullRequest: record('mergePullRequest', overrides.mergePullRequest),
    openPullRequest: record('openPullRequest', overrides.openPullRequest),
    loadManualCheck: record('loadManualCheck', overrides.loadManualCheck),
    pickEvidence: record('pickEvidence', overrides.pickEvidence),
    recordManualCheck: record('recordManualCheck', overrides.recordManualCheck),
    syncManualResult: record('syncManualResult', overrides.syncManualResult),
    claimManualCheck: record('claimManualCheck', overrides.claimManualCheck),
    runOnLinux: record('runOnLinux', overrides.runOnLinux),
    listRemoteRuns: record('listRemoteRuns', overrides.listRemoteRuns ?? (async () => ({ ok: true as const, configured: true, runs: [] }))),
  };
}

export const okPreview = (changes: Partial<Extract<MergePreviewResult, { ok: true }>> = {}): MergePreviewResult => ({
  ok: true, headSha: 'a'.repeat(40), baseRef: 'main', readiness: 'passed', candidateId: 'cand-1', candidateReleaseId: 50, publishes: true, releaseIntent: ['release branch'], ...changes,
});
export const done = (message = 'done'): ActionResult => ({ ok: true, message });
