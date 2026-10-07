import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { designateTestRoot, type Candidate } from '@frogbyte-io/release-qa';
import type { RunStatus } from '../src/shared/contract.ts';
import { cancelRunAction, chooseCheckout, getCheckout, listRunsAction, parseRunConfirmation, parseRunRequest, parseSyncRequest, previewRun, RunSession, startRunAction, syncRunAction, type CheckoutStore, type RunDeps } from '../src/main/run-actions.ts';
import { writeConsumer } from '../../../packages/qa/test/fixtures/consumer.ts';
import { candidate as candidateRecord } from '../../../packages/qa/test/fixtures/records.ts';
import { cleanUpProcessesAndRoots, makeTempDir } from '../../../packages/qa/test/fixtures/processes.ts';
import { actionTransport } from './transport.ts';

vi.setConfig({ testTimeout: 60_000 });
afterEach(cleanUpProcessesAndRoots);

const HEAD = 'a'.repeat(40);
const REVISION = 'b'.repeat(40);
const RUN_ID = 'run-20260930T101010Z-0a1b2c';
const target = { repository: 'acme/app', number: 7, headSha: HEAD };
const worker = join(import.meta.dirname, '..', '..', '..', 'packages', 'qa', 'src', 'cli', 'consumer-worker.ts');

describe('validating what the window sends', () => {
  test.each([
    [{ ...target, profile: 'windows', suite: 'release' }, true],
    [{ ...target, profile: 'windows', suite: 'release', runId: RUN_ID }, true],
    [{ ...target, profile: '../windows', suite: 'release' }, false],
    [{ ...target, profile: 'windows', suite: 'a/b' }, false],
    [{ ...target, profile: 'win dows', suite: 'release' }, false],
    [{ ...target, profile: 'windows', suite: '' }, false],
    [{ ...target, profile: 'windows', suite: 'release', runId: '..' }, false],
    [{ ...target, profile: 'windows', suite: 'release', runId: `../${RUN_ID}` }, false],
    [{ ...target, profile: 'windows', suite: 'release', runId: 5 }, false],
    [{ ...target, repository: '../x', profile: 'windows', suite: 'release' }, false],
    [{ ...target, headSha: 'main', profile: 'windows', suite: 'release' }, false],
    [null, false],
  ])('parseRunRequest(%j) is valid: %s', (value, valid) => {
    expect(parseRunRequest(value) !== undefined).toBe(valid);
  });

  test('a confirmation must carry the candidate and test root that were shown, and nothing else is passed on', () => {
    const base = { ...target, profile: 'windows', suite: 'release', candidateId: 'cand-1', root: 'C:\\work\\.release-qa' };
    expect(parseRunConfirmation({ ...base, extra: 'ignored' })).toEqual(base);
    expect(parseRunConfirmation({ ...base, candidateId: '' })).toBeUndefined();
    expect(parseRunConfirmation({ ...base, root: 5 })).toBeUndefined();
    expect(parseRunConfirmation({ ...base, root: 'x'.repeat(4097) })).toBeUndefined();
    expect(parseRunConfirmation({ ...target, profile: 'windows', suite: 'release' })).toBeUndefined();
  });

  test.each([null, undefined, 5, 'x', []])('a confirmation of %j is refused, not thrown on', (value) => {
    expect(parseRunConfirmation(value)).toBeUndefined();
  });

  test('a sync request needs a real run id', () => {
    expect(parseSyncRequest({ ...target, runId: RUN_ID })).toEqual({ ...target, runId: RUN_ID });
    expect(parseSyncRequest({ ...target, runId: '../../etc' })).toBeUndefined();
    expect(parseSyncRequest({ ...target })).toBeUndefined();
  });
});

describe('the run session', () => {
  const info = { kind: 'start' as const, repository: 'acme/app', number: 7, candidateId: 'c', profile: 'windows', suite: 'release' };

  test('one run at a time, and every change is announced', async () => {
    const seen: RunStatus[] = [];
    const session = new RunSession((status) => seen.push(status));
    let release = (): void => undefined;
    expect(session.begin(info, () => new Promise<void>((resolve) => { release = resolve; }))).toBe(true);
    expect(session.busy).toBe(true);
    expect(session.begin(info, async () => undefined)).toBe(false);
    session.progress({ scenario: 's', phase: 'steps', status: 'started' });
    release();
    await session.settled();
    expect(seen.at(-1)).toMatchObject({ state: 'preparing', progress: [{ scenario: 's' }] });
  });

  test('stopping aborts the signal the work was given', async () => {
    const session = new RunSession();
    let aborted = false;
    session.begin(info, (controller) => new Promise<void>((resolve) => { controller.signal.addEventListener('abort', () => { aborted = true; resolve(); }); }));
    expect(session.stop()).toBe(true);
    await session.settled();
    expect(aborted).toBe(true);
    expect(session.current).toMatchObject({ stopping: true });
  });

  test('work that throws leaves a failed state, not a stuck one', async () => {
    const session = new RunSession();
    session.begin(info, async () => { throw new Error('disk full'); });
    await session.settled();
    expect(session.current).toMatchObject({ state: 'failed' });
    expect(session.busy).toBe(false);
    expect(session.stop()).toBe(false);
  });
});

// A real checkout on disk, a designated test root inside it, and GitHub answered from a table.
async function setUp(options: { permissions?: Record<string, boolean>; git?: (args: string[]) => string; designate?: boolean; scenarios?: Record<string, 'pass' | 'fail' | 'hang'> } = {}) {
  const consumer = await writeConsumer({ scenarios: options.scenarios ?? { startup: 'pass' } });
  const projectFile = await readFile(consumer.projectPath, 'utf8');
  if (options.designate !== false) { await mkdir(join(consumer.dir, '.release-qa'), { recursive: true }); await designateTestRoot(join(consumer.dir, '.release-qa')); }
  const record: Candidate = candidateRecord({
    id: 'cand-0001', pullRequest: 7, testRevision: REVISION,
    artifacts: [{ profile: consumer.profile, name: 'setup.bin', sha256: 'b'.repeat(64), assetId: 101, actionsArtifactId: 201 }],
  });
  const base = actionTransport({
    'repos/acme/app': { ok: true, value: { id: 1, full_name: 'acme/app', default_branch: 'main', permissions: options.permissions ?? { pull: true, push: true, maintain: true } } },
    'repos/acme/app/contents/qa/project.json?ref=main': { ok: true, value: { type: 'file', encoding: 'base64', content: Buffer.from(projectFile).toString('base64') } },
  });
  let active: string | undefined = 'cand-0001';
  const downloads: string[] = [];
  const api = Object.assign(base, {
    download: async (path: string, destination: string) => {
      downloads.push(path);
      await writeFile(destination, JSON.stringify({ ...record, id: active }));
      return { ok: true as const, value: true as const };
    },
  }) as unknown as RunDeps['api'];
  const stored = new Map<string, string>([['acme/app', consumer.dir]]);
  const checkouts: CheckoutStore = { get: async (repository) => stored.get(repository), set: async (repository, path) => { stored.set(repository, path); } };
  const gitCalls: string[][] = [];
  const seen: string[] = [];
  const deps: RunDeps = {
    api,
    checkouts,
    session: new RunSession(),
    candidatesDir: await makeTempDir('qa-candidates-'),
    chooseDirectory: async () => undefined,
    consumerWorker: worker,
    git: async (_cwd, args) => { gitCalls.push(args); return (options.git ?? ((a) => (a[0] === 'rev-parse' ? `${REVISION}\n` : '')))(args); },
    evaluate: (async (...args: unknown[]) => { seen.push(String(args[3])); return { ok: true, value: { candidateId: active, candidateReleaseId: 50, candidateAssetId: 900 } }; }) as never,
    download: (async (_candidate: Candidate, _profile: string, directory: string) => {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'setup.bin'), consumer.artifactBytes);
      return { ok: true as const, path: join(directory, 'setup.bin'), sha256: createHash('sha256').update(consumer.artifactBytes).digest('hex') };
    }) as never,
  };
  const request = { ...target, profile: consumer.profile, suite: 'release' };
  const root = join(consumer.dir, '.release-qa');
  const confirmation = { ...request, candidateId: 'cand-0001', root };
  return { consumer, deps, request, confirmation, root, stored, gitCalls, seen, downloads, retire: () => { active = undefined; }, replace: () => { active = 'cand-0002'; } };
}

const finish = async (deps: RunDeps): Promise<void> => { await deps.session.settled(); };
/** How long to wait for something a real child process does. */
const CHILD_WAIT = { timeout: 15_000, interval: 50 };

describe('choosing a checkout', () => {
  test('a folder that is this project is remembered, and one that is not is reported and dropped', async () => {
    const { deps, consumer, stored } = await setUp();
    stored.clear();
    expect(await getCheckout('acme/app', deps)).toEqual({ status: 'none' });
    expect(await chooseCheckout('acme/app', { ...deps, chooseDirectory: async () => consumer.dir })).toEqual({ status: 'ready', path: consumer.dir });
    expect(stored.get('acme/app')).toBe(consumer.dir);
    stored.clear();
    const empty = await makeTempDir('qa-empty-');
    const bad = await chooseCheckout('acme/app', { ...deps, chooseDirectory: async () => empty });
    expect(bad).toMatchObject({ status: 'invalid', path: empty });
    expect(stored.size).toBe(0);
  });

  test('a repository name that is not a repository is refused before any dialog opens', async () => {
    const { deps } = await setUp();
    let opened = false;
    expect(await chooseCheckout('../x', { ...deps, chooseDirectory: async () => { opened = true; return undefined; } })).toMatchObject({ status: 'invalid' });
    expect(opened).toBe(false);
  });

  test('a checkout of a different project is refused', async () => {
    const { deps, consumer } = await setUp();
    const project = JSON.parse(await readFile(consumer.projectPath, 'utf8')) as Record<string, unknown>;
    await writeFile(consumer.projectPath, JSON.stringify({ ...project, projectId: 'other' }));
    const view = await getCheckout('acme/app', deps);
    expect(view).toMatchObject({ status: 'invalid' });
    expect(view.status === 'invalid' && view.error).toContain('other');
  });
});

describe('reviewing a run', () => {
  test('shows the candidate, file, plan and test root, and changes nothing on this machine', async () => {
    const { deps, request, root, downloads, consumer } = await setUp({ scenarios: { startup: 'pass' } });
    const result = await previewRun(request, deps);
    expect(result).toMatchObject({ ok: true, candidateId: 'cand-0001', candidateReleaseId: 50, artifactName: 'setup.bin', root, checkout: consumer.dir });
    expect(result.ok && result.automated).toEqual([`${consumer.profile}/startup`]);
    // Only the small candidate record was read; the installer was not downloaded, and no journal was created.
    expect(downloads).toEqual(['repos/acme/app/releases/assets/900']);
    expect(await readFile(consumer.logPath, 'utf8').catch(() => '')).toBe('');
  });

  test('asks the shared evaluator about the head the person saw', async () => {
    const { deps, request, seen } = await setUp();
    await previewRun(request, deps);
    expect(seen).toEqual([HEAD]);
  });

  test('a read-only account cannot run tests here', async () => {
    const { deps, request } = await setUp({ permissions: { pull: true } });
    const result = await previewRun(request, deps);
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toContain('read-only');
  });

  test('is refused with no checkout, no active candidate, or an unknown environment or suite', async () => {
    const { deps, request, stored, retire } = await setUp();
    expect(await previewRun({ ...request, suite: 'nightly' }, deps)).toMatchObject({ ok: false });
    expect(await previewRun({ ...request, profile: 'plan9' }, deps)).toMatchObject({ ok: false });
    retire();
    const none = await previewRun(request, deps);
    expect(!none.ok && none.error).toContain('no active candidate');
    stored.clear();
    const missing = await previewRun(request, deps);
    expect(!missing.ok && missing.error).toContain('Choose a local checkout');
  });

  test('is refused when the checkout is not at the test revision of the candidate, or has changed files', async () => {
    const moved = await setUp({ git: (args) => (args[0] === 'rev-parse' ? `${'c'.repeat(40)}\n` : '') });
    const wrongRevision = await previewRun(moved.request, moved.deps);
    expect(!wrongRevision.ok && wrongRevision.error).toContain('Check that revision out first');
    const dirty = await setUp({ git: (args) => (args[0] === 'rev-parse' ? `${REVISION}\n` : ' M qa/scenarios.ts\n') });
    const changed = await previewRun(dirty.request, dirty.deps);
    expect(!changed.ok && changed.error).toContain('uncommitted changes');
  });

  test('is refused when the checkout is not a git working copy', async () => {
    const { deps, request } = await setUp({ git: () => { throw new Error('not a git repository'); } });
    const result = await previewRun(request, deps);
    expect(!result.ok && result.error).toContain('git state');
  });

  test('is refused until the person designated the test root, and says how', async () => {
    const { deps, request } = await setUp({ designate: false });
    const result = await previewRun(request, deps);
    expect(!result.ok && result.error).toContain('release-qa designate');
  });

  test('a bad request never reaches GitHub', async () => {
    const { deps, seen } = await setUp();
    expect(await previewRun({ ...target, profile: '../x', suite: 'release' }, deps)).toMatchObject({ ok: false });
    expect(seen).toEqual([]);
  });
});

describe('starting a run', () => {
  test('installs nothing when what was confirmed is no longer true', async () => {
    const { deps, confirmation, replace, consumer } = await setUp();
    expect(await startRunAction({ ...confirmation, root: 'C:\\somewhere\\else' }, deps)).toMatchObject({ ok: false });
    replace();
    const replaced = await startRunAction(confirmation, deps);
    expect(replaced).toMatchObject({ ok: false });
    expect(deps.session.current).toEqual({ state: 'idle' });
    expect(await readFile(consumer.logPath, 'utf8').catch(() => '')).toBe('');
  });

  test('runs the suite for the confirmed candidate, then lists it as not synced until it is uploaded', async () => {
    const { deps, confirmation, consumer } = await setUp();
    const started = await startRunAction(confirmation, deps);
    expect(started).toMatchObject({ ok: true });
    await finish(deps);
    const status = deps.session.current;
    expect(status).toMatchObject({ state: 'finished', exitCode: 0 });
    expect(status.state === 'finished' && status.results).toEqual([{ requirement: `${consumer.profile}/startup`, outcome: 'passed' }]);
    // The consumer's install ran on the verified copy of the file, inside the run's own folders.
    expect(await readFile(consumer.logPath, 'utf8')).toContain('install');

    const listed = await listRunsAction({ repository: 'acme/app', candidateId: 'cand-0001' }, deps);
    expect(listed.ok && listed.runs).toHaveLength(1);
    expect(listed.ok && listed.runs[0]).toMatchObject({ pending: expect.any(Number), attempts: 1, resumable: false, active: false });
    expect(listed.ok && listed.runs[0]?.pending).toBeGreaterThan(0);
    expect(await listRunsAction({ repository: 'acme/app', candidateId: 'another' }, deps)).toEqual({ ok: true, runs: [] });
  });

  test('a second start while one is under way is refused, and stopping is possible', async () => {
    const { deps, confirmation } = await setUp();
    let running = false;
    const held = { ...deps, start: ((_input: unknown, options: { signal: AbortSignal }) => new Promise((resolve) => {
      running = true; options.signal.addEventListener('abort', () => resolve({ ok: false, error: 'stopped' })); })) as never };
    expect(await startRunAction(confirmation, held)).toMatchObject({ ok: true });
    expect(await startRunAction(confirmation, held)).toMatchObject({ ok: false });
    await vi.waitFor(() => expect(running).toBe(true));
    expect(await cancelRunAction(held)).toMatchObject({ ok: true });
    await finish(held);
    expect(deps.session.current).toMatchObject({ state: 'failed', message: 'stopped' });
    expect(await cancelRunAction(held)).toMatchObject({ ok: false });
  });

  test('a stop during the download ends the run before anything is installed', async () => {
    const { deps, confirmation, consumer } = await setUp();
    let stopped = false;
    const slow = { ...deps, download: (async (...args: unknown[]) => {
      deps.session.stop();
      stopped = true;
      return (deps.download as (...a: unknown[]) => Promise<unknown>)(...args);
    }) as never, start: (async () => { throw new Error('must not start'); }) as never };
    await startRunAction(confirmation, slow);
    await finish(slow);
    expect(stopped).toBe(true);
    expect(deps.session.current).toMatchObject({ state: 'failed', message: expect.stringContaining('Nothing was installed') });
    expect(await readFile(consumer.logPath, 'utf8').catch(() => '')).toBe('');
  });

  test('a run that did not finish (exit 3) is a failed state, not a finished one', async () => {
    const { deps, confirmation } = await setUp();
    const interrupted = { ...deps, start: (async () => ({ ok: true, summary: { runId: RUN_ID, candidateId: 'cand-0001', profile: 'windows', suite: 'release', results: [], exitCode: 3 } })) as never };
    await startRunAction(confirmation, interrupted);
    await finish(interrupted);
    expect(deps.session.current).toMatchObject({ state: 'failed', exitCode: 3 });
  });

  test('a download that fails is a failed state and leaves nothing to install', async () => {
    const { deps, confirmation, consumer } = await setUp();
    const failing = { ...deps, download: (async () => ({ ok: false, error: 'digest mismatch' })) as never };
    await startRunAction(confirmation, failing);
    await finish(failing);
    expect(deps.session.current).toMatchObject({ state: 'failed' });
    expect(deps.session.current.state !== 'idle' && deps.session.current.message).toContain('digest mismatch');
    expect(await readFile(consumer.logPath, 'utf8').catch(() => '')).toBe('');
  });
});

describe('resuming a run', () => {
  async function interrupted() {
    const ctx = await setUp({ scenarios: { startup: 'pass', slow: 'hang' } });
    await startRunAction(ctx.confirmation, ctx.deps);
    // These wait on a real child process (Node starting, the tool loading, a first scenario passing). vi.waitFor gives up
    // after 1 s by default, which a busy Windows runner has exceeded.
    await vi.waitFor(() => expect(ctx.deps.session.current).toMatchObject({ state: 'running' }), CHILD_WAIT);
    await vi.waitFor(async () => expect(await readFile(ctx.consumer.logPath, 'utf8').catch(() => '')).toContain('steps:slow'), CHILD_WAIT);
    await cancelRunAction(ctx.deps);
    await finish(ctx.deps);
    const listed = await listRunsAction({ repository: 'acme/app', candidateId: 'cand-0001' }, ctx.deps);
    const run = listed.ok ? listed.runs[0] : undefined;
    return { ...ctx, run };
  }

  test('an interrupted run is resumable, and resuming it needs the same candidate, environment and suite', async () => {
    const { deps, request, run, replace } = await interrupted();
    expect(run).toMatchObject({ resumable: true });
    const runId = run!.runId;
    expect(await previewRun({ ...request, runId, suite: 'other' }, deps)).toMatchObject({ ok: false });
    const shown = await previewRun({ ...request, runId }, deps);
    expect(shown).toMatchObject({ ok: true, resumes: runId });
    replace();
    const changed = await previewRun({ ...request, runId }, deps);
    expect(!changed.ok && changed.error).toContain('is not resumed');
  }, 2 * CHILD_WAIT.timeout);

  test('a run id that does not exist here is refused', async () => {
    const { deps, request } = await setUp();
    const result = await previewRun({ ...request, runId: RUN_ID }, deps);
    expect(!result.ok && result.error).toContain('no local run');
  });
});

describe('syncing a run', () => {
  async function finished() {
    const ctx = await setUp();
    await startRunAction(ctx.confirmation, ctx.deps);
    await finish(ctx.deps);
    const listed = await listRunsAction({ repository: 'acme/app', candidateId: 'cand-0001' }, ctx.deps);
    return { ...ctx, runId: listed.ok ? listed.runs[0]!.runId : '' };
  }

  test('uploads through the shared sync with the identity of the signed-in account and the digest of the candidate', async () => {
    const { deps, runId } = await finished();
    const calls: Array<Record<string, unknown>> = [];
    const result = await syncRunAction({ ...target, runId }, { ...deps, sync: (async (input: Record<string, unknown>) => { calls.push(input); return { ok: true, reportId: runId, uploaded: 3 }; }) as never });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.message).toContain('3 files uploaded');
    expect(calls[0]).toMatchObject({ repository: 'acme/app', releaseId: 50, runId });
    expect(calls[0]?.report).toMatchObject({ id: runId, actor: 'maintainer', candidateId: 'cand-0001', testRevision: REVISION });
  });

  test('a failed upload is an uncertain result that keeps the local results and can be repeated', async () => {
    const { deps, runId } = await finished();
    const result = await syncRunAction({ ...target, runId }, { ...deps, sync: (async () => ({ ok: false, error: 'network-error while uploading events.json' })) as never });
    expect(result).toMatchObject({ ok: false, uncertain: true });
    expect(!result.ok && result.error).toContain('Your local results are kept');
    expect(!result.ok && result.error).toContain('could not be reached');
    const after = await listRunsAction({ repository: 'acme/app', candidateId: 'cand-0001' }, deps);
    expect(after.ok && after.runs[0]?.pending).toBeGreaterThan(0);
  });

  test('an upload and a run exclude each other, and the claim is released afterwards', async () => {
    const { deps, runId, confirmation } = await finished();
    let release: (() => void) | undefined;
    const held = { ...deps, sync: (() => new Promise((resolve) => { release = () => resolve({ ok: true, reportId: runId, uploaded: 1 }); })) as never };
    const first = syncRunAction({ ...target, runId }, held);
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(deps.session.syncing).toBe(true);
    expect(await syncRunAction({ ...target, runId }, held)).toMatchObject({ ok: false });
    expect(await startRunAction({ ...confirmation, runId }, deps)).toMatchObject({ ok: false });
    release?.();
    expect(await first).toMatchObject({ ok: true });
    expect(deps.session.syncing).toBe(false);
    expect(deps.session.begin({ kind: 'start', repository: 'acme/app', number: 7, candidateId: 'c', profile: 'windows', suite: 'release' }, async () => undefined)).toBe(true);
  });

  test('a sync is refused while a run is under way', async () => {
    const { deps, runId } = await finished();
    deps.session.begin({ kind: 'start', repository: 'acme/app', number: 7, candidateId: 'c', profile: 'windows', suite: 'release' }, () => new Promise<void>(() => undefined));
    expect(await syncRunAction({ ...target, runId }, deps)).toMatchObject({ ok: false });
    expect(deps.session.syncing).toBe(false);
  });

  test('results for a replaced candidate are not uploaded', async () => {
    const { deps, runId, replace } = await finished();
    replace();
    let uploaded = false;
    const result = await syncRunAction({ ...target, runId }, { ...deps, sync: (async () => { uploaded = true; return { ok: true, reportId: '', uploaded: 0 }; }) as never });
    expect(!result.ok && result.error).toContain('replaced candidate');
    expect(uploaded).toBe(false);
  });

  test('is refused for a read-only account, an unknown run, or a run id that is a path', async () => {
    const { deps, runId } = await finished();
    const readOnly = await setUp({ permissions: { pull: true } });
    expect(await syncRunAction({ ...target, runId }, readOnly.deps)).toMatchObject({ ok: false });
    expect(await syncRunAction({ ...target, runId: RUN_ID }, deps)).toMatchObject({ ok: false });
    expect(await syncRunAction({ ...target, runId: '..\\..\\x' }, deps)).toMatchObject({ ok: false });
  });
});
