import { appendFile, readFile } from 'node:fs/promises';
import { GhTransport } from './transport.ts';
import { finalizeGateResult } from './gate-finalize.ts';

const repository = process.env.GITHUB_REPOSITORY;
const eventPath = process.env.GITHUB_EVENT_PATH;
const resultPath = process.env.RELEASE_QA_DEFERRED_RESULT_FILE;
if (!repository || !eventPath || !resultPath) throw new Error('GitHub repository, event payload, and deferred result path are required');
if (process.env.GITHUB_EVENT_NAME !== 'pull_request_target') throw new Error('required gate status may only be finalized from pull_request_target');

const event = JSON.parse(await readFile(eventPath, 'utf8')) as { pull_request?: { number?: unknown; head?: { sha?: unknown } } };
const pullRequest = event.pull_request?.number;
const eventHead = event.pull_request?.head?.sha;
if (!Number.isSafeInteger(pullRequest) || (pullRequest as number) <= 0 || typeof eventHead !== 'string' || !/^[0-9a-f]{40}$/.test(eventHead)) {
  throw new Error('workflow must run from a pull_request_target event with a valid pull request head');
}

let evaluation: unknown = null;
try { evaluation = JSON.parse(await readFile(resultPath, 'utf8')) as unknown; }
catch { console.log('Evaluator result artifact is missing or unreadable; publishing a failing required status.'); }

const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : undefined;
const finalization = await finalizeGateResult(repository, pullRequest as number, eventHead, evaluation, new GhTransport(), runUrl);
if (!finalization.ok) throw new Error(finalization.error);
console.log(finalization.summary);

if (process.env.GITHUB_STEP_SUMMARY) {
  try { await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Release QA gate\n\n${finalization.summary}\n`, 'utf8'); }
  catch { console.log('Workflow step summary could not be written; the required status was already published.'); }
}
if (finalization.state !== 'success') process.exitCode = 1;
