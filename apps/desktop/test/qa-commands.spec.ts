import { describe, expect, test } from 'vitest';
import type { PullRequestGateResult } from '@frogbyte-io/release-qa';
import { loadDashboard } from '../src/main/qa-commands.ts';
import { project as projectFixture } from '../../../packages/qa/test/fixtures/records.ts';
import { evaluation, snapshot } from './fixtures.ts';
import { fixtureTransport, memoryCache } from './transport.ts';

const NOW = new Date('2026-09-29T12:00:00.000Z');
const sha = 'a'.repeat(40);
const projectJson = (name = 'tauri-smoke') => ({ type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(projectFixture({ projectId: name }))).toString('base64') });
const repo = (name: string, permissions: Record<string, boolean> = { pull: true, push: true, maintain: true }) => ({ full_name: name, default_branch: 'main', id: 1, permissions });
const pullEntry = (number: number, extra: Record<string, unknown> = {}) => ({ number, title: `Release ${number}`, user: { login: 'maintainer' }, html_url: `https://github.com/acme/app/pull/${number}`, head: { ref: `release/${number}`, sha }, draft: false, ...extra });

/** What a project's GitHub answers look like for one repository: its listing entry, its qa/project.json, pulls and releases. */
function repository(name: string, extras: Record<string, ReturnType<typeof okReply>> = {}) {
  return {
    [`repos/${name}`]: okReply(repo(name)),
    [`repos/${name}/contents/qa/project.json?ref=main`]: okReply(projectJson(name.split('/')[1])),
    [`repos/${name}/pulls?state=open&per_page=100`]: okReply([]),
    [`repos/${name}/releases?per_page=20`]: okReply([]),
    ...extras,
  };
}
const okReply = (value: unknown) => ({ ok: true as const, value });
const failure = (reason: 'network-error' | 'organization-rejected') => ({ ok: false as const, reason }) as unknown as ReturnType<typeof okReply>;
const listing = (...names: string[]) => ({ 'user/repos?per_page=100&affiliation=owner,collaborator,organization_member': okReply(names.map((name) => ({ full_name: name, default_branch: 'main' }))) });
const notEvaluated: () => Promise<PullRequestGateResult> = async () => ({ ok: false, error: 'not used' });

describe('loadDashboard', () => {
  test('shows the evaluator result exactly, without computing readiness itself', async () => {
    const evaluated = evaluation({ readiness: 'approved-with-exceptions', excused: [{ reason: { code: 'missing-result', requirement: 'windows/device-feel' }, exceptionId: 'ex-1' }], acceptedReportIds: ['r-1'] });
    const asked: Array<[string, number]> = [];
    const api = fixtureTransport({ ...listing('acme/app'), ...repository('acme/app', { 'repos/acme/app/pulls?state=open&per_page=100': okReply([pullEntry(7)]) }) });
    const result = await loadDashboard({
      api, cache: memoryCache(), now: () => NOW,
      evaluate: async (repositoryName, number) => {
        asked.push([repositoryName, number]);
        return { ok: true, value: { pullRequest: number, headSha: sha, baseRef: 'main', baseSha: sha, releaseIntent: ['release branch'], evaluation: evaluated, summary: '', markers: { releaseNotes: 'release-notes', qa: 'qa' } } };
      },
    });
    expect(asked).toEqual([['acme/app', 7]]);
    const items = result.projects[0]?.pullRequests;
    expect(items?.status === 'ok' && items.items[0]?.gate).toEqual({ status: 'evaluated', evaluation: evaluated });
    // The very object the evaluator returned: nothing was rebuilt or recomputed on the way.
    expect(items?.status === 'ok' && items.items[0]?.gate.status === 'evaluated' && items.items[0].gate.evaluation).toBe(evaluated);
  });

  test('a gate that cannot be evaluated is shown as unavailable, never as passed', async () => {
    const api = fixtureTransport({ ...listing('acme/app'), ...repository('acme/app', { 'repos/acme/app/pulls?state=open&per_page=100': okReply([pullEntry(7)]) }) });
    const result = await loadDashboard({ api, cache: memoryCache(), now: () => NOW, evaluate: async () => ({ ok: false, error: 'manual check required: no active candidate selected' }) });
    const items = result.projects[0]?.pullRequests;
    expect(items?.status === 'ok' && items.items[0]?.gate).toEqual({ status: 'unavailable', error: 'manual check required: no active candidate selected' });
    // Whether it is a release is unknown when the gate cannot say, and is left out rather than reported as empty.
    expect(items?.status === 'ok' && items.items[0] !== undefined && 'releaseIntent' in items.items[0]).toBe(false);
  });

  test('reports no projects when none are configured, and keeps the account', async () => {
    const result = await loadDashboard({ api: fixtureTransport({ ...listing('acme/plain') }), cache: memoryCache(), now: () => NOW, evaluate: notEvaluated });
    expect(result).toMatchObject({ account: { status: 'signed-in', login: 'maintainer' }, projects: [], problems: [], stale: false });
  });

  test('expired auth with nothing cached is signed out, with the reason', async () => {
    const api = fixtureTransport({}, { auth: { ok: false, reason: 'logged-out' } });
    expect(await loadDashboard({ api, cache: memoryCache(), now: () => NOW, evaluate: notEvaluated })).toMatchObject({
      account: { status: 'signed-out', reason: 'logged-out' }, projects: [], problems: [{ repository: '*', reason: 'logged-out' }],
    });
  });

  test('expired auth keeps the last good projects, marked stale and signed out', async () => {
    const cache = memoryCache(snapshot({ loadedAt: '2026-09-28T08:00:00.000Z' }));
    const api = fixtureTransport({}, { auth: { ok: false, reason: 'logged-out' } });
    const result = await loadDashboard({ api, cache, now: () => NOW, evaluate: notEvaluated });
    expect(result).toMatchObject({ stale: true, loadedAt: '2026-09-28T08:00:00.000Z', account: { status: 'signed-out' } });
    expect(result.projects).toHaveLength(1);
  });

  test('an unreachable GitHub shows the cached copy, stale, and does not overwrite it', async () => {
    const cached = snapshot({ loadedAt: '2026-09-28T08:00:00.000Z' });
    const cache = memoryCache(cached);
    const api = fixtureTransport({ 'user/repos?per_page=100&affiliation=owner,collaborator,organization_member': failure('network-error') });
    const result = await loadDashboard({ api, cache, now: () => NOW, evaluate: notEvaluated });
    expect(result).toMatchObject({ stale: true, account: { status: 'signed-in' }, problems: [{ repository: '*', reason: 'network-error' }] });
    expect(cache.last()).toBe(cached);
  });

  test('a fresh read replaces the cache', async () => {
    const cache = memoryCache(snapshot({ loadedAt: '2026-09-01T00:00:00.000Z' }));
    const api = fixtureTransport({ ...listing('acme/app'), ...repository('acme/app') });
    await loadDashboard({ api, cache, now: () => NOW, evaluate: notEvaluated });
    expect(cache.last()?.loadedAt).toBe(NOW.toISOString());
  });

  test('a partial read does not replace the last complete copy', async () => {
    const complete = snapshot({ loadedAt: '2026-09-28T08:00:00.000Z' });
    const cache = memoryCache(complete);
    const api = fixtureTransport({ ...listing('acme/app', 'acme/locked'), ...repository('acme/app'), ...repository('acme/locked', { 'repos/acme/locked': failure('network-error') }) });
    const result = await loadDashboard({ api, cache, now: () => NOW, evaluate: notEvaluated });
    expect(result.problems).toEqual([{ repository: 'acme/locked', reason: 'network-error' }]);
    expect(cache.last()).toBe(complete);
  });

  test.each([[{}], [{ ...snapshot(), projects: 'x' }], [{ ...snapshot(), account: null }], ['text']])(
    'discards a cache of the wrong shape instead of trusting it (%#)',
    async (bad) => {
      const api = fixtureTransport({}, { auth: { ok: false, reason: 'network-error' } });
      const result = await loadDashboard({ api, cache: memoryCache(bad as never), now: () => NOW, evaluate: notEvaluated });
      expect(result).toMatchObject({ stale: false, projects: [], problems: [{ repository: '*', reason: 'network-error' }] });
    },
  );

  test('a read-only user gets every project marked read-only', async () => {
    const api = fixtureTransport({ ...listing('acme/app'), ...repository('acme/app', { 'repos/acme/app': okReply(repo('acme/app', { pull: true })) }) });
    const result = await loadDashboard({ api, cache: memoryCache(), now: () => NOW, evaluate: notEvaluated });
    expect(result.projects[0]).toMatchObject({ role: 'read', readOnly: true });
  });

  test('an inaccessible repository is reported and the others still load', async () => {
    const api = fixtureTransport({
      ...listing('acme/app', 'acme/locked', 'acme/other'),
      ...repository('acme/app'),
      ...repository('acme/other'),
      ...repository('acme/locked', { 'repos/acme/locked': failure('organization-rejected') }),
    });
    const result = await loadDashboard({ api, cache: memoryCache(), now: () => NOW, evaluate: notEvaluated });
    expect(result.projects.map((item) => item.repository)).toEqual(['acme/app', 'acme/other']);
    expect(result.problems).toEqual([{ repository: 'acme/locked', reason: 'organization-rejected' }]);
  });

  test('a repository whose pull requests fail keeps its other views', async () => {
    const api = fixtureTransport({ ...listing('acme/app'), ...repository('acme/app', { 'repos/acme/app/pulls?state=open&per_page=100': failure('network-error') }) });
    const result = await loadDashboard({ api, cache: memoryCache(), now: () => NOW, evaluate: notEvaluated });
    expect(result.projects[0]?.pullRequests).toEqual({ status: 'unavailable', reason: 'network-error' });
    expect(result.projects[0]?.history.status).toBe('ok');
  });

  test('marks a published release without a QA record as missing, and one with a record as recorded', async () => {
    const releases = [
      { tag_name: 'v1.0.0', name: 'v1.0.0', published_at: '2026-08-01T00:00:00Z', html_url: 'https://github.com/acme/app/releases/tag/v1.0.0', draft: false, assets: [{ name: 'app.exe' }] },
      { tag_name: 'v1.1.0', name: 'v1.1.0', published_at: '2026-09-01T00:00:00Z', html_url: 'https://github.com/acme/app/releases/tag/v1.1.0', draft: false, assets: [{ name: 'app.exe' }, { name: 'release-qa-record.json' }] },
      { tag_name: 'v1.2.0', name: 'QA PR #7', draft: true, assets: [] },
    ];
    const api = fixtureTransport({ ...listing('acme/app'), ...repository('acme/app', { 'repos/acme/app/releases?per_page=20': okReply(releases) }) });
    const result = await loadDashboard({ api, cache: memoryCache(), now: () => NOW, evaluate: notEvaluated });
    expect(result.projects[0]?.history).toEqual({ status: 'ok', releases: [
      { tag: 'v1.0.0', name: 'v1.0.0', publishedAt: '2026-08-01T00:00:00Z', url: 'https://github.com/acme/app/releases/tag/v1.0.0', qa: 'missing' },
      { tag: 'v1.1.0', name: 'v1.1.0', publishedAt: '2026-09-01T00:00:00Z', url: 'https://github.com/acme/app/releases/tag/v1.1.0', qa: 'recorded' },
    ] });
  });

  test('carries repository-written text as data: only GitHub links survive, and long text is cut', async () => {
    const entries = [pullEntry(7, { title: '<img src=x onerror=alert(1)>'.padEnd(500, 'x'), html_url: 'javascript:alert(1)' }), pullEntry(8, { html_url: 'https://evil.example/pull/8' }), { number: 'x' }, null];
    const api = fixtureTransport({ ...listing('acme/app'), ...repository('acme/app', { 'repos/acme/app/pulls?state=open&per_page=100': okReply(entries) }) });
    const result = await loadDashboard({ api, cache: memoryCache(), now: () => NOW, evaluate: notEvaluated });
    const items = result.projects[0]?.pullRequests;
    expect(items?.status).toBe('ok');
    if (items?.status !== 'ok') return;
    expect(items.items.map((item) => item.number)).toEqual([7, 8]);
    expect(items.items.map((item) => item.url)).toEqual(['', '']);
    expect(items.items[0]?.title).toHaveLength(300);
    expect(items.items[0]?.title.startsWith('<img')).toBe(true);
  });

  test('a failure inside one repository does not lose the others', async () => {
    const api = fixtureTransport({ ...listing('acme/app', 'acme/boom'), ...repository('acme/app'), ...repository('acme/boom', { 'repos/acme/boom/pulls?state=open&per_page=100': okReply([pullEntry(3)]) }) });
    const result = await loadDashboard({
      api, cache: memoryCache(), now: () => NOW,
      evaluate: async (repositoryName) => { if (repositoryName === 'acme/boom') throw new Error('unexpected'); return { ok: false, error: 'x' }; },
    });
    // The evaluation failure is contained to its pull request; the repository itself still loads.
    expect(result.projects.map((item) => item.repository)).toEqual(['acme/app', 'acme/boom']);
    const boom = result.projects[1]?.pullRequests;
    expect(boom?.status === 'ok' && boom.items[0]?.gate).toEqual({ status: 'unavailable', error: 'GitHub state could not be read' });
  });
});
