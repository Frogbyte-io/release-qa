import { describe, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverProjects, type RepositoryApi } from '../../src/github/discover.ts';
import { GhTransport, inspectGitHubAccess, type GitHubApi } from '../../src/github/transport.ts';
import { project } from '../fixtures/records.ts';

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
    const api = fakeApi({
      'user/repos?per_page=100&affiliation=owner,collaborator,organization_member': [
        { full_name: 'team/one', default_branch: 'main' },
        { full_name: 'team/two', default_branch: 'v2' },
      ],
      'repos/team/one/contents/qa/project.json?ref=main': file(project()),
      'repos/team/two/contents/qa/project.json?ref=v2': { type: 'file', encoding: 'base64', content: Buffer.from('not JSON').toString('base64') },
    });
    const result = await discoverProjects(api);
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
});

describe('access inspection', () => {
  const repo = { id: 7, permissions: { pull: true, push: false, admin: false }, full_name: 'team/sample' };
  test('distinguishes logged out from a read-only repository role', async () => {
    const loggedOut: GitHubApi = { auth: async () => false, get: async () => ({ ok: false, reason: 'logged-out' }) };
    expect(await inspectGitHubAccess('team/sample', loggedOut)).toEqual({ ok: false, reason: 'logged-out' });
    const readOnly: GitHubApi = { auth: async () => true, get: async () => ({ ok: true, value: repo }) };
    expect(await inspectGitHubAccess('team/sample', readOnly)).toEqual({ ok: true, repositoryId: 7, role: 'read' });
  });

  test.each(['missing-scope', 'organization-rejected', 'not-found'] as const)('preserves %s as a distinct access problem', async (reason) => {
    const api: GitHubApi = { auth: async () => true, get: async () => ({ ok: false, reason }) };
    expect(await inspectGitHubAccess('team/sample', api)).toEqual({ ok: false, reason });
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
});
