import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { RequirementKey } from '../model/requirement.ts';
import type { Attempt, Outcome } from '../model/result.ts';
import { Collector, parseVersioned, type FieldSpec } from '../model/validate.ts';
import type { EnvironmentProbes } from '../runner/environment.ts';
import type { RunEvent } from '../runner/events.ts';
import { executeScenario, type ExecutionContext, type ScenarioEvent } from '../runner/execute.ts';
import { appendEvent, readRun, writeFileAtomic, writeSummary, type RunState } from '../runner/journal.ts';
import { loadCandidate } from './candidate.ts';
import { loadConsumer } from './consumer.ts';
import { selectPlan } from './plan.ts';
import { loadProject } from './project.ts';

/** What `run` was asked to do, kept next to the run so `resume` repeats exactly that. Paths are absolute. */
export interface RunInvocation {
  project: string;
  candidate: string;
  profile: string;
  suite: string;
  root: string;
}

/**
 * `manual`: work for a person, never run. `not-run`: the run was cancelled before reaching it; `resume` runs it.
 * Everything else is the recorded attempt's outcome.
 */
export type ResultOutcome = Outcome | 'manual' | 'not-run';

export interface RequirementResult {
  requirement: RequirementKey;
  outcome: ResultOutcome;
  /** The attempt that decided this result. */
  attempt?: string;
  /** Recorded by an earlier session of this run and not rerun. */
  carried?: boolean;
  reason?: string;
  detail?: string;
  cleanup?: { ok: boolean; failures: string[] };
}

export interface RunSummary {
  runId: string;
  candidateId: string;
  profile: string;
  suite: string;
  results: RequirementResult[];
  exitCode: number;
}

export type RunResult = { ok: true; summary: RunSummary } | { ok: false; error: string };

export interface RunOptions {
  /** Where each run's journal lives, one directory per run. */
  stateDir: string;
  signal: AbortSignal;
  /** Progress, for display. */
  onEvent?: (event: ScenarioEvent) => void;
  /** Called once the run is recorded and before anything runs, so its id is known even if the process then dies. */
  onStart?: (runId: string) => void;
  /** Test seams. */
  probes?: EnvironmentProbes;
  timeouts?: ExecutionContext['timeouts'];
}

const INVOCATION_FILE = 'invocation.json';
const MACHINE_FILE = 'machine-id';
const STARTED = 'scenario-started';
/** Recorded after an attempt whose cleanup failed, so a resumed run still reports it for the carried result. */
const CLEANUP_FAILED = 'cleanup-failed';

/**
 * Starts a run. Everything that can be checked without touching the machine is checked first (project, plan,
 * candidate bytes, the consumer's code), so a mistake is reported before any run state exists or anything is
 * installed. Never throws.
 */
export async function startRun(input: RunInvocation, options: RunOptions): Promise<RunResult> {
  const invocation: RunInvocation = { ...input, project: resolve(input.project), candidate: resolve(input.candidate), root: resolve(input.root) };
  const prepared = await prepare(invocation);
  if (!prepared.ok) return prepared;

  const runId = newRunId();
  const runDir = join(options.stateDir, runId);
  try {
    await mkdir(runDir, { recursive: true });
    // The artifact's digest is kept with the invocation, so resume can tell a rebuild under the same candidate id.
    await writeFileAtomic(join(runDir, INVOCATION_FILE), `${JSON.stringify({ schemaVersion: 1, ...invocation, artifactSha256: prepared.artifact.sha256 }, null, 2)}\n`);
    const journal = new Journal(runDir, runId, undefined, 0);
    await journal.append('run-started', { runId, candidateId: prepared.candidate.id, profile: invocation.profile, machineId: await machineId(options.stateDir) });
    options.onStart?.(runId);
    return { ok: true, summary: await execute(prepared, invocation, runId, journal, emptyState(), options) };
  } catch (error) {
    return { ok: false, error: `run ${runId} stopped: ${message(error)}` };
  }
}

/**
 * Continues a run. Passed and failed results carry forward; a failure cannot disappear by being run again. Anything
 * else (blocked, cancelled, interrupted, never reached) runs again as a retry of its latest attempt. A scenario that
 * was started but never recorded, because the process died, is first recorded as interrupted, so the crash stays in
 * the run's history. The candidate must still be the same bytes under the same identity. Never throws.
 */
export async function resumeRun(runId: string, options: RunOptions): Promise<RunResult> {
  const runDir = join(options.stateDir, runId);
  try {
    const invocation = await readInvocation(runDir);
    if (!invocation.ok) return invocation;

    const state = await readRun(runDir);
    const start = state.events.find((e) => e.type === 'run-started');
    if (start === undefined || start.type !== 'run-started') return { ok: false, error: `run ${runId} has no recorded start` };
    if (state.conflicts.length > 0 || state.cyclic.length > 0) {
      return { ok: false, error: `run ${runId}'s journal is inconsistent (conflicting or cyclic events); it cannot be continued safely` };
    }

    const prepared = await prepare(invocation.value);
    if (!prepared.ok) return prepared;
    if (prepared.candidate.id !== start.data.candidateId) {
      return { ok: false, error: `run ${runId} tested candidate "${start.data.candidateId}", but the manifest now names "${prepared.candidate.id}"` };
    }
    // The manifest could have been edited to name new bytes under the same id: that is a different build.
    if (prepared.artifact.sha256 !== invocation.artifactSha256) {
      return { ok: false, error: `run ${runId} tested an artifact with SHA-256 ${invocation.artifactSha256}, but the manifest now names ${prepared.artifact.sha256}: a different build` };
    }

    const last = state.events.at(-1);
    const journal = new Journal(runDir, runId, last?.id, state.events.length);
    return { ok: true, summary: await execute(prepared, invocation.value, runId, journal, state, options) };
  } catch (error) {
    return { ok: false, error: `run ${runId} stopped: ${message(error)}` };
  }
}

type Prepared = Extract<Awaited<ReturnType<typeof prepare>>, { ok: true }>;

async function prepare(invocation: RunInvocation) {
  const loaded = await loadProject(invocation.project);
  if (!loaded.ok) return { ok: false as const, error: loaded.error };
  const plan = selectPlan(loaded.project, invocation.profile, invocation.suite);
  if (!plan.ok) return plan;
  const candidate = await loadCandidate(invocation.candidate, invocation.profile);
  if (!candidate.ok) return candidate;
  const consumer = await loadConsumer(invocation.project, loaded.project, plan.automated);
  if (!consumer.ok) return consumer;
  return { ok: true as const, plan, candidate: candidate.candidate, artifact: candidate.artifact, consumer };
}

async function execute(prepared: Prepared, invocation: RunInvocation, runId: string, journal: Journal, state: RunState, options: RunOptions): Promise<RunSummary> {
  const results: RequirementResult[] = [];
  let attemptCount = state.attempts.length;
  const newAttemptId = (): string => `${runId}.a${++attemptCount}`;

  for (const scenario of prepared.consumer.scenarios) {
    const key = scenario.requirement.key;
    const history = historyOf(state, key);

    // The process died after starting this scenario and before recording it: say so before anything else.
    let latest = history.latest;
    if (history.startedAfterLatest) {
      const interrupted: Attempt = { id: newAttemptId(), requirement: key, outcome: 'interrupted', evidence: [], ...(latest === undefined ? {} : { retryOf: latest.id }) };
      await journal.append('attempt-recorded', { attempt: interrupted });
      latest = interrupted;
    }

    if (latest !== undefined && (latest.outcome === 'passed' || latest.outcome === 'failed')) {
      results.push({
        requirement: key,
        outcome: latest.outcome,
        attempt: latest.id,
        carried: true,
        // The environment it left may since have been reset, but the attempt did leave it dirty; that stays on record.
        ...(history.cleanupFailed ? { cleanup: { ok: false, failures: ['cleanup failed after this attempt, in an earlier session of this run'] } } : {}),
      });
      continue;
    }
    if (options.signal.aborted) {
      results.push({ requirement: key, outcome: 'not-run' });
      continue;
    }

    await journal.append('checkpoint', { name: STARTED, requirement: key });
    const result = await executeScenario(
      {
        candidate: prepared.candidate,
        artifact: prepared.artifact,
        profile: prepared.plan.profile,
        testRoot: invocation.root,
        signal: options.signal,
        emit: (event) => options.onEvent?.(event),
        lifecycle: prepared.consumer.lifecycle,
        ...(options.probes === undefined ? {} : { probes: options.probes }),
        ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
      },
      scenario,
    );
    const attempt: Attempt = { id: newAttemptId(), requirement: key, outcome: result.outcome, evidence: [], ...(latest === undefined ? {} : { retryOf: latest.id }) };
    await journal.append('attempt-recorded', { attempt });
    if (!result.cleanup.ok) await journal.append('checkpoint', { name: CLEANUP_FAILED, requirement: key });
    results.push({
      requirement: key,
      outcome: result.outcome,
      attempt: attempt.id,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      ...(result.detail === undefined ? {} : { detail: result.detail }),
      cleanup: result.cleanup,
    });
  }

  for (const requirement of prepared.plan.manual) results.push({ requirement: requirement.key, outcome: 'manual' });
  await writeSummary(journal.runDir, await readRun(journal.runDir));
  return { runId, candidateId: prepared.candidate.id, profile: invocation.profile, suite: invocation.suite, results, exitCode: exitCodeOf(results) };
}

/**
 * Any failure outranks everything: it is a verdict on the candidate. Then anything unfinished, or a cleanup that
 * failed (the environment is left dirty, however the scenario went), then work left for a person.
 */
export function exitCodeOf(results: readonly RequirementResult[]): number {
  const has = (...outcomes: ResultOutcome[]) => results.some((r) => outcomes.includes(r.outcome));
  if (has('failed')) return 1;
  if (has('interrupted', 'cancelled', 'not-run') || results.some((r) => r.cleanup?.ok === false)) return 3;
  if (has('blocked', 'manual')) return 2;
  return 0;
}

/**
 * The latest recorded attempt for a requirement; whether a start was recorded after it with no result (a crash); and
 * whether its cleanup was recorded as failed.
 */
function historyOf(state: RunState, key: RequirementKey): { latest?: Attempt; startedAfterLatest: boolean; cleanupFailed: boolean } {
  let latest: Attempt | undefined;
  let startedAfterLatest = false;
  let cleanupFailed = false;
  for (const event of state.events) {
    if (event.type === 'attempt-recorded' && event.data.attempt.requirement === key) {
      latest = event.data.attempt;
      startedAfterLatest = false;
      cleanupFailed = false;
    } else if (event.type === 'checkpoint' && event.data.requirement === key) {
      if (event.data.name === STARTED) startedAfterLatest = true;
      if (event.data.name === CLEANUP_FAILED) cleanupFailed = true;
    }
  }
  return { ...(latest === undefined ? {} : { latest }), startedAfterLatest, cleanupFailed };
}

/** Appends events in a chain: each names the one before it, so their order never depends on clocks. */
class Journal {
  readonly runDir: string;
  private readonly runId: string;
  private previous: string | undefined;
  private count: number;

  constructor(runDir: string, runId: string, previous: string | undefined, count: number) {
    this.runDir = runDir;
    this.runId = runId;
    this.previous = previous;
    this.count = count;
  }

  async append<T extends RunEvent['type']>(type: T, data: Extract<RunEvent, { type: T }>['data']): Promise<void> {
    const id = `${this.runId}.e${++this.count}`;
    const event = { schemaVersion: 1, id, recordedAt: timestamp(), type, data, ...(this.previous === undefined ? {} : { prev: this.previous }) } as RunEvent;
    const appended = await appendEvent(this.runDir, event);
    if (!appended.ok) throw appended.error;
    this.previous = id;
  }
}

const INVOCATION_SPEC: FieldSpec = { required: ['project', 'candidate', 'profile', 'suite', 'root', 'artifactSha256'] };

async function readInvocation(runDir: string): Promise<{ ok: true; value: RunInvocation; artifactSha256: string } | { ok: false; error: string }> {
  let text: string;
  try {
    text = await readFile(join(runDir, INVOCATION_FILE), 'utf8');
  } catch {
    return { ok: false, error: `there is no run at ${runDir}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `${join(runDir, INVOCATION_FILE)} is not valid JSON: ${message(error)}` };
  }
  const result = parseVersioned(parsed, INVOCATION_SPEC, (c: Collector, rec) => ({
    value: {
      project: c.text(rec.project, 'project', { max: 4096 }),
      candidate: c.text(rec.candidate, 'candidate', { max: 4096 }),
      profile: c.profileId(rec.profile, 'profile'),
      suite: c.id(rec.suite, 'suite'),
      root: c.text(rec.root, 'root', { max: 4096 }),
    } as RunInvocation,
    artifactSha256: c.sha256(rec.artifactSha256, 'artifactSha256') as string,
  }));
  return result.ok ? { ok: true, ...result.value } : { ok: false, error: `${join(runDir, INVOCATION_FILE)}: ${result.error.message}` };
}

/**
 * Identifies this machine in run records without saying anything about it: a random token kept in the state
 * directory, never the host name, which uploads must not carry.
 */
async function machineId(stateDir: string): Promise<string> {
  const path = join(stateDir, MACHINE_FILE);
  const existing = (await readFile(path, 'utf8').catch(() => '')).trim();
  if (existing !== '') return existing;
  const created = `machine-${randomUUID()}`;
  await mkdir(stateDir, { recursive: true });
  await writeFileAtomic(path, `${created}\n`);
  return created;
}

function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `run-${stamp}-${randomBytes(3).toString('hex')}`;
}

const timestamp = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function emptyState(): RunState {
  return {
    exists: false, events: [], attempts: [], truncated: null, corrupt: [], conflicts: [], missingPredecessors: [], cyclic: [],
    pending: [], synced: [], ackMismatches: [], orphanAcks: [], missingEvidence: [],
  };
}

