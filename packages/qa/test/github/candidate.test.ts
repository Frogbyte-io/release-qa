import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCandidate } from '../../src/model/candidate.ts';
import { discoverProjects, type RepositoryApi } from '../../src/github/discover.ts';
import { GhTransport, inspectGitHubAccess, type GitHubApi } from '../../src/github/transport.ts';
import { project } from '../fixtures/records.ts';
import { candidate, SHA1, SHA256 } from '../fixtures/records.ts';
import { downloadCandidate, inspectCandidatePreparation, prepareCandidate, verifyCandidateAssets, type CandidateDownloadApi, type PreparationApi } from '../../src/github/candidate.ts';

function fakeApi(entries: Record<string, unknown>): RepositoryApi {
  return {
    async get(path) {
      return path in entries ? { ok: true, value: entries[path] } : { ok: false, reason: 'not-found' as const };
    },
    async list(path) {
      return path in entries ? { ok: true, value: entries[path] as unknown[] } : { ok: false, reason: 'not-found' as const };
    },
  };
}

const file = (value: unknown) => ({ type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(value)).toString('base64') });

describe('repository discovery', () => {
  test('finds projects across accessible repositories by parsing JSON without importing code', async () => {
    const fake = fakeApi({
      'user/repos?per_page=100&affiliation=owner,collaborator,organization_member': [
        { full_name: 'team/one', default_branch: 'main' },
        { full_name: 'team/two', default_branch: 'v2' },
      ],
      'repos/team/one/contents/qa/project.json?ref=main': file(project()),
      'repos/team/two/contents/qa/project.json?ref=v2': { type: 'file', encoding: 'base64', content: Buffer.from('not JSON').toString('base64') },
    });
    let projected: string | undefined;
    const api: RepositoryApi = { ...fake, list: async (path, projection) => { projected = projection; return fake.list(path); } };
    const result = await discoverProjects(api);
    expect(projected).toBe('.[] | {full_name,default_branch}');
    expect(result.projects.map((item) => item.repository)).toEqual(['team/one']);
    expect(result.problems).toEqual([{ repository: 'team/two', reason: 'invalid project.json' }]);
  });

  test('uses a manually supplied GitHub repository URL without scanning other repositories', async () => {
    const api = fakeApi({
      'repos/team/sample': { full_name: 'team/sample', default_branch: 'release/next' },
      'repos/team/sample/contents/qa/project.json?ref=release%2Fnext': file(project()),
    });
    const result = await discoverProjects(api, 'https://github.com/team/sample');
    expect(result.projects.map((item) => item.repository)).toEqual(['team/sample']);
    expect(result.problems).toEqual([]);
  });

  test('rejects a non-GitHub manual URL without making a request', async () => {
    const result = await discoverProjects(fakeApi({}), 'https://example.com/team/sample');
    expect(result.projects).toEqual([]);
    expect(result.problems[0]?.reason).toContain('GitHub repository URL');
  });

  test('bounds concurrent project reads and keeps discovery order', async () => {
    const repositories = Array.from({ length: 9 }, (_, i) => ({ full_name: `team/repo-${i}`, default_branch: 'main' }));
    let active = 0;
    let peak = 0;
    const api: RepositoryApi = {
      list: async () => ({ ok: true, value: repositories }),
      get: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { ok: true, value: file(project()) };
      },
    };
    const result = await discoverProjects(api);
    expect(result.projects.map((item) => item.repository)).toEqual(repositories.map((item) => item.full_name));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });
});

describe('access inspection', () => {
  const repo = { id: 7, permissions: { pull: true, push: false, admin: false }, full_name: 'team/sample' };
  test('distinguishes logged out from a read-only repository role', async () => {
    const loggedOut: GitHubApi = { auth: async () => ({ ok: false, reason: 'logged-out' }), get: async () => ({ ok: false, reason: 'logged-out' }) };
    expect(await inspectGitHubAccess('team/sample', loggedOut)).toEqual({ ok: false, reason: 'logged-out' });
    const readOnly: GitHubApi = { auth: async () => ({ ok: true, value: true }), get: async () => ({ ok: true, value: repo }) };
    expect(await inspectGitHubAccess('team/sample', readOnly)).toEqual({ ok: true, repositoryId: 7, role: 'read' });
  });

  test.each(['missing-scope', 'organization-rejected', 'not-found'] as const)('preserves %s as a distinct access problem', async (reason) => {
    const api: GitHubApi = { auth: async () => ({ ok: true, value: true }), get: async () => ({ ok: false, reason }) };
    expect(await inspectGitHubAccess('team/sample', api)).toEqual({ ok: false, reason });
  });

  test('does not report a network failure during auth as logged out', async () => {
    const api: GitHubApi = { auth: async () => ({ ok: false, reason: 'network-error' }), get: async () => { throw new Error('must not fetch'); } };
    expect(await inspectGitHubAccess('team/sample', api)).toEqual({ ok: false, reason: 'network-error' });
  });

  test('handles an empty repository API response as an access failure', async () => {
    const api: GitHubApi = { auth: async () => ({ ok: true, value: true }), get: async () => ({ ok: true, value: null }) };
    expect(await inspectGitHubAccess('team/sample', api)).toEqual({ ok: false, reason: 'insufficient-role' });
  });
});

describe('GitHub CLI transport', () => {
  test('passes API arguments without a shell and parses every paginated row', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-gh-transport-'));
    try {
      const script = join(dir, 'fake-gh.mjs');
      const recorded = join(dir, 'args.json');
      await writeFile(script, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(recorded)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ id: 1 }));
console.log(JSON.stringify({ id: 2 }));`);
      const transport = new GhTransport(process.execPath, [script]);
      expect(await transport.list('user/repos?per_page=100&affiliation=owner,collaborator,organization_member')).toEqual({
        ok: true, value: [{ id: 1 }, { id: 2 }],
      });
      expect(JSON.parse(await readFile(recorded, 'utf8'))).toEqual([
        'api', '--paginate', 'user/repos?per_page=100&affiliation=owner,collaborator,organization_member', '--jq', '.[]',
      ]);
      expect(await transport.list('user/repos?per_page=100', '.[] | {full_name,default_branch}')).toEqual({ ok: true, value: [{ id: 1 }, { id: 2 }] });
      expect(JSON.parse(await readFile(recorded, 'utf8'))).toEqual([
        'api', '--paginate', 'user/repos?per_page=100', '--jq', '.[] | {full_name,default_branch}',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('classifies an organization SSO denial without returning raw CLI output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-gh-transport-'));
    try {
      const script = join(dir, 'fake-gh.mjs');
      await writeFile(script, `console.error('HTTP 403: SAML SSO authorization required for organization; token-secret'); process.exit(1);`);
      expect(await new GhTransport(process.execPath, [script]).get('repos/team/sample')).toEqual({ ok: false, reason: 'organization-rejected' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('sends JSON writes through stdin without putting the body in arguments', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-gh-write-'));
    try {
      const script = join(dir, 'fake-gh.mjs');
      const recorded = join(dir, 'requests.jsonl');
      await writeFile(script, `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
let body = '';
if (args.includes('--input')) for await (const chunk of process.stdin) body += chunk;
appendFileSync(${JSON.stringify(recorded)}, JSON.stringify({ args, body: args.includes('--input') ? body : null }) + '\\n');
if (args.includes('--method') && args[args.indexOf('--method') + 1] === 'DELETE') process.exit(0);
console.log(JSON.stringify({ id: 17 }));`);
      const transport = new GhTransport(process.execPath, [script]);
      const body = { token: 'private-marker', expected_head_sha: SHA1.source };
      expect(await transport.post('repos/team/sample/actions/workflows/qa-prepare.yml/dispatches', body)).toEqual({ ok: true, value: { id: 17 } });
      expect(await transport.patch('repos/team/sample/pulls/9', body)).toEqual({ ok: true, value: { id: 17 } });
      expect(await transport.delete('repos/team/sample/releases/assets/17')).toEqual({ ok: true, value: null });
      const requests = (await readFile(recorded, 'utf8')).trim().split('\n').map((row) => JSON.parse(row) as { args: string[]; body: string | null });
      expect(requests.map((request) => request.args[request.args.indexOf('--method') + 1])).toEqual(['POST', 'PATCH', 'DELETE']);
      expect(requests.slice(0, 2).map((request) => JSON.parse(request.body ?? ''))).toEqual([body, body]);
      expect(requests[2]?.body).toBeNull();
      for (const request of requests) {
        expect(JSON.stringify(request.args)).not.toContain('private-marker');
        const index = request.args.indexOf('--input');
        if (index >= 0) expect(request.args[index + 1]).toBe('-');
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('classifies a rejected write without exposing its body', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-gh-write-'));
    try {
      const script = join(dir, 'fake-gh.mjs');
      await writeFile(script, `for await (const chunk of process.stdin) void chunk;
console.error('HTTP 403: permission denied; private-marker');
process.exit(1);`);
      expect(await new GhTransport(process.execPath, [script]).post('repos/team/sample/dispatches', { token: 'private-marker' })).toEqual({ ok: false, reason: 'insufficient-role' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('streams release asset bytes by ID through gh without a shell', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-gh-download-'));
    try {
      const script = join(dir, 'fake-gh.mjs');
      const recorded = join(dir, 'args.json');
      const destination = join(dir, 'asset.bin');
      await writeFile(script, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(recorded)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(Buffer.from([0, 255, 1, 254]));`);
      const result = await new GhTransport(process.execPath, [script]).download('repos/team/sample/releases/assets/101', destination);
      expect(result).toEqual({ ok: true, value: true });
      expect(await readFile(destination)).toEqual(Buffer.from([0, 255, 1, 254]));
      expect(JSON.parse(await readFile(recorded, 'utf8'))).toEqual([
        'api', '-H', 'Accept: application/octet-stream', 'repos/team/sample/releases/assets/101',
      ]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('waits for handles to close when the destination cannot be written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-gh-download-'));
    try {
      const script = join(dir, 'fake-gh.mjs');
      const destination = join(dir, 'existing.bin');
      await writeFile(script, `process.stdout.write(Buffer.alloc(1024 * 1024)); setTimeout(() => {}, 10000);`);
      await writeFile(destination, 'already here');
      const result = await new GhTransport(process.execPath, [script]).download('repos/team/sample/releases/assets/101', destination);
      expect(result).toEqual({ ok: false, reason: 'network-error' });
      expect(await readFile(destination, 'utf8')).toBe('already here');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('candidate asset identity', () => {
  const build = { id: 5000, run_attempt: 1, path: '.github/workflows/qa-prepare.yml', head_sha: SHA1.source, conclusion: 'success', repository: { id: 1 } };
  const releases = [
    { id: 101, name: 'Release QA Smoke_0.1.0_x64-setup.exe', state: 'uploaded', digest: `sha256:${SHA256.windowsInstaller}` },
    { id: 102, name: 'release-qa-smoke_0.1.0_amd64.deb', state: 'uploaded', digest: `sha256:${SHA256.linuxPackage}` },
  ];
  const actions = [
    { id: 201, name: 'windows', expired: false, workflow_run: { id: 5000, repository_id: 1, head_sha: SHA1.source } },
    { id: 202, name: 'linux', expired: false, workflow_run: { id: 5000, repository_id: 1, head_sha: SHA1.source } },
  ];

  test('accepts exact asset IDs and hashes from the recorded successful build', () => {
    expect(verifyCandidateAssets(candidate(), build, releases, actions)).toEqual({ ok: true, issues: [] });
  });

  test('allows an expired Actions archive when the exact draft asset survives with its hash', () => {
    expect(verifyCandidateAssets(candidate(), build, releases, [{ ...actions[0]!, expired: true }, actions[1]!])).toEqual({ ok: true, issues: [] });
  });

  test('rejects a same-name release asset with different bytes', () => {
    const wrong = { ...releases[0]!, digest: `sha256:${'d'.repeat(64)}` };
    expect(verifyCandidateAssets(candidate(), build, [wrong, releases[1]!], actions).ok).toBe(false);
  });

  test('rejects the wrong workflow, run attempt, or source', () => {
    for (const changed of [
      { ...build, path: '.github/workflows/other.yml' },
      { ...build, path: 'unrelated/.github/workflows/qa-prepare.yml' },
      { ...build, run_attempt: 2 },
      { ...build, head_sha: SHA1.base },
      { ...build, conclusion: 'cancelled' },
    ]) expect(verifyCandidateAssets(candidate(), changed, releases, actions).ok).toBe(false);
  });

  test('rejects an Actions archive associated with another run even if its name matches', () => {
    const wrong = { ...actions[0]!, workflow_run: { ...actions[0]!.workflow_run, id: 9999 } };
    expect(verifyCandidateAssets(candidate(), build, releases, [wrong, actions[1]!]).ok).toBe(false);
  });

  test('distinguishes a trusted workflow revision from the packaged PR source', () => {
    const selected = candidate({ build: { ...candidate().build, workflowHeadSha: SHA1.base } });
    const trustedRun = { ...build, head_sha: SHA1.base, event: 'workflow_dispatch', display_title: `qa-prepare PR #${selected.pullRequest} ${selected.sourceSha}` };
    const trustedArtifacts = actions.map((entry) => ({ ...entry, workflow_run: { ...entry.workflow_run, head_sha: SHA1.base } }));
    expect(parseCandidate(selected).ok).toBe(true);
    expect(verifyCandidateAssets(selected, trustedRun, releases, trustedArtifacts).ok).toBe(true);
    expect(verifyCandidateAssets(selected, build, releases, trustedArtifacts).ok).toBe(false);
    expect(verifyCandidateAssets(selected, trustedRun, releases, actions).ok).toBe(false);
    expect(verifyCandidateAssets({ ...selected, sourceSha: SHA1.tree }, trustedRun, releases, trustedArtifacts).ok).toBe(false);
  });
});

describe('downloading a selected candidate artifact', () => {
  const bytes = Buffer.from('the exact installer bytes');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const selected = candidate({ artifacts: [{ profile: 'windows', name: 'setup.exe', sha256: digest, assetId: 101, actionsArtifactId: 201 }] });
  const metadata: Record<string, unknown> = {
    'repositories/1': { id: 1, full_name: 'team/sample' },
    'repos/team/sample/actions/runs/5000': { id: 5000, run_attempt: 1, path: selected.build.workflowPath, head_sha: selected.sourceSha, conclusion: 'success', repository: { id: 1 } },
    'repos/team/sample/releases/assets/101': { id: 101, name: 'setup.exe', state: 'uploaded', digest: `sha256:${digest}` },
    'repos/team/sample/actions/artifacts/201': { id: 201, name: 'windows', expired: false, workflow_run: { id: 5000, repository_id: 1, head_sha: selected.sourceSha } },
  };
  const api = (payload: Buffer, overrides: Record<string, unknown> = {}): CandidateDownloadApi => ({
    get: async (path) => {
      const entries = { ...metadata, ...overrides };
      return Object.hasOwn(entries, path) ? { ok: true, value: entries[path] } : { ok: false, reason: 'not-found' };
    },
    download: async (_path, destination) => { await writeFile(destination, payload); return { ok: true, value: true }; },
  });

  test('uses the recorded asset ID and returns only bytes matching its inner SHA-256', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-download-'));
    try {
      const paths: string[] = [];
      const client = api(bytes);
      const result = await downloadCandidate(selected, 'windows', dir, {
        ...client,
        download: async (path, destination) => { paths.push(path); return client.download(path, destination); },
      });
      expect(result).toMatchObject({ ok: true, path: join(dir, 'setup.exe') });
      expect(paths).toEqual(['repos/team/sample/releases/assets/101']);
      expect(await readFile(join(dir, 'setup.exe'))).toEqual(bytes);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('rejects altered download bytes and removes the partial file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-download-'));
    try {
      const result = await downloadCandidate(selected, 'windows', dir, api(Buffer.from('different bytes')));
      expect(result).toMatchObject({ ok: false });
      expect(!result.ok && result.error).toMatch(/SHA-256/);
      expect(await readdir(dir)).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('removes the temporary file after a download transport failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-download-'));
    try {
      const client = api(bytes);
      const result = await downloadCandidate(selected, 'windows', dir, {
        ...client,
        download: async (_path, destination) => { await writeFile(destination, 'partial'); return { ok: false, reason: 'network-error' }; },
      });
      expect(result).toMatchObject({ ok: false });
      expect(!result.ok && result.error).toContain('asset 101');
      expect(await readdir(dir)).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('rejects metadata for another asset before downloading anything', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-download-'));
    try {
      let downloaded = false;
      const client = api(bytes, { 'repos/team/sample/releases/assets/101': { id: 999, name: 'setup.exe', state: 'uploaded', digest: `sha256:${digest}` } });
      const result = await downloadCandidate(selected, 'windows', dir, {
        ...client,
        download: async (path, destination) => { downloaded = true; return client.download(path, destination); },
      });
      expect(result).toMatchObject({ ok: false });
      expect(downloaded).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('candidate preparation preflight', () => {
  const policy = { releaseBranchPrefix: 'release/', releaseLabel: 'release', releaseFiles: ['VERSION'], required: ['windows/persistence'] };
  const repository = { id: 7, permissions: { pull: true, push: true }, full_name: 'team/sample' };
  const pr = { number: 9, state: 'open', head: { sha: SHA1.source, ref: 'feature/version', repo: { id: 7 } }, base: { ref: 'main', repo: { id: 7 } }, labels: [] };
  const records: Record<string, unknown> = {
    'repos/team/sample': repository,
    'repos/team/sample/pulls/9': pr,
    'repos/team/sample/branches/main': { commit: { sha: SHA1.base } },
    [`repos/team/sample/contents/qa/policy.json?ref=${SHA1.base}`]: file(policy),
    'repos/team/sample/pulls/9/files?per_page=100': [{ filename: 'VERSION' }],
  };
  const api = (overrides: Record<string, unknown> = {}): PreparationApi => ({
    auth: async () => ({ ok: true, value: true }),
    get: async (path) => {
      const entries = { ...records, ...overrides };
      return Object.hasOwn(entries, path) ? { ok: true, value: entries[path] } : { ok: false, reason: 'not-found' };
    },
    list: async (path) => {
      const entries = { ...records, ...overrides };
      return Object.hasOwn(entries, path) ? { ok: true, value: entries[path] as unknown[] } : { ok: false, reason: 'not-found' };
    },
  });

  test('recognizes a changed release file despite a removed label and records the trusted base tip', async () => {
    const result = await inspectCandidatePreparation('team/sample', 9, SHA1.source, api());
    expect(result).toMatchObject({ ok: true, repositoryId: 7, sourceSha: SHA1.source, baseSha: SHA1.base, releaseIntent: ['release file changed: VERSION'] });
    expect(result.ok && result.policyDigest).toBe(createHash('sha256').update(JSON.stringify(policy)).digest('hex'));
  });

  test('dispatches the trusted default-branch workflow with exact preflight identities', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const client = api({ 'repos/team/sample': { ...repository, default_branch: 'main' } });
    const result = await prepareCandidate('team/sample', 9, SHA1.source, {
      ...client,
      post: async (path, body) => { calls.push({ path, body }); return { ok: true, value: { workflow_run_id: 123 } }; },
    });
    expect(result).toMatchObject({ ok: true, runId: 123, sourceSha: SHA1.source, workflowHeadSha: SHA1.base });
    expect(calls).toEqual([{ path: 'repos/team/sample/actions/workflows/qa-prepare.yml/dispatches', body: {
      ref: 'main', inputs: { pr_number: '9', expected_head: SHA1.source, expected_base: SHA1.base,
        policy_digest: createHash('sha256').update(JSON.stringify(policy)).digest('hex') },
    } }]);
  });

  test('does not dispatch a changed head or ambiguous workflow response', async () => {
    let dispatched = 0;
    const client = api({ 'repos/team/sample': { ...repository, default_branch: 'main' } });
    const dispatch = { ...client, post: async () => { dispatched++; return { ok: true as const, value: {} }; } };
    expect((await prepareCandidate('team/sample', 9, SHA1.base, dispatch)).ok).toBe(false);
    expect(dispatched).toBe(0);
    expect((await prepareCandidate('team/sample', 9, SHA1.source, dispatch)).ok).toBe(false);
    expect(dispatched).toBe(1);
  });

  test('refuses a changed PR head before building or selecting a candidate', async () => {
    const result = await inspectCandidatePreparation('team/sample', 9, SHA1.base, api());
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toContain('head');
  });

  test('refuses a PR with no trusted release intent', async () => {
    const result = await inspectCandidatePreparation('team/sample', 9, SHA1.source, api({ 'repos/team/sample/pulls/9/files?per_page=100': [] }));
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toContain('release intent');
  });

  test('refuses policy metadata that is not a base64 file from the target branch', async () => {
    const result = await inspectCandidatePreparation('team/sample', 9, SHA1.source, api({
      [`repos/team/sample/contents/qa/policy.json?ref=${SHA1.base}`]: { type: 'symlink', content: file(policy).content },
    }));
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toContain('trusted QA policy');
  });

  test('refuses a forked PR or a read-only operator', async () => {
    const fork = await inspectCandidatePreparation('team/sample', 9, SHA1.source, api({ 'repos/team/sample/pulls/9': { ...pr, head: { ...pr.head, repo: { id: 8 } } } }));
    expect(fork).toMatchObject({ ok: false });
    const reader = await inspectCandidatePreparation('team/sample', 9, SHA1.source, api({ 'repos/team/sample': { ...repository, permissions: { pull: true, push: false } } }));
    expect(reader).toMatchObject({ ok: false });
  });

  test('refuses preparation when the target branch moves during preflight', async () => {
    const client = api();
    let branchReads = 0;
    const result = await inspectCandidatePreparation('team/sample', 9, SHA1.source, {
      ...client,
      get: async (path) => {
        if (path === 'repos/team/sample/branches/main' && ++branchReads === 2) return { ok: true, value: { commit: { sha: SHA1.tree } } };
        return client.get(path);
      },
    });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toContain('target branch changed');
  });

  test('refuses when a release label is removed during preflight', async () => {
    const labeled = { ...pr, labels: [{ name: 'release' }] };
    const client = api({
      'repos/team/sample/pulls/9': labeled,
      'repos/team/sample/pulls/9/files?per_page=100': [],
    });
    let reads = 0;
    const result = await inspectCandidatePreparation('team/sample', 9, SHA1.source, {
      ...client,
      get: async (path) => path === 'repos/team/sample/pulls/9' && ++reads === 2 ? { ok: true, value: pr } : client.get(path),
    });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toContain('labels changed');
  });

  test('accepts a release branch as the sole release-intent signal', async () => {
    const branch = { ...pr, head: { ...pr.head, ref: 'release/1.2.3' } };
    const result = await inspectCandidatePreparation('team/sample', 9, SHA1.source, api({
      'repos/team/sample/pulls/9': branch,
      'repos/team/sample/pulls/9/files?per_page=100': [],
    }));
    expect(result).toMatchObject({ ok: true, releaseIntent: ['release branch'] });
  });

  test('refuses a PR that closes or changes head during the final read', async () => {
    for (const second of [{ ...pr, state: 'closed' }, { ...pr, head: { ...pr.head, sha: SHA1.tree } }]) {
      const client = api();
      let reads = 0;
      const result = await inspectCandidatePreparation('team/sample', 9, SHA1.source, {
        ...client,
        get: async (path) => path === 'repos/team/sample/pulls/9' && ++reads === 2 ? { ok: true, value: second } : client.get(path),
      });
      expect(result).toMatchObject({ ok: false });
      expect(!result.ok && result.error).toContain('during candidate preparation preflight');
    }
  });
});
