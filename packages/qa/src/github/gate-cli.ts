import { appendFile, readFile } from 'node:fs/promises';
import { GhTransport } from './transport.ts';
import { evaluatePullRequest } from './pull-request-gate.ts';
import { renderQaSection } from './gate.ts';
import { ensureManagedSections, proposeReleaseNotes, readManagedSection, updatePullRequestBody } from './pull-request.ts';

const repository = process.env.GITHUB_REPOSITORY;
const eventPath = process.env.GITHUB_EVENT_PATH;
if (!repository || !eventPath) throw new Error('GitHub repository and event payload are required');
const event = JSON.parse(await readFile(eventPath, 'utf8')) as { pull_request?: { number?: unknown; head?: { sha?: unknown } } };
const pullRequest = event.pull_request?.number;
const eventHead = event.pull_request?.head?.sha;
if (!Number.isSafeInteger(pullRequest) || (pullRequest as number) <= 0 || typeof eventHead !== 'string' || !/^[0-9a-f]{40}$/.test(eventHead)) {
  throw new Error('workflow must run from a pull_request_target event with a valid pull request head');
}
const pullRequestNumber = pullRequest as number;

const api = new GhTransport();
const evaluation = await evaluatePullRequest(repository, pullRequestNumber, api, eventHead);
const state = evaluation.ok && evaluation.value.evaluation.readiness !== 'blocked' ? 'success' : 'failure';
const description = evaluation.ok
  ? `${evaluation.value.evaluation.readiness === 'approved-with-exceptions' ? 'Approved with exceptions' : evaluation.value.evaluation.readiness === 'passed' ? 'QA passed' : 'QA blocked'} for PR #${pullRequest}`
  : `QA blocked: ${evaluation.error}`;
const summary = evaluation.ok ? evaluation.value.summary : `**BLOCKED**: ${evaluation.error}`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Release QA gate\n\n${summary}\n`, 'utf8');

// Publish immediately after the evaluator's final identity check; optional PR-summary writes follow.
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
if (state !== 'success') process.exitCode = 1;

const prResponse = await api.get(`repos/${repository}/pulls/${pullRequestNumber}`);
if (prResponse.ok && typeof prResponse.value === 'object' && prResponse.value !== null) {
  const prBody = (prResponse.value as { body?: unknown }).body;
  const body = typeof prBody === 'string' ? prBody : '';
  const markers = evaluation.ok ? evaluation.value.markers : { releaseNotes: 'release-notes', qa: 'release-qa' };
  const initialized = ensureManagedSections(body, [markers.releaseNotes, markers.qa]);
  if (initialized.ok) {
    const notes = readManagedSection(initialized.body, markers.releaseNotes);
    const qa = readManagedSection(initialized.body, markers.qa);
    if (notes.ok && qa.ok) {
      const proposed = notes.content.trim() ? { ok: true as const, content: notes.content } : await proposeReleaseNotes(api, repository);
      const qaContent = evaluation.ok ? renderQaSection(evaluation.value.evaluation) : `**QA: Blocked**\n${evaluation.error}`;
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
