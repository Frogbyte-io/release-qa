import { describe, expect, test } from 'vitest';
import type { PullRequestGateResult } from '@frogbyte-io/release-qa';
import { mergePullRequest, parseMergeRequest, parsePullRef, parseTarget, prepareReleaseCandidate, previewMerge, pullRequestUrl } from '../src/main/release-actions.ts';
import { evaluation } from './fixtures.ts';
import { actionTransport } from './transport.ts';

const HEAD = 'a'.repeat(40);
const MOVED = 'b'.repeat(40);
const target = { repository: 'acme/app', number: 7, headSha: HEAD };
const request = { ...target, method: 'squash' as const, candidateId: 'cand-1' };
const repoReply = (permissions: Record<string, boolean>) => ({ 'repos/acme/app': { ok: true as const, value: { id: 1, full_name: 'acme/app', permissions } } });
const maintainer = repoReply({ pull: true, push: true, maintain: true });

const gate = (changes: { readiness?: 'blocked' | 'passed' | 'approved-with-exceptions'; candidateId?: string | undefined; head?: string; intent?: string[] } = {}): PullRequestGateResult => ({
  ok: true,
  value: {
    pullRequest: 7, headSha: changes.head ?? HEAD, baseRef: 'main', baseSha: 'd'.repeat(40),
    ...('candidateId' in changes ? (changes.candidateId === undefined ? {} : { candidateId: changes.candidateId }) : { candidateId: 'cand-1', candidateReleaseId: 50 }),
    releaseIntent: changes.intent ?? ['release branch'], evaluation: evaluation({ readiness: changes.readiness ?? 'passed' }), summary: '', markers: { releaseNotes: 'release-notes', qa: 'qa' },
  },
});
const evaluating = (result: PullRequestGateResult, seen: unknown[] = []) => async (...args: unknown[]) => { seen.push(args); return result; };

describe('validating what the window sends', () => {
  test.each([
    [{ ...target }, true],
    [{ ...target, repository: 'not a repo' }, false],
    [{ ...target, repository: 'acme/app/../../x' }, false],
    [{ ...target, number: 0 }, false],
    [{ ...target, number: 1.5 }, false],
    [{ ...target, number: '7' }, false],
    [{ ...target, headSha: 'main' }, false],
    [{ ...target, headSha: HEAD.toUpperCase() }, false],
    [null, false],
    ['acme/app#7', false],
  ])('parseTarget(%j) is valid: %s', (value, valid) => {
    expect(parseTarget(value) !== undefined).toBe(valid);
  });

  test('a merge request needs a known method, and only a short candidate id', () => {
    expect(parseMergeRequest(request)).toEqual(request);
    expect(parseMergeRequest({ ...request, method: 'octopus' })).toBeUndefined();
    expect(parseMergeRequest({ ...request, candidateId: 5 })).toBeUndefined();
    expect(parseMergeRequest({ ...request, candidateId: 'x'.repeat(201) })).toBeUndefined();
    expect(parseMergeRequest({ ...target, method: 'merge' })).toEqual({ ...target, method: 'merge' });
  });

  test('the pull request link is built from validated parts, never a URL the window sent', () => {
    expect(parsePullRef({ repository: 'acme/app', number: 7, url: 'https://evil.example' })).toEqual({ repository: 'acme/app', number: 7 });
    expect(pullRequestUrl('acme/app', 7)).toBe('https://github.com/acme/app/pull/7');
  });
});

describe('mergePullRequest', () => {
  test('merges a passed pull request, telling GitHub the head that was reviewed', async () => {
    const api = actionTransport(maintainer);
    const seen: unknown[] = [];
    const result = await mergePullRequest(request, { api, evaluate: evaluating(gate(), seen) as never });
    expect(result).toEqual({ ok: true, message: 'Merged #7 as ccccccc.', url: 'https://github.com/acme/app/pull/7' });
    expect(api.puts).toEqual([{ path: 'repos/acme/app/pulls/7/merge', body: { sha: HEAD, merge_method: 'squash' } }]);
    // The gate was asked about the exact head the person saw.
    expect((seen[0] as unknown[])[3]).toBe(HEAD);
  });

  test('approved with exceptions may merge; blocked may not, and nothing is written', async () => {
    const allowed = actionTransport(maintainer);
    expect((await mergePullRequest(request, { api: allowed, evaluate: evaluating(gate({ readiness: 'approved-with-exceptions' })) as never })).ok).toBe(true);
    const api = actionTransport(maintainer);
    const result = await mergePullRequest(request, { api, evaluate: evaluating(gate({ readiness: 'blocked' })) as never });
    expect(result).toEqual({ ok: false, error: 'Not merged: QA is blocked for this pull request. Refresh to see why.' });
    expect(api.puts).toEqual([]);
  });

  test('refuses when the gate cannot be evaluated, rather than merging on an unknown', async () => {
    const api = actionTransport(maintainer);
    const result = await mergePullRequest(request, { api, evaluate: evaluating({ ok: false, error: 'manual check required: no active candidate selected' }) as never });
    expect(result).toEqual({ ok: false, error: 'Not merged: manual check required: no active candidate selected' });
    expect(api.puts).toEqual([]);
  });

  test('refuses when a different candidate became active while the person was looking', async () => {
    const api = actionTransport(maintainer);
    const result = await mergePullRequest(request, { api, evaluate: evaluating(gate({ candidateId: 'cand-2' })) as never });
    expect(result).toEqual({ ok: false, error: 'Not merged: the active candidate is now cand-2, not the cand-1 you reviewed. Review it again.' });
    expect(api.puts).toEqual([]);
  });

  test('refuses when the candidate was withdrawn (none is active now)', async () => {
    const api = actionTransport(maintainer);
    const result = await mergePullRequest(request, { api, evaluate: evaluating(gate({ candidateId: undefined })) as never });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toContain('now none');
    expect(api.puts).toEqual([]);
  });

  test('merges an ordinary pull request that never had a candidate', async () => {
    const api = actionTransport(maintainer);
    const { candidateId: _seen, ...ordinary } = request;
    const result = await mergePullRequest(ordinary, { api, evaluate: evaluating(gate({ candidateId: undefined, intent: [] })) as never });
    expect(result.ok).toBe(true);
  });

  test('a push just before the merge is refused by GitHub and explained', async () => {
    const api = actionTransport({ ...maintainer, 'repos/acme/app/pulls/7': { ok: true, value: { head: { sha: MOVED } } } }, { put: { ok: false, reason: 'network-error' } });
    const result = await mergePullRequest(request, { api, evaluate: evaluating(gate()) as never });
    expect(result).toEqual({ ok: false, error: 'Not merged: the pull request changed just before the merge. Refresh and review the new head.' });
    expect(api.puts).toHaveLength(1);
  });

  test('the head having moved before the check is refused by the gate itself', async () => {
    const api = actionTransport(maintainer);
    const result = await mergePullRequest(request, { api, evaluate: async () => ({ ok: false, error: 'pull request head does not match the event head; evaluate again' }) });
    expect(result).toEqual({ ok: false, error: 'Not merged: pull request head does not match the event head; evaluate again' });
    expect(api.puts).toEqual([]);
  });

  test('losing write access is reported as that, and no write is attempted when the role is already read-only', async () => {
    const lost = actionTransport({ ...maintainer, 'repos/acme/app/pulls/7': { ok: true, value: { head: { sha: HEAD } } } }, { put: { ok: false, reason: 'insufficient-role' } });
    expect(await mergePullRequest(request, { api: lost, evaluate: evaluating(gate()) as never })).toEqual({ ok: false, error: 'Not merged: Your account does not have write access to this repository.' });
    const readOnly = actionTransport(repoReply({ pull: true }));
    const result = await mergePullRequest(request, { api: readOnly, evaluate: evaluating(gate()) as never });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toContain('read-only');
    expect(readOnly.puts).toEqual([]);
  });

  test('an unexplained refusal from GitHub says what it might be', async () => {
    const api = actionTransport({ ...maintainer, 'repos/acme/app/pulls/7': { ok: true, value: { head: { sha: HEAD } } } }, { put: { ok: false, reason: 'network-error' } });
    const result = await mergePullRequest(request, { api, evaluate: evaluating(gate()) as never });
    expect(!result.ok && result.error).toContain('branch may be protected');
  });

  test('a malformed request never reaches GitHub', async () => {
    const api = actionTransport(maintainer);
    expect(await mergePullRequest({ ...request, method: 'rm -rf' }, { api, evaluate: evaluating(gate()) as never })).toEqual({ ok: false, error: 'That is not a valid merge request.' });
    expect(api.puts).toEqual([]);
  });
});

describe('previewMerge', () => {
  test('reports what merging would do: readiness, candidate, and that a release publishes', async () => {
    const api = actionTransport(maintainer);
    expect(await previewMerge(target, { api, evaluate: evaluating(gate()) as never })).toEqual({
      ok: true, headSha: HEAD, baseRef: 'main', readiness: 'passed', candidateId: 'cand-1', candidateReleaseId: 50, publishes: true, releaseIntent: ['release branch'],
    });
  });

  test('an ordinary pull request publishes nothing', async () => {
    const api = actionTransport(maintainer);
    const result = await previewMerge(target, { api, evaluate: evaluating(gate({ candidateId: undefined, intent: [] })) as never });
    expect(result).toMatchObject({ ok: true, publishes: false });
  });

  test('is refused for a read-only account, and when the gate cannot be evaluated', async () => {
    expect(await previewMerge(target, { api: actionTransport(repoReply({ pull: true })), evaluate: evaluating(gate()) as never })).toMatchObject({ ok: false });
    expect(await previewMerge(target, { api: actionTransport(maintainer), evaluate: evaluating({ ok: false, error: 'no candidate' }) as never })).toEqual({ ok: false, error: 'no candidate' });
  });
});

describe('prepareReleaseCandidate', () => {
  test('starts preparation for the head the person saw and links the workflow run', async () => {
    const asked: unknown[][] = [];
    const result = await prepareReleaseCandidate(target, {
      api: actionTransport(maintainer),
      prepare: async (...args: unknown[]) => { asked.push(args); return { ok: true, runId: 99, repositoryId: 1, sourceSha: HEAD, baseSha: 'd'.repeat(40), policyDigest: 'e'.repeat(64), workflowHeadSha: 'f'.repeat(40) }; },
    });
    expect(asked[0]?.slice(0, 3)).toEqual(['acme/app', 7, HEAD]);
    expect(result).toMatchObject({ ok: true, url: 'https://github.com/acme/app/actions/runs/99' });
  });

  test('passes the shared preparation\'s refusal through in its own words', async () => {
    const result = await prepareReleaseCandidate(target, { api: actionTransport(maintainer), prepare: async () => ({ ok: false, error: 'PR #7 is closed or its head no longer matches ' + HEAD }) });
    expect(result).toEqual({ ok: false, error: 'PR #7 is closed or its head no longer matches ' + HEAD });
  });

  test('is refused for a read-only account before anything is dispatched', async () => {
    let dispatched = false;
    const result = await prepareReleaseCandidate(target, { api: actionTransport(repoReply({ pull: true })), prepare: async () => { dispatched = true; return { ok: false, error: 'x' }; } });
    expect(result).toMatchObject({ ok: false });
    expect(dispatched).toBe(false);
  });

  test('a malformed target is refused', async () => {
    expect(await prepareReleaseCandidate({ ...target, headSha: 'main' }, { api: actionTransport(maintainer) })).toEqual({ ok: false, error: 'That is not a valid pull request.' });
  });
});
