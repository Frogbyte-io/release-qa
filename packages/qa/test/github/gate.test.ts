import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { Evaluation } from '../../src/model/evaluate.ts';
import { evaluatePullRequest, hasReleaseIntent, renderQaSection, type GateApi } from '../../src/github/gate.ts';
import { ensureManagedSections, proposeReleaseNotes, readManagedSection, updateManagedSections, updatePullRequestBody } from '../../src/github/pull-request.ts';
import { candidate, exception, project, SHA1 } from '../fixtures/records.ts';

const evaluation = (changes: Partial<Evaluation> = {}): Evaluation => ({
  readiness: 'passed', reasons: [], excused: [], acceptedReportIds: ['report-1'], exceptionIds: [], ignored: [], ...changes,
});

describe('managed PR sections', () => {
  const body = 'Intro 🌍\n\n<!-- release-notes:start -->\nHuman-edited notes\n<!-- release-notes:end -->\n\n<!-- qa:start -->\nOld QA\n<!-- qa:end -->\n\nFooter';

  test('replaces only the named generated section and keeps Unicode and human notes intact', () => {
    expect(updateManagedSections(body, [{ name: 'qa', content: 'New QA ✓', expected: 'Old QA' }])).toEqual({
      ok: true,
      body: body.replace('Old QA', 'New QA ✓'),
    });
  });

  test('refuses a concurrent or manual change inside a section', () => {
    expect(updateManagedSections(body, [{ name: 'qa', content: 'New QA', expected: 'Prior QA' }])).toEqual({
      ok: false, error: 'qa section changed since it was read',
    });
  });

  test.each([
    ['missing end', '<!-- qa:start -->\nOld QA'],
    ['duplicate start', '<!-- qa:start --><!-- qa:start --><!-- qa:end -->'],
    ['reversed', '<!-- qa:end --><!-- qa:start -->'],
  ])('refuses %s markers instead of replacing the PR body', (_case, malformed) => {
    expect(updateManagedSections(malformed, [{ name: 'qa', content: 'New QA' }]).ok).toBe(false);
  });

  test('preserves CRLF around a generated section', () => {
    const crlf = '<!-- qa:start -->\r\nOld QA\r\n<!-- qa:end -->';
    expect(updateManagedSections(crlf, [{ name: 'qa', content: 'New QA' }])).toEqual({
      ok: true, body: '<!-- qa:start -->\r\nNew QA\r\n<!-- qa:end -->',
    });
  });

  test('refuses nested sections and repeated names', () => {
    const nested = '<!-- qa:start -->\n<!-- release-notes:start -->\nNotes\n<!-- release-notes:end -->\n<!-- qa:end -->';
    expect(updateManagedSections(nested, [
      { name: 'qa', content: 'QA' }, { name: 'release-notes', content: 'Notes' },
    ])).toEqual({ ok: false, error: 'managed sections overlap' });
    expect(updateManagedSections(body, [{ name: 'qa', content: 'A' }, { name: 'qa', content: 'B' }])).toEqual({
      ok: false, error: 'invalid or repeated section name: qa',
    });
  });

  test('refuses invalid layout and markers injected into another managed section', () => {
    expect(updateManagedSections('<!-- qa:start -->Old QA<!-- qa:end -->', [{ name: 'qa', content: 'New QA' }]).ok).toBe(false);
    expect(updateManagedSections(body, [
      { name: 'release-notes', content: '<!-- qa:start -->\nInjected\n<!-- qa:end -->' },
      { name: 'qa', content: 'New QA' },
    ]).ok).toBe(false);
  });

  test('adds absent marker blocks after consumer prose and reads their exact contents', () => {
    const initialized = ensureManagedSections('Consumer template 🌱', ['release-notes', 'qa']);
    expect(initialized).toEqual({ ok: true, body: 'Consumer template 🌱\n\n<!-- release-notes:start -->\n\n<!-- release-notes:end -->\n\n<!-- qa:start -->\n\n<!-- qa:end -->' });
    if (initialized.ok) {
      expect(readManagedSection(initialized.body, 'release-notes')).toEqual({ ok: true, content: '' });
    }
  });

  test('does not bootstrap a partially present or duplicated marker pair', () => {
    expect(ensureManagedSections('<!-- qa:start -->', ['qa']).ok).toBe(false);
    expect(ensureManagedSections('<!-- qa:start --><!-- qa:start --><!-- qa:end -->', ['qa']).ok).toBe(false);
  });

  test('rejects same-line prose after an end marker when reading and updating a section', () => {
    const malformed = '<!-- qa:start -->\nOld QA\n<!-- qa:end -->prose';
    expect(readManagedSection(malformed, 'qa').ok).toBe(false);
    expect(updateManagedSections(malformed, [{ name: 'qa', content: 'New QA' }]).ok).toBe(false);
  });

  test('does not overwrite prose edited after the first read', async () => {
    let reads = 0;
    const writes: unknown[] = [];
    const api = {
      get: async () => ({ ok: true as const, value: { body: ++reads === 1 ? body : body.replace('Footer', 'New human prose') } }),
      patch: async (_path: string, value: unknown) => { writes.push(value); return { ok: true as const, value }; },
    };
    await expect(updatePullRequestBody(api, 'owner/repo', 4, [{ name: 'qa', content: 'New QA', expected: 'Old QA' }])).resolves.toEqual({
      ok: false, error: 'PR body changed while the managed update was being prepared',
    });
    expect(writes).toEqual([]);
  });

  test('patches the fresh PR body when no concurrent edit occurred', async () => {
    let reads = 0;
    const writes: Array<{ body?: unknown }> = [];
    const api = {
      get: async () => ({ ok: true as const, value: { body: ++reads <= 2 ? body : '' } }),
      patch: async (_path: string, value: { body?: unknown }) => { writes.push(value); return { ok: true as const, value }; },
    };
    await expect(updatePullRequestBody(api, 'owner/repo', 4, [{ name: 'qa', content: 'New QA', expected: 'Old QA' }])).resolves.toEqual({ ok: true, body: body.replace('Old QA', 'New QA') });
    expect(writes).toEqual([{ body: body.replace('Old QA', 'New QA') }]);
  });
});

describe('release note proposals', () => {
  test('proposes only merged PRs since the latest release and includes linked issues', async () => {
    const api = {
      get: async (path: string) => path.endsWith('/releases/latest')
        ? { ok: true as const, value: { tag_name: 'v2.0.0', published_at: '2026-09-01T00:00:00Z' } }
        : path.endsWith('/owner/repo')
          ? { ok: true as const, value: { default_branch: 'main' } }
        : { ok: false as const, reason: 'not-found' },
      list: async () => ({ ok: true as const, value: [
        { number: 12, title: 'Add orchard mode', body: 'Closes #34; related to team/other#35 and https://github.com/owner/repo/issues/36', merged_at: '2026-09-10T12:00:00Z', labels: [{ name: 'enhancement' }] },
        { number: 11, title: 'Fix old installer', body: 'Fixes #29', merged_at: '2026-08-20T12:00:00Z', labels: [{ name: 'bug' }] },
        { number: 13, title: 'Open work', body: '', merged_at: null, labels: [] },
      ] }),
    };
    await expect(proposeReleaseNotes(api, 'owner/repo')).resolves.toEqual({
      ok: true,
      tag: 'v2.0.0',
      content: '- Add orchard mode (#12; #34, team/other#35, #36)',
      pullRequests: [12],
    });
  });
});

describe('QA section', () => {
  test('shows a passed evaluation, plural reports and why records were ignored', () => {
    const output = renderQaSection(evaluation({
      acceptedReportIds: ['report-1', 'report-2'],
      ignored: [{ kind: 'report', id: 'replayed', reason: 'duplicate-replay' }, { kind: 'report', id: 'conflict', reason: 'conflicting-report-id' }],
    }));
    expect(output).toContain('QA: Passed');
    expect(output).toContain('2 accepted reports');
    expect(output).toContain('duplicate-replay');
    expect(output).toContain('conflicting-report-id');
    expect(output).not.toContain('stale or ineligible');
  });

  test('shows every blocking reason and the accepted report count', () => {
    const output = renderQaSection(evaluation({ readiness: 'blocked', reasons: [
      { code: 'head-changed', expected: 'old', actual: 'new' },
      { code: 'missing-result', requirement: 'windows/persistence' },
    ] }));
    expect(output).toContain('Blocked');
    expect(output).toContain('windows/persistence');
    expect(output).toContain('old');
    expect(output).toContain('new');
    expect(output).toContain('1 accepted report');
  });

  test('makes approved exceptions conspicuous and escapes record text', () => {
    const output = renderQaSection(evaluation({
      readiness: 'approved-with-exceptions',
      excused: [{ reason: { code: 'missing-result', requirement: 'windows/<unsafe>|data' }, exceptionId: 'ex-1' }],
      exceptionIds: ['ex-1'],
    }));
    expect(output).toContain('Approved with exceptions');
    expect(output).toContain('&lt;unsafe&gt;');
    expect(output).toContain('\\|data');
    expect(output).toContain('ex-1');
    expect(output).not.toContain('<unsafe>');
  });
});

describe('release intent', () => {
  const policy = { releaseBranchPrefix: 'release/', releaseLabel: 'release', releaseFiles: ['VERSION'] };
  test('keeps a PR gated when its release label is removed but it changes VERSION', () => {
    expect(hasReleaseIntent({ branch: 'feature/update', labels: [], files: ['VERSION'] }, policy)).toEqual(['release file changed: VERSION']);
  });
  test('recognizes branch and label signals and leaves ordinary changes ungated', () => {
    expect(hasReleaseIntent({ branch: 'release/2.0', labels: [], files: [] }, policy)).toEqual(['release branch']);
    expect(hasReleaseIntent({ branch: 'feature/update', labels: ['release'], files: [] }, policy)).toEqual(['release label']);
    expect(hasReleaseIntent({ branch: 'feature/update', labels: [], files: ['README.md'] }, policy)).toEqual([]);
  });
});

describe('live pull request evaluation', () => {
  test('blocks a release candidate with missing required reports using the shared evaluator', async () => {
    const api = makeGateApi();
    const result = await evaluatePullRequest('owner/repo', 7, api);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidateId).toBe('cand-0001');
    expect(result.value.evaluation.readiness).toBe('blocked');
    expect(result.value.summary).toContain('windows/persistence');
    expect(result.value.summary).toContain('windows/device-feel');
  });

  test('loads a brokered draft release id directly without listing draft releases', async () => {
    const api = makeGateApi();
    const list = api.list.bind(api);
    api.list = async (path) => path === 'repos/owner/repo/releases?per_page=100'
      ? { ok: false, reason: 'missing-scope' }
      : list(path);
    const result = await evaluatePullRequest('owner/repo', 7, api, SHA1.source, 50);
    expect(result.ok && result.value.candidateId).toBe('cand-0001');
  });

  test('rejects a delayed green result when the PR head changes before revalidation', async () => {
    const api = makeGateApi({ changeHeadOnSecondRead: true });
    await expect(evaluatePullRequest('owner/repo', 7, api)).resolves.toEqual({ ok: false, error: 'pull request or target branch changed during evaluation', markers: { releaseNotes: 'release-notes', qa: 'qa' } });
  });

  test('rejects an API response that still shows the pre-push head from the workflow event', async () => {
    await expect(evaluatePullRequest('owner/repo', 7, makeGateApi(), SHA1.tree)).resolves.toEqual({ ok: false, error: 'pull request head does not match the event head; evaluate again' });
  });

  test('blocks a candidate prepared against a stale policy digest', async () => {
    const api = makeGateApi({ wrongPolicyDigest: true });
    await expect(evaluatePullRequest('owner/repo', 7, api)).resolves.toEqual({ ok: false, error: 'candidate was prepared against a different QA policy; prepare it again', markers: { releaseNotes: 'release-notes', qa: 'qa' } });
  });

  test('rechecks target ref and repository identities before a green decision', async () => {
    await expect(evaluatePullRequest('owner/repo', 7, makeGateApi({ changeBaseOnSecondRead: true }))).resolves.toEqual({ ok: false, error: 'pull request or target branch changed during evaluation', markers: { releaseNotes: 'release-notes', qa: 'qa' } });
  });

  test('does not pass a non-release PR when a release label is added during evaluation', async () => {
    await expect(evaluatePullRequest('owner/repo', 7, makeGateApi({ nonReleaseBranch: true, addReleaseLabelDuringRecheck: true }))).resolves.toEqual({ ok: false, error: 'release intent changed during evaluation; evaluate again', markers: { releaseNotes: 'release-notes', qa: 'qa' } });
  });

  test('shows an authenticated maintainer exception prominently', async () => {
    const result = await evaluatePullRequest('owner/repo', 7, makeGateApi({ exceptionAsset: true }));
    expect(result.ok && result.value.evaluation.readiness).toBe('approved-with-exceptions');
    expect(result.ok && result.value.summary).toContain('Approved with exceptions');
  });

  test('does not accept an exception whose claimed actor differs from its uploader', async () => {
    const result = await evaluatePullRequest('owner/repo', 7, makeGateApi({ exceptionAsset: true, exceptionActorMismatch: true }));
    expect(result.ok && result.value.evaluation.readiness).toBe('blocked');
    expect(result.ok && result.value.evaluation.ignored).toContainEqual({ kind: 'exception', id: 'exception-0001', reason: 'unauthorized-exception' });
  });

  test('rechecks exception authority immediately before publishing an approved result', async () => {
    const result = await evaluatePullRequest('owner/repo', 7, makeGateApi({ exceptionAsset: true, revokeExceptionPermission: true }));
    expect(result.ok && result.value.evaluation.readiness).toBe('blocked');
  });
});

function makeGateApi(options: { changeHeadOnSecondRead?: boolean; changeBaseOnSecondRead?: boolean; wrongPolicyDigest?: boolean; exceptionAsset?: boolean; exceptionActorMismatch?: boolean; revokeExceptionPermission?: boolean; nonReleaseBranch?: boolean; addReleaseLabelDuringRecheck?: boolean } = {}): GateApi {
  const headSha = SHA1.source;
  const baseSha = SHA1.base;
  const policy = { releaseBranchPrefix: 'release/', releaseLabel: 'release', releaseFiles: ['VERSION'], required: ['windows/persistence', 'windows/device-feel'] };
  const policyBytes = Buffer.from(JSON.stringify(policy));
  const candidateRecord = { ...candidate({ repositoryId: 1, pullRequest: 7, sourceSha: headSha, baseSha }), policyDigest: options.wrongPolicyDigest ? '0'.repeat(64) : createHashFor(policyBytes) };
  const candidateAsset = { id: 70, name: 'candidate.json', state: 'uploaded', uploader: { login: 'maintainer' } };
  const exceptionAsset = { id: 71, name: 'qa-exception-ex1.json', state: 'uploaded', uploader: { login: 'maintainer' } };
  const assets = [candidateAsset, ...(options.exceptionAsset ? [exceptionAsset] : [])];
  const release = { id: 50, name: 'QA PR #7', draft: true, assets };
  let pullReads = 0;
  return {
    currentUser: async () => ({ ok: true, value: 'maintainer' }),
    upload: async () => ({ ok: false, reason: 'unused' }),
    dispatchReconciliation: async () => ({ ok: true, value: true }),
    get: async (path) => {
      if (path === 'repos/owner/repo/pulls/7') {
        pullReads += 1;
        return { ok: true, value: { state: 'open', head: { sha: options.changeHeadOnSecondRead && pullReads > 1 ? SHA1.tree : headSha, ref: options.nonReleaseBranch ? 'feature/update' : 'release/orbit-orchard-0.1.0', repo: { id: 1 } }, base: { ref: options.changeBaseOnSecondRead && pullReads > 1 ? 'release/2.0' : 'main', repo: { id: 1 } }, labels: options.addReleaseLabelDuringRecheck && pullReads > 1 ? [{ name: 'release' }] : [] } };
      }
      if (path === 'repos/owner/repo/branches/main') return { ok: true, value: { commit: { sha: baseSha } } };
      if (path === `repos/owner/repo/contents/qa/policy.json?ref=${baseSha}`) return { ok: true, value: { type: 'file', encoding: 'base64', content: policyBytes.toString('base64') } };
      if (path === `repos/owner/repo/contents/qa/project.json?ref=${baseSha}`) return { ok: true, value: { type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(project())).toString('base64') } };
      if (path === 'repos/owner/repo/releases/50') return { ok: true, value: release };
      if (path === 'repos/owner/repo/collaborators/maintainer/permission') {
        return { ok: true, value: { permission: options.revokeExceptionPermission && pullReads > 1 ? 'read' : 'admin' } };
      }
      return { ok: false, reason: 'not-found' };
    },
    list: async (path) => {
      if (path === 'repos/owner/repo/pulls/7/files?per_page=100') return { ok: true, value: [{ filename: options.nonReleaseBranch ? 'README.md' : 'VERSION' }] };
      if (path === 'repos/owner/repo/releases?per_page=100') return { ok: true, value: [release] };
      if (path === 'repos/owner/repo/releases/50/assets?per_page=100') return { ok: true, value: assets };
      return { ok: false, reason: 'not-found' };
    },
    download: async (path, destination) => {
      if (path.endsWith('/70')) { await writeFile(destination, JSON.stringify(candidateRecord)); return { ok: true, value: true }; }
      if (path.endsWith('/71')) {
        const value = exception({ candidateId: candidateRecord.id, requirements: ['windows/persistence', 'windows/device-feel'], actor: options.exceptionActorMismatch ? 'other-user' : 'maintainer' });
        await writeFile(destination, JSON.stringify(value));
        return { ok: true, value: true };
      }
      return { ok: false, reason: 'not-found' };
    },
  };
}

function createHashFor(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
