import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, test } from 'vitest';
import App from '../src/renderer/App.vue';
import Run from '../src/renderer/views/Run.vue';
import type { QaBridge, RunStatus } from '../src/shared/contract.ts';
import { done, evaluation, fakeBridge, projectView, pull, runEntry, runPreview, runningStatus, snapshot } from './fixtures.ts';

const HEAD = 'a'.repeat(40);
const ready = { status: 'ready' as const, path: 'C:\\work\\app' };
const passed = () => pull({ gate: { status: 'evaluated', evaluation: evaluation({ readiness: 'passed' }), candidateId: 'cand-1', candidateReleaseId: 50 } });

async function open(overrides: Partial<QaBridge> = {}, options: { project?: Parameters<typeof projectView>[0]; pullRequest?: ReturnType<typeof pull> } = {}) {
  const qa = fakeBridge({ getCheckout: async () => ready, ...overrides });
  const wrapper = mount(Run, { props: { project: projectView(options.project), pullRequest: options.pullRequest ?? passed(), qa } });
  await flushPromises();
  return { wrapper, qa };
}
const calls = (qa: ReturnType<typeof fakeBridge>, name: string) => qa.calls.filter((call) => call.name === name);

describe('starting a run', () => {
  test('shows the candidate, environment, test root and consequence first, and installs only after confirmation', async () => {
    let status: RunStatus = { state: 'idle' };
    const { wrapper, qa } = await open({ previewRun: async () => runPreview(), startRun: async () => { status = runningStatus(); return done('Started release on windows for candidate cand-1.'); }, getRunStatus: async () => status });
    await wrapper.get('[data-test="review-run"]').trigger('click');
    await flushPromises();
    expect(calls(qa, 'previewRun')[0]?.args).toEqual([{ repository: 'acme/app', number: 7, headSha: HEAD, profile: 'windows', suite: 'release' }]);
    expect(wrapper.get('[data-test="confirm-candidate"]').text()).toContain('cand-1');
    expect(wrapper.get('[data-test="confirm-target"]').text()).toContain('1 automated scenario');
    expect(wrapper.get('[data-test="confirm-consequence"]').text()).toContain('installs the candidate and launches it on this computer');
    expect(wrapper.get('[data-test="confirm-consequence"]').text()).toContain('C:\\work\\app\\.release-qa');
    expect(calls(qa, 'startRun')).toHaveLength(0);

    await wrapper.get('[data-test="confirm-run-go"]').trigger('click');
    await flushPromises();
    // What was shown goes back so the privileged side can refuse if it changed.
    expect(calls(qa, 'startRun')[0]?.args[0]).toMatchObject({ candidateId: 'cand-1', root: 'C:\\work\\app\\.release-qa', profile: 'windows', suite: 'release' });
    expect(wrapper.find('[data-test="confirm-run"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="run-notice"]').text()).toContain('Started');
    expect(wrapper.get('[data-test="run-status"]').attributes('data-state')).toBe('running');
  });

  test('cancelling the review starts nothing', async () => {
    const { wrapper, qa } = await open({ previewRun: async () => runPreview() });
    await wrapper.get('[data-test="review-run"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="cancel-run"]').trigger('click');
    expect(wrapper.find('[data-test="confirm-run"]').exists()).toBe(false);
    expect(calls(qa, 'startRun')).toHaveLength(0);
  });

  test('a refusal is shown and nothing is confirmed', async () => {
    const { wrapper } = await open({ previewRun: async () => ({ ok: false, error: 'The test root has not been designated.' }) });
    await wrapper.get('[data-test="review-run"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="run-error"]').text()).toContain('designated');
    expect(wrapper.find('[data-test="confirm-run"]').exists()).toBe(false);
  });

  test('a refusal at confirmation is shown and the review stays open', async () => {
    const { wrapper } = await open({ previewRun: async () => runPreview(), startRun: async () => ({ ok: false, error: 'The active candidate is now cand-2.' }) });
    await wrapper.get('[data-test="review-run"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="confirm-run-go"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="run-error"]').text()).toContain('cand-2');
  });
});

describe('what blocks a run', () => {
  test('a read-only user cannot run or sync, and the bridge is not called', async () => {
    const { wrapper, qa } = await open({ listRuns: async () => ({ ok: true, runs: [runEntry()] }) }, { project: { role: 'read', readOnly: true } });
    expect(wrapper.get('[data-test="review-run"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="sync"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-test="review-run"]').trigger('click');
    await wrapper.get('[data-test="sync"]').trigger('click');
    expect(calls(qa, 'previewRun')).toHaveLength(0);
    expect(calls(qa, 'syncRun')).toHaveLength(0);
  });

  test('without an active candidate nothing can run and the reason is shown', async () => {
    const { releaseIntent: _unknown, ...unavailable } = pull({ gate: { status: 'unavailable', error: 'no active candidate selected' } });
    const { wrapper } = await open({}, { pullRequest: unavailable });
    expect(wrapper.get('[data-test="review-run"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="run-no-candidate"]').text()).toContain('Prepare one');
  });

  test('without a checkout nothing can run, and choosing one uses the folder dialog owned by the main process', async () => {
    const { wrapper, qa } = await open({ getCheckout: async () => ({ status: 'none' }), chooseCheckout: async () => ready });
    expect(wrapper.get('[data-test="review-run"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="run-block"]').text()).toContain('Choose a local checkout');
    await wrapper.get('[data-test="choose-checkout"]').trigger('click');
    await flushPromises();
    expect(calls(qa, 'chooseCheckout')[0]?.args).toEqual(['acme/app']);
    expect(wrapper.get('[data-test="checkout-ready"]').text()).toContain('C:\\work\\app');
    expect(wrapper.get('[data-test="review-run"]').attributes('disabled')).toBeUndefined();
  });

  test('an unusable checkout is shown with why', async () => {
    const { wrapper } = await open({ getCheckout: async () => ({ status: 'invalid', path: 'C:\\x', error: 'does not hold a usable qa/project.json' }) });
    expect(wrapper.get('[data-test="checkout-invalid"]').text()).toContain('usable qa/project.json');
    expect(wrapper.get('[data-test="review-run"]').attributes('disabled')).toBeDefined();
  });

  test('while a run is under way another cannot start, and it can be stopped', async () => {
    const { wrapper, qa } = await open({ getRunStatus: async () => runningStatus({ progress: [{ scenario: 'windows/persistence', phase: 'steps', status: 'started' }] }), cancelRun: async () => done('Stopping after the current step; cleanup still runs.') });
    expect(wrapper.get('[data-test="review-run"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="progress-line"]').text()).toContain('windows/persistence: steps started');
    await wrapper.get('[data-test="stop-run"]').trigger('click');
    expect(calls(qa, 'cancelRun')).toHaveLength(1);
  });

  test('a run of another pull request is labelled as such', async () => {
    const { wrapper } = await open({ getRunStatus: async () => runningStatus({ number: 9 }) });
    expect(wrapper.find('[data-test="other-run"]').exists()).toBe(true);
  });
});

describe('following a run', () => {
  test('a status pushed from the main process replaces what is shown, and the listener is removed on leaving', async () => {
    const { wrapper, qa } = await open();
    expect(wrapper.find('[data-test="run-status"]').exists()).toBe(false);
    qa.emitStatus(runningStatus());
    await flushPromises();
    expect(wrapper.get('[data-test="run-status"]').attributes('data-state')).toBe('running');
    qa.emitStatus({ ...runningStatus(), state: 'finished', message: 'Finished: every automated scenario passed.', exitCode: 0, results: [{ requirement: 'windows/persistence', outcome: 'passed' }] });
    await flushPromises();
    expect(wrapper.get('[data-test="run-message"]').text()).toContain('every automated scenario passed');
    expect(wrapper.get('[data-test="run-result"]').text()).toContain('Passed');
    wrapper.unmount();
    expect(qa.listeners).toBe(0);
  });

  test('a failed run is an alert, not a success', async () => {
    const { wrapper } = await open({ getRunStatus: async () => ({ ...runningStatus(), state: 'failed', message: 'The run stopped: disk full' }) });
    expect(wrapper.get('[data-test="run-message"]').attributes('role')).toBe('alert');
  });
});

describe('local runs, resume and sync', () => {
  test('a run with events only on this machine says it is not synced, and syncing tells the dashboard GitHub changed', async () => {
    let entries = [runEntry({ pending: 3 })];
    const { wrapper, qa } = await open({
      listRuns: async () => ({ ok: true, runs: entries }),
      syncRun: async () => { entries = [runEntry({ pending: 0 })]; return done('Synced run: 3 files uploaded.'); },
    });
    expect(wrapper.get('[data-test="sync-state"]').text()).toContain('Not synced: 3 events exist only on this machine');
    await wrapper.get('[data-test="sync"]').trigger('click');
    await flushPromises();
    expect(calls(qa, 'syncRun')[0]?.args).toEqual([{ repository: 'acme/app', number: 7, headSha: HEAD, runId: 'run-20260930T101010Z-0a1b2c' }]);
    expect(wrapper.get('[data-test="sync-state"]').text()).toBe('Synced');
    expect(wrapper.emitted('done')?.[0]).toEqual(['Synced run: 3 files uploaded.']);
  });

  test('a failed upload stays beside the run, the state is read again, and an uncertain one refreshes GitHub data', async () => {
    let reads = 0;
    const { wrapper } = await open({
      listRuns: async () => { reads += 1; return { ok: true, runs: [runEntry({ pending: 3 })] }; },
      syncRun: async () => ({ ok: false, error: 'Not synced: GitHub could not be reached. Your local results are kept.', uncertain: true }),
    });
    const before = reads;
    await wrapper.get('[data-test="sync"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="sync-error"]').text()).toContain('local results are kept');
    expect(wrapper.get('[data-test="sync-state"]').text()).toContain('Not synced');
    expect(reads).toBeGreaterThan(before);
    expect(wrapper.emitted('done')).toHaveLength(1);
  });

  test('a run with nothing recorded cannot be synced, and a finished one cannot be resumed', async () => {
    const { wrapper } = await open({ listRuns: async () => ({ ok: true, runs: [runEntry({ attempts: 0, pending: 0, results: [] })] }) });
    expect(wrapper.get('[data-test="sync"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="resume"]').attributes('disabled')).toBeDefined();
  });

  test('resume repeats the environment and suite of the run, whatever the pickers say, and shows the consequence first', async () => {
    const { wrapper, qa } = await open({
      listRuns: async () => ({ ok: true, runs: [runEntry({ resumable: true, profile: 'linux', suite: 'nightly' })] }),
      previewRun: async () => runPreview({ resumes: 'run-20260930T101010Z-0a1b2c', profile: 'linux', suite: 'nightly' }),
      startRun: async () => done('Resuming.'),
    });
    await wrapper.get('[data-test="resume"]').trigger('click');
    await flushPromises();
    expect(calls(qa, 'previewRun')[0]?.args[0]).toMatchObject({ profile: 'linux', suite: 'nightly', runId: 'run-20260930T101010Z-0a1b2c' });
    expect(wrapper.get('[data-test="confirm-run"]').text()).toContain('Resume run-20260930T101010Z-0a1b2c?');
    expect(wrapper.get('[data-test="confirm-consequence"]').text()).toContain('launches it on this computer');
    expect(calls(qa, 'startRun')).toHaveLength(0);
    await wrapper.get('[data-test="confirm-run-go"]').trigger('click');
    await flushPromises();
    expect(calls(qa, 'startRun')[0]?.args[0]).toMatchObject({ runId: 'run-20260930T101010Z-0a1b2c', profile: 'linux', suite: 'nightly' });
  });

  test('a local run whose journal is damaged shows why', async () => {
    const { wrapper } = await open({ listRuns: async () => ({ ok: true, runs: [runEntry({ resumable: false, problem: 'the journal is damaged or inconsistent' })] }) });
    expect(wrapper.get('[data-test="run-problem"]').text()).toContain('damaged');
    expect(wrapper.get('[data-test="sync"]').attributes('disabled')).toBeDefined();
  });

  test('local runs that cannot be read are reported, not shown as none', async () => {
    const { wrapper } = await open({ listRuns: async () => { throw new Error('ipc'); } });
    expect(wrapper.get('[data-test="runs-error"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="no-runs"]').exists()).toBe(false);
  });
});

describe('inside the dashboard', () => {
  test('the Run page is reached from the release and its Back returns there', async () => {
    const qa = fakeBridge({ loadDashboard: async () => snapshot({ projects: [projectView({ pullRequests: { status: 'ok', items: [passed()] } })] }), getCheckout: async () => ready });
    const wrapper = mount(App, { props: { qa } });
    await flushPromises();
    await wrapper.get('[data-test="open-acme/app-7"]').trigger('click');
    await wrapper.get('[data-test="open-run"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="run"]').exists()).toBe(true);
    await wrapper.get('[data-test="run-back"]').trigger('click');
    expect(wrapper.find('[data-test="run"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="open-run"]').exists()).toBe(true);
  });
});
