import { GhTransport } from './transport.ts';
import { reconcileRelease } from './sync.ts';

const repository = process.env.GITHUB_REPOSITORY;
const releaseId = Number(process.env.INPUT_RELEASE_ID);
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (!repository || !Number.isSafeInteger(releaseId) || releaseId <= 0 || !summaryPath) throw new Error('reconcile workflow inputs are missing');

const api = new GhTransport();
const rebuilt = await reconcileRelease(repository, releaseId, api);
if (!rebuilt.ok) throw new Error(`could not reconcile release: ${rebuilt.reason}`);
const lines = [`## Release QA synchronization`, `Release asset ID: ${releaseId}`, `Candidate records: ${rebuilt.value.length}`];
for (const progress of rebuilt.value) {
  lines.push(`### ${progress.candidateId}`, `- Verified reports: ${progress.reports.length}`, `- Incomplete uploads: ${progress.incomplete.length}`, `- Duplicate attempt IDs: ${progress.duplicateAttempts.length}`, `- Advisory scenario claims: ${progress.claims.length}`);
  for (const name of progress.incomplete) lines.push(`  - Incomplete: ${name}`);
}
const { appendFile } = await import('node:fs/promises');
await appendFile(summaryPath, `${lines.join('\n')}\n`, 'utf8');
