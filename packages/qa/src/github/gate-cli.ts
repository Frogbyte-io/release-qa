import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { GhTransport } from './transport.ts';
import { evaluatePullRequest } from './pull-request-gate.ts';
import type { DeferredGateResult } from './gate-finalize.ts';
import { renderQaSection } from './gate.ts';
import { ensureManagedSections, proposeReleaseNotes, readManagedSection, updatePullRequestBody } from './pull-request.ts';

const repository = process.env.GITHUB_REPOSITORY;
const eventPath = process.env.GITHUB_EVENT_PATH;
if (!repository || !eventPath) throw new Error('GitHub repository and event payload are required');
if (process.env.GITHUB_EVENT_NAME !== 'pull_request_target') throw new Error('required gate status may only be published from pull_request_target');
const event = JSON.parse(await readFile(eventPath, 'utf8')) as { pull_request?: { number?: unknown; head?: { sha?: unknown } } };
const pullRequest = event.pull_request?.number;
const eventHead = event.pull_request?.head?.sha;
if (!Number.isSafeInteger(pullRequest) || (pullRequest as number) <= 0 || typeof eventHead !== 'string' || !/^[0-9a-f]{40}$/.test(eventHead)) {
  throw new Error('workflow must run from a pull_request_target event with a valid pull request head');
}
const pullRequestNumber = pullRequest as number;
const releaseIdInput = process.env.RELEASE_QA_RELEASE_ID;
const candidateReleaseId = releaseIdInput === undefined || releaseIdInput === '' ? undefined : Number(releaseIdInput);
const releaseSnapshotInput = process.env.RELEASE_QA_RELEASE_SNAPSHOT_B64;
const releaseSnapshotPath = process.env.RELEASE_QA_RELEASE_SNAPSHOT_FILE;
let candidateReleaseSnapshot: unknown;
if (releaseSnapshotPath !== undefined && releaseSnapshotPath !== '') {
  try { candidateReleaseSnapshot = JSON.parse(await readFile(releaseSnapshotPath, 'utf8')) as unknown; }
  catch { candidateReleaseSnapshot = null; }
} else if (releaseSnapshotInput !== undefined && releaseSnapshotInput !== '') {
  try { candidateReleaseSnapshot = JSON.parse(Buffer.from(releaseSnapshotInput, 'base64').toString('utf8')) as unknown; }
  catch { candidateReleaseSnapshot = null; }
}

const api = new GhTransport();
const deferredResultFile = process.env.RELEASE_QA_DEFER_FINALIZATION_FILE;
const evaluation = await evaluatePullRequest(repository, pullRequestNumber, api, eventHead, candidateReleaseId, candidateReleaseSnapshot, {
  deferFinalReleaseVerification: deferredResultFile !== undefined && deferredResultFile !== '',
});
const state = evaluation.ok && evaluation.value.evaluation.readiness !== 'blocked' ? 'success' : 'failure';
const description = evaluation.ok
  ? `${evaluation.value.evaluation.readiness === 'approved-with-exceptions' ? 'Approved with exceptions' : evaluation.value.evaluation.readiness === 'passed' ? 'QA passed' : 'QA blocked'} for PR #${pullRequest}`
  : `QA blocked: ${evaluation.error}`;
const summary = evaluation.ok ? evaluation.value.summary : `**BLOCKED**: ${evaluation.error}`;
console.log(summary);

if (deferredResultFile !== undefined && deferredResultFile !== '') {
  const result: DeferredGateResult = {
    schemaVersion: 1,
    repository,
    pullRequest: pullRequestNumber,
    eventHead,
    state,
    description,
    summary,
    ...(evaluation.ok ? {
      headSha: evaluation.value.headSha,
      baseRef: evaluation.value.baseRef,
      baseSha: evaluation.value.baseSha,
      candidateId: evaluation.value.candidateId,
      candidateReleaseId: evaluation.value.candidateReleaseId,
      candidateAssetId: evaluation.value.candidateAssetId,
      releaseIntent: evaluation.value.releaseIntent,
    } : {}),
  };
  await writeFile(deferredResultFile, JSON.stringify(result), { encoding: 'utf8', flag: 'wx' });
} else {
  // Direct mode is retained for local diagnostics and workflows without a broker/finalizer boundary.
  const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined;
  const posted = await api.post(`repos/${repository}/statuses/${eventHead}`, {
    state,
    context: 'release-qa',
    description: description.slice(0, 140),
    ...(runUrl === undefined ? {} : { target_url: runUrl }),
  });
  if (!posted.ok) throw new Error(`could not publish required release-qa status: ${posted.reason}`);
}

if (process.env.GITHUB_STEP_SUMMARY) {
  try { await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Release QA gate\n\n${summary}\n`, 'utf8'); }
  catch { console.log('Workflow step summary could not be written; the required status was already published.'); }
}

const markers = evaluation.ok ? evaluation.value.markers : evaluation.markers;
if (deferredResultFile === undefined && markers !== undefined) {
  const prResponse = await api.get(`repos/${repository}/pulls/${pullRequestNumber}`);
  if (prResponse.ok && typeof prResponse.value === 'object' && prResponse.value !== null) {
  const prBody = (prResponse.value as { body?: unknown }).body;
  const body = typeof prBody === 'string' ? prBody : '';
  const initialized = ensureManagedSections(body, [markers.releaseNotes, markers.qa]);
  if (initialized.ok) {
    const notes = readManagedSection(initialized.body, markers.releaseNotes);
    const qa = readManagedSection(initialized.body, markers.qa);
    if (notes.ok && qa.ok) {
      const proposed = notes.content.trim() ? { ok: true as const, content: notes.content } : await proposeReleaseNotes(api, repository);
      const qaContent = evaluation.ok ? renderQaSection(evaluation.value.evaluation) : `**BLOCKED**: ${evaluation.error}`;
      const update = await updatePullRequestBody(api, repository, pullRequestNumber, [
        { name: markers.releaseNotes, content: proposed.ok ? proposed.content : notes.content, expected: notes.content },
        { name: markers.qa, content: qaContent, expected: qa.content },
      ]);
      if (!update.ok) console.log(`PR summary was not updated: ${update.error}`);
    }
  } else {
    console.log(`PR summary was not updated: ${initialized.error}`);
  }
  }
}
