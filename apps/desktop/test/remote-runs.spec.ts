import { describe, expect, test } from 'vitest';
import { remoteRunTitle, type PullRequestGateResult } from '@frogbyte-io/release-qa';
import { listRemoteRuns, parseRemoteRunRequest, runOnLinux } from '../src/main/remote-runs.ts';
import { evaluation } from './fixtures.ts';
import { actionTransport } from './transport.ts';

const HEAD = 'a'.repeat(40);
const TRUNK = 'b'.repeat(40);
const request = { repository: 'acme/app', number: 7, headSha: HEAD, candidateId: 'cand-1', profile: 'linux', suite: 'release' };
const repoReply = (permissions: Record<string, boolean>) => ({ 'repos/acme/app': { ok: true as const, value: { id: 1, full_name: 'acme/app', default_branch: 'main', permissions } } });
const maintainer = repoReply({ pull: true, push: true, maintain: true });

/** A project as discovery returns it: a run workflow, a Windows and a Linux profile, one suite covering both. */
const discovered = (workflows: Record<string, string> = { prepare: 'qa-prepare.yml', gate: 'qa-gate.yml', publish: 'qa-publish.yml', run: 'qa-run.yml' }) => (async () => ({
  problems: [],
  projects: [{
    repository: 'acme/app',
    project: {
      profiles: [{ id: 'windows', os: 'windows', arch: 'x86_64' }, { id: 'linux', os: 'linux', arch: 'x86_64' }],
      suites: [{ id: 'release', requirements: ['windows/persistence', 'linux/persistence'] }, { id: 'windows-only', requirements: ['windows/persistence'] }],
      workflows,
    },
  }],
})) as never;

const gate = (candidateId: string | undefined = 'cand-1'): PullRequestGateResult => ({
  ok: true,
  value: {
    pullRequest: 7, headSha: HEAD, baseRef: 'main', baseSha: 'd'.repeat(40), ...(candidateId === undefined ? {} : { candidateId, candidateReleaseId: 50 }),
    releaseIntent: ['release branch'], evaluation: evaluation({ readiness: 'blocked' }), summary: '', markers: { releaseNotes: 'release-notes', qa: 'qa' },
  },
});
const evaluating = (result: PullRequestGateResult, seen: unknown[][] = []) => (async (...args: unknown[]) => { seen.push(args); return result; }) as never;
const dispatching = (result: unknown, seen: unknown[][] = []) => (async (...args: unknown[]) => { seen.push(args); return result; }) as never;

describe('validating the run request from the window', () => {
  test.each([
    [{ ...request }, true],
    [{ ...request, headSha: 'main' }, false],
    [{ ...request, repository: '../x' }, false],
    [{ ...request, candidateId: 'a b' }, false],
    [{ ...request, profile: '../linux' }, false],
    [{ ...request, suite: '' }, false],
    [{ ...request, suite: 5 }, false],
    [{ ...request, candidateId: undefined }, false],
    [null, false],
  ])('parseRemoteRunRequest(%j) is valid: %s', (value, valid) => {
    expect(parseRemoteRunRequest(value) !== undefined).toBe(valid);
  });
});

describe('runOnLinux', () => {
  test('dispatches the reviewed head, candidate, profile and suite through the project\'s own workflow', async () => {
    const seen: unknown[][] = [];
    const evaluated: unknown[][] = [];
    const api = actionTransport({ ...maintainer });
    const result = await runOnLinux(request, { api, discover: discovered(), evaluate: evaluating(gate(), evaluated), dispatchRun: dispatching({ ok: true, runId: 99, workflowHeadSha: TRUNK, url: 'u' }, seen) });
    expect(result).toMatchObject({ ok: true, message: expect.stringContaining('workflow run 99') });
    expect(seen[0]?.slice(0, 3)).toEqual(['acme/app', 'qa-run.yml', { prNumber: 7, candidateId: 'cand-1', profile: 'linux', suite: 'release', expectedHead: HEAD }]);
    // The head is pinned when the gate is re-read.
    expect(evaluated[0]?.[3]).toBe(HEAD);
  });

  test('refuses malformed input before reading anything', async () => {
    const api = actionTransport({});
    expect(await runOnLinux({ ...request, headSha: 'nope' }, { api })).toEqual({ ok: false, error: 'That is not a valid run request.' });
  });

  test('a read-only account is refused, and nothing is dispatched', async () => {
    const seen: unknown[][] = [];
    const result = await runOnLinux(request, { api: actionTransport(repoReply({ pull: true })), discover: discovered(), evaluate: evaluating(gate()), dispatchRun: dispatching({ ok: true, runId: 1 }, seen) });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('read-only') });
    expect(seen).toEqual([]);
  });

  test('lost sign-in is refused with the way to fix it', async () => {
    const api = actionTransport({}, {});
    const signedOut = Object.assign(api, { auth: async () => ({ ok: false as const, reason: 'logged-out' as const }) });
    const result = await runOnLinux(request, { api: signedOut, discover: discovered(), evaluate: evaluating(gate()) });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('gh auth login') });
  });

  test('a project without a run workflow cannot run one', async () => {
    const seen: unknown[][] = [];
    const result = await runOnLinux(request, { api: actionTransport({ ...maintainer }), discover: discovered({ prepare: 'a.yml', gate: 'b.yml', publish: 'c.yml' }), evaluate: evaluating(gate()), dispatchRun: dispatching({ ok: true, runId: 1 }, seen) });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('workflows.run') });
    expect(seen).toEqual([]);
  });

  test('only a Linux profile and suite pair the project offers is accepted', async () => {
    const seen: unknown[][] = [];
    const deps = { api: actionTransport({ ...maintainer }), discover: discovered(), evaluate: evaluating(gate()), dispatchRun: dispatching({ ok: true, runId: 1 }, seen) };
    for (const changes of [{ profile: 'windows' }, { suite: 'windows-only' }, { suite: 'unknown' }, { profile: 'other' }]) {
      expect(await runOnLinux({ ...request, ...changes }, deps)).toMatchObject({ ok: false, error: expect.stringContaining('offers no Linux run') });
    }
    expect(seen).toEqual([]);
  });

  test('a candidate replaced since the person looked is refused', async () => {
    const seen: unknown[][] = [];
    const result = await runOnLinux(request, { api: actionTransport({ ...maintainer }), discover: discovered(), evaluate: evaluating(gate('cand-2')), dispatchRun: dispatching({ ok: true, runId: 1 }, seen) });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('now cand-2, not the cand-1') });
    expect(seen).toEqual([]);
  });

  test('a gate that cannot be evaluated (head moved, no candidate) is refused', async () => {
    const result = await runOnLinux(request, { api: actionTransport({ ...maintainer }), discover: discovered(), evaluate: evaluating({ ok: false, error: 'PR head changed' } as never) });
    expect(result).toEqual({ ok: false, error: 'Not started: PR head changed' });
  });

  test('a dispatch GitHub refuses is reported, and a run that already started is named so it is not started twice', async () => {
    const deps = { api: actionTransport({ ...maintainer }), discover: discovered(), evaluate: evaluating(gate()) };
    expect(await runOnLinux(request, { ...deps, dispatchRun: dispatching({ ok: false, error: 'suite run dispatch failed: not-found' }) })).toEqual({ ok: false, error: 'suite run dispatch failed: not-found' });
    expect(await runOnLinux(request, { ...deps, dispatchRun: dispatching({ ok: false, error: 'does not match', runId: 99 }) })).toMatchObject({ ok: false, error: expect.stringContaining('workflow run 99 was already started') });
  });
});

describe('listRemoteRuns rebuilds everything from GitHub', () => {
  const entry = (id: number, changes: Record<string, unknown> = {}) => ({
    id, run_attempt: 1, path: '.github/workflows/qa-run.yml', event: 'workflow_dispatch', head_branch: 'main', repository: { id: 1 },
    display_title: remoteRunTitle({ prNumber: 7, candidateId: 'cand-1', profile: 'linux', suite: 'release', expectedHead: HEAD }), status: 'queued', conclusion: null, created_at: `2026-09-30T11:5${id}:00Z`, ...changes,
  });
  const github = (runs: unknown[], jobs: Record<string, unknown> = {}) => ({
    ...maintainer,
    'repos/acme/app/actions/workflows/qa-run.yml/runs?event=workflow_dispatch&branch=main&per_page=100': { ok: true as const, value: { workflow_runs: runs } },
    ...Object.fromEntries(Object.entries(jobs).map(([id, value]) => [`repos/acme/app/actions/runs/${id}/jobs?per_page=100`, { ok: true as const, value }])),
  });
  const now = () => new Date('2026-09-30T12:00:00Z');

  test('two reads with no shared state show the same runs and statuses', async () => {
    const table = github([entry(3, { status: 'completed', conclusion: 'failure' }), entry(2, { status: 'in_progress' })], { 2: { jobs: [{ status: 'in_progress', runner_id: 1 }] } });
    const first = await listRemoteRuns({ repository: 'acme/app', number: 7 }, { api: actionTransport(table), discover: discovered(), now });
    // A new transport and new dependencies stand in for a new process: nothing carries over but GitHub.
    const second = await listRemoteRuns({ repository: 'acme/app', number: 7 }, { api: actionTransport(table), discover: discovered(), now });
    expect(second).toEqual(first);
    expect(first.ok && first.runs.map((run) => [run.runId, run.state, run.conclusion])).toEqual([[3, 'completed', 'failure'], [2, 'running', undefined]]);
    expect(first.ok && first.runs[1]).toMatchObject({ candidateId: 'cand-1', profile: 'linux', suite: 'release', headSha: HEAD, url: 'https://github.com/acme/app/actions/runs/2' });
  });

  test('each of the five states comes through', async () => {
    const stuck = { status: 'queued', runner_id: null, runner_name: null, labels: ['ubuntu-24.04'], created_at: '2026-09-30T11:00:00Z' };
    const table = github(
      [entry(1), entry(2, { status: 'in_progress' }), entry(3, { status: 'completed', conclusion: 'success' }), entry(4, { status: 'queued' }), entry(5, { status: 'waiting' })],
      { 1: { jobs: [{ ...stuck, created_at: '2026-09-30T11:59:30Z' }] }, 2: { jobs: [{ status: 'in_progress', runner_id: 1 }] }, 4: { jobs: [stuck] }, 5: { jobs: [] } },
    );
    const result = await listRemoteRuns({ repository: 'acme/app', number: 7 }, { api: actionTransport(table), discover: discovered(), now });
    expect(result.ok && Object.fromEntries(result.runs.map((run) => [run.runId, run.state]))).toEqual({ 1: 'queued', 2: 'running', 3: 'completed', 4: 'runner-unavailable', 5: 'blocked' });
  });

  test('a project with no run workflow is reported as not configured, not as having no runs', async () => {
    const result = await listRemoteRuns({ repository: 'acme/app', number: 7 }, { api: actionTransport({ ...maintainer }), discover: discovered({ prepare: 'a.yml', gate: 'b.yml', publish: 'c.yml' }) });
    expect(result).toEqual({ ok: true, configured: false, runs: [] });
  });

  test('losing access or sign-in is an error, never an empty list', async () => {
    const lost = await listRemoteRuns({ repository: 'acme/app', number: 7 }, { api: actionTransport({}), discover: discovered() });
    expect(lost).toMatchObject({ ok: false });
    const api = Object.assign(actionTransport(github([])), { auth: async () => ({ ok: false as const, reason: 'logged-out' as const }) });
    expect(await listRemoteRuns({ repository: 'acme/app', number: 7 }, { api, discover: discovered() })).toMatchObject({ ok: false, error: expect.stringContaining('gh auth login') });
  });

  test('a listing GitHub cannot return is an error', async () => {
    const result = await listRemoteRuns({ repository: 'acme/app', number: 7 }, { api: actionTransport({ ...maintainer }), discover: discovered() });
    expect(result).toMatchObject({ ok: false });
  });

  test('a malformed pull request reference is refused', async () => {
    expect(await listRemoteRuns({ repository: '../x', number: 7 }, { api: actionTransport({}) })).toEqual({ ok: false, error: 'That is not a valid pull request.' });
  });
});
