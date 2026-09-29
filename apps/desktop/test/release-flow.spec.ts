import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, test } from 'vitest';
import App from '../src/renderer/App.vue';
import type { DashboardSnapshot, QaBridge } from '../src/shared/contract.ts';
import { done, evaluation, fakeBridge, okPreview, projectView, pull, snapshot } from './fixtures.ts';

const HEAD = 'a'.repeat(40);
const passed = (extra: Partial<Parameters<typeof pull>[0]> = {}) => pull({ gate: { status: 'evaluated', evaluation: evaluation({ readiness: 'passed' }), candidateId: 'cand-1', candidateReleaseId: 50 }, ...extra });
const withPull = (item = passed(), project: Parameters<typeof projectView>[0] = {}) => snapshot({ projects: [projectView({ pullRequests: { status: 'ok', items: [item] }, ...project })] });

async function view(data: DashboardSnapshot, overrides: Partial<QaBridge> = {}) {
  const qa = fakeBridge({ loadDashboard: async () => data, ...overrides });
  const wrapper = mount(App, { props: { qa } });
  await flushPromises();
  await wrapper.get('[data-test="open-acme/app-7"]').trigger('click');
  return { wrapper, qa };
}
const calls = (qa: ReturnType<typeof fakeBridge>, name: string) => qa.calls.filter((call) => call.name === name);

describe('what can be started', () => {
  test('a maintainer can prepare, merge and open a release pull request that has passed', async () => {
    const { wrapper } = await view(withPull());
    for (const name of ['prepare', 'merge', 'open-pr']) expect(wrapper.get(`[data-test="${name}"]`).attributes('disabled')).toBeUndefined();
  });

  test('blocked QA disables merge and says why, but preparing a candidate stays possible', async () => {
    const { wrapper, qa } = await view(withPull(pull()));
    expect(wrapper.get('[data-test="merge"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="merge-block"]').text()).toContain('blocked');
    expect(wrapper.get('[data-test="prepare"]').attributes('disabled')).toBeUndefined();
    await wrapper.get('[data-test="merge"]').trigger('click');
    expect(calls(qa, 'previewMerge')).toHaveLength(0);
  });

  test('an unevaluated gate cannot be merged, and is where a candidate is prepared', async () => {
    const { releaseIntent: _unknown, ...unknown } = pull({ gate: { status: 'unavailable', error: 'no active candidate selected' } });
    const { wrapper } = await view(withPull(unknown));
    expect(wrapper.get('[data-test="merge"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="merge-block"]').text()).toContain('unavailable');
    expect(wrapper.get('[data-test="prepare"]').attributes('disabled')).toBeUndefined();
  });

  test('a read-only user can only open the pull request', async () => {
    const { wrapper, qa } = await view(withPull(passed(), { role: 'read', readOnly: true }));
    expect(wrapper.get('[data-test="prepare"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="merge"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="open-pr"]').attributes('disabled')).toBeUndefined();
    await wrapper.get('[data-test="merge"]').trigger('click');
    await wrapper.get('[data-test="prepare"]').trigger('click');
    expect(qa.calls.filter((call) => call.name !== 'loadDashboard')).toEqual([]);
  });

  test('an ordinary pull request cannot have a candidate prepared', async () => {
    const { wrapper } = await view(withPull(passed({ releaseIntent: [] })));
    expect(wrapper.get('[data-test="prepare"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="prepare-block"]').text()).toContain('not a release');
  });
});

describe('merging', () => {
  test('shows the candidate, QA state and consequence first, and merges only after confirmation', async () => {
    const { wrapper, qa } = await view(withPull(), { previewMerge: async () => okPreview(), mergePullRequest: async () => done('Merged #7 as ccccccc.') });
    await wrapper.get('[data-test="merge"]').trigger('click');
    await flushPromises();
    expect(calls(qa, 'previewMerge')[0]?.args).toEqual([{ repository: 'acme/app', number: 7, headSha: HEAD }]);
    const panel = wrapper.get('[data-test="confirm-merge"]').text();
    expect(panel).toContain('Merge #7 into main');
    expect(panel).toContain('QA: Passed at head aaaaaaa, candidate cand-1');
    expect(wrapper.get('[data-test="merge-publishes"]').text()).toContain('authorizes publication');
    // Looking at the consequences changed nothing.
    expect(calls(qa, 'mergePullRequest')).toHaveLength(0);

    // A release is always merged with a merge commit, so there is no method to choose.
    expect(wrapper.find('[data-test="method"]').exists()).toBe(false);
    expect(panel).toContain('saved with the candidate');
    await wrapper.get('[data-test="confirm-merge-go"]').trigger('click');
    await flushPromises();
    expect(calls(qa, 'mergePullRequest')[0]?.args).toEqual([{ repository: 'acme/app', number: 7, headSha: HEAD, method: 'merge', candidateId: 'cand-1' }]);
    expect(wrapper.get('[data-test="notice"]').text()).toBe('Merged #7 as ccccccc.');
    expect(wrapper.find('[data-test="confirm-merge"]').exists()).toBe(false);
    // GitHub changed, so the window read it again, and stayed on the release.
    expect(calls(qa, 'loadDashboard')).toHaveLength(2);
    expect(wrapper.find('[data-test="release"]').exists()).toBe(true);
  });

  test('cancelling merges nothing', async () => {
    const { wrapper, qa } = await view(withPull(), { previewMerge: async () => okPreview() });
    await wrapper.get('[data-test="merge"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="cancel"]').trigger('click');
    expect(wrapper.find('[data-test="confirm-merge"]').exists()).toBe(false);
    expect(calls(qa, 'mergePullRequest')).toHaveLength(0);
  });

  test('an ordinary pull request says it publishes nothing and lets the person choose the method', async () => {
    const ordinary = passed({ releaseIntent: [], gate: { status: 'evaluated', evaluation: evaluation() } });
    const { wrapper, qa } = await view(withPull(ordinary), { previewMerge: async () => okPreview({ publishes: false, releaseIntent: [], candidateId: undefined as never }), mergePullRequest: async () => done() });
    await wrapper.get('[data-test="merge"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="merge-plain"]').text()).toContain('publishes nothing');
    expect(wrapper.find('[data-test="merge-publishes"]').exists()).toBe(false);
    await wrapper.get('[data-test="method"]').setValue('rebase');
    await wrapper.get('[data-test="confirm-merge-go"]').trigger('click');
    await flushPromises();
    expect(calls(qa, 'mergePullRequest')[0]?.args).toMatchObject([{ method: 'rebase' }]);
  });

  test('a push while the confirmation is open blocks the merge and explains it', async () => {
    const { wrapper, qa } = await view(withPull(), { previewMerge: async () => okPreview({ headSha: 'b'.repeat(40) }) });
    await wrapper.get('[data-test="merge"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="drift"]').text()).toContain('now bbbbbbb, not the aaaaaaa');
    expect(wrapper.get('[data-test="confirm-merge-go"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-test="confirm-merge-go"]').trigger('click');
    expect(calls(qa, 'mergePullRequest')).toHaveLength(0);
  });

  test('a candidate replaced while viewing blocks the merge and explains it', async () => {
    const { wrapper, qa } = await view(withPull(), { previewMerge: async () => okPreview({ candidateId: 'cand-2' }) });
    await wrapper.get('[data-test="merge"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="drift"]').text()).toContain('now cand-2, not cand-1');
    expect(calls(qa, 'mergePullRequest')).toHaveLength(0);
  });

  test('a refusal on the privileged side is shown, keeps the panel and does not refresh or claim success', async () => {
    const { wrapper, qa } = await view(withPull(), {
      previewMerge: async () => okPreview(),
      mergePullRequest: async () => ({ ok: false, error: 'Not merged: the pull request changed just before the merge. Refresh and review the new head.' }),
    });
    await wrapper.get('[data-test="merge"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="confirm-merge-go"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="action-error"]').text()).toContain('changed just before the merge');
    expect(wrapper.find('[data-test="notice"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="confirm-merge"]').exists()).toBe(true);
    expect(calls(qa, 'loadDashboard')).toHaveLength(1);
  });

  test('a preview that cannot be read (permission lost) shows why and opens no confirmation', async () => {
    const { wrapper } = await view(withPull(), { previewMerge: async () => ({ ok: false, error: 'Your account does not have write access to this repository.' }) });
    await wrapper.get('[data-test="merge"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="action-error"]').text()).toContain('write access');
    expect(wrapper.find('[data-test="confirm-merge"]').exists()).toBe(false);
  });

  test('an action that throws is reported, not left spinning', async () => {
    const { wrapper } = await view(withPull(), { previewMerge: async () => okPreview(), mergePullRequest: async () => { throw new Error('ipc'); } });
    await wrapper.get('[data-test="merge"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="confirm-merge-go"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="action-error"]').text()).toContain('could not be completed');
    expect(wrapper.get('[data-test="confirm-merge-go"]').attributes('disabled')).toBeUndefined();
  });

  test('a new head arriving with a refresh closes a confirmation left open for the old one', async () => {
    let data = withPull();
    const { wrapper } = await view(data, { loadDashboard: async () => data, previewMerge: async () => okPreview() });
    await wrapper.get('[data-test="merge"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="confirm-merge"]').exists()).toBe(true);
    data = withPull(passed({ headSha: 'b'.repeat(40) }));
    await wrapper.get('[data-test="refresh"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="release"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="confirm-merge"]').exists()).toBe(false);
  });
});

describe('preparing a candidate', () => {
  test('states what it does before it starts, then starts it for the head seen', async () => {
    const { wrapper, qa } = await view(withPull(), { prepareCandidate: async () => ({ ok: true, message: 'Candidate preparation started for aaaaaaa (workflow run 99).' }) });
    await wrapper.get('[data-test="prepare"]').trigger('click');
    const panel = wrapper.get('[data-test="confirm-prepare"]').text();
    expect(panel).toContain('qa-prepare');
    expect(panel).toContain('aaaaaaa');
    expect(panel).toContain('candidate cand-1 will no longer count');
    expect(panel).toContain('Nothing is installed or published');
    expect(calls(qa, 'prepareCandidate')).toHaveLength(0);
    await wrapper.get('[data-test="confirm-prepare-go"]').trigger('click');
    await flushPromises();
    expect(calls(qa, 'prepareCandidate')[0]?.args).toEqual([{ repository: 'acme/app', number: 7, headSha: HEAD }]);
    expect(wrapper.get('[data-test="notice"]').text()).toContain('workflow run 99');
  });

  test('a refusal (head moved, read-only, no release intent) is shown and starts nothing', async () => {
    const { wrapper } = await view(withPull(), { prepareCandidate: async () => ({ ok: false, error: 'PR #7 is closed or its head no longer matches ' + HEAD }) });
    await wrapper.get('[data-test="prepare"]').trigger('click');
    await wrapper.get('[data-test="confirm-prepare-go"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="action-error"]').text()).toContain('no longer matches');
    expect(wrapper.find('[data-test="notice"]').exists()).toBe(false);
  });
});

describe('opening the pull request', () => {
  test('leaves an open confirmation and the notice alone', async () => {
    const { wrapper } = await view(withPull(), { previewMerge: async () => okPreview(), openPullRequest: async () => done('Opened in your browser.') });
    await wrapper.get('[data-test="merge"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="open-pr"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="confirm-merge"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="notice"]').exists()).toBe(false);
  });

  test('a failure to open is shown', async () => {
    const { wrapper } = await view(withPull(), { openPullRequest: async () => ({ ok: false, error: 'That is not a valid pull request.' }) });
    await wrapper.get('[data-test="open-pr"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="action-error"]').text()).toContain('not a valid');
  });

  test('asks the privileged side to open it and does not refresh', async () => {
    const { wrapper, qa } = await view(withPull(), { openPullRequest: async () => done('Opened in your browser.') });
    await wrapper.get('[data-test="open-pr"]').trigger('click');
    await flushPromises();
    expect(calls(qa, 'openPullRequest')[0]?.args).toEqual([{ repository: 'acme/app', number: 7, headSha: HEAD }]);
    expect(calls(qa, 'loadDashboard')).toHaveLength(1);
  });
});
