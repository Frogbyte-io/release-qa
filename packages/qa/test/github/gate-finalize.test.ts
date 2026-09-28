import { describe, expect, test } from 'vitest';
import { finalizeGateResult, type DeferredGateResult, type GateFinalizeApi } from '../../src/github/gate-finalize.ts';

const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const POLICY = Buffer.from(JSON.stringify({ releaseBranchPrefix: 'release/', releaseLabel: 'release', releaseFiles: ['VERSION'] })).toString('base64');

describe('deferred gate finalization', () => {
  test('publishes success only after the candidate, PR head, and base still match', async () => {
    const api = makeApi();
    const result = await finalizeGateResult('owner/repo', 7, SHA, passingResult(), api);

    expect(result).toMatchObject({ ok: true, state: 'success' });
    expect(api.statuses).toEqual([{ state: 'success', context: 'release-qa', description: 'QA passed for PR #7' }]);
  });

  test('publishes failure when the active candidate changed after evaluation', async () => {
    const api = makeApi({ candidateAssetId: 71 });
    const result = await finalizeGateResult('owner/repo', 7, SHA, passingResult(), api);

    expect(result).toMatchObject({ ok: true, state: 'failure' });
    expect(api.statuses[0]?.description).toContain('candidate changed');
  });

  test('preserves an evaluator failure without turning it green', async () => {
    const api = makeApi();
    const result = await finalizeGateResult('owner/repo', 7, SHA, { ...passingResult(), state: 'failure', description: 'QA blocked: missing evidence', summary: 'missing evidence' }, api);

    expect(result).toMatchObject({ ok: true, state: 'failure', summary: 'missing evidence' });
    expect(api.statuses[0]?.state).toBe('failure');
  });

  test('fails closed when the result artifact is malformed', async () => {
    const api = makeApi();
    const result = await finalizeGateResult('owner/repo', 7, SHA, { schemaVersion: 2 }, api);

    expect(result).toMatchObject({ ok: true, state: 'failure' });
    expect(api.statuses[0]?.description).toContain('missing or invalid');
  });

  test('fails closed when the result artifact is missing', async () => {
    const api = makeApi();
    const result = await finalizeGateResult('owner/repo', 7, SHA, null, api);

    expect(result).toMatchObject({ ok: true, state: 'failure' });
    expect(api.statuses[0]?.description).toContain('missing or invalid');
  });

  test('publishes failure when the PR head changed after evaluation', async () => {
    const api = makeApi({ headSha: 'c'.repeat(40) });
    const result = await finalizeGateResult('owner/repo', 7, SHA, passingResult(), api);

    expect(result).toMatchObject({ ok: true, state: 'failure' });
    expect(api.statuses[0]?.description).toContain('PR head changed');
  });

  test('publishes failure when the target branch changed after evaluation', async () => {
    const api = makeApi({ baseSha: 'c'.repeat(40) });
    const result = await finalizeGateResult('owner/repo', 7, SHA, passingResult(), api);

    expect(result).toMatchObject({ ok: true, state: 'failure' });
    expect(api.statuses[0]?.description).toContain('target branch changed');
  });

  test('keeps an ordinary PR green while release intent remains absent', async () => {
    const api = makeApi({ branch: 'feature/update' });
    const { candidateReleaseId: _releaseId, candidateAssetId: _assetId, ...nonReleaseResult } = passingResult();
    const result = await finalizeGateResult('owner/repo', 7, SHA, { ...nonReleaseResult, releaseIntent: [] }, api);

    expect(result).toMatchObject({ ok: true, state: 'success' });
    expect(api.statuses[0]?.state).toBe('success');
  });

  test('keeps an ordinary PR green only when it remains without release intent', async () => {
    const api = makeApi({ releaseLabel: true, branch: 'feature/update' });
    const { candidateReleaseId: _releaseId, candidateAssetId: _assetId, ...nonReleaseResult } = passingResult();
    const result = await finalizeGateResult('owner/repo', 7, SHA, { ...nonReleaseResult, releaseIntent: [] }, api);

    expect(result).toMatchObject({ ok: true, state: 'failure' });
    expect(api.statuses[0]?.description).toContain('release intent changed');
  });
});

function passingResult(): DeferredGateResult {
  return {
    schemaVersion: 1,
    repository: 'owner/repo',
    pullRequest: 7,
    eventHead: SHA,
    state: 'success',
    description: 'QA passed for PR #7',
    summary: 'QA passed',
    headSha: SHA,
    baseRef: 'main',
    baseSha: BASE,
    releaseIntent: ['release branch'],
    candidateReleaseId: 50,
    candidateAssetId: 70,
  };
}

function makeApi(options: { candidateAssetId?: number; releaseLabel?: boolean; branch?: string; headSha?: string; baseSha?: string } = {}): GateFinalizeApi & { statuses: Array<{ state: string; context: string; description: string }> } {
  const statuses: Array<{ state: string; context: string; description: string }> = [];
  return {
    statuses,
    get: async (path) => {
      if (path === 'repos/owner/repo/pulls/7') return { ok: true, value: { state: 'open', head: { sha: options.headSha ?? SHA, ref: options.branch ?? 'release/1', repo: { id: 1 } }, base: { ref: 'main', repo: { id: 1 } }, labels: options.releaseLabel ? [{ name: 'release' }] : [] } };
      if (path === 'repos/owner/repo/branches/main') return { ok: true, value: { commit: { sha: options.baseSha ?? BASE } } };
      if (path === `repos/owner/repo/contents/qa/policy.json?ref=${BASE}`) return { ok: true, value: { type: 'file', encoding: 'base64', content: POLICY } };
      if (path === 'repos/owner/repo/releases/50') return { ok: true, value: { id: 50, draft: true, name: 'QA PR #7', assets: [{ id: options.candidateAssetId ?? 70, name: 'candidate.json' }] } };
      return { ok: false, reason: 'not-found' };
    },
    list: async (path) => path === 'repos/owner/repo/pulls/7/files?per_page=100' ? { ok: true, value: [] } : { ok: false, reason: 'not-found' },
    post: async (_path, body) => { statuses.push(body as typeof statuses[number]); return { ok: true, value: {} }; },
  };
}
