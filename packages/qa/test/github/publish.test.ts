import { describe, expect, test } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { candidate, requirement, SHA1, SHA256 } from '../fixtures/records.ts';
import { mergeReleasePr, publishApprovedCandidate, renderPublicationNotes, resolveTagCommit, verifyPublication, type PublicationInput, type PublishApi } from '../../src/github/publish.ts';

function publication(overrides: Partial<PublicationInput> = {}): PublicationInput {
  const selected = candidate();
  return {
    repository: 'owner/app', candidate: selected,
    evaluation: { candidate: selected, currentHeadSha: selected.sourceSha, currentBaseSha: selected.baseSha, required: [], reports: [], exceptions: [], retryResolutions: [] },
    currentPolicyDigest: SHA256.policy, pullRequest: selected.pullRequest,
    merged: true, mergedHeadSha: selected.sourceSha, mergeCommitSha: '6'.repeat(40), mergeTreeSha: selected.sourceTreeSha,
    expectedTag: 'v1.2.3', tagName: 'v1.2.3', changelog: 'Adds orchard mode.', ...overrides,
  };
}

describe('verifyPublication', () => {
  test('records source and merge identities when reviewed candidate is unchanged', () => {
    const result = verifyPublication(publication());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest).toMatchObject({ sourceSha: SHA1.source, sourceTreeSha: SHA1.tree, mergeTreeSha: SHA1.tree, tag: 'v1.2.3' });
  });

  test.each([
    ['changed binary', { candidate: candidate({ artifacts: candidate().artifacts.map((a, i) => i === 0 ? { ...a, sha256: SHA256.linuxPackage } : a) }) }],
    ['source tree mismatch', { mergeTreeSha: '9'.repeat(40) }],
    ['changed policy', { currentPolicyDigest: 'f'.repeat(64) }],
    ['absent evidence', { evaluation: { ...publication().evaluation, required: [requirement()] } }],
    ['wrong tag', { tagName: 'v9.9.9' }],
    ['unexpected merged head', { mergedHeadSha: '8'.repeat(40) }],
    ['unidentifiable changelog', { changelog: '   ' }],
  ] as const)('blocks %s', (_name, overrides) => {
    expect(verifyPublication(publication(overrides)).ok).toBe(false);
  });

  test('reserves the final QA record name even for an otherwise valid candidate', () => {
    const selected = candidate({ artifacts: [{ ...candidate().artifacts[0]!, name: 'release-qa-record.json' }] });
    const result = verifyPublication(publication({ candidate: selected, evaluation: { ...publication().evaluation, candidate: selected } }));
    expect(result).toMatchObject({ ok: false, reasons: expect.arrayContaining(['candidate uses a reserved publication asset name']) });
  });

  test('rechecks exception authority through the current evaluation input', () => {
    const selected = candidate();
    const base = publication();
    const result = verifyPublication(publication({
      evaluation: { ...base.evaluation, required: [requirement({ key: 'windows/device-feel', mode: 'manual' })], exceptions: [{ exception: { schemaVersion: 1, id: 'ex-1', candidateId: selected.id, requirements: ['windows/device-feel'], reason: 'Approved', actor: 'owner', createdAt: '2026-09-20T00:00:00Z' }, authority: { login: 'owner', authorized: false } }] },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain('current QA evidence does not pass');
  });
});

test('resolves an annotated release tag to its commit', async () => {
  const target = await resolveTagCommit({ get: async () => ({ ok: true, value: { object: { type: 'commit', sha: '6'.repeat(40) } } }) }, 'repos/owner/app', { object: { type: 'tag', sha: '7'.repeat(40) } });
  expect(target).toBe('6'.repeat(40));
});

describe('mergeReleasePr', () => {
  test('never attempts a merge when PR head differs', async () => {
    let writes = 0;
    const result = await mergeReleasePr('owner/app', 7, SHA1.source, {
      get: async () => ({ ok: true, value: { state: 'open', head: { sha: '9'.repeat(40) } } }),
      put: async () => { writes++; return { ok: true, value: {} }; },
      list: async () => ({ ok: false, reason: 'not-found' }),
      upload: async () => ({ ok: false, reason: 'not-found' }),
      download: async () => ({ ok: false, reason: 'not-found' }),
    });
    expect(result.ok).toBe(false);
    expect(writes).toBe(0);
  });

  test('uses the normal head-matched endpoint and verifies an uncertain response', async () => {
    const paths: string[] = [];
    let reads = 0;
    let notesBytes: Buffer = Buffer.alloc(0);
    const reviewedBody = '<!-- release-notes:start -->\nA tested release\n<!-- release-notes:end -->';
    const result = await mergeReleasePr('owner/app', 7, SHA1.source, {
      get: async (path) => path.endsWith('/releases/50')
        ? { ok: true, value: { id: 50, name: 'QA PR #7', draft: true, assets: [{ id: 70, name: 'candidate.json' }] } }
        : { ok: true, value: ++reads <= 3
          ? { state: 'open', head: { sha: SHA1.source }, body: reviewedBody }
          : { state: 'closed', merged: true, head: { sha: SHA1.source }, merge_commit_sha: '5'.repeat(40) } },
      put: async (path, body) => { paths.push(`${path}:${JSON.stringify(body)}`); return { ok: false, reason: 'network-error' }; },
      list: async () => ({ ok: true, value: [{ id: 50, name: 'QA PR #7', draft: true }] }),
      upload: async (_repo, _id, _name, bytes) => { notesBytes = bytes; return { ok: true, value: { id: 80, name: `qa-merge-notes-${SHA1.source}.json`, state: 'uploaded' } }; },
      download: async (_path, destination) => { await writeFile(destination, notesBytes); return { ok: true, value: true }; },
    });
    expect(result).toEqual({ ok: true, sha: '5'.repeat(40), reviewedBody, notesAssetId: 80, alreadyMerged: false });
    expect(JSON.parse(notesBytes.toString('utf8'))).toMatchObject({ pullRequest: 7, headSha: SHA1.source, body: reviewedBody });
    expect(paths[0]).toContain('"sha":"1111111111111111111111111111111111111111"');
  });
});

describe('publishApprovedCandidate', () => {
  test('removes superseded final-download assets before publishing a draft', async () => {
    const tested = Buffer.from('approved installer');
    const selected = candidate({ artifacts: [{ ...candidate().artifacts[0]!, sha256: createHash('sha256').update(tested).digest('hex') }] });
    const checked = verifyPublication(publication({ candidate: selected, evaluation: { ...publication().evaluation, candidate: selected } }));
    if (!checked.ok) throw new Error(checked.reasons.join('; '));
    const assets = new Map<number, { name: string; bytes: Buffer }>([[800, { name: 'old-installer.exe', bytes: Buffer.from('old') }]]);
    let removed = 0;
    let published = 0;
    const api: PublishApi = {
      get: async () => ({ ok: false, reason: 'not-found' }),
      list: async (path) => ({ ok: true, value: path.endsWith('/releases?per_page=100')
        ? [{ id: 42, tag_name: 'v1.2.3', name: 'v1.2.3', draft: true, body: renderPublicationNotes(checked.manifest) }]
        : [...assets].map(([id, item]) => ({ id, name: item.name, state: 'uploaded' })) }),
      post: async () => ({ ok: false, reason: 'network-error' }),
      patch: async () => { published++; return { ok: true, value: null }; },
      upload: async (_repository, _release, name, bytes) => { const id = 900 + assets.size; assets.set(id, { name, bytes: Buffer.from(bytes) }); return { ok: true, value: { id, name, state: 'uploaded' } }; },
      download: async (path, destination) => { const id = Number(path.split('/').at(-1)); const bytes = id === 101 ? tested : assets.get(id)?.bytes; if (!bytes) return { ok: false, reason: 'not-found' }; await writeFile(destination, bytes); return { ok: true, value: true }; },
      delete: async (path) => { removed++; assets.delete(Number(path.split('/').at(-1))); return { ok: true, value: null }; },
    };
    expect((await publishApprovedCandidate(checked.manifest, api)).ok).toBe(true);
    expect(removed).toBe(1);
    expect(published).toBe(1);
    expect([...assets.values()].map((item) => item.name).sort()).toEqual([selected.artifacts[0]!.name, 'release-qa-record.json'].sort());
  });

  test.each(['missing-assets', 'conflicting-metadata'] as const)('does not mutate an already published release with %s', async (problem) => {
    const selected = candidate({ artifacts: [candidate().artifacts[0]!] });
    const checked = verifyPublication(publication({ candidate: selected, evaluation: { ...publication().evaluation, candidate: selected } }));
    if (!checked.ok) throw new Error(checked.reasons.join('; '));
    let writes = 0;
    const api: PublishApi = {
      get: async () => ({ ok: false, reason: 'not-found' }),
      list: async (path) => ({ ok: true, value: path.endsWith('/releases?per_page=100')
        ? [{ id: 42, tag_name: 'v1.2.3', name: 'v1.2.3', draft: false, body: problem === 'conflicting-metadata' ? 'changed notes' : renderPublicationNotes(checked.manifest) }]
        : [] }),
      post: async () => { writes++; return { ok: false, reason: 'network-error' }; },
      patch: async () => { writes++; return { ok: false, reason: 'network-error' }; },
      upload: async () => { writes++; return { ok: false, reason: 'network-error' }; },
      download: async () => ({ ok: false, reason: 'network-error' }),
      delete: async () => { writes++; return { ok: false, reason: 'network-error' }; },
    };
    expect((await publishApprovedCandidate(checked.manifest, api)).ok).toBe(false);
    expect(writes).toBe(0);
  });

  test('refuses a candidate asset whose downloaded bytes changed', async () => {
    const selected = candidate({ artifacts: [candidate().artifacts[0]!] });
    const checked = verifyPublication(publication({ candidate: selected, evaluation: { ...publication().evaluation, candidate: selected } }));
    if (!checked.ok) throw new Error(checked.reasons.join('; '));
    let uploads = 0;
    let publishes = 0;
    const api: PublishApi = {
      get: async () => ({ ok: false, reason: 'not-found' }),
      list: async (path) => ({ ok: true, value: path.endsWith('/releases?per_page=100')
        ? [{ id: 42, tag_name: 'v1.2.3', name: 'v1.2.3', draft: true, body: renderPublicationNotes(checked.manifest) }] : [] }),
      post: async () => ({ ok: false, reason: 'network-error' }),
      patch: async () => { publishes++; return { ok: true, value: null }; },
      upload: async () => { uploads++; return { ok: false, reason: 'network-error' }; },
      download: async (_path, destination) => { await writeFile(destination, 'different bytes'); return { ok: true, value: true }; },
      delete: async () => ({ ok: true, value: null }),
    };
    expect(await publishApprovedCandidate(checked.manifest, api)).toMatchObject({ ok: false, error: expect.stringContaining('changed after QA') });
    expect(uploads).toBe(0);
    expect(publishes).toBe(0);
  });

  test.each(['create', 'publish'] as const)('recovers an uncertain %s response without duplicate bytes or release', async (fault) => {
    const tested = Buffer.from('tested installer');
    const selected = candidate({ artifacts: [{ ...candidate().artifacts[0]!, sha256: createHash('sha256').update(tested).digest('hex') }] });
    const checked = verifyPublication(publication({ candidate: selected, evaluation: { ...publication().evaluation, candidate: selected } }));
    if (!checked.ok) throw new Error(checked.reasons.join('; '));
    let release: { id: number; tag_name: string; name: string; body: string; draft: boolean } | undefined;
    let creates = 0;
    let patches = 0;
    let uploads = 0;
    const assets = new Map<number, { name: string; bytes: Buffer }>();
    const api: PublishApi = {
      get: async () => ({ ok: false, reason: 'not-found' }),
      list: async (path) => ({ ok: true, value: path.endsWith('/releases?per_page=100') ? release ? [release] : [] : [...assets].map(([id, asset]) => ({ id, name: asset.name, state: 'uploaded' })) }),
      post: async () => { creates++; release = { id: 42, tag_name: 'v1.2.3', name: 'v1.2.3', body: renderPublicationNotes(checked.manifest), draft: true }; return fault === 'create' && creates === 1 ? { ok: false, reason: 'network-error' } : { ok: true, value: release }; },
      patch: async () => { patches++; if (release) release.draft = false; return fault === 'publish' && patches === 1 ? { ok: false, reason: 'network-error' } : { ok: true, value: release }; },
      upload: async (_repository, _releaseId, name, bytes) => { uploads++; const id = 900 + assets.size; assets.set(id, { name, bytes: Buffer.from(bytes) }); return { ok: true, value: { id, name, state: 'uploaded' } }; },
      download: async (path, destination) => { const id = Number(path.split('/').at(-1)); const bytes = id === selected.artifacts[0]?.assetId ? tested : assets.get(id)?.bytes; if (!bytes) return { ok: false, reason: 'not-found' }; await writeFile(destination, bytes); return { ok: true, value: true }; },
      delete: async () => ({ ok: true, value: null }),
    };
    expect((await publishApprovedCandidate(checked.manifest, api)).ok).toBe(false);
    expect(await publishApprovedCandidate(checked.manifest, api)).toMatchObject({ ok: true, releaseId: 42, retried: true });
    expect(creates).toBe(1);
    expect(uploads).toBe(2); // installer and QA record, each uploaded once
    expect(patches).toBe(1);
    expect(assets.get(900)?.bytes.equals(tested)).toBe(true);
  });

  test('resumes a partial draft, verifies tested bytes, and never duplicates the release', async () => {
    const firstBytes = Buffer.from('windows installer');
    const secondBytes = Buffer.from('linux package');
    const digestOf = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
    const selected = candidate({ artifacts: candidate().artifacts.map((item, index) => ({ ...item, sha256: digestOf(index === 0 ? firstBytes : secondBytes) })) });
    const verified = verifyPublication(publication({ candidate: selected, evaluation: { ...publication().evaluation, candidate: selected } }));
    if (!verified.ok) throw new Error(verified.reasons.join('; '));
    const byteMap = new Map<number, Buffer>([[101, firstBytes], [102, secondBytes]]);
    const published = new Map<number, { name: string; bytes: Buffer }>();
    let createCount = 0;
    let publishCount = 0;
    let isDraft = true;
    const api: PublishApi = {
      get: async () => ({ ok: false, reason: 'not-found' }),
      list: async (path) => ({ ok: true, value: path.endsWith('/releases?per_page=100')
        ? [{ id: 42, tag_name: 'v1.2.3', name: 'v1.2.3', draft: isDraft, body: renderPublicationNotes(verified.manifest) }]
        : [...published].map(([id, asset]) => ({ id, name: asset.name, state: 'uploaded' })) }),
      post: async () => { createCount++; return { ok: true, value: { id: 42, tag_name: 'v1.2.3', draft: true } }; },
      patch: async () => { publishCount++; isDraft = false; return { ok: true, value: {} }; },
      upload: async (_repo, _id, name, bytes) => { const id = 900 + published.size; published.set(id, { name, bytes: Buffer.from(bytes) }); return { ok: true, value: { id, name, state: 'uploaded' } }; },
      download: async (path, destination) => {
        const id = Number(path.split('/').at(-1));
        const bytes = id >= 900 ? published.get(id)?.bytes : byteMap.get(id);
        if (!bytes) return { ok: false, reason: 'not-found' };
        await writeFile(destination, bytes);
        return { ok: true, value: true };
      },
      delete: async () => ({ ok: true, value: null }),
    };
    const first = await publishApprovedCandidate(verified.manifest, api);
    expect(first.ok).toBe(true);
    expect(createCount).toBe(0);
    expect(publishCount).toBe(1);
    expect([...published.values()].filter((asset) => asset.name !== 'release-qa-record.json').map((asset) => asset.bytes.toString())).toEqual(['windows installer', 'linux package']);
    const retry = await publishApprovedCandidate(verified.manifest, api);
    expect(retry).toMatchObject({ ok: true, releaseId: 42, retried: true });
    expect(createCount).toBe(0);
    expect(publishCount).toBe(1);
  });

  test('leaves a draft recoverable when byte verification fails halfway through', async () => {
    const data = Buffer.from('tested bytes');
    const selected = candidate({ artifacts: [
      { ...candidate().artifacts[0]!, name: 'one.exe', sha256: createHash('sha256').update(data).digest('hex') },
      { ...candidate().artifacts[1]!, name: 'two.deb', sha256: createHash('sha256').update(data).digest('hex') },
    ] });
    const checked = verifyPublication(publication({ candidate: selected, evaluation: { ...publication().evaluation, candidate: selected }, changelog: 'Notes' }));
    if (!checked.ok) throw new Error(checked.reasons.join('; '));
    let published = false;
    let publishCalls = 0;
    const api: PublishApi = {
      get: async () => ({ ok: false, reason: 'not-found' }),
      list: async (path) => ({ ok: true, value: path.includes('/assets?') && published ? [{ id: 900, name: 'one.exe', state: 'uploaded' }] : path.includes('/assets?') ? [] : [{ id: 50, tag_name: 'v1.2.3', name: 'v1.2.3', draft: true, body: renderPublicationNotes(checked.manifest) }] }),
      post: async () => ({ ok: false, reason: 'network-error' }),
      patch: async () => { publishCalls++; return { ok: true, value: {} }; },
      upload: async (_repo, _release, name) => { if (name === 'one.exe') published = true; return { ok: true, value: { id: 900, name, state: 'uploaded' } }; },
      download: async (path, destination) => {
        if (path.endsWith('/900')) return { ok: false, reason: 'network-error' };
        await writeFile(destination, data);
        return { ok: true, value: true };
      },
      delete: async () => ({ ok: true, value: null }),
    };
    await expect(publishApprovedCandidate(checked.manifest, api)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('failed byte verification') });
    expect(publishCalls).toBe(0);
  });
});
