import { readFile } from 'node:fs/promises';
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
    if (event.action !== 'closed' || pull?.merged !== true || typeof pull.number !== 'number' || typeof pull.body !== 'string') throw new Error('event is not a merged release PR with reviewed notes');
    prNumber = pull.number;
    reviewedBody = pull.body;
    expectedHead = record(pull.head)?.sha as string | undefined;
  } else if (eventName === 'workflow_dispatch') {
    const inputs = record(event.inputs);
    prNumber = Number(inputs?.pr_number);
    expectedHead = typeof inputs?.expected_head === 'string' ? inputs.expected_head : undefined;
    if (typeof inputs?.reviewed_body_base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(inputs.reviewed_body_base64)) throw new Error('reviewed PR body snapshot is required');
    reviewedBody = Buffer.from(inputs.reviewed_body_base64, 'base64').toString('utf8');
  } else throw new Error('unsupported publication event');
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0 || !/^[0-9a-f]{40}$/.test(expectedHead ?? '')) throw new Error('publication PR or source identity is invalid');
  const prepared = await preparePublication(repository, prNumber, reviewedBody, api);
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
