import { describe, expect, test } from 'vitest';
import { dispatchSuiteRun, listSuiteRuns, parseRemoteRunTitle, remoteRunStatus, remoteRunTitle, RUNNER_WAIT_MS, type SuiteRunDispatchApi, type SuiteRunRequest } from '../../src/github/remote-run.ts';

const HEAD = 'a'.repeat(40);
const TRUNK = 'b'.repeat(40);
const request: SuiteRunRequest = { prNumber: 7, candidateId: 'cand-1', profile: 'linux', suite: 'release', expectedHead: HEAD };
const NOW = new Date('2026-09-30T12:00:00Z');
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

describe('remoteRunStatus', () => {
  const run = (changes: Record<string, unknown> = {}) => ({ status: 'queued', conclusion: null, created_at: ago(1000), ...changes });
  const job = (changes: Record<string, unknown> = {}) => ({ status: 'queued', conclusion: null, runner_id: null, runner_name: null, labels: ['ubuntu-24.04'], created_at: ago(1000), ...changes });

  test('a run that has only just been queued is queued', () => {
    expect(remoteRunStatus(run(), [job()], NOW).state).toBe('queued');
  });

  test('a run with no jobs yet is queued, whatever its age, because nothing says a runner is missing', () => {
    expect(remoteRunStatus(run({ created_at: ago(RUNNER_WAIT_MS * 3) }), [], NOW).state).toBe('queued');
  });

  test('a job with no runner after the wait threshold is runner-unavailable and names the labels it needs', () => {
    const status = remoteRunStatus(run(), [job({ created_at: ago(RUNNER_WAIT_MS + 1000), labels: ['self-hosted', 'linux-gpu'] })], NOW);
    expect(status.state).toBe('runner-unavailable');
    expect(status.detail).toContain('self-hosted, linux-gpu');
    expect(status.detail).toContain('guess');
  });

  test('the threshold is the boundary between queued and runner-unavailable', () => {
    expect(remoteRunStatus(run(), [job({ created_at: ago(RUNNER_WAIT_MS - 1) })], NOW).state).toBe('queued');
    expect(remoteRunStatus(run(), [job({ created_at: ago(RUNNER_WAIT_MS) })], NOW).state).toBe('runner-unavailable');
  });

  test('a job that has a runner is not counted as waiting for one', () => {
    const status = remoteRunStatus(run({ status: 'in_progress' }), [job({ runner_id: 9, runner_name: 'GitHub Actions 3', created_at: ago(RUNNER_WAIT_MS * 2) })], NOW);
    expect(status.state).toBe('running');
  });

  test('a job in progress means running, even while another job still waits', () => {
    expect(remoteRunStatus(run({ status: 'in_progress' }), [job({ status: 'in_progress', runner_id: 1 }), job({ created_at: ago(RUNNER_WAIT_MS * 2) })], NOW).state).toBe('running');
  });

  test('an in-progress run with no job information is running', () => {
    expect(remoteRunStatus(run({ status: 'in_progress' }), [], NOW).state).toBe('running');
  });

  test('a run waiting for approval or an environment is blocked, not queued', () => {
    expect(remoteRunStatus(run({ status: 'waiting' }), [], NOW).state).toBe('blocked');
    expect(remoteRunStatus(run({ status: 'queued' }), [job({ status: 'waiting' })], NOW).state).toBe('blocked');
  });

  test('a finished run that needs action is blocked', () => {
    expect(remoteRunStatus(run({ status: 'completed', conclusion: 'action_required' }), [], NOW).state).toBe('blocked');
  });

  test.each(['success', 'failure', 'cancelled', 'timed_out', 'skipped'])('a finished run is completed with its conclusion %s', (conclusion) => {
    expect(remoteRunStatus(run({ status: 'completed', conclusion }), [], NOW)).toMatchObject({ state: 'completed', conclusion });
  });

  test('a status GitHub adds later is shown as queued with a saying so, not invented', () => {
    const status = remoteRunStatus(run({ status: 'hovering' }), [], NOW);
    expect(status.state).toBe('queued');
    expect(status.detail).toContain('hovering');
  });

  test('unusable input still yields exactly one state', () => {
    expect(remoteRunStatus(null, 'nope', NOW).state).toBe('queued');
  });
});

describe('the run title', () => {
  test('round-trips, and only that exact shape is accepted', () => {
    expect(remoteRunTitle(request)).toBe(`qa-run PR #7 cand-1 linux/release ${HEAD}`);
    expect(parseRemoteRunTitle(remoteRunTitle(request))).toEqual(request);
    for (const bad of ['qa-prepare PR #7 x', `qa-run PR #0 cand-1 linux/release ${HEAD}`, `qa-run PR #7 cand-1 linux/release main`, `qa-run PR #7 cand-1 linux/release ${HEAD} extra`, undefined, 5]) {
      expect(parseRemoteRunTitle(bad)).toBeUndefined();
    }
  });
});

interface Calls { gets: string[]; posts: Array<{ path: string; body: unknown }> }
function dispatchApi(overrides: Record<string, unknown> = {}, post?: { ok: false; reason: 'network-error' } | { ok: true; value: unknown }): SuiteRunDispatchApi & Calls {
  const goodRun = { id: 99, path: '.github/workflows/qa-run.yml', event: 'workflow_dispatch', display_title: remoteRunTitle(request), head_sha: TRUNK, repository: { id: 1 } };
  const table: Record<string, unknown> = {
    'repos/acme/app': { id: 1, default_branch: 'main', permissions: { pull: true, push: true } },
    'repos/acme/app/pulls/7': { state: 'open', head: { sha: HEAD } },
    'repos/acme/app/branches/main': { commit: { sha: TRUNK } },
    'repos/acme/app/actions/runs/99': goodRun,
    ...overrides,
  };
  const calls: Calls = { gets: [], posts: [] };
  return Object.assign(calls, {
    auth: async () => ({ ok: true as const, value: true as const }),
    get: async (path: string) => { calls.gets.push(path); return path in table ? { ok: true as const, value: table[path] } : { ok: false as const, reason: 'not-found' as const }; },
    post: async (path: string, body: unknown) => { calls.posts.push({ path, body }); return post ?? { ok: true as const, value: { workflow_run_id: 99 } }; },
  });
}
const dispatch = (api: SuiteRunDispatchApi, changes: Partial<SuiteRunRequest> = {}) => dispatchSuiteRun('acme/app', 'qa-run.yml', { ...request, ...changes }, api, { retryDelayMs: 0 });

describe('dispatchSuiteRun', () => {
  test('dispatches from the default branch with the reviewed inputs and verifies the returned run', async () => {
    const api = dispatchApi();
    const result = await dispatch(api);
    expect(result).toEqual({ ok: true, runId: 99, workflowHeadSha: TRUNK, url: 'https://github.com/acme/app/actions/runs/99' });
    expect(api.posts).toEqual([{
      path: 'repos/acme/app/actions/workflows/qa-run.yml/dispatches',
      body: { ref: 'main', return_run_details: true, inputs: { pr_number: '7', candidate_id: 'cand-1', profile: 'linux', suite: 'release', expected_head: HEAD } },
    }]);
  });

  test.each([
    ['a bad head', { expectedHead: 'main' }],
    ['a bad candidate id', { candidateId: 'x y' }],
    ['a profile that is a path', { profile: '../linux' }],
    ['a pull request number of zero', { prNumber: 0 }],
  ])('refuses %s without contacting GitHub', async (_name, changes) => {
    const api = dispatchApi();
    expect((await dispatch(api, changes)).ok).toBe(false);
    expect(api.gets).toEqual([]);
    expect(api.posts).toEqual([]);
  });

  test('refuses a workflow name that is a path', async () => {
    const api = dispatchApi();
    expect((await dispatchSuiteRun('acme/app', '../qa-run.yml', request, api)).ok).toBe(false);
    expect(api.posts).toEqual([]);
  });

  test('refuses read-only access, and dispatches nothing', async () => {
    const api = dispatchApi({ 'repos/acme/app': { id: 1, default_branch: 'main', permissions: { pull: true } } });
    expect(await dispatch(api)).toMatchObject({ ok: false, error: expect.stringContaining('write access') });
    expect(api.posts).toEqual([]);
  });

  test('refuses when the pull request head moved or it is closed', async () => {
    const moved = dispatchApi({ 'repos/acme/app/pulls/7': { state: 'open', head: { sha: 'c'.repeat(40) } } });
    expect(await dispatch(moved)).toMatchObject({ ok: false, error: expect.stringContaining('no longer matches') });
    expect(moved.posts).toEqual([]);
    const closed = dispatchApi({ 'repos/acme/app/pulls/7': { state: 'closed', head: { sha: HEAD } } });
    expect((await dispatch(closed)).ok).toBe(false);
  });

  test('reports a refused dispatch', async () => {
    const result = await dispatch(dispatchApi({}, { ok: false, reason: 'network-error' }));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('dispatch failed') });
  });

  test('a reply with no run id is not trusted', async () => {
    expect(await dispatch(dispatchApi({}, { ok: true, value: {} }))).toMatchObject({ ok: false, error: expect.stringContaining('run ID') });
  });

  test.each([
    ['another workflow file', { path: '.github/workflows/other.yml' }],
    ['another event', { event: 'push' }],
    ['a title for another head', { display_title: remoteRunTitle({ ...request, expectedHead: 'c'.repeat(40) }) }],
    ['another repository', { repository: { id: 2 } }],
  ])('a run from %s is rejected, and the run id is still reported so a retry does not start a second', async (_name, changes) => {
    const good = { id: 99, path: '.github/workflows/qa-run.yml', event: 'workflow_dispatch', display_title: remoteRunTitle(request), head_sha: TRUNK, repository: { id: 1 } };
    const result = await dispatch(dispatchApi({ 'repos/acme/app/actions/runs/99': { ...good, ...changes } }));
    expect(result).toMatchObject({ ok: false, runId: 99 });
  });

  test('a run that used a different workflow revision is rejected', async () => {
    const good = { id: 99, path: '.github/workflows/qa-run.yml', event: 'workflow_dispatch', display_title: remoteRunTitle(request), head_sha: 'c'.repeat(40), repository: { id: 1 } };
    expect(await dispatch(dispatchApi({ 'repos/acme/app/actions/runs/99': good }))).toMatchObject({ ok: false, runId: 99, error: expect.stringContaining('different workflow revision') });
  });
});

describe('listSuiteRuns', () => {
  const entry = (id: number, changes: Record<string, unknown> = {}) => ({
    id, run_attempt: 1, path: '.github/workflows/qa-run.yml', event: 'workflow_dispatch', head_branch: 'main', repository: { id: 1 },
    display_title: remoteRunTitle(request), status: 'queued', conclusion: null, created_at: ago(id * 1000), ...changes,
  });
  const listing = (runs: unknown[], extra: Record<string, unknown> = {}) => ({
    'repos/acme/app': { id: 1, default_branch: 'main' },
    'repos/acme/app/actions/workflows/qa-run.yml/runs?event=workflow_dispatch&branch=main&per_page=100': { workflow_runs: runs },
    ...extra,
  });
  const apiFor = (table: Record<string, unknown>) => ({
    auth: async () => ({ ok: true as const, value: true as const }),
    get: async (path: string) => (path in table ? { ok: true as const, value: table[path] } : { ok: false as const, reason: 'not-found' as const }),
  });

  test('lists this pull request\'s runs newest first, each with its own state, and ignores everything else', async () => {
    const api = apiFor(listing(
      [
        entry(3, { status: 'completed', conclusion: 'success' }),
        entry(2, { status: 'in_progress' }),
        entry(4, { display_title: remoteRunTitle({ ...request, prNumber: 8 }) }),
        entry(5, { head_branch: 'feature' }),
        entry(6, { path: '.github/workflows/other.yml' }),
        entry(7, { repository: { id: 2 } }),
        entry(8, { display_title: 'something else' }),
      ],
      { 'repos/acme/app/actions/runs/2/jobs?per_page=100': { jobs: [{ status: 'in_progress', runner_id: 4 }] } },
    ));
    const result = await listSuiteRuns('acme/app', 'qa-run.yml', 7, api, NOW);
    expect(result.ok && result.runs.map((item) => [item.runId, item.status.state])).toEqual([[2, 'running'], [3, 'completed']]);
    expect(result.ok && result.runs[0]).toMatchObject({ candidateId: 'cand-1', profile: 'linux', suite: 'release', expectedHead: HEAD, url: 'https://github.com/acme/app/actions/runs/2' });
  });

  test('reads jobs to tell a queued run from a stuck one', async () => {
    const api = apiFor(listing([entry(1)], { 'repos/acme/app/actions/runs/1/jobs?per_page=100': { jobs: [{ status: 'queued', runner_id: null, runner_name: null, labels: ['ubuntu-24.04'], created_at: ago(RUNNER_WAIT_MS * 2) }] } }));
    const result = await listSuiteRuns('acme/app', 'qa-run.yml', 7, api, NOW);
    expect(result.ok && result.runs[0]?.status.state).toBe('runner-unavailable');
  });

  test('a repository or workflow that cannot be read is an error, not an empty list', async () => {
    expect(await listSuiteRuns('acme/app', 'qa-run.yml', 7, apiFor({}), NOW)).toEqual({ ok: false, error: 'not-found' });
    expect(await listSuiteRuns('acme/app', 'qa-run.yml', 7, apiFor({ 'repos/acme/app': { id: 1, default_branch: 'main' } }), NOW)).toEqual({ ok: false, error: 'not-found' });
  });

  test('a failed job read is an error too, so a run is never shown with a guessed state', async () => {
    const api = apiFor(listing([entry(1)]));
    expect(await listSuiteRuns('acme/app', 'qa-run.yml', 7, api, NOW)).toEqual({ ok: false, error: 'not-found' });
  });
});
