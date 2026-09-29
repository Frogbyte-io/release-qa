import { describe, expect, test } from 'vitest';
import type { MergeResult, PullRequestGateResult } from '@frogbyte-io/release-qa';
import { mergePullRequest, parseMergeRequest, parsePullRef, parseTarget, prepareReleaseCandidate, previewMerge, pullRequestUrl } from '../src/main/release-actions.ts';
import { evaluation } from './fixtures.ts';
import { actionTransport } from './transport.ts';

const HEAD = 'a'.repeat(40);
const MOVED = 'b'.repeat(40);
const target = { repository: 'acme/app', number: 7, headSha: HEAD };
const request = { ...target, method: 'merge' as const, candidateId: 'cand-1' };
const repoReply = (permissions: Record<string, boolean>) => ({ 'repos/acme/app': { ok: true as const, value: { id: 1, full_name: 'acme/app', permissions } } });
const maintainer = repoReply({ pull: true, push: true, maintain: true });
const pullNow = (value: unknown) => ({ 'repos/acme/app/pulls/7': { ok: true as const, value } });

const gate = (changes: { readiness?: 'blocked' | 'passed' | 'approved-with-exceptions'; candidateId?: string | undefined; head?: string; intent?: string[] } = {}): PullRequestGateResult => ({
  ok: true,
  value: {
    pullRequest: 7, headSha: changes.head ?? HEAD, baseRef: 'main', baseSha: 'd'.repeat(40),
    ...('candidateId' in changes ? (changes.candidateId === undefined ? {} : { candidateId: changes.candidateId }) : { candidateId: 'cand-1', candidateReleaseId: 50 }),
    releaseIntent: changes.intent ?? ['release branch'], evaluation: evaluation({ readiness: changes.readiness ?? 'passed' }), summary: '', markers: { releaseNotes: 'release-notes', qa: 'qa' },
  },
});
const ordinary = () => gate({ candidateId: undefined, intent: [] });
const evaluating = (result: PullRequestGateResult, seen: unknown[][] = []) => (async (...args: unknown[]) => { seen.push(args); return result; }) as never;
const merging = (result: MergeResult, seen: unknown[][] = []) => (async (...args: unknown[]) => { seen.push(args); return result; }) as never;
const mergedOk: MergeResult = { ok: true, sha: 'c'.repeat(40), reviewedBody: 'notes', notesAssetId: 5, alreadyMerged: false };

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
    expect(parseMergeRequest({ ...target, method: 'squash' })).toEqual({ ...target, method: 'squash' });
  });

  test('the pull request link is built from validated parts, never a URL the window sent', () => {
    expect(parsePullRef({ repository: 'acme/app', number: 7, url: 'https://evil.example' })).toEqual({ repository: 'acme/app', number: 7 });
    expect(pullRequestUrl('acme/app', 7)).toBe('https://github.com/acme/app/pull/7');
  });
});

describe('merging a release pull request', () => {
  test('goes through the shared release merge, for the head reviewed, and never a plain PUT', async () => {
    const api = actionTransport(maintainer);
    const seen: unknown[][] = [];
    const evaluated: unknown[][] = [];
    const result = await mergePullRequest({ ...request, method: 'squash' }, { api, evaluate: evaluating(gate(), evaluated), mergeRelease: merging(mergedOk, seen) });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.message).toContain('Merged #7 as ccccccc');
    expect(seen[0]?.slice(0, 3)).toEqual(['acme/app', 7, HEAD]);
    expect(api.puts).toEqual([]);
    // The gate was asked about the exact head the person saw.
    expect(evaluated[0]?.[3]).toBe(HEAD);
  });

  test('the method the window sent does not matter: only the shared merge decides it', async () => {
    const seen: unknown[][] = [];
    await mergePullRequest({ ...request, method: 'rebase' }, { api: actionTransport(maintainer), evaluate: evaluating(gate()), mergeRelease: merging(mergedOk, seen) });
    expect(seen[0]).toHaveLength(4);
  });

  test('approved with exceptions may merge; blocked may not, and nothing is called', async () => {
    const allowed: unknown[][] = [];
    expect((await mergePullRequest(request, { api: actionTransport(maintainer), evaluate: evaluating(gate({ readiness: 'approved-with-exceptions' })), mergeRelease: merging(mergedOk, allowed) })).ok).toBe(true);
    expect(allowed).toHaveLength(1);
    const refused: unknown[][] = [];
    const result = await mergePullRequest(request, { api: actionTransport(maintainer), evaluate: evaluating(gate({ readiness: 'blocked' })), mergeRelease: merging(mergedOk, refused) });
    expect(result).toEqual({ ok: false, error: 'Not merged: QA is blocked for this pull request. Refresh to see why.' });
    expect(refused).toEqual([]);
  });

  test('refuses when the gate cannot be evaluated, rather than merging on an unknown', async () => {
    const seen: unknown[][] = [];
    const result = await mergePullRequest(request, { api: actionTransport(maintainer), evaluate: evaluating({ ok: false, error: 'manual check required: no active candidate selected' }), mergeRelease: merging(mergedOk, seen) });
    expect(result).toEqual({ ok: false, error: 'Not merged: manual check required: no active candidate selected' });
    expect(seen).toEqual([]);
  });

  test('refuses when a different candidate became active, or none is, while the person was looking', async () => {
    const seen: unknown[][] = [];
    const replaced = await mergePullRequest(request, { api: actionTransport(maintainer), evaluate: evaluating(gate({ candidateId: 'cand-2' })), mergeRelease: merging(mergedOk, seen) });
    expect(replaced).toEqual({ ok: false, error: 'Not merged: the active candidate is now cand-2, not the cand-1 you reviewed. Review it again.' });
    const withdrawn = await mergePullRequest(request, { api: actionTransport(maintainer), evaluate: evaluating(gate({ candidateId: undefined })), mergeRelease: merging(mergedOk, seen) });
    expect(!withdrawn.ok && withdrawn.error).toContain('now none');
    expect(seen).toEqual([]);
  });

  test('reports the shared merge\'s own refusal, such as release notes edited after review', async () => {
    const result = await mergePullRequest(request, { api: actionTransport(maintainer), evaluate: evaluating(gate()), mergeRelease: merging({ ok: false, error: 'PR head or release notes changed before merge' }) });
    expect(result).toEqual({ ok: false, error: 'Not merged: PR head or release notes changed before merge' });
  });

  test('an outcome the shared merge could not confirm is reported as unconfirmed, not as a plain failure', async () => {
    const result = await mergePullRequest(request, { api: actionTransport(maintainer), evaluate: evaluating(gate()), mergeRelease: merging({ ok: false, error: 'merge outcome is unconfirmed; reread PR before retry: network-error' }) });
    expect(!result.ok && result.error).toContain('unconfirmed');
    expect(!result.ok && result.error).not.toContain('Not merged');
  });

  test('the head having moved before the check is refused by the gate itself', async () => {
    const seen: unknown[][] = [];
    const result = await mergePullRequest(request, { api: actionTransport(maintainer), evaluate: async () => ({ ok: false, error: 'pull request head does not match the event head; evaluate again' }), mergeRelease: merging(mergedOk, seen) });
    expect(result).toEqual({ ok: false, error: 'Not merged: pull request head does not match the event head; evaluate again' });
    expect(seen).toEqual([]);
  });

  test('a read-only account is refused before anything is evaluated or written', async () => {
    const seen: unknown[][] = [];
    const evaluated: unknown[][] = [];
    const api = actionTransport(repoReply({ pull: true }));
    const result = await mergePullRequest(request, { api, evaluate: evaluating(gate(), evaluated), mergeRelease: merging(mergedOk, seen) });
    expect(!result.ok && result.error).toContain('read-only');
    expect([seen, evaluated, api.puts]).toEqual([[], [], []]);
  });

  test('a malformed request never reaches GitHub', async () => {
    const api = actionTransport(maintainer);
    expect(await mergePullRequest({ ...request, method: 'rm -rf' }, { api, evaluate: evaluating(gate()) })).toEqual({ ok: false, error: 'That is not a valid merge request.' });
    expect(api.puts).toEqual([]);
  });
});

describe('merging an ordinary pull request', () => {
  test('uses the chosen method and tells GitHub the reviewed head', async () => {
    const api = actionTransport(maintainer);
    const result = await mergePullRequest({ ...target, method: 'squash' }, { api, evaluate: evaluating(ordinary()) });
    expect(result).toEqual({ ok: true, message: 'Merged #7 as ccccccc.' });
    expect(api.puts).toEqual([{ path: 'repos/acme/app/pulls/7/merge', body: { sha: HEAD, merge_method: 'squash' } }]);
  });

  test('a push just before the merge is refused by GitHub and explained', async () => {
    const api = actionTransport({ ...maintainer, ...pullNow({ merged: false, head: { sha: MOVED } }) }, { put: { ok: false, reason: 'network-error' } });
    const result = await mergePullRequest({ ...target, method: 'merge' }, { api, evaluate: evaluating(ordinary()) });
    expect(result).toEqual({ ok: false, error: 'Not merged: the pull request changed just before the merge. Refresh and review the new head.' });
  });

  test('a merge whose reply was lost is reported as merged when GitHub shows it merged', async () => {
    const api = actionTransport({ ...maintainer, ...pullNow({ merged: true, head: { sha: HEAD } }) }, { put: { ok: false, reason: 'network-error' } });
    const result = await mergePullRequest({ ...target, method: 'merge' }, { api, evaluate: evaluating(ordinary()) });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.message).toContain('shows as merged');
  });

  test('when GitHub cannot be re-read the outcome is unknown, not "not merged"', async () => {
    const api = actionTransport(maintainer, { put: { ok: false, reason: 'network-error' } });
    const result = await mergePullRequest({ ...target, method: 'merge' }, { api, evaluate: evaluating(ordinary()) });
    expect(!result.ok && result.error).toContain('outcome unknown');
  });

  test('an unexplained failure does not blame branch protection alone', async () => {
    const api = actionTransport({ ...maintainer, ...pullNow({ merged: false, head: { sha: HEAD } }) }, { put: { ok: false, reason: 'network-error' } });
    const result = await mergePullRequest({ ...target, method: 'merge' }, { api, evaluate: evaluating(ordinary()) });
    expect(!result.ok && result.error).toContain('or not reached');
  });

  test('losing write access mid-merge is reported as that', async () => {
    const api = actionTransport({ ...maintainer, ...pullNow({ merged: false, head: { sha: HEAD } }) }, { put: { ok: false, reason: 'insufficient-role' } });
    expect(await mergePullRequest({ ...target, method: 'merge' }, { api, evaluate: evaluating(ordinary()) })).toEqual({ ok: false, error: 'Not merged: Your account does not have write access to this repository.' });
  });
});

describe('previewMerge', () => {
  test('reports what merging would do: readiness, candidate, and that a release publishes', async () => {
    expect(await previewMerge(target, { api: actionTransport(maintainer), evaluate: evaluating(gate()) })).toEqual({
      ok: true, headSha: HEAD, baseRef: 'main', readiness: 'passed', candidateId: 'cand-1', candidateReleaseId: 50, publishes: true, releaseIntent: ['release branch'],
    });
  });

  test('does not pin the head, so a moved head is reported for the window to explain', async () => {
    const seen: unknown[][] = [];
    const result = await previewMerge(target, { api: actionTransport(maintainer), evaluate: evaluating(gate({ head: MOVED }), seen) });
    expect(result).toMatchObject({ ok: true, headSha: MOVED });
    expect(seen[0]?.[3]).toBeUndefined();
  });

  test('an ordinary pull request publishes nothing', async () => {
    expect(await previewMerge(target, { api: actionTransport(maintainer), evaluate: evaluating(ordinary()) })).toMatchObject({ ok: true, publishes: false });
  });

  test('is refused for a read-only account, and when the gate cannot be evaluated', async () => {
    expect(await previewMerge(target, { api: actionTransport(repoReply({ pull: true })), evaluate: evaluating(gate()) })).toMatchObject({ ok: false });
    expect(await previewMerge(target, { api: actionTransport(maintainer), evaluate: evaluating({ ok: false, error: 'no candidate' }) })).toEqual({ ok: false, error: 'no candidate' });
  });
});

describe('prepareReleaseCandidate', () => {
  test('starts preparation for the head the person saw', async () => {
    const asked: unknown[][] = [];
    const result = await prepareReleaseCandidate(target, {
      api: actionTransport(maintainer),
      prepare: (async (...args: unknown[]) => { asked.push(args); return { ok: true, runId: 99, repositoryId: 1, sourceSha: HEAD, baseSha: 'd'.repeat(40), policyDigest: 'e'.repeat(64), workflowHeadSha: 'f'.repeat(40) }; }) as never,
    });
    expect(asked[0]?.slice(0, 3)).toEqual(['acme/app', 7, HEAD]);
    expect(result).toEqual({ ok: true, message: 'Candidate preparation started for aaaaaaa (workflow run 99). The candidate appears here after the run succeeds; refresh to see it.' });
  });

  test('passes the shared preparation\'s refusal through in its own words, including read-only', async () => {
    const refused = (error: string) => (async () => ({ ok: false, error })) as never;
    expect(await prepareReleaseCandidate(target, { api: actionTransport(maintainer), prepare: refused('candidate preparation requires repository write access') })).toEqual({ ok: false, error: 'candidate preparation requires repository write access' });
  });

  test('says when a run was already started even though verifying it failed, so a retry is not a second run', async () => {
    const result = await prepareReleaseCandidate(target, { api: actionTransport(maintainer), prepare: (async () => ({ ok: false, error: 'dispatched preparation run does not match the trusted workflow revision and PR source', runId: 99 })) as never });
    expect(!result.ok && result.error).toContain('workflow run 99 was already started');
  });

  test('a malformed target is refused', async () => {
    expect(await prepareReleaseCandidate({ ...target, headSha: 'main' }, { api: actionTransport(maintainer) })).toEqual({ ok: false, error: 'That is not a valid pull request.' });
  });
});
