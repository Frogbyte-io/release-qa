import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, test } from 'vitest';
import App from '../src/renderer/App.vue';
import type { ManualCheckState, ManualResultView, QaBridge } from '../src/shared/contract.ts';
import { done, evaluation, fakeBridge, pull, snapshot } from './fixtures.ts';

const KEY = 'windows/device-feel';
const requirement = { key: KEY, title: 'Sliders feel right', mode: 'manual' as const, profile: 'windows' };
const blocked = pull({ gate: { status: 'evaluated', evaluation: evaluation({ readiness: 'blocked', reasons: [{ code: 'missing-result', requirement: KEY }] }), candidateId: 'cand-1', candidateReleaseId: 50 } });
const result = (changes: Partial<ManualResultView> = {}): ManualResultView => ({ runId: 'manual-20260930T080000Z-abcdef', outcome: 'passed', reporter: 'maintainer', recordedAt: '2026-09-30T08:00:00Z', evidenceCount: 2, synced: false, ...changes });
const state = (changes: Partial<ManualCheckState> = {}): ManualCheckState => ({ login: 'maintainer', requirement, candidateId: 'cand-1', results: [], readOnly: false, ...changes });
const ready = (changes: Partial<ManualCheckState> = {}) => async () => ({ ok: true as const, state: state(changes) });
const file = (name: string) => ({ token: `token-${name}`, name, bytes: 12 });

async function open(overrides: Partial<QaBridge> = {}, project: Parameters<typeof snapshot>[0] = {}) {
  const data = snapshot({ projects: [{ ...snapshot().projects[0]!, pullRequests: { status: 'ok', items: [blocked] } }], ...project });
  const qa = fakeBridge({ loadDashboard: async () => data, loadManualCheck: ready(), ...overrides });
  const wrapper = mount(App, { props: { qa } });
  await flushPromises();
  await wrapper.get('[data-test="open-acme/app-7"]').trigger('click');
  await wrapper.get(`[data-test="open-manual-${KEY}"]`).trigger('click');
  await flushPromises();
  return { wrapper, qa };
}
const bridgeCalls = (qa: ReturnType<typeof fakeBridge>, name: string) => qa.calls.filter((call) => call.name === name);

describe('the manual check view', () => {
  test('is reached from the release\'s manual work and shows the requirement, candidate and who results are recorded as', async () => {
    const { wrapper, qa } = await open();
    expect(wrapper.get('[data-test="manual-check"]').text()).toContain('Sliders feel right');
    expect(wrapper.get('[data-test="manual-key"]').text()).toBe(KEY);
    expect(wrapper.get('[data-test="manual-candidate"]').text()).toContain('cand-1');
    expect(wrapper.get('[data-test="manual-reporter"]').text()).toContain('Recorded as maintainer');
    expect(bridgeCalls(qa, 'loadManualCheck')[0]?.args).toEqual([{ repository: 'acme/app', number: 7, headSha: 'a'.repeat(40), requirement: KEY }]);
    // Identity is shown, not typed: there is no field for it.
    expect(wrapper.find('input[name="reporter"], input[name="actor"]').exists()).toBe(false);
    await wrapper.get('[data-test="manual-close"]').trigger('click');
    expect(wrapper.find('[data-test="manual-check"]').exists()).toBe(false);
  });

  test('no manual check can be opened without a candidate to record against', async () => {
    const noCandidate = pull({ gate: { status: 'evaluated', evaluation: evaluation({ readiness: 'blocked', reasons: [{ code: 'missing-result', requirement: KEY }] }) } });
    const qa = fakeBridge({ loadDashboard: async () => snapshot({ projects: [{ ...snapshot().projects[0]!, pullRequests: { status: 'ok', items: [noCandidate] } }] }) });
    const wrapper = mount(App, { props: { qa } });
    await flushPromises();
    await wrapper.get('[data-test="open-acme/app-7"]').trigger('click');
    expect(wrapper.find(`[data-test="open-manual-${KEY}"]`).exists()).toBe(false);
  });

  test('shows why the check cannot be read', async () => {
    const { wrapper } = await open({ loadManualCheck: async () => ({ ok: false, error: 'This pull request has no active candidate to record a check against.' }) });
    expect(wrapper.get('[data-test="manual-failed"]').text()).toContain('no active candidate');
    expect(wrapper.find('[data-test="manual-form"]').exists()).toBe(false);
  });
});

describe('recording a result', () => {
  test('notes and evidence are both required before a result can be saved', async () => {
    const { wrapper, qa } = await open({ pickEvidence: async () => ({ ok: true, files: [file('slider.png')] }) });
    const save = () => wrapper.get('[data-test="record"]');
    expect(save().attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="notes-hint"]').text()).toContain('Notes are required');
    expect(wrapper.get('[data-test="evidence-hint"]').text()).toContain('at least one evidence file');

    await wrapper.get('[data-test="notes"]').setValue('Dragged every slider.');
    expect(wrapper.find('[data-test="notes-hint"]').exists()).toBe(false);
    expect(save().attributes('disabled')).toBeDefined();

    await wrapper.get('[data-test="choose-evidence"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="evidence-file"]').text()).toContain('slider.png');
    expect(save().attributes('disabled')).toBeUndefined();

    await wrapper.get('[data-test="notes"]').setValue('   ');
    expect(save().attributes('disabled')).toBeDefined();
    await wrapper.get('[data-test="manual-form"]').trigger('submit');
    expect(bridgeCalls(qa, 'recordManualCheck')).toHaveLength(0);
  });

  test('sends the outcome, notes and evidence handles only, then shows the result as Not synced', async () => {
    let saved = false;
    const { wrapper, qa } = await open({
      loadManualCheck: async () => ({ ok: true, state: state({ results: saved ? [result({ outcome: 'failed' })] : [] }) }),
      pickEvidence: async () => ({ ok: true, files: [file('slider.png')] }),
      recordManualCheck: async () => { saved = true; return { ok: true, message: 'Saved on this computer as maintainer.', result: result({ outcome: 'failed' }) }; },
    });
    await wrapper.get('[data-test="outcome-failed"]').setValue(true);
    await wrapper.get('[data-test="notes"]').setValue('Slider 3 sticks.');
    await wrapper.get('[data-test="choose-evidence"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="manual-form"]').trigger('submit');
    await flushPromises();
    expect(bridgeCalls(qa, 'recordManualCheck')[0]?.args).toEqual([{ repository: 'acme/app', number: 7, headSha: 'a'.repeat(40), requirement: KEY, outcome: 'failed', notes: 'Slider 3 sticks.', evidence: ['token-slider.png'] }]);
    expect(wrapper.get('[data-test="manual-saved"]').text()).toContain('Saved on this computer');
    expect(wrapper.get('[data-test="manual-result"]').text()).toContain('failed by maintainer');
    expect(wrapper.get('[data-test="not-synced"]').text()).toBe('Not synced');
    expect(wrapper.find('[data-test="synced"]').exists()).toBe(false);
    // The form is empty again: the same notes cannot be saved twice by accident.
    expect((wrapper.get('[data-test="notes"]').element as HTMLTextAreaElement).value).toBe('');
    // Saving is local: it changed nothing on GitHub, so the dashboard was not read again.
    expect(bridgeCalls(qa, 'loadDashboard')).toHaveLength(1);
  });

  test('a refused save keeps what was typed and says why', async () => {
    const { wrapper } = await open({
      pickEvidence: async () => ({ ok: true, files: [file('slider.png')] }),
      recordManualCheck: async () => ({ ok: false, error: 'This machine cannot record a windows check: this machine is linux.' }),
    });
    await wrapper.get('[data-test="notes"]').setValue('seen it');
    await wrapper.get('[data-test="choose-evidence"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="manual-form"]').trigger('submit');
    await flushPromises();
    expect(wrapper.get('[data-test="manual-error"]').text()).toContain('cannot record a windows check');
    expect((wrapper.get('[data-test="notes"]').element as HTMLTextAreaElement).value).toBe('seen it');
    expect(wrapper.findAll('[data-test="evidence-file"]')).toHaveLength(1);
  });

  test('a file can be removed again before saving', async () => {
    const { wrapper } = await open({ pickEvidence: async () => ({ ok: true, files: [file('a.png'), file('b.png')] }) });
    await wrapper.get('[data-test="choose-evidence"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="remove-a.png"]').trigger('click');
    expect(wrapper.findAll('[data-test="evidence-file"]').map((item) => item.text())).toEqual([expect.stringContaining('b.png')]);
  });
});

describe('uploading', () => {
  test('a failed upload keeps the result Not synced and shows the error; a retry marks it Synced', async () => {
    let synced = false;
    let attempts = 0;
    const { wrapper, qa } = await open({
      loadManualCheck: async () => ({ ok: true, state: state({ results: [result({ synced })] }) }),
      syncManualResult: async () => { attempts++; if (attempts === 1) return { ok: false, error: 'upload qa-report failed: HTTP 502. The result is still saved here and can be uploaded again.' }; synced = true; return done('Uploaded 3 files to the candidate\'s draft release.'); },
    });
    expect(wrapper.find('[data-test="not-synced"]').exists()).toBe(true);
    const upload = wrapper.get('[data-test="sync-manual-20260930T080000Z-abcdef"]');
    await upload.trigger('click');
    await flushPromises();
    expect(bridgeCalls(qa, 'syncManualResult')[0]?.args).toEqual([{ runId: 'manual-20260930T080000Z-abcdef' }]);
    expect(wrapper.get('[data-test="sync-error"]').text()).toContain('HTTP 502');
    expect(wrapper.find('[data-test="not-synced"]').exists()).toBe(true);
    // Nothing changed on GitHub, so the dashboard was not refreshed.
    expect(bridgeCalls(qa, 'loadDashboard')).toHaveLength(1);

    await wrapper.get('[data-test="sync-manual-20260930T080000Z-abcdef"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="sync-error"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="not-synced"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="synced"]').text()).toBe('Synced');
    expect(wrapper.get('[data-test="notice"]').text()).toContain('Uploaded 3 files');
    // GitHub changed, so the release was read again.
    expect(bridgeCalls(qa, 'loadDashboard')).toHaveLength(2);
    expect(wrapper.find('[data-test="manual-check"]').exists()).toBe(true);
  });

  test('a damaged saved result is flagged and cannot be uploaded', async () => {
    const { wrapper } = await open({ loadManualCheck: ready({ results: [result({ problem: 'The saved result is incomplete or has been changed on disk.' })] }) });
    expect(wrapper.get('[data-test="result-problem"]').text()).toContain('incomplete');
    expect(wrapper.get('[data-test="sync-manual-20260930T080000Z-abcdef"]').attributes('disabled')).toBeDefined();
  });
});

describe('advisory ownership', () => {
  test('nobody has claimed: claim it, then the view shows you as the owner with a Release button', async () => {
    let owner: ManualCheckState['owner'];
    const { wrapper, qa } = await open({
      loadManualCheck: async () => ({ ok: true, state: state(owner === undefined ? {} : { owner }) }),
      claimManualCheck: async (request) => { owner = request.intent === 'claim' ? { actor: 'maintainer', action: 'claim', recordedAt: '2026-09-30T08:00:00Z', stale: false, mine: true } : undefined; return done(request.intent === 'claim' ? 'You are marked as doing this check.' : 'Released.'); },
    });
    expect(wrapper.get('[data-test="manual-owner"]').text()).toContain('Nobody');
    expect(wrapper.get('[data-test="claim"]').text()).toBe('Claim this check');
    await wrapper.get('[data-test="claim"]').trigger('click');
    await flushPromises();
    expect(bridgeCalls(qa, 'claimManualCheck')[0]?.args).toEqual([{ repository: 'acme/app', number: 7, headSha: 'a'.repeat(40), requirement: KEY, intent: 'claim' }]);
    expect(wrapper.get('[data-test="manual-owner"]').text()).toContain('You have claimed');
    expect(wrapper.find('[data-test="claim"]').exists()).toBe(false);
    await wrapper.get('[data-test="manual-release"]').trigger('click');
    await flushPromises();
    expect(bridgeCalls(qa, 'claimManualCheck')[1]?.args).toEqual([{ repository: 'acme/app', number: 7, headSha: 'a'.repeat(40), requirement: KEY, intent: 'release' }]);
    expect(wrapper.get('[data-test="manual-owner"]').text()).toContain('Nobody');
  });

  test('another user\'s fresh claim is shown, is only advisory, and can be taken over', async () => {
    const { wrapper } = await open({ loadManualCheck: ready({ owner: { actor: 'alice', action: 'claim', recordedAt: '2026-09-30T08:00:00Z', stale: false, mine: false } }) });
    expect(wrapper.get('[data-test="manual-owner"]').text()).toContain('alice has claimed');
    expect(wrapper.get('[data-test="manual-owner"]').text()).not.toContain('stale');
    expect(wrapper.get('[data-test="claim"]').text()).toBe('Take over from alice');
    expect(wrapper.find('[data-test="manual-release"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('not a lock');
    // The claim does not stop the form.
    expect(wrapper.get('[data-test="choose-evidence"]').attributes('disabled')).toBeUndefined();
  });

  test('two users handing off: a stale claim is marked stale, and taking it over shows the new owner', async () => {
    let owner: NonNullable<ManualCheckState['owner']> = { actor: 'alice', action: 'claim', recordedAt: '2026-09-29T02:00:00Z', stale: true, mine: false };
    const { wrapper } = await open({
      loadManualCheck: async () => ({ ok: true, state: state({ owner }) }),
      claimManualCheck: async () => { owner = { actor: 'maintainer', action: 'takeover', recordedAt: '2026-09-30T08:00:00Z', stale: false, mine: true }; return done('You took this check over from alice.'); },
    });
    expect(wrapper.get('[data-test="manual-owner"]').text()).toContain('alice claimed this since 2026-09-29T02:00:00Z, and that claim is stale');
    await wrapper.get('[data-test="claim"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="manual-owner"]').text()).toContain('You have claimed');
    expect(wrapper.get('[data-test="notice"]').text()).toContain('took this check over from alice');
  });

  test('a refused claim shows why', async () => {
    const { wrapper } = await open({ claimManualCheck: async () => ({ ok: false, error: 'The claim was not recorded (HTTP 502).' }) });
    await wrapper.get('[data-test="claim"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="manual-error"]').text()).toContain('HTTP 502');
  });
});

describe('permission loss', () => {
  test('a read-only user can look but cannot claim, record or upload', async () => {
    const { wrapper, qa } = await open({ loadManualCheck: ready({ readOnly: true, results: [result()] }) });
    expect(wrapper.get('[data-test="manual-readonly"]').text()).toContain('Read-only');
    for (const name of ['claim', 'choose-evidence', 'record', 'sync-manual-20260930T080000Z-abcdef']) expect(wrapper.get(`[data-test="${name}"]`).attributes('disabled')).toBeDefined();
    await wrapper.get('[data-test="claim"]').trigger('click');
    await wrapper.get('[data-test="manual-form"]').trigger('submit');
    expect(qa.calls.filter((call) => !['loadDashboard', 'loadManualCheck'].includes(call.name))).toEqual([]);
    // The local result is still listed, and still says it is not synced.
    expect(wrapper.find('[data-test="not-synced"]').exists()).toBe(true);
  });

  test('access lost after the view opened: the upload is refused, the result stays Not synced with the reason', async () => {
    const { wrapper } = await open({
      loadManualCheck: ready({ results: [result()] }),
      syncManualResult: async () => ({ ok: false, error: 'Your account no longer has write access to this repository, so the result was not uploaded. It is still saved here.' }),
    });
    await wrapper.get('[data-test="sync-manual-20260930T080000Z-abcdef"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="sync-error"]').text()).toContain('no longer has write access');
    expect(wrapper.find('[data-test="not-synced"]').exists()).toBe(true);
  });
});
