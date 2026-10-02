import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { GhTransport } from '../../src/github/transport.ts';
import { parseArgs } from '../../src/cli/args.ts';
import type { CiApi } from '../../src/cli/ci-commands.ts';
import { EXIT, main } from '../../src/cli/main.ts';
import type { PullRequestGateResult } from '../../src/github/pull-request-gate.ts';
import type { SyncAsset } from '../../src/github/sync.ts';
import { parseLocalCandidate } from '../../src/model/local-candidate.ts';
import type { RunEvent } from '../../src/runner/events.ts';
import { candidate, SHA1, SHA256 } from '../fixtures/records.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.allSettled(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qa-ci-commands-'));
  dirs.push(dir);
  return dir;
}

function io() {
  const log: string[] = [];
  const error: string[] = [];
  return { log, error, sink: { log: (s: string) => log.push(s), error: (s: string) => error.push(s) } };
}

const HEAD = SHA1.source;
const RUN_ID = 'run-20260101T000000Z-abc123';
const bytes = Buffer.from('the exact linux package bytes');
const digest = createHash('sha256').update(bytes).digest('hex');
const active = candidate({
  artifacts: [{ profile: 'linux', name: 'smoke_amd64.deb', sha256: digest, assetId: 102, actionsArtifactId: 202 }],
});

/** What the gate hands back for a pull request with an active candidate; the gate itself is tested elsewhere. */
const evaluated = (overrides: { candidate?: typeof active; none?: boolean } = {}) => async (): Promise<PullRequestGateResult> => {
  const record = overrides.candidate ?? active;
  if (overrides.none) return { ok: true, value: { pullRequest: 7, headSha: HEAD } as never };
  return { ok: true, value: { pullRequest: 7, headSha: HEAD, candidate: record, candidateId: record.id, candidateReleaseId: 50, candidateAssetId: 70 } as never };
};

const target = ['--repo', 'team/sample', '--pr', '7', '--head', HEAD, '--candidate', 'cand-0001'];

describe('argument validation', () => {
  const download = ['download-candidate', ...target, '--profile', 'linux', '--out', 'candidate'];
  const sync = ['sync-run', ...target, '--run', RUN_ID];

  test('both commands read their flags', () => {
    expect(parseArgs(download)).toEqual({ ok: true, command: { name: 'download-candidate', repo: 'team/sample', pr: 7, head: HEAD, candidate: 'cand-0001', profile: 'linux', out: 'candidate', json: false } });
    expect(parseArgs([...sync, '--state', 's', '--json'])).toEqual({ ok: true, command: { name: 'sync-run', repo: 'team/sample', pr: 7, head: HEAD, candidate: 'cand-0001', run: RUN_ID, state: 's', json: true } });
  });

  test.each([
    ['a repository that is not owner/name', ['--repo', 'sample'], /--repo/],
    ['a repository that climbs out of the API path', ['--repo', '../..'], /--repo/],
    ['a pull request number that is not positive', ['--pr', '0'], /--pr/],
    ['a pull request number with a suffix', ['--pr', '7x'], /--pr/],
    ['a head that is not a full SHA', ['--head', 'abc123'], /--head/],
    ['an upper-case head', ['--head', 'A'.repeat(40)], /--head/],
    ['a candidate id that is a path', ['--candidate', '../cand'], /--candidate/],
  ])('both commands refuse %s', (_title, override, message) => {
    const replaced = (argv: string[]): string[] => {
      const copy = [...argv];
      const index = copy.indexOf(override[0]!);
      copy[index + 1] = override[1]!;
      return copy;
    };
    for (const argv of [download, sync]) {
      const parsed = parseArgs(replaced(argv));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(message);
    }
  });

  test('a profile that is a path, an empty --out and a run id that is a path are refused', () => {
    expect(parseArgs([...download.slice(0, -4), '--profile', '../linux', '--out', 'o'])).toMatchObject({ ok: false, error: expect.stringMatching(/--profile/) });
    expect(parseArgs([...download.slice(0, -2), '--out', ' '])).toMatchObject({ ok: false, error: expect.stringMatching(/--out/) });
    expect(parseArgs(['sync-run', ...target, '--run', '../run-20260101T000000Z-abc123'])).toMatchObject({ ok: false, error: expect.stringMatching(/--run/) });
    expect(parseArgs(['sync-run', ...target, '--run', 'run-1'])).toMatchObject({ ok: false });
  });

  test('a missing flag, an unknown flag and a repeated flag are refused', () => {
    expect(parseArgs(download.slice(0, -2))).toMatchObject({ ok: false, error: '--out is required' });
    expect(parseArgs([...sync, '--profile', 'linux'])).toMatchObject({ ok: false, error: 'unknown flag "--profile"' });
    expect(parseArgs([...sync, '--run', RUN_ID])).toMatchObject({ ok: false, error: '--run was given more than once' });
  });

  test('main reports bad arguments as exit 3, as JSON when asked, and contacts no one', async () => {
    const out = io();
    const code = await main(['download-candidate', ...target.slice(0, 2), 'nope', '--json'], out.sink, () => '.', undefined, {
      api: new Proxy({}, { get: () => { throw new Error('the network must not be used'); } }) as CiApi,
    });
    expect(code).toBe(EXIT.infrastructure);
    expect(out.log).toEqual([]);
    expect(JSON.parse(out.error[0]!)).toMatchObject({ ok: false, issues: [] });
  });
});

describe('download-candidate', () => {
  const metadata = (): Record<string, unknown> => ({
    'repositories/1': { id: 1, full_name: 'team/sample' },
    'repos/team/sample/actions/runs/5000': { id: 5000, run_attempt: 1, path: active.build.workflowPath, head_sha: active.sourceSha, conclusion: 'success', repository: { id: 1 } },
    'repos/team/sample/releases/assets/102': { id: 102, name: 'smoke_amd64.deb', state: 'uploaded', digest: `sha256:${digest}` },
    'repos/team/sample/actions/artifacts/202': { id: 202, name: 'linux', expired: false, workflow_run: { id: 5000, repository_id: 1, head_sha: active.sourceSha } },
  });
  const api = (payload: Buffer, downloaded: string[] = []): CiApi => ({
    get: async (path) => (Object.hasOwn(metadata(), path) ? { ok: true, value: metadata()[path] } : { ok: false, reason: 'not-found' }),
    list: async () => ({ ok: false, reason: 'not-found' }),
    download: async (path, destination) => { downloaded.push(path); await writeFile(destination, payload); return { ok: true, value: true }; },
    upload: async () => ({ ok: false, reason: 'unused' }),
    currentUser: async () => ({ ok: false, reason: 'unused' }),
    dispatchReconciliation: async () => ({ ok: false, reason: 'unused' }),
  });
  const argv = (out: string, extra: string[] = []): string[] => ['download-candidate', ...target, '--profile', 'linux', '--out', out, ...extra];

  test('writes the verified file and the manifest run --candidate reads, and prints them with --json', async () => {
    const dir = await makeDir();
    const downloaded: string[] = [];
    const out = io();
    const code = await main(argv('candidate', ['--json']), out.sink, () => dir, undefined, { api: api(bytes, downloaded), evaluate: evaluated() });
    expect(code).toBe(EXIT.ok);
    expect(out.error).toEqual([]);
    expect(downloaded).toEqual(['repos/team/sample/releases/assets/102']);
    const result = JSON.parse(out.log[0]!) as Record<string, unknown>;
    expect(result).toEqual({ ok: true, candidateId: 'cand-0001', profile: 'linux', manifest: join(dir, 'candidate', 'candidate.json'), artifact: join(dir, 'candidate', 'smoke_amd64.deb'), sha256: digest });
    expect(await readFile(join(dir, 'candidate', 'smoke_amd64.deb'))).toEqual(bytes);
    const manifest = parseLocalCandidate(JSON.parse(await readFile(join(dir, 'candidate', 'candidate.json'), 'utf8')) as unknown);
    expect(manifest.ok && manifest.value).toEqual({ schemaVersion: 1, id: 'cand-0001', artifacts: [{ profile: 'linux', name: 'smoke_amd64.deb', path: 'smoke_amd64.deb', sha256: digest }] });
    expect((await readdir(join(dir, 'candidate'))).sort()).toEqual(['candidate.json', 'smoke_amd64.deb']);
  });

  test('prints a plain line without --json', async () => {
    const dir = await makeDir();
    const out = io();
    expect(await main(argv('c'), out.sink, () => dir, undefined, { api: api(bytes), evaluate: evaluated() })).toBe(EXIT.ok);
    expect(out.log[0]).toContain(`verified (SHA-256 ${digest})`);
  });

  test('a hash mismatch is refused with exit 3 and nothing written', async () => {
    const dir = await makeDir();
    const out = io();
    const code = await main(argv('candidate', ['--json']), out.sink, () => dir, undefined, { api: api(Buffer.from('tampered bytes')), evaluate: evaluated() });
    expect(code).toBe(EXIT.infrastructure);
    expect(out.log).toEqual([]);
    expect(JSON.parse(out.error[0]!)).toMatchObject({ ok: false, error: expect.stringContaining('does not match the candidate') });
    expect(await readdir(join(dir, 'candidate'))).toEqual([]);
  });

  test('a candidate that is not the one reviewed is refused before anything is downloaded', async () => {
    const dir = await makeDir();
    const downloaded: string[] = [];
    const out = io();
    const code = await main(argv('candidate'), out.sink, () => dir, undefined, { api: api(bytes, downloaded), evaluate: evaluated({ candidate: { ...active, id: 'cand-0002' } }) });
    expect(code).toBe(EXIT.infrastructure);
    expect(out.error.join(' ')).toContain('cand-0002, not cand-0001');
    expect(downloaded).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  test('a pull request with no active candidate, a failed evaluation and a missing profile are refused', async () => {
    const dir = await makeDir();
    const none = io();
    expect(await main(argv('c'), none.sink, () => dir, undefined, { api: api(bytes), evaluate: evaluated({ none: true }) })).toBe(EXIT.infrastructure);
    expect(none.error.join(' ')).toContain('no active candidate');
    const failed = io();
    expect(await main(argv('c'), failed.sink, () => dir, undefined, { api: api(bytes), evaluate: async () => ({ ok: false, error: 'pull request head does not match the event head; evaluate again' }) })).toBe(EXIT.infrastructure);
    expect(failed.error.join(' ')).toContain('head does not match');
    const missing = io();
    expect(await main(['download-candidate', ...target, '--profile', 'windows', '--out', 'c'], missing.sink, () => dir, undefined, { api: api(bytes), evaluate: evaluated() })).toBe(EXIT.infrastructure);
    expect(missing.error.join(' ')).toContain('no artifact for profile windows');
    expect(await readdir(dir)).toEqual([]);
  });

  test('a candidate prepared for another commit than the reviewed head is refused, though the gate passed', async () => {
    const dir = await makeDir();
    const downloaded: string[] = [];
    for (const [argvs, name] of [[argv('candidate'), 'download'], [['sync-run', ...target, '--run', RUN_ID], 'sync']] as const) {
      const out = io();
      const stale = evaluated({ candidate: { ...active, sourceSha: SHA1.base } });
      expect(await main([...argvs], out.sink, () => dir, undefined, { api: api(bytes, downloaded), evaluate: stale }), name).toBe(EXIT.infrastructure);
      expect(out.error.join(' ')).toContain('is stale');
    }
    expect(downloaded).toEqual([]);
  });

  test('a verified file left by a crash before the manifest was written is replaced on retry', async () => {
    const dir = await makeDir();
    await mkdir(join(dir, 'candidate'));
    await writeFile(join(dir, 'candidate', 'smoke_amd64.deb'), bytes);
    const out = io();
    expect(await main(argv('candidate'), out.sink, () => dir, undefined, { api: api(bytes), evaluate: evaluated() })).toBe(EXIT.ok);
    expect((await readdir(join(dir, 'candidate'))).sort()).toEqual(['candidate.json', 'smoke_amd64.deb']);
  });

  test('a temporary download directory left by a crash is removed on retry, and unrelated files are kept', async () => {
    const dir = await makeDir();
    await mkdir(join(dir, 'candidate', '.release-qa-download-abc123'), { recursive: true });
    await writeFile(join(dir, 'candidate', '.release-qa-download-abc123', 'smoke_amd64.deb'), 'partial');
    await writeFile(join(dir, 'candidate', 'notes.txt'), 'keep');
    const out = io();
    expect(await main(argv('candidate'), out.sink, () => dir, undefined, { api: api(bytes), evaluate: evaluated() })).toBe(EXIT.ok);
    expect((await readdir(join(dir, 'candidate'))).sort()).toEqual(['candidate.json', 'notes.txt', 'smoke_amd64.deb']);
  });

  test('a different file of the same name is never replaced', async () => {
    const dir = await makeDir();
    await mkdir(join(dir, 'candidate'));
    await writeFile(join(dir, 'candidate', 'smoke_amd64.deb'), 'somebody else');
    const out = io();
    expect(await main(argv('candidate'), out.sink, () => dir, undefined, { api: api(bytes), evaluate: evaluated() })).toBe(EXIT.infrastructure);
    expect(out.error.join(' ')).toContain('not the candidate');
    expect(await readFile(join(dir, 'candidate', 'smoke_amd64.deb'), 'utf8')).toBe('somebody else');
  });

  test('an existing manifest is not replaced', async () => {
    const dir = await makeDir();
    await mkdir(join(dir, 'candidate'));
    await writeFile(join(dir, 'candidate', 'candidate.json'), 'earlier');
    const out = io();
    expect(await main(argv('candidate'), out.sink, () => dir, undefined, { api: api(bytes), evaluate: evaluated() })).toBe(EXIT.infrastructure);
    expect(out.error.join(' ')).toContain('already exists');
    expect(await readFile(join(dir, 'candidate', 'candidate.json'), 'utf8')).toBe('earlier');
  });
});

describe('sync-run', () => {
  class MemoryApi {
    assets: Array<SyncAsset & { bytes: Buffer }> = [];
    login: string | undefined = 'tester';
    role = 'write';
    failUploads = false;
    async get(path: string) { return path.includes('/permission') ? { ok: true as const, value: { permission: this.role } } : { ok: false as const, reason: 'not-found' as const }; }
    async list() { return { ok: true as const, value: this.assets.map(({ bytes: _bytes, ...asset }) => asset) }; }
    async download(path: string, destination: string) {
      const asset = this.assets.find((item) => item.id === Number(path.split('/').at(-1)));
      if (asset === undefined) return { ok: false as const, reason: 'not-found' as const };
      await writeFile(destination, asset.bytes);
      return { ok: true as const, value: true as const };
    }
    async upload(_repository: string, _releaseId: number, name: string, content: Buffer) {
      if (this.failUploads) return { ok: false as const, reason: 'HTTP 429' };
      const asset = { id: this.assets.length + 1, name, uploader: { login: this.login ?? 'tester' }, state: 'uploaded', bytes: content };
      this.assets.push(asset);
      return { ok: true as const, value: asset };
    }
    async currentUser() { return this.login === undefined ? { ok: false as const, reason: 'missing-scope' } : { ok: true as const, value: this.login }; }
    dispatchFailure: string | undefined;
    async dispatchReconciliation() { return this.dispatchFailure === undefined ? { ok: true as const, value: true as const } : { ok: false as const, reason: this.dispatchFailure }; }
  }

  /** A state directory holding one finished run of the active candidate, as `run` leaves it. */
  async function makeRun(candidateId = 'cand-0001'): Promise<string> {
    const state = await makeDir();
    const run = join(state, RUN_ID);
    await mkdir(join(run, 'evidence'), { recursive: true });
    await writeFile(join(run, 'invocation.json'), JSON.stringify({ schemaVersion: 1, project: '/p/project.json', candidate: '/c/candidate.json', profile: 'linux', suite: 'release', root: '/root', artifactSha256: SHA256.linuxPackage }));
    const events: RunEvent[] = [
      { schemaVersion: 1, id: `${RUN_ID}.e1`, recordedAt: '2026-01-01T00:00:00Z', type: 'run-started', data: { runId: RUN_ID, candidateId, profile: 'linux', machineId: 'machine-1' } },
      { schemaVersion: 1, id: `${RUN_ID}.e2`, prev: `${RUN_ID}.e1`, recordedAt: '2026-01-01T00:01:00Z', type: 'attempt-recorded', data: { attempt: { id: `${RUN_ID}.a1`, requirement: 'linux/persistence', outcome: 'passed', evidence: [] } } },
    ];
    await writeFile(join(run, 'events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    return state;
  }
  const argv = (state: string, extra: string[] = []): string[] => ['sync-run', ...target, '--run', RUN_ID, '--state', state, ...extra];

  test('uploads the report, events and evidence as the signed-in user and prints the result with --json', async () => {
    const state = await makeRun();
    const api = new MemoryApi();
    const out = io();
    const code = await main(argv(state, ['--json']), out.sink, () => '.', undefined, { api: api as unknown as CiApi, evaluate: evaluated() });
    expect(out.error).toEqual([]);
    expect(code).toBe(EXIT.ok);
    expect(JSON.parse(out.log[0]!)).toEqual({ ok: true, candidateId: 'cand-0001', runId: RUN_ID, releaseId: 50, actor: 'tester', uploaded: 3 });
    const names = api.assets.map((asset) => asset.name);
    expect(names.filter((name) => name.startsWith('qa-event-'))).toHaveLength(2);
    expect(names.filter((name) => name === `qa-report-${RUN_ID}.json`)).toHaveLength(1);
    const manifest = JSON.parse(api.assets.find((asset) => asset.name.startsWith('qa-report-'))!.bytes.toString('utf8')) as { report: { actor: string; policyDigest: string; testRevision: string } };
    expect(manifest.report).toMatchObject({ actor: 'tester', policyDigest: active.policyDigest, testRevision: active.testRevision });
    // The journal now records that GitHub acknowledged the events: the run is no longer only on this machine.
    expect(await readFile(join(state, RUN_ID, 'events.jsonl'), 'utf8')).toContain('upload-acknowledged');
  });

  test('prints a plain line without --json', async () => {
    const state = await makeRun();
    const out = io();
    expect(await main(argv(state), out.sink, () => '.', undefined, { api: new MemoryApi() as unknown as CiApi, evaluate: evaluated() })).toBe(EXIT.ok);
    expect(out.log[0]).toContain(`synced run ${RUN_ID} to candidate cand-0001`);
  });

  test('a repository without a reconcile workflow is exit 0, with a note on stderr and in --json', async () => {
    const state = await makeRun();
    const api = new MemoryApi();
    api.dispatchFailure = 'not-found';
    const out = io();
    expect(await main(argv(state), out.sink, () => '.', undefined, { api: api as unknown as CiApi, evaluate: evaluated() })).toBe(EXIT.ok);
    expect(out.error.join(' ')).toContain('has no qa-reconcile.yml workflow');
    expect(out.log[0]).toContain(`synced run ${RUN_ID}`);
    const json = io();
    expect(await main(argv(state, ['--json']), json.sink, () => '.', undefined, { api: api as unknown as CiApi, evaluate: evaluated() })).toBe(EXIT.ok);
    expect(JSON.parse(json.log[0]!)).toMatchObject({ ok: true, notice: expect.stringContaining('qa-reconcile.yml') });
  });

  test('an upload that fails is exit 3 with an honest message, and nothing is acknowledged', async () => {
    const state = await makeRun();
    const api = new MemoryApi();
    api.failUploads = true;
    const out = io();
    const code = await main(argv(state, ['--json']), out.sink, () => '.', undefined, { api: api as unknown as CiApi, evaluate: evaluated() });
    expect(code).toBe(EXIT.infrastructure);
    expect(out.log).toEqual([]);
    expect(JSON.parse(out.error[0]!)).toMatchObject({ ok: false, error: expect.stringContaining('HTTP 429') });
    expect(await readFile(join(state, RUN_ID, 'events.jsonl'), 'utf8')).not.toContain('upload-acknowledged');
  });

  test('an identity that cannot be established is refused before anything is uploaded', async () => {
    const state = await makeRun();
    const api = new MemoryApi();
    api.login = undefined;
    const out = io();
    expect(await main(argv(state), out.sink, () => '.', undefined, { api: api as unknown as CiApi, evaluate: evaluated() })).toBe(EXIT.infrastructure);
    expect(out.error.join(' ')).toMatch(/GITHUB_TOKEN of a workflow is not a user/);
    expect(api.assets).toEqual([]);
  });

  test('an uploader without write access is refused, because the gate would ignore the report', async () => {
    const state = await makeRun();
    const api = new MemoryApi();
    api.role = 'read';
    const out = io();
    expect(await main(argv(state), out.sink, () => '.', undefined, { api: api as unknown as CiApi, evaluate: evaluated() })).toBe(EXIT.infrastructure);
    expect(out.error.join(' ')).toContain('does not have write access');
    expect(api.assets).toEqual([]);
  });

  test('a run of another candidate, a missing run and a replaced candidate are refused', async () => {
    const api = new MemoryApi();
    const other = io();
    expect(await main(argv(await makeRun('cand-0009')), other.sink, () => '.', undefined, { api: api as unknown as CiApi, evaluate: evaluated() })).toBe(EXIT.infrastructure);
    expect(other.error.join(' ')).toContain('tested candidate cand-0009');
    const missing = io();
    expect(await main(argv(await makeDir()), missing.sink, () => '.', undefined, { api: api as unknown as CiApi, evaluate: evaluated() })).toBe(EXIT.infrastructure);
    expect(missing.error.join(' ')).toContain('no run at');
    const replaced = io();
    expect(await main(argv(await makeRun()), replaced.sink, () => '.', undefined, { api: api as unknown as CiApi, evaluate: evaluated({ candidate: { ...active, id: 'cand-0002' } }) })).toBe(EXIT.infrastructure);
    expect(replaced.error.join(' ')).toContain('replaced');
    expect(api.assets).toEqual([]);
  });

  test('output never contains the token, even when the real transport fails with it in its own stderr', async () => {
    // A stand-in for `gh` that fails the way a rejected call does, printing the token it was given. The real GhTransport
    // must classify that, never pass it on.
    const dir = await makeDir();
    const fakeGh = join(dir, 'gh.mjs');
    await writeFile(fakeGh, "console.error('HTTP 401 bad credentials for ' + process.env.GH_TOKEN); process.exit(1);\n");
    const previous = process.env.GH_TOKEN;
    process.env.GH_TOKEN = 'ghp_sentinel_token_value';
    try {
      const transport = new GhTransport(process.execPath, [fakeGh]) as unknown as CiApi;
      const sync = io();
      expect(await main(argv(await makeRun(), ['--json']), sync.sink, () => '.', undefined, { api: transport, evaluate: evaluated() })).toBe(EXIT.infrastructure);
      const download = io();
      expect(await main(['download-candidate', ...target, '--profile', 'linux', '--out', 'c', '--json'], download.sink, () => dir, undefined, { api: transport, evaluate: evaluated() })).toBe(EXIT.infrastructure);
      const text = [...sync.log, ...sync.error, ...download.log, ...download.error].join('\n');
      expect(text).toContain('logged-out');
      expect(text).not.toContain('ghp_sentinel_token_value');
    } finally {
      if (previous === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previous;
    }
  });
});
