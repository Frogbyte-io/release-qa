import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, test } from 'vitest';
import App from '../src/renderer/App.vue';
import type { DashboardSnapshot } from '../src/shared/contract.ts';
import { evaluation, projectView, pull, snapshot } from './fixtures.ts';

async function open(load: () => Promise<DashboardSnapshot>) {
  const wrapper = mount(App, { props: { load } });
  await flushPromises();
  return wrapper;
}
const show = (value: DashboardSnapshot) => open(async () => value);
const text = (wrapper: Awaited<ReturnType<typeof open>>, selector: string) => wrapper.get(`[data-test="${selector}"]`).text();

describe('loading and failure', () => {
  test('shows a loading state until the data arrives, then the projects', async () => {
    let arrive: (value: DashboardSnapshot) => void = () => {};
    const wrapper = mount(App, { props: { load: () => new Promise<DashboardSnapshot>((resolve) => { arrive = resolve; }) } });
    expect(wrapper.find('[data-test="loading"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="refresh"]').attributes('disabled')).toBeDefined();
    arrive(snapshot());
    await flushPromises();
    expect(wrapper.find('[data-test="loading"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="project-acme/app"]').exists()).toBe(true);
  });

  test('says so when the data cannot be read at all, and lets the user retry', async () => {
    let calls = 0;
    const wrapper = await open(async () => { calls += 1; if (calls === 1) throw new Error('ipc'); return snapshot(); });
    expect(text(wrapper, 'failed')).toContain('could not read');
    await wrapper.get('[data-test="refresh"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="failed"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="project-acme/app"]').exists()).toBe(true);
  });
});

describe('what the account can see', () => {
  test('no configured projects gets an explanation, not an empty page', async () => {
    const wrapper = await show(snapshot({ projects: [] }));
    expect(text(wrapper, 'empty')).toContain('qa/project.json');
  });

  test('expired auth says how to sign in again and keeps cached projects visible', async () => {
    const wrapper = await show(snapshot({ stale: true, account: { status: 'signed-out', reason: 'logged-out' }, problems: [{ repository: '*', reason: 'logged-out' }] }));
    expect(text(wrapper, 'signed-out')).toContain('gh auth login');
    expect(text(wrapper, 'account')).toBe('Not signed in to GitHub');
    expect(wrapper.find('[data-test="project-acme/app"]').exists()).toBe(true);
    expect(text(wrapper, 'stale')).toContain('2026-09-29T12:00:00.000Z');
  });

  test('a read-only user sees the notice on the project and on the release', async () => {
    const wrapper = await show(snapshot({ projects: [projectView({ role: 'read', readOnly: true })] }));
    expect(wrapper.find('[data-test="read-only"]').exists()).toBe(true);
    await wrapper.get('[data-test="open-acme/app-7"]').trigger('click');
    expect(wrapper.text()).toContain('Read-only access');
  });

  test('an inaccessible repository is listed beside the ones that loaded', async () => {
    const wrapper = await show(snapshot({ problems: [{ repository: 'acme/locked', reason: 'organization-rejected' }] }));
    expect(wrapper.find('[data-test="project-acme/app"]').exists()).toBe(true);
    expect(text(wrapper, 'problem')).toContain('acme/locked');
    expect(text(wrapper, 'problem')).toContain('SSO');
  });

  test('a published release without a QA record is flagged', async () => {
    const wrapper = await show(snapshot({ projects: [projectView({ history: { status: 'ok', releases: [{ tag: 'v1.0.0', name: 'v1.0.0', publishedAt: '2026-08-01T00:00:00Z', url: '', qa: 'missing' }] } })] }));
    expect(text(wrapper, 'history-missing')).toBe('No QA record');
  });
});

describe('navigation', () => {
  test('opens a pull request from the repositories view and returns', async () => {
    const wrapper = await show(snapshot());
    expect(wrapper.find('[data-test="release"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="nav-release"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-test="open-acme/app-7"]').trigger('click');
    expect(wrapper.find('[data-test="release"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="project-acme/app"]').exists()).toBe(false);
    await wrapper.get('[data-test="back"]').trigger('click');
    expect(wrapper.find('[data-test="project-acme/app"]').exists()).toBe(true);
    await wrapper.get('[data-test="open-acme/app-7"]').trigger('click');
    await wrapper.get('[data-test="nav-repositories"]').trigger('click');
    expect(wrapper.find('[data-test="release"]').exists()).toBe(false);
  });

  test('a refresh that no longer has the pull request returns to the list', async () => {
    let current = snapshot();
    const wrapper = await open(async () => current);
    await wrapper.get('[data-test="open-acme/app-7"]').trigger('click');
    current = snapshot({ projects: [projectView({ pullRequests: { status: 'ok', items: [] } })] });
    await wrapper.get('[data-test="refresh"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="release"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="project-acme/app"]').exists()).toBe(true);
  });
});

describe('release view shows what the evaluator returned', () => {
  const blocked = evaluation({
    readiness: 'blocked',
    reasons: [
      { code: 'missing-result', requirement: 'windows/persistence' },
      { code: 'missing-result', requirement: 'windows/device-feel' },
      { code: 'no-artifact-for-profile', requirement: 'linux/persistence' },
      { code: 'head-changed', expected: 'aaaaaaa', actual: 'bbbbbbb' },
    ],
    excused: [{ reason: { code: 'capability-missing', requirement: 'windows/audio', missing: ['audio'] }, exceptionId: 'ex-1' }],
    acceptedReportIds: ['report-1'],
    ignored: [{ kind: 'report', id: 'report-0', reason: 'other-candidate' }],
  });
  const view = async (readiness = blocked) => {
    const wrapper = await show(snapshot({ projects: [projectView({ pullRequests: { status: 'ok', items: [pull({ gate: { status: 'evaluated', evaluation: readiness, candidateId: 'cand-1', candidateReleaseId: 50 } })] } })] }));
    await wrapper.get('[data-test="open-acme/app-7"]').trigger('click');
    return wrapper;
  };

  test('lists every blocking reason under its environment, candidate-wide ones apart', async () => {
    const wrapper = await view();
    expect(text(wrapper, 'readiness')).toBe('Blocked');
    const groups = wrapper.findAll('[data-test="environment"]').map((group) => group.get('h4').text());
    expect(groups).toEqual(['windows', 'linux', 'all environments']);
    expect(wrapper.findAll('[data-test="reason"]')).toHaveLength(4);
    expect(text(wrapper, 'candidate')).toContain('cand-1');
  });

  test('shows manual work, waived items, accepted reports and set-aside records', async () => {
    const wrapper = await view();
    expect(wrapper.findAll('[data-test="manual"]').map((item) => item.text())).toEqual(['windows/device-feel has no passing result']);
    expect(text(wrapper, 'excused')).toContain('windows/audio needs audio');
    expect(text(wrapper, 'report')).toBe('report-1');
    expect(text(wrapper, 'ignored')).toBe('report report-0: other-candidate');
  });

  test('a passed evaluation shows passed with no blockers, whatever else is on the page', async () => {
    const wrapper = await view(evaluation({ readiness: 'passed' }));
    expect(text(wrapper, 'readiness')).toBe('Passed');
    expect(wrapper.find('[data-test="reason"]').exists()).toBe(false);
    expect(text(wrapper, 'no-blockers')).toContain('nothing blocking');
    expect(text(wrapper, 'no-manual')).toContain('No manual check');
    expect(text(wrapper, 'no-reports')).toContain('No accepted reports');
    expect(text(wrapper, 'no-ignored')).toContain('Nothing was set aside');
  });

  test('an unavailable gate is shown as unavailable, never as a verdict', async () => {
    const wrapper = await show(snapshot({ projects: [projectView({ pullRequests: { status: 'ok', items: [pull({ gate: { status: 'unavailable', error: 'no active candidate selected' } })] } })] }));
    expect(text(wrapper, 'gate-unavailable')).toBe('Status unavailable');
    await wrapper.get('[data-test="open-acme/app-7"]').trigger('click');
    expect(text(wrapper, 'gate-error')).toContain('no active candidate selected');
    expect(wrapper.find('[data-test="readiness"]').exists()).toBe(false);
  });

  test('an ordinary pull request is not presented as a release', async () => {
    const wrapper = await show(snapshot({ projects: [projectView({ pullRequests: { status: 'ok', items: [pull({ releaseIntent: [] })] } })] }));
    await wrapper.get('[data-test="open-acme/app-7"]').trigger('click');
    expect(text(wrapper, 'not-release')).toContain('normal merge policy');
  });
});

describe('unsafe markup in repository text', () => {
  const hostile = '<img src=x onerror="window.__pwned = true"><script>window.__pwned = true</script>';

  test('is shown as text and never becomes elements', async () => {
    const wrapper = await show(snapshot({
      problems: [{ repository: `acme/${hostile}`, reason: hostile }],
      projects: [projectView({
        repository: 'acme/app',
        projectId: hostile,
        releaseBranch: hostile,
        pullRequests: { status: 'ok', items: [pull({ title: hostile, author: hostile, headRef: hostile, gate: { status: 'evaluated', evaluation: evaluation({ readiness: 'blocked', reasons: [{ code: 'missing-result', requirement: `windows/${hostile}` }], acceptedReportIds: [hostile], ignored: [{ kind: 'report', id: hostile, reason: 'other-candidate' }] }), candidateId: hostile } }) ] },
        history: { status: 'ok', releases: [{ tag: hostile, name: hostile, publishedAt: hostile, url: '', qa: 'missing' }] },
      })],
    }));
    await wrapper.get('[data-test="open-acme/app-7"]').trigger('click');
    for (const html of [wrapper.html()]) {
      expect(html).not.toContain('<img');
      expect(html).not.toContain('<script');
    }
    expect(wrapper.text()).toContain(hostile);
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
    await wrapper.get('[data-test="back"]').trigger('click');
    expect(wrapper.html()).not.toContain('<img');
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('script').exists()).toBe(false);
  });
});
