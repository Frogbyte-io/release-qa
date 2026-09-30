import { inspectGitHubAccess, type ApiResult, type GitHubApi } from './transport.ts';

/**
 * Running a suite on a Linux runner through GitHub, for a UI that runs on Windows.
 *
 * The consumer supplies the workflow (`workflows.run` in `qa/project.json`). It is dispatched from the default branch
 * only, and its `run-name` must be exactly {@link remoteRunTitle}: that title is how a run is found again, so the state
 * of a remote execution lives on GitHub and is rebuilt from it, never from anything the app remembered.
 */

export interface SuiteRunRequest {
  prNumber: number;
  candidateId: string;
  profile: string;
  suite: string;
  expectedHead: string;
}

export interface SuiteRunDispatchApi extends GitHubApi {
  post(path: string, body: unknown): Promise<ApiResult<unknown>>;
}

export type SuiteRunDispatch =
  | { ok: true; runId: number; workflowHeadSha: string; url: string }
  | { ok: false; error: string; runId?: number };

const gitSha = /^[0-9a-f]{40}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const workflowFile = /^[A-Za-z0-9_.-]+\.ya?ml$/;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** The `run-name` a consumer's run workflow must set. Every part is a validated id or a SHA, so it has no spaces of its own. */
export const remoteRunTitle = (request: SuiteRunRequest): string =>
  `qa-run PR #${request.prNumber} ${request.candidateId} ${request.profile}/${request.suite} ${request.expectedHead}`;

const TITLE = /^qa-run PR #([1-9][0-9]*) ([A-Za-z0-9][A-Za-z0-9._-]{0,127}) ([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/([A-Za-z0-9][A-Za-z0-9._-]{0,127}) ([0-9a-f]{40})$/;

/** The request a run title names, or undefined for any other title. */
export function parseRemoteRunTitle(title: unknown): SuiteRunRequest | undefined {
  const match = typeof title === 'string' ? TITLE.exec(title) : null;
  if (match === null) return undefined;
  return { prNumber: Number(match[1]), candidateId: match[2]!, profile: match[3]!, suite: match[4]!, expectedHead: match[5]! };
}

export function validSuiteRunRequest(request: SuiteRunRequest): boolean {
  return Number.isSafeInteger(request.prNumber) && request.prNumber > 0 && gitSha.test(request.expectedHead) &&
    idPattern.test(request.candidateId) && idPattern.test(request.profile) && idPattern.test(request.suite);
}

const workflowPath = (workflow: string): string => `.github/workflows/${workflow}`;

/**
 * Dispatches the consumer's run workflow from the default branch, for the pull request head the caller reviewed, then
 * verifies the run GitHub returned (id, workflow file, event, title, workflow revision, repository) like
 * `prepareCandidate` does. Checks write access and that the pull request is open at `expectedHead` first. It does not
 * decide whether `candidateId` is the active candidate; the caller has the gate result for that, and the workflow itself
 * must re-check it before running anything.
 */
export async function dispatchSuiteRun(
  repository: string,
  workflow: string,
  request: SuiteRunRequest,
  api: SuiteRunDispatchApi,
  options: { retryDelayMs?: number } = {},
): Promise<SuiteRunDispatch> {
  if (!repositoryName.test(repository) || !workflowFile.test(workflow)) return { ok: false, error: 'invalid repository or workflow file' };
  if (!validSuiteRunRequest(request)) return { ok: false, error: 'invalid pull request, candidate, profile, suite or head SHA' };
  const delay = options.retryDelayMs ?? 500;
  try {
    const access = await inspectGitHubAccess(repository, api);
    if (!access.ok) return { ok: false, error: `cannot run a suite: ${access.reason}` };
    if (!['write', 'maintain', 'admin'].includes(access.role)) return { ok: false, error: 'running a suite requires repository write access' };
    const pull = await api.get(`repos/${repository}/pulls/${request.prNumber}`);
    if (!pull.ok) return { ok: false, error: `cannot inspect PR #${request.prNumber}: ${pull.reason}` };
    const pr = record(pull.value);
    if (pr?.state !== 'open' || record(pr.head)?.sha !== request.expectedHead) {
      return { ok: false, error: `PR #${request.prNumber} is closed or its head no longer matches ${request.expectedHead}` };
    }
    const info = await api.get(`repos/${repository}`);
    const branchName = record(info.ok ? info.value : undefined)?.default_branch;
    if (typeof branchName !== 'string' || !branchName) return { ok: false, error: 'cannot identify the trusted default branch' };
    const branch = await api.get(`repos/${repository}/branches/${encodeURIComponent(branchName)}`);
    const workflowHeadSha = record(record(branch.ok ? branch.value : undefined)?.commit)?.sha;
    if (typeof workflowHeadSha !== 'string' || !gitSha.test(workflowHeadSha)) return { ok: false, error: 'cannot verify the trusted workflow revision' };

    const dispatched = await api.post(`repos/${repository}/actions/workflows/${workflow}/dispatches`, {
      ref: branchName,
      return_run_details: true,
      inputs: {
        pr_number: String(request.prNumber),
        candidate_id: request.candidateId,
        profile: request.profile,
        suite: request.suite,
        expected_head: request.expectedHead,
      },
    });
    if (!dispatched.ok) return { ok: false, error: `suite run dispatch failed: ${dispatched.reason}` };
    const runId = record(dispatched.value)?.workflow_run_id;
    if (typeof runId !== 'number' || !Number.isSafeInteger(runId) || runId <= 0) return { ok: false, error: 'suite run dispatch did not return a run ID' };

    const matches = (run: Record<string, unknown> | undefined): boolean =>
      run?.id === runId && run.path === workflowPath(workflow) && run.event === 'workflow_dispatch' &&
      run.display_title === remoteRunTitle(request) && record(run.repository)?.id === access.repositoryId && run.head_sha === workflowHeadSha;
    let run: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await api.get(`repos/${repository}/actions/runs/${runId}`);
      if (response.ok) {
        run = record(response.value);
        if (typeof run?.head_sha === 'string' && run.head_sha !== workflowHeadSha) return { ok: false, error: 'dispatched suite run used a different workflow revision', runId };
        if (matches(run)) break;
      } else if (response.reason !== 'not-found') return { ok: false, error: `cannot inspect dispatched suite run: ${response.reason}`, runId };
      if (attempt < 9 && delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (!matches(run)) return { ok: false, error: 'dispatched suite run does not match the trusted workflow, its title or the reviewed head (does the workflow set run-name to the required title?)', runId };
    return { ok: true, runId, workflowHeadSha, url: `https://github.com/${repository}/actions/runs/${runId}` };
  } catch {
    return { ok: false, error: 'suite run dispatch could not verify GitHub state' };
  }
}

/**
 * The five states a remote execution is shown in. `completed` carries GitHub's conclusion (`success`, `failure`,
 * `cancelled`, `timed_out`, ...); a completed run is not necessarily a pass, and QA readiness still comes from the
 * synced reports, never from this status.
 */
export type RemoteRunState = 'queued' | 'runner-unavailable' | 'running' | 'blocked' | 'completed';

export interface RemoteRunStatus {
  state: RemoteRunState;
  /** Only for `completed`. */
  conclusion?: string;
  /** One line saying why this state was chosen, including when it is a guess. */
  detail: string;
}

/** How long a job may wait for a runner before it is shown as "runner unavailable" rather than "queued". */
export const RUNNER_WAIT_MS = 5 * 60 * 1000;

const time = (value: unknown): number | undefined => {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? undefined : parsed;
};

/**
 * Maps a GitHub Actions run and its jobs (the `jobs` array from `actions/runs/{id}/jobs`) to exactly one state, first
 * match wins:
 *
 * 1. Run `completed`: `action_required` is `blocked` (GitHub is waiting for someone to approve it); anything else is
 *    `completed` with that conclusion.
 * 2. Run or any job `waiting`: `blocked`. GitHub uses this while an environment protection rule (required reviewers, a
 *    wait timer) or a concurrency group holds the job. Which of those it is cannot be told from the run or jobs alone.
 * 3. Any job `in_progress`: `running`.
 * 4. Some job `queued` (or `pending`) with no runner assigned for longer than {@link RUNNER_WAIT_MS}: `runner-unavailable`;
 *    for less: `queued`.
 * 5. Run `in_progress` with no job information: `running`. Otherwise (`queued`, `requested`, `pending`, or a status this
 *    code does not know): `queued`.
 *
 * Limits of the runner-unavailable rule: it is a time heuristic. GitHub does not report "no runner matches these
 * labels" or "all matching runners are busy"; both look like a job that is queued with no runner. A hosted runner that
 * is merely slow to start (a busy day, a large runner pool) also crosses the threshold, and a self-hosted runner that
 * comes online later starts the job and clears the state. The job's `labels` are named in the detail so a person can
 * judge. Listing the repository's runners would need admin rights, so it is not attempted.
 */
export function remoteRunStatus(runInput: unknown, jobsInput: unknown, now: Date = new Date(), waitMs: number = RUNNER_WAIT_MS): RemoteRunStatus {
  const run = record(runInput) ?? {};
  const jobs = (Array.isArray(jobsInput) ? jobsInput : []).flatMap((job) => { const item = record(job); return item === undefined ? [] : [item]; });
  const status = run.status;
  const conclusion = typeof run.conclusion === 'string' ? run.conclusion : undefined;

  if (status === 'completed') {
    if (conclusion === 'action_required') return { state: 'blocked', detail: 'GitHub needs someone to approve this run before it can start.' };
    return { state: 'completed', conclusion: conclusion ?? 'unknown', detail: `Finished: ${conclusion ?? 'no conclusion reported'}.` };
  }
  const waiting = status === 'waiting' || jobs.some((job) => job.status === 'waiting');
  if (waiting) return { state: 'blocked', detail: 'Waiting for approval or a protection rule (for example a required reviewer on an environment), or for a concurrency group to free up.' };
  if (jobs.some((job) => job.status === 'in_progress')) return { state: 'running', detail: 'A job is executing on a runner.' };

  const queued = jobs.filter((job) => (job.status === 'queued' || job.status === 'pending') && job.runner_id == null && job.runner_name == null);
  if (queued.length > 0) {
    const started = Math.min(...queued.map((job) => time(job.created_at) ?? time(run.created_at) ?? now.getTime()));
    const waited = now.getTime() - started;
    if (waited >= waitMs) {
      const labels = [...new Set(queued.flatMap((job) => (Array.isArray(job.labels) ? job.labels.filter((label): label is string => typeof label === 'string') : [])))];
      return {
        state: 'runner-unavailable',
        detail: `No runner has picked up a job for ${Math.floor(waited / 60000)} minutes${labels.length > 0 ? ` (needs: ${labels.join(', ')})` : ''}. This is a guess from waiting time: the runner may be busy, missing or just slow to start.`,
      };
    }
    return { state: 'queued', detail: 'Waiting for a runner to pick up the job.' };
  }
  if (jobs.some((job) => job.status === 'queued' || job.status === 'pending')) return { state: 'running', detail: 'A job has been assigned a runner and is starting.' };
  if (status === 'in_progress') return { state: 'running', detail: 'The run is in progress.' };
  if (status === 'queued' || status === 'requested' || status === 'pending') return { state: 'queued', detail: 'The run is queued; GitHub has not created its jobs yet.' };
  return { state: 'queued', detail: `GitHub reported the status "${String(status)}", which is not one this tool knows; shown as queued.` };
}

export interface RemoteRun extends SuiteRunRequest {
  runId: number;
  attempt: number;
  url: string;
  createdAt: string;
  status: RemoteRunStatus;
}

export type RemoteRunList = { ok: true; runs: RemoteRun[] } | { ok: false; error: string };

/** Older runs than this many per pull request are not listed; enough to see the current and recent attempts. */
const MAX_RUNS = 10;

/**
 * Lists this pull request's remote runs from GitHub: the workflow's `workflow_dispatch` runs on the default branch whose
 * title names this pull request. Nothing is read from local state, so a restarted app shows the same runs. A title alone
 * is not proof of who dispatched it (any writer can dispatch the workflow), so the list is a status view, not evidence:
 * results still count only when their reports have been synced and accepted by the gate.
 */
export async function listSuiteRuns(repository: string, workflow: string, prNumber: number, api: GitHubApi, now: Date = new Date()): Promise<RemoteRunList> {
  if (!repositoryName.test(repository) || !workflowFile.test(workflow) || !Number.isSafeInteger(prNumber) || prNumber <= 0) return { ok: false, error: 'invalid repository, workflow or pull request' };
  try {
    const info = await api.get(`repos/${repository}`);
    if (!info.ok) return { ok: false, error: info.reason };
    const defaultBranch = record(info.value)?.default_branch;
    const repositoryId = record(info.value)?.id;
    if (typeof defaultBranch !== 'string') return { ok: false, error: 'cannot identify the trusted default branch' };
    const listed = await api.get(`repos/${repository}/actions/workflows/${workflow}/runs?event=workflow_dispatch&branch=${encodeURIComponent(defaultBranch)}&per_page=100`);
    if (!listed.ok) return { ok: false, error: listed.reason };
    const entries = Array.isArray(record(listed.value)?.workflow_runs) ? (record(listed.value)!.workflow_runs as unknown[]) : [];
    const wanted = entries.flatMap((entry) => {
      const run = record(entry);
      const named = parseRemoteRunTitle(run?.display_title);
      if (run === undefined || named === undefined || named.prNumber !== prNumber) return [];
      if (run.path !== workflowPath(workflow) || run.event !== 'workflow_dispatch' || run.head_branch !== defaultBranch || record(run.repository)?.id !== repositoryId) return [];
      if (typeof run.id !== 'number' || !Number.isSafeInteger(run.id) || typeof run.created_at !== 'string') return [];
      return [{ run, named, id: run.id, createdAt: run.created_at }];
    });
    wanted.sort((a, b) => (time(b.createdAt) ?? 0) - (time(a.createdAt) ?? 0));
    const runs: RemoteRun[] = [];
    for (const { run, named, id, createdAt } of wanted.slice(0, MAX_RUNS)) {
      let jobs: unknown[] = [];
      // Jobs decide queued vs. running vs. runner-unavailable; a completed run needs no job read.
      if (run.status !== 'completed') {
        const response = await api.get(`repos/${repository}/actions/runs/${id}/jobs?per_page=100`);
        if (!response.ok) return { ok: false, error: response.reason };
        jobs = Array.isArray(record(response.value)?.jobs) ? (record(response.value)!.jobs as unknown[]) : [];
      }
      runs.push({
        ...named,
        runId: id,
        attempt: typeof run.run_attempt === 'number' ? run.run_attempt : 1,
        url: `https://github.com/${repository}/actions/runs/${id}`,
        createdAt,
        status: remoteRunStatus(run, jobs, now),
      });
    }
    return { ok: true, runs };
  } catch {
    return { ok: false, error: 'network-error' };
  }
}
