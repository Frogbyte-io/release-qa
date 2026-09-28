import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preparePublication, publishApprovedCandidate } from './publish.ts';
import { GhTransport } from './transport.ts';

const repository = process.env.GITHUB_REPOSITORY ?? '';
const eventName = process.env.GITHUB_EVENT_NAME ?? '';
const eventFile = process.env.GITHUB_EVENT_PATH ?? '';
const api = new GhTransport();
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

async function main(): Promise<void> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !eventFile) throw new Error('publication event identity is missing');
  const event = record(JSON.parse(await readFile(eventFile, 'utf8')) as unknown);
  if (!event) throw new Error('publication event is invalid');
  const repo = await api.get(`repos/${repository}`);
  const defaultBranch = record(repo.ok ? repo.value : undefined)?.default_branch;
  if (typeof defaultBranch !== 'string' || process.env.GITHUB_REF !== `refs/heads/${defaultBranch}`) throw new Error('publication must run from the trusted default branch');
  let prNumber: number;
  let reviewedBody: string;
  let expectedHead: string | undefined;
  if (eventName === 'pull_request_target') {
    const pull = record(event.pull_request);
    if (event.action !== 'closed' || pull?.merged !== true || typeof pull.number !== 'number') throw new Error('event is not a merged pull request');
    prNumber = pull.number;
    reviewedBody = typeof pull.body === 'string' ? pull.body : '';
    expectedHead = record(pull.head)?.sha as string | undefined;
    if (/^[0-9a-f]{40}$/.test(expectedHead ?? '')) {
      const assetId = await findSavedMergeNotesAssetId(repository, prNumber, expectedHead as string);
      if (assetId !== undefined) {
        const savedBody = await readSavedMergeNotes(repository, prNumber, expectedHead as string, assetId);
        if (savedBody !== reviewedBody) throw new Error('merge event notes differ from the saved reviewed snapshot');
        reviewedBody = savedBody;
      }
    }
  } else if (eventName === 'workflow_dispatch') {
    const inputs = record(event.inputs);
    prNumber = Number(inputs?.pr_number);
    expectedHead = typeof inputs?.expected_head === 'string' ? inputs.expected_head : undefined;
    const notesAssetId = Number(inputs?.notes_asset_id);
    if (!Number.isSafeInteger(notesAssetId) || notesAssetId <= 0 || !/^[0-9a-f]{40}$/.test(expectedHead ?? '')) throw new Error('saved merge notes identity is required');
    reviewedBody = await readSavedMergeNotes(repository, prNumber, expectedHead as string, notesAssetId);
  } else throw new Error('unsupported publication event');
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0 || !/^[0-9a-f]{40}$/.test(expectedHead ?? '')) throw new Error('publication PR or source identity is invalid');
  const prepared = await preparePublication(repository, prNumber, reviewedBody, api);
  if (!prepared.ok && prepared.reasons.length === 1 && prepared.reasons[0] === 'no release intent') {
    console.log(`PR #${prNumber} has no release intent; publication is not needed`);
    return;
  }
  if (!prepared.ok) throw new Error(`publication blocked: ${prepared.reasons.join('; ')}`);
  if (prepared.manifest.sourceSha !== expectedHead) throw new Error('merged source differs from publication event');
  const published = await publishApprovedCandidate(prepared.manifest, api, async () => {
    const refreshed = await preparePublication(repository, prNumber, reviewedBody, api);
    return refreshed.ok && refreshed.manifest.idempotencyKey === prepared.manifest.idempotencyKey &&
      JSON.stringify(refreshed.manifest) === JSON.stringify(prepared.manifest);
  });
  if (!published.ok) throw new Error(`publication incomplete; rerun after repair: ${published.error}`);
  console.log(`Published ${prepared.manifest.tag} from candidate ${prepared.manifest.candidateId}; release ${published.releaseId}`);
}

await main();

async function findSavedMergeNotesAssetId(repository: string, prNumber: number, expectedHead: string): Promise<number | undefined> {
  const prefix = `repos/${repository}`;
  const releases = await api.list(`${prefix}/releases?per_page=100`);
  if (!releases.ok) throw new Error('candidate releases could not be checked for saved notes');
  const release = releases.value.map(record).find((item) => item?.draft === true && item.name === `QA PR #${prNumber}`);
  if (release === undefined) return undefined;
  const details = await api.get(`${prefix}/releases/${release.id}`);
  const assets = record(details.ok ? details.value : undefined)?.assets;
  if (!Array.isArray(assets)) throw new Error('candidate release assets could not be checked for saved notes');
  const saved = assets.map(record).find((item) => item?.name === `qa-merge-notes-${expectedHead}.json`);
  if (saved === undefined) return undefined;
  if (!Number.isSafeInteger(saved.id) || (saved.id as number) <= 0) throw new Error('saved notes asset identity is invalid');
  return saved.id as number;
}

async function readSavedMergeNotes(repository: string, prNumber: number, expectedHead: string, assetId: number): Promise<string> {
  const prefix = `repos/${repository}`;
  const pullResult = await api.get(`${prefix}/pulls/${prNumber}`);
  const pull = record(pullResult.ok ? pullResult.value : undefined);
  if (pull?.merged !== true || record(pull.head)?.sha !== expectedHead || typeof pull.merged_at !== 'string') throw new Error('saved notes do not belong to the merged PR');
  const mergedAt = Date.parse(pull.merged_at);
  if (Number.isNaN(mergedAt)) throw new Error('merge time is unavailable');
  const releases = await api.list(`${prefix}/releases?per_page=100`);
  const release = releases.ok ? releases.value.map(record).find((item) => item?.draft === true && item.name === `QA PR #${prNumber}`) : undefined;
  if (!Number.isSafeInteger(release?.id)) throw new Error('candidate draft release is unavailable');
  const releaseResult = await api.get(`${prefix}/releases/${release?.id}`);
  const assets = record(releaseResult.ok ? releaseResult.value : undefined)?.assets;
  const asset = Array.isArray(assets) ? assets.map(record).find((item) => item?.id === assetId) : undefined;
  if (asset?.name !== `qa-merge-notes-${expectedHead}.json` || asset.state !== 'uploaded' || typeof asset.created_at !== 'string' ||
      Number.isNaN(Date.parse(asset.created_at)) || Date.parse(asset.created_at) > mergedAt) throw new Error('reviewed notes snapshot was not saved before merge');
  const directory = await mkdtemp(join(tmpdir(), 'release-qa-merge-notes-'));
  try {
    const destination = join(directory, 'snapshot.json');
    const downloaded = await api.download(`${prefix}/releases/assets/${assetId}`, destination);
    if (!downloaded.ok) throw new Error('reviewed notes snapshot could not be downloaded');
    const snapshot = record(JSON.parse(await readFile(destination, 'utf8')) as unknown);
    if (snapshot?.schemaVersion !== 1 || snapshot.pullRequest !== prNumber || snapshot.headSha !== expectedHead || typeof snapshot.body !== 'string') throw new Error('reviewed notes snapshot is invalid');
    return snapshot.body;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
