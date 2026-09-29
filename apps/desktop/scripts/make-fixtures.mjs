// Writes the two recorded snapshots the window-capture uses (fixtures/before.json and fixtures/after.json). They are what
// the privileged process would send for one release pull request at two moments: blocked on Windows work, then passed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sha = '3f9c2a71d0b84e5a9c6d21f0a7b3e8c45d1e2f60';
const requirements = [
  { key: 'windows/persistence', title: 'Mapping persists across a restart', mode: 'automated', profile: 'windows' },
  { key: 'windows/device-feel', title: 'Sliders feel right', mode: 'manual', profile: 'windows' },
  { key: 'linux/persistence', title: 'Mapping persists across a restart', mode: 'automated', profile: 'linux' },
];
const history = {
  status: 'ok',
  releases: [
    { tag: 'v1.4.0', name: 'v1.4.0', publishedAt: '2026-09-12T09:30:00Z', url: 'https://github.com/acme/orbit-orchard/releases/tag/v1.4.0', qa: 'recorded' },
    { tag: 'v1.3.2', name: 'v1.3.2', publishedAt: '2026-08-20T14:05:00Z', url: 'https://github.com/acme/orbit-orchard/releases/tag/v1.3.2', qa: 'missing' },
  ],
};
const pull = (gate) => ({
  number: 14, title: 'Release 1.5.0', author: 'maintainer', url: 'https://github.com/acme/orbit-orchard/pull/14', headRef: 'release/1.5.0', headSha: sha, draft: false,
  releaseIntent: ['release branch', 'release label'], gate,
});
const project = (gate) => ({
  repository: 'acme/orbit-orchard', projectId: 'orbit-orchard', releaseBranch: 'main', role: 'maintain', readOnly: false, profiles: ['windows', 'linux'], requirements,
  pullRequests: { status: 'ok', items: [pull(gate)] }, history,
});
const snapshot = (gate, loadedAt) => ({
  loadedAt, stale: false, account: { status: 'signed-in', login: 'maintainer' }, projects: [project(gate)],
  problems: [{ repository: 'acme/private-tools', reason: 'organization-rejected' }],
});

const before = { status: 'evaluated', candidateId: 'cand-20260929-1', candidateReleaseId: 812, evaluation: {
  readiness: 'blocked',
  reasons: [
    { code: 'missing-result', requirement: 'windows/device-feel' },
    { code: 'not-passed', requirement: 'linux/persistence', outcomes: ['failed'] },
  ],
  excused: [], acceptedReportIds: ['report-win-01'], exceptionIds: [],
  ignored: [{ kind: 'report', id: 'report-old-07', reason: 'other-candidate' }],
} };
const after = { status: 'evaluated', candidateId: 'cand-20260929-1', candidateReleaseId: 812, evaluation: {
  readiness: 'passed', reasons: [], excused: [], acceptedReportIds: ['report-win-01', 'report-win-02', 'report-linux-01'], exceptionIds: [],
  ignored: [{ kind: 'report', id: 'report-old-07', reason: 'other-candidate' }],
} };

const out = resolve(import.meta.dirname, '..', 'fixtures');
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, 'before.json'), `${JSON.stringify(snapshot(before, '2026-09-29T09:00:00.000Z'), null, 2)}\n`);
writeFileSync(resolve(out, 'after.json'), `${JSON.stringify(snapshot(after, '2026-09-29T11:30:00.000Z'), null, 2)}\n`);
