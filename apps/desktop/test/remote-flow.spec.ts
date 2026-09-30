import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import App from '../src/renderer/App.vue';
import type { DashboardSnapshot, QaBridge, RemoteRunState, RemoteRunView, RemoteRunsResult } from '../src/shared/contract.ts';
import { done, evaluation, fakeBridge, projectView, pull, snapshot } from './fixtures.ts';

const HEAD = 'a'.repeat(40);
const remoteRun = { workflow: 'qa-run.yml', options: [{ profile: 'linux', suite: 'release' }] };
const withCandidate = (item = pull({ gate: { status: 'evaluated', evaluation: evaluation({ readiness: 'blocked' }), candidateId: 'cand-1', candidateReleaseId: 50 } }), project: Parameters<typeof projectView>[0] = {}) =>
  snapshot({ projects: [projectView({ remoteRun, pullRequests: { status: 'ok', items: [item] }, ...project })] });
const run = (runId: number, state: RemoteRunState, changes: Partial<RemoteRunView> = {}): RemoteRunView => ({
  runId, attempt: 1, url: `https://github.com/acme/app/actions/runs/${runId}`, createdAt: '2026-09-30T11:00:00Z', candidateId: 'cand-1', profile: 'linux', suite: 'release', headSha: HEAD, state, detail: `detail-${state}`, ...changes,
});
const listed = (runs: RemoteRunView[]): RemoteRunsResult => ({ ok: true, configured: true, runs });

async function view(data: DashboardSnapshot, overrides: Partial<QaBridge> = {}) {
  const qa = fakeBridge({ loadDashboard: async () => data, ...overrides });
  const wrapper = mount(App, { props: { qa } });
  await flushPromises();
  await wrapper.get('[data-test="open-acme/app-7"]').trigger('click');
  await flushPromises();
  return { wrapper, qa };
}
const calls = (qa: ReturnType<typeof fakeBridge>, name: string) => qa.calls.filter((call) => call.name === name);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('Run on Linux', () => {
  test('shows the candidate, profile, suite, head and consequences first, and starts only after confirmation', async () => {
    const { wrapper, qa } = await view(withCandidate(), { runOnLinux: async () => done('Started release on Linux (linux) for aaaaaaa (workflow run 99).') });
    expect(wrapper.get('[data-test="run-linux"]').attributes('disabled')).toBeUndefined();
    await wrapper.get('[data-test="run-linux"]').trigger('click');
    const panel = wrapper.get('[data-test="confirm-run"]').text();
    expect(panel).toContain('Candidate cand-1, profile linux, suite release, exact head aaaaaaa');
    expect(panel).toContain('qa-run.yml');
    expect(panel).toContain('not on this computer');
    expect(panel).toContain('keeps running if you close this window');
    expect(panel).toContain('Actions minutes');
    expect(calls(qa, 'runOnLinux')).toHaveLength(0);

    await wrapper.get('[data-test="confirm-run-go"]').trigger('click');
    await flushPromises();
    expect(calls(qa, 'runOnLinux')[0]?.args).toEqual([{ repository: 'acme/app', number: 7, headSha: HEAD, candidateId: 'cand-1', profile: 'linux', suite: 'release' }]);
    expect(wrapper.find('[data-test="confirm-run"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="notice"]').text()).toContain('workflow run 99');
  });

  test('starting a run reads the remote runs again straight away', async () => {
    let runs: RemoteRunView[] = [];
    const { wrapper, qa } = await view(withCandidate(), { runOnLinux: async () => { runs = [run(99, 'queued')]; return done('started'); }, listRemoteRuns: async () => listed(runs) });
    expect(wrapper.find('[data-test="remote-none"]').exists()).toBe(true);
    await wrapper.get('[data-test="run-linux"]').trigger('click');
    await wrapper.get('[data-test="confirm-run-go"]').trigger('click');
    await flushPromises();
    expect(calls(qa, 'listRemoteRuns').length).toBeGreaterThanOrEqual(2);
    expect(wrapper.findAll('[data-test="remote-run"]')).toHaveLength(1);
  });

  test('cancel leaves nothing started', async () => {
    const { wrapper, qa } = await view(withCandidate());
    await wrapper.get('[data-test="run-linux"]').trigger('click');
    await wrapper.get('[data-test="cancel"]').trigger('click');
    expect(wrapper.find('[data-test="confirm-run"]').exists()).toBe(false);
    expect(calls(qa, 'runOnLinux')).toHaveLength(0);
  });

  test('a read-only user cannot start a run', async () => {
    const { wrapper, qa } = await view(withCandidate(undefined, { role: 'read', readOnly: true }));
    expect(wrapper.get('[data-test="run-linux"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="run-block"]').text()).toContain('Read-only');
    await wrapper.get('[data-test="run-linux"]').trigger('click');
    expect(wrapper.find('[data-test="confirm-run"]').exists()).toBe(false);
    expect(calls(qa, 'runOnLinux')).toHaveLength(0);
  });

  test('without an active candidate there is nothing to run', async () => {
    const { wrapper } = await view(withCandidate(pull({ gate: { status: 'unavailable', error: 'no active candidate selected' } })));
    expect(wrapper.get('[data-test="run-linux"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="run-block"]').text()).toContain('no active candidate');
  });

  test('a project with no run workflow says so and offers nothing', async () => {
    const { remoteRun: _none, ...plain } = projectView({ pullRequests: { status: 'ok', items: [pull()] } });
    const { wrapper } = await view(snapshot({ projects: [plain] }));
    expect(wrapper.get('[data-test="run-linux"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="run-block"]').text()).toContain('workflows.run');
    expect(wrapper.find('[data-test="remote-runs"]').exists()).toBe(false);
  });

  test('a refused dispatch keeps the confirmation open with the reason', async () => {
    const { wrapper } = await view(withCandidate(), { runOnLinux: async () => ({ ok: false, error: 'Not started: the active candidate is now cand-2, not the cand-1 you were looking at.' }) });
    await wrapper.get('[data-test="run-linux"]').trigger('click');
    await wrapper.get('[data-test="confirm-run-go"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="action-error"]').text()).toContain('cand-2');
    expect(wrapper.find('[data-test="confirm-run"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="notice"]').exists()).toBe(false);
  });

  test('a dispatch that throws says the action could not be completed', async () => {
    const { wrapper } = await view(withCandidate(), { runOnLinux: async () => { throw new Error('ipc'); } });
    await wrapper.get('[data-test="run-linux"]').trigger('click');
    await wrapper.get('[data-test="confirm-run-go"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="action-error"]').text()).toContain('could not be completed');
  });
});

describe('remote runs on GitHub', () => {
  test('each of the five states is drawn distinctly, with its reason', async () => {
    const runs = [run(5, 'completed', { conclusion: 'failure' }), run(4, 'blocked'), run(3, 'runner-unavailable'), run(2, 'running'), run(1, 'queued')];
    const { wrapper } = await view(withCandidate(), { listRemoteRuns: async () => listed(runs) });
    const rows = wrapper.findAll('[data-test="remote-run"]');
    expect(rows.map((row) => row.attributes('data-state'))).toEqual(['completed', 'blocked', 'runner-unavailable', 'running', 'queued']);
    expect(rows.map((row) => row.get('[data-test="remote-state"]').text())).toEqual(['Completed · failure', 'Blocked', 'Runner unavailable', 'Running', 'Queued']);
    expect(rows[2]!.get('[data-test="remote-detail"]').text()).toContain('detail-runner-unavailable');
    expect(new Set(rows.map((row) => row.get('[data-test="remote-state"]').classes().join(' '))).size).toBe(5);
    expect(rows[0]!.text()).toContain('release on linux');
  });

  test('closing and reopening the window shows the same runs, read again from GitHub', async () => {
    const github = [run(9, 'running'), run(8, 'completed', { conclusion: 'success' })];
    const listRemoteRuns = async () => listed(github);
    const first = await view(withCandidate(), { listRemoteRuns });
    const before = first.wrapper.findAll('[data-test="remote-run"]').map((row) => row.text());
    first.wrapper.unmount();
    // A fresh window and a fresh bridge: nothing but GitHub's answer is shared.
    const second = await view(withCandidate(), { listRemoteRuns });
    expect(second.wrapper.findAll('[data-test="remote-run"]').map((row) => row.text())).toEqual(before);
    expect(calls(second.qa, 'listRemoteRuns').length).toBeGreaterThanOrEqual(1);
  });

  test('a run advances on the next poll, and polling stops when the view is closed', async () => {
    let state: RemoteRunState = 'queued';
    const { wrapper, qa } = await view(withCandidate(), { listRemoteRuns: async () => listed([run(1, state)]) });
    expect(wrapper.get('[data-test="remote-state"]').text()).toBe('Queued');
    state = 'running';
    await vi.advanceTimersByTimeAsync(15000);
    expect(wrapper.get('[data-test="remote-state"]').text()).toBe('Running');
    const reads = calls(qa, 'listRemoteRuns').length;
    await wrapper.get('[data-test="back"]').trigger('click');
    await vi.advanceTimersByTimeAsync(60000);
    expect(calls(qa, 'listRemoteRuns').length).toBe(reads);
  });

  test('a runs for another head or candidate is marked as not current', async () => {
    const { wrapper } = await view(withCandidate(), { listRemoteRuns: async () => listed([run(2, 'completed', { conclusion: 'success', headSha: 'b'.repeat(40) }), run(1, 'running', { candidateId: 'cand-0' }), run(3, 'running')]) });
    const stale = wrapper.findAll('[data-test="remote-run"]').map((row) => row.find('[data-test="remote-stale"]').exists());
    expect(stale).toEqual([true, true, false]);
  });

  test('a completed run is never shown as a QA pass', async () => {
    const { wrapper } = await view(withCandidate(), { listRemoteRuns: async () => listed([run(1, 'completed', { conclusion: 'success' })]) });
    expect(wrapper.get('[data-test="remote-runs"]').text()).toContain('not a QA result until its reports are synced');
    expect(wrapper.find('[data-test="readiness"]').text()).toBe('Blocked');
  });

  test('losing access keeps the last runs, marked, and says why', async () => {
    let answer: RemoteRunsResult = listed([run(1, 'running')]);
    const { wrapper } = await view(withCandidate(), { listRemoteRuns: async () => answer });
    answer = { ok: false, error: 'GitHub sign-in has expired. Run "gh auth login", then refresh.' };
    await vi.advanceTimersByTimeAsync(15000);
    expect(wrapper.get('[data-test="remote-error"]').text()).toContain('gh auth login');
    expect(wrapper.get('[data-test="remote-error"]').text()).toContain('last successful read');
    expect(wrapper.findAll('[data-test="remote-run"]')).toHaveLength(1);
    answer = listed([run(1, 'completed', { conclusion: 'success' })]);
    await vi.advanceTimersByTimeAsync(15000);
    expect(wrapper.find('[data-test="remote-error"]').exists()).toBe(false);
  });

  test('a first read that fails is an error, not "no runs"', async () => {
    const { wrapper } = await view(withCandidate(), { listRemoteRuns: async () => ({ ok: false, error: 'GitHub could not be reached.' }) });
    expect(wrapper.get('[data-test="remote-error"]').text()).toContain('could not be reached');
    expect(wrapper.find('[data-test="remote-none"]').exists()).toBe(false);
  });

  test('a bridge that throws is an error too', async () => {
    const { wrapper } = await view(withCandidate(), { listRemoteRuns: async () => { throw new Error('ipc'); } });
    expect(wrapper.get('[data-test="remote-error"]').text()).toContain('could not be read');
  });
});
