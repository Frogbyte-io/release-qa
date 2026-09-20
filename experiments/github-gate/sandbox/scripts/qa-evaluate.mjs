// Experiment evaluator for Release QA Task 0.2. Reads candidate/report/exception records from a
// draft release named "QA PR #<n>" and fails the job unless the current PR head has a
// complete, matching set of passing reports (or authorized exceptions). Never emits neutral/skipped.
//
// NOT SAFE for untrusted PR authors: for `pull_request` the workflow file comes from the PR's
// test-merge commit, so a PR can replace this job. See docs/decisions/github-gate.md.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const ghRaw = (...args) => execFileSync('gh', ['api', ...args], { encoding: 'utf8' });
const gh = (...args) => JSON.parse(ghRaw(...args));
// Paginated list endpoints: one JSON object per line via --jq '.[]', so every page is read.
const ghList = (path) =>
  ghRaw('--paginate', path, '--jq', '.[]').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const repo = process.env.GITHUB_REPOSITORY;
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const eventName = process.env.GITHUB_EVENT_NAME;
const prNumber = event.pull_request?.number ?? Number(event.inputs?.pr_number);
const summary = [];
const say = (line) => { console.log(line); summary.push(line); };
const finish = (ok, title) => {
  say(`\n**${ok ? 'PASS' : 'BLOCKED'}**: ${title}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');
  process.exit(ok ? 0 : 1);
};

const pr = gh(`repos/${repo}/pulls/${prNumber}`);
say(`- event: ${eventName}/${event.action ?? ''}`);
say(`- GITHUB_SHA (checked-out ref): ${process.env.GITHUB_SHA}`);
say(`- event head sha: ${event.pull_request?.head.sha}`);
say(`- current PR head sha: ${pr.head.sha}`);
say(`- current base sha: ${pr.base.sha}`);
say(`- merge_commit_sha: ${pr.merge_commit_sha}`);

if (event.pull_request && event.pull_request.head.sha !== pr.head.sha) {
  finish(false, `obsolete evaluation: event head ${event.pull_request.head.sha} is not current head ${pr.head.sha}`);
}
if (eventName === 'workflow_dispatch' && process.env.GITHUB_SHA !== pr.head.sha) {
  finish(false, `dispatched at ${process.env.GITHUB_SHA}, which is not the PR head ${pr.head.sha}; result would attach to the wrong commit`);
}

const baseTip = gh(`repos/${repo}/branches/${pr.base.ref}`).commit.sha;
say(`- current tip of ${pr.base.ref}: ${baseTip}${baseTip === pr.base.sha ? '' : ' (PR base.sha is stale)'}`);
const policy = JSON.parse(
  Buffer.from(gh(`repos/${repo}/contents/qa/policy.json?ref=${baseTip}`).content, 'base64').toString(),
);

// Release intent comes from branch, label AND changed version metadata, so removing a label cannot bypass QA.
const files = ghList(`repos/${repo}/pulls/${prNumber}/files?per_page=100`).map((f) => f.filename);
const reasons = [];
if (pr.head.ref.startsWith(policy.releaseBranchPrefix)) reasons.push('release branch');
if (pr.labels.some((l) => l.name === policy.releaseLabel)) reasons.push('release label');
const versionFiles = files.filter((f) => policy.releaseFiles.includes(f));
if (versionFiles.length) reasons.push(`release file changed: ${versionFiles.join(', ')}`);
say(`- release intent: ${reasons.length ? reasons.join('; ') : 'none'}`);
if (!reasons.length) finish(true, 'not a release PR; normal policy applies');

const draftName = `QA PR #${prNumber}`;
const releases = ghList(`repos/${repo}/releases?per_page=100`);
say(`- releases visible to token: ${releases.length} (drafts: ${releases.filter((r) => r.draft).length})`);
const draft = releases.find((r) => r.draft && r.name === draftName);
if (!draft) finish(false, 'manual check required: no candidate release record for this PR');

const assetJson = (asset) =>
  JSON.parse(ghRaw('-H', 'Accept: application/octet-stream', `repos/${repo}/releases/assets/${asset.id}`));
const candidateAsset = draft.assets.find((a) => a.name === 'candidate.json');
if (!candidateAsset) finish(false, 'manual check required: no active candidate selected');
const candidate = assetJson(candidateAsset);
say(`- candidate ${candidate.id} for source ${candidate.sourceSha}`);
if (candidate.baseSha !== baseTip) {
  finish(false, `target branch moved: candidate base ${candidate.baseSha}, current ${baseTip}; prepare a new candidate`);
}
if (candidate.sourceSha !== pr.head.sha) {
  finish(false, `candidate was prepared for ${candidate.sourceSha}, current head is ${pr.head.sha}`);
}

const reports = draft.assets.filter((a) => a.name.startsWith('report-')).map((a) => ({ ...assetJson(a), uploader: a.uploader?.login }))
  .filter((r) => r.candidateId === candidate.id);
const unknown = [...new Set(reports.map((r) => r.requirement))].filter((k) => !policy.required.includes(k));
if (unknown.length) say(`- ignoring results for requirements not in policy.required: ${unknown.join(', ')}`);
const missing = [];
for (const key of policy.required) {
  const mine = reports.filter((r) => r.requirement === key);
  if (mine.some((r) => r.outcome === 'failed')) missing.push(`${key} (failed attempt present)`);
  else if (!mine.some((r) => r.outcome === 'passed')) missing.push(key);
}

// Exceptions: authority comes from the verified uploader of the release asset, never from claimed text.
const authorized = new Map();
for (const asset of draft.assets.filter((a) => a.name.startsWith('exception-'))) {
  const ex = assetJson(asset);
  const login = asset.uploader?.login;
  if (ex.candidateId !== candidate.id) continue;
  let role = 'none';
  try { role = gh(`repos/${repo}/collaborators/${login}/permission`).role_name; } catch { /* unknown user */ }
  say(`- exception asset ${asset.name} uploaded by ${login} (role ${role}, claimed actor ${ex.actor})`);
  if (['admin', 'maintain'].includes(role)) for (const key of ex.requirements) authorized.set(key, ex.reason);
}

const unresolved = missing.filter((m) => !authorized.has(m.replace(/ \(failed attempt present\)$/, '')));

// Re-read identities immediately before passing: a candidate replaced, or a head/base moved, while this
// job ran must not be approved by a stale snapshot. This narrows the race; publication must still revalidate.
const revalidate = () => {
  const head2 = gh(`repos/${repo}/pulls/${prNumber}`).head.sha;
  const tip2 = gh(`repos/${repo}/branches/${pr.base.ref}`).commit.sha;
  const cand2 = gh(`repos/${repo}/releases/${draft.id}`).assets.find((a) => a.name === 'candidate.json');
  const cid2 = cand2 ? assetJson(cand2).id : null;
  if (head2 !== pr.head.sha || tip2 !== baseTip || cid2 !== candidate.id) {
    finish(false, 'state changed during evaluation (head, base or candidate); evaluate again');
  }
};

if (unresolved.length) finish(false, `manual check required: ${unresolved.join(', ')}`);
revalidate();
if (missing.length) finish(true, `APPROVED WITH EXCEPTIONS for ${missing.join(', ')}`);
finish(true, `all ${policy.required.length} required results present for candidate ${candidate.id}`);
