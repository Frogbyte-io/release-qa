import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { Candidate, EnvironmentProbes, PullRequestGateResult } from '@frogbyte-io/release-qa';
import {
  CLAIM_STALE_MS, claimManual, EvidenceRegistry, loadManualCheck, parseClaimRequest, parseManualTarget, parseRecordRequest, pickEvidence, recordManual, syncManualResult, type ManualDeps,
} from '../src/main/manual-checks.ts';
import { evaluation } from './fixtures.ts';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const temp = async (): Promise<string> => { const dir = await mkdtemp(join(tmpdir(), 'qa-desktop-manual-')); dirs.push(dir); return dir; };

// Recording refuses a machine that is not the profile's kind, so the profile is the one of the machine running the tests.
const OS = process.platform === 'win32' ? 'windows' : 'linux';
const KEY = `${OS}/device-feel`;
const HEAD = 'a'.repeat(40);
const target = { repository: 'acme/app', number: 7, headSha: HEAD, requirement: KEY };
const probes: EnvironmentProbes = { display: async () => true, audio: async () => false, describeDisplay: async () => ({ kind: 'real', detail: 'test' }) };
const runnable = process.arch === 'x64' ? describe : describe.skip;

const projectJson = {
  schemaVersion: 1, projectId: 'app', releaseBranch: 'main',
  profiles: [{ id: OS, os: OS, arch: 'x86_64' }],
  requirements: [{ key: KEY, mode: 'manual', title: 'Sliders feel right', capabilities: ['hardware'] }, { key: `${OS}/persistence`, mode: 'automated', title: 'Persists', capabilities: [] }],
  suites: [{ id: 'release', requirements: [KEY] }],
  scenarioFiles: ['scenarios/persistence.spec.ts'], lifecycleModule: 'lifecycle.ts',
  workflows: { prepare: 'qa-prepare.yml', gate: 'qa-gate.yml', publish: 'qa-publish.yml' },
  markers: { releaseNotes: 'release-notes', qa: 'qa' },
};
const candidate: Candidate = {
  schemaVersion: 1, id: 'cand-1', repositoryId: 1, pullRequest: 7, sourceSha: HEAD, baseSha: 'b'.repeat(40), sourceTreeSha: 'c'.repeat(40), testRevision: 'd'.repeat(40), policyDigest: 'e'.repeat(64),
  build: { workflowPath: '.github/workflows/qa-prepare.yml', runId: 1, attempt: 1 },
  artifacts: [{ profile: OS, name: 'setup.exe', sha256: 'f'.repeat(64), assetId: 9, actionsArtifactId: 10 }],
};
const gate: PullRequestGateResult = {
  ok: true,
  value: { pullRequest: 7, headSha: HEAD, baseRef: 'main', baseSha: 'b'.repeat(40), candidateId: 'cand-1', candidate, candidateReleaseId: 50, releaseIntent: ['release branch'], evaluation: evaluation({ readiness: 'blocked' }), summary: '', markers: { releaseNotes: 'release-notes', qa: 'qa' } },
};

/** What one GitHub release holds, shared by every signed-in user who talks to it. */
interface Store { assets: Array<{ id: number; name: string; uploader: { login: string }; state: string; created_at: string; bytes: Buffer }>; roles: Record<string, string> }

/** GitHub as one signed-in user sees it: the repository, the project file, permissions and the release's assets. */
class GitHubFake {
  readonly store: Store;
  login: string;
  failUploads = false;
  signedIn = true;
  constructor(store: Store, login: string) { this.store = store; this.login = login; }
  private role(): string { return this.store.roles[this.login] ?? 'write'; }
  async auth() { return this.signedIn ? { ok: true as const, value: true as const } : { ok: false as const, reason: 'logged-out' as const }; }
  async get(path: string) {
    if (path === 'repos/acme/app') {
      const role = this.role();
      return { ok: true as const, value: { id: 1, full_name: 'acme/app', default_branch: 'main', permissions: { pull: true, push: role !== 'read', maintain: role === 'maintain' || role === 'admin', admin: role === 'admin' } } };
    }
    if (path.startsWith('repos/acme/app/contents/qa/project.json')) return { ok: true as const, value: { type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(projectJson)).toString('base64') } };
    const permission = /collaborators\/([^/]+)\/permission$/.exec(path);
    if (permission) return { ok: true as const, value: { permission: this.store.roles[decodeURIComponent(permission[1]!)] ?? 'write' } };
    return { ok: false as const, reason: 'not-found' as const };
  }
  async list(path: string) {
    if (path.includes('/releases/50/assets')) return { ok: true as const, value: this.store.assets.map(({ bytes: _bytes, ...asset }) => asset) };
    return { ok: false as const, reason: 'not-found' as const };
  }
  async download(path: string, destination: string) {
    const asset = this.store.assets.find((item) => item.id === Number(path.split('/').at(-1)));
    if (asset === undefined) return { ok: false as const, reason: 'not-found' as const };
    await writeFile(destination, asset.bytes);
    return { ok: true as const, value: true as const };
  }
  async upload(_repository: string, _releaseId: number, name: string, content: Buffer) {
    if (this.failUploads) return { ok: false as const, reason: 'HTTP 502' };
    const id = this.store.assets.length + 1;
    const asset = { id, name, uploader: { login: this.login }, state: 'uploaded', created_at: `2026-09-30T10:00:${String(id).padStart(2, '0')}Z`, bytes: content };
    this.store.assets.push(asset);
    return { ok: true as const, value: { id, name, state: 'uploaded', uploader: { login: this.login } } };
  }
  async currentUser() { return this.signedIn ? { ok: true as const, value: this.login } : { ok: false as const, reason: 'logged-out' as const }; }
  async dispatchReconciliation() { return { ok: true as const, value: true as const }; }
}

const newStore = (): Store => ({ assets: [], roles: {} });
/** One person's app on one computer: their own state folder and evidence handles. */
async function app(store: Store, login: string, choose?: () => Promise<string[]>) {
  const api = new GitHubFake(store, login);
  let clock = new Date('2026-09-30T08:00:00Z');
  const deps: ManualDeps = { api: api as never, stateDir: await temp(), evidence: new EvidenceRegistry(), evaluate: (async () => gate) as never, probes, now: () => clock, ...(choose === undefined ? {} : { choose }) };
  return { api, deps, at: (iso: string) => { clock = new Date(iso); } };
}
async function picked(deps: ManualDeps, ...names: string[]): Promise<string[]> {
  const source = await temp();
  const paths: string[] = [];
  for (const name of names) { await writeFile(join(source, name), `content of ${name}`); paths.push(join(source, name)); }
  const result = await pickEvidence({ ...deps, choose: async () => paths });
  if (!result.ok) throw new Error(result.error);
  return result.files.map((file) => file.token);
}

describe('what the window may send', () => {
  test('a manual target is a validated pull request plus a requirement key', () => {
    expect(parseManualTarget(target)).toEqual(target);
    for (const requirement of ['../x', 'Windows/Persist', 'windows', 'a/b/c', 5, undefined]) expect(parseManualTarget({ ...target, requirement })).toBeUndefined();
    expect(parseManualTarget({ ...target, headSha: 'main' })).toBeUndefined();
  });

  test('a result request carries an outcome, notes and evidence handles, and no reporter', () => {
    const request = { ...target, outcome: 'passed', notes: 'ok', evidence: ['t1'] };
    expect(parseRecordRequest({ ...request, actor: 'mallory', reporter: 'mallory' })).toEqual(request);
    expect(parseRecordRequest({ ...request, outcome: 'cancelled' })).toBeUndefined();
    expect(parseRecordRequest({ ...request, notes: 5 })).toBeUndefined();
    expect(parseRecordRequest({ ...request, evidence: [5] })).toBeUndefined();
    expect(parseRecordRequest({ ...request, evidence: Array.from({ length: 11 }, (_, i) => `t${i}`) })).toBeUndefined();
    expect(parseClaimRequest({ ...target, intent: 'claim' })).toEqual({ ...target, intent: 'claim' });
    expect(parseClaimRequest({ ...target, intent: 'steal' })).toBeUndefined();
  });

  test('the file dialog hands back handles and names, never paths', async () => {
    const store = newStore();
    const { deps } = await app(store, 'alice');
    const source = await temp();
    await writeFile(join(source, 'slider.png'), 'pixels');
    const result = await pickEvidence({ ...deps, choose: async () => [join(source, 'slider.png')] });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(source);
    expect(result.ok && result.files[0]).toMatchObject({ name: 'slider.png', bytes: 6 });
    expect(await pickEvidence({ ...deps, choose: async () => [] })).toEqual({ ok: true, files: [] });
    expect((await pickEvidence({ ...deps, choose: async () => [join(source, 'gone.png')] })).ok).toBe(false);
    // A handle the dialog never issued resolves to nothing.
    const outcome = await recordManual({ ...target, outcome: 'passed', notes: 'ok', evidence: [join(source, 'slider.png')] }, deps);
    expect(outcome).toEqual({ ok: false, error: expect.stringContaining('no longer available') });
  });
});

runnable('recording and uploading a manual result', () => {
  test('is recorded as the signed-in GitHub user, is not synced until uploaded, then counts from the release', async () => {
    const store = newStore();
    const { deps } = await app(store, 'alice');
    const evidence = await picked(deps, 'slider.png');
    const recorded = await recordManual({ ...target, outcome: 'passed', notes: 'Every slider followed the device.', evidence, actor: 'mallory' }, deps);
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.result).toMatchObject({ reporter: 'alice', outcome: 'passed', synced: false, evidenceCount: 2 });
    expect(store.assets).toEqual([]);

    const before = await loadManualCheck(target, deps);
    expect(before.ok && before.state).toMatchObject({ login: 'alice', candidateId: 'cand-1', readOnly: false, requirement: { key: KEY, mode: 'manual' } });
    expect(before.ok && before.state.results.map((r) => [r.runId, r.synced])).toEqual([[recorded.result.runId, false]]);

    expect(await syncManualResult({ runId: recorded.result.runId }, deps)).toMatchObject({ ok: true });
    const after = await loadManualCheck(target, deps);
    expect(after.ok && after.state.results[0]?.synced).toBe(true);
    const manifest = store.assets.find((asset) => asset.name.startsWith('qa-report-'));
    expect(manifest?.uploader.login).toBe('alice');
    expect(JSON.parse(manifest!.bytes.toString()).report.actor).toBe('alice');
  });

  test('notes and evidence are required, and a refused result leaves nothing saved', async () => {
    const { deps } = await app(newStore(), 'alice');
    const evidence = await picked(deps, 'slider.png');
    expect(await recordManual({ ...target, outcome: 'passed', notes: '   ', evidence }, deps)).toEqual({ ok: false, error: expect.stringContaining('Notes are required') });
    expect(await recordManual({ ...target, outcome: 'passed', notes: 'seen', evidence: [] }, deps)).toEqual({ ok: false, error: expect.stringContaining('at least one evidence file') });
    expect(await readdir(deps.stateDir)).toEqual([]);
    // The handles stay valid, so the person can fix the notes and save without choosing the files again.
    expect((await recordManual({ ...target, outcome: 'failed', notes: 'slider 3 stuck', evidence }, deps)).ok).toBe(true);
  });

  test('a failed upload keeps the local result, still not synced, and uploading again works', async () => {
    const store = newStore();
    const { api, deps } = await app(store, 'alice');
    const recorded = await recordManual({ ...target, outcome: 'passed', notes: 'seen', evidence: await picked(deps, 'a.png') }, deps);
    if (!recorded.ok) throw new Error(recorded.error);
    api.failUploads = true;
    const failed = await syncManualResult({ runId: recorded.result.runId }, deps);
    expect(failed).toEqual({ ok: false, error: expect.stringContaining('still saved here') });
    expect(failed.ok === false && failed.error).toContain('HTTP 502');
    const state = await loadManualCheck(target, deps);
    expect(state.ok && state.state.results).toMatchObject([{ runId: recorded.result.runId, synced: false, outcome: 'passed' }]);
    api.failUploads = false;
    expect((await syncManualResult({ runId: recorded.result.runId }, deps)).ok).toBe(true);
  });

  test('losing write access stops recording, claiming and uploading, and the result stays saved', async () => {
    const store = newStore();
    const { deps } = await app(store, 'alice');
    const recorded = await recordManual({ ...target, outcome: 'passed', notes: 'seen', evidence: await picked(deps, 'a.png') }, deps);
    if (!recorded.ok) throw new Error(recorded.error);
    store.roles.alice = 'read';
    const refused = await syncManualResult({ runId: recorded.result.runId }, deps);
    expect(refused).toEqual({ ok: false, error: expect.stringContaining('no longer has write access') });
    expect(store.assets).toEqual([]);
    expect(await recordManual({ ...target, outcome: 'passed', notes: 'seen', evidence: await picked(deps, 'b.png') }, deps)).toEqual({ ok: false, error: expect.stringContaining('read-only') });
    expect(await claimManual({ ...target, intent: 'claim' }, deps)).toEqual({ ok: false, error: expect.stringContaining('read-only') });
    const state = await loadManualCheck(target, deps);
    expect(state.ok && state.state).toMatchObject({ readOnly: true, results: [{ synced: false }] });
    store.roles.alice = 'write';
    expect((await syncManualResult({ runId: recorded.result.runId }, deps)).ok).toBe(true);
  });

  test('an expired sign-in is reported and nothing is saved or uploaded', async () => {
    const { api, deps } = await app(newStore(), 'alice');
    const evidence = await picked(deps, 'a.png');
    api.signedIn = false;
    expect(await recordManual({ ...target, outcome: 'passed', notes: 'seen', evidence }, deps)).toEqual({ ok: false, error: expect.stringContaining('gh auth login') });
    expect(await readdir(deps.stateDir)).toEqual([]);
  });

  test('only manual checks of the project can be recorded, and a candidate must exist', async () => {
    const { deps } = await app(newStore(), 'alice');
    expect(await loadManualCheck({ ...target, requirement: `${OS}/persistence` }, deps)).toEqual({ ok: false, error: expect.stringContaining('not a manual check') });
    expect(await loadManualCheck({ ...target, requirement: `${OS}/unknown` }, deps)).toEqual({ ok: false, error: expect.stringContaining('not a manual check') });
    const noCandidate = { ...deps, evaluate: (async () => ({ ok: true, value: { ...(gate as { value: object }).value, candidate: undefined, candidateId: undefined } })) as never };
    expect(await loadManualCheck(target, noCandidate)).toEqual({ ok: false, error: expect.stringContaining('no active candidate') });
    expect(await syncManualResult({ runId: '../../x' }, deps)).toEqual({ ok: false, error: expect.stringContaining('not a saved manual result') });
  });

  test('a result recorded by someone else on this computer is not uploaded under another name', async () => {
    const store = newStore();
    const alice = await app(store, 'alice');
    const recorded = await recordManual({ ...target, outcome: 'passed', notes: 'seen', evidence: await picked(alice.deps, 'a.png') }, alice.deps);
    if (!recorded.ok) throw new Error(recorded.error);
    alice.api.login = 'bob';
    const result = await syncManualResult({ runId: recorded.result.runId }, alice.deps);
    expect(result).toEqual({ ok: false, error: expect.stringContaining('does not match') });
    expect(store.assets).toEqual([]);
  });
});

runnable('claiming a manual check', () => {
  test('claim, then release; nobody is blocked by it', async () => {
    const store = newStore();
    const { deps } = await app(store, 'alice');
    const empty = await loadManualCheck(target, deps);
    expect(empty.ok && empty.state.owner).toBeUndefined();
    expect(await claimManual({ ...target, intent: 'claim' }, deps)).toMatchObject({ ok: true, message: expect.stringContaining('not a lock') });
    const mine = await loadManualCheck(target, deps);
    expect(mine.ok && mine.state.owner).toMatchObject({ actor: 'alice', mine: true, stale: false, action: 'claim' });
    expect(await claimManual({ ...target, intent: 'claim' }, deps)).toEqual({ ok: true, message: 'You already have this check.' });
    expect(store.assets.filter((asset) => asset.name.startsWith('qa-claim-'))).toHaveLength(1);
    // Holding the claim does not stop the same person, or anyone, from recording a result.
    expect((await recordManual({ ...target, outcome: 'passed', notes: 'seen', evidence: await picked(deps, 'a.png') }, deps)).ok).toBe(true);
    expect((await claimManual({ ...target, intent: 'release' }, deps)).ok).toBe(true);
    const released = await loadManualCheck(target, deps);
    expect(released.ok && released.state.owner).toBeUndefined();
    expect(await claimManual({ ...target, intent: 'release' }, deps)).toEqual({ ok: false, error: expect.stringContaining('Nobody has claimed') });
  });

  test('two users handing off: a stale claim is shown as stale and a second user takes it over', async () => {
    const store = newStore();
    const alice = await app(store, 'alice');
    const bob = await app(store, 'bob');
    expect((await claimManual({ ...target, intent: 'claim' }, alice.deps)).ok).toBe(true);

    // Shortly after, bob sees alice's claim as current, and cannot release what is hers.
    bob.at('2026-09-30T08:30:00Z');
    const fresh = await loadManualCheck(target, bob.deps);
    expect(fresh.ok && fresh.state.owner).toMatchObject({ actor: 'alice', mine: false, stale: false });
    expect(await claimManual({ ...target, intent: 'release' }, bob.deps)).toEqual({ ok: false, error: expect.stringContaining('only they can release') });

    // Long after the claim's limit it is stale, still shown, and bob takes over.
    bob.at(new Date(Date.parse('2026-09-30T08:00:00Z') + CLAIM_STALE_MS + 60_000).toISOString());
    const stale = await loadManualCheck(target, bob.deps);
    expect(stale.ok && stale.state.owner).toMatchObject({ actor: 'alice', stale: true });
    expect(await claimManual({ ...target, intent: 'claim' }, bob.deps)).toMatchObject({ ok: true, message: expect.stringContaining('took this check over from alice') });
    const after = await loadManualCheck(target, bob.deps);
    expect(after.ok && after.state.owner).toMatchObject({ actor: 'bob', mine: true, action: 'takeover', stale: false });
    const forAlice = await loadManualCheck(target, alice.deps);
    expect(forAlice.ok && forAlice.state.owner).toMatchObject({ actor: 'bob', mine: false });
    // The history is kept, not overwritten.
    expect(store.assets.filter((asset) => asset.name.startsWith('qa-claim-'))).toHaveLength(2);
  });

  test('taking over is possible even while the other claim is fresh: claims never lock', async () => {
    const store = newStore();
    const alice = await app(store, 'alice');
    const bob = await app(store, 'bob');
    await claimManual({ ...target, intent: 'claim' }, alice.deps);
    expect((await claimManual({ ...target, intent: 'claim' }, bob.deps)).ok).toBe(true);
    const state = await loadManualCheck(target, alice.deps);
    expect(state.ok && state.state.owner?.actor).toBe('bob');
  });
});
