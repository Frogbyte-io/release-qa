import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { Candidate } from '../model/candidate.ts';
import type { EnvironmentProfile } from '../model/project.ts';
import type { Requirement, RequirementKey } from '../model/requirement.ts';
import type { MeasuredEnvironment, Outcome } from '../model/result.ts';
import { defaultProbes, inspectEnvironment, type EnvironmentProbes } from './environment.ts';
import {
  acquireTestRoot,
  checkTestRoot,
  cleanupOwnedResources,
  markDirty,
  readDirty,
  readLedger,
  recordOwned,
  spawnOwned,
  type CleanupFailure,
  type OwnedResource,
  type RootLock,
} from './resources.ts';

/** Thrown by a scenario or hook to say the candidate behaved wrongly. The only thing that makes a result `failed`. */
export class AssertionFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionFailure';
  }
}

export type Phase = 'prerequisites' | 'install' | 'reset' | 'launch' | 'setup' | 'steps' | 'cleanup';

export interface ScenarioEvent {
  scenario: string;
  phase: Phase;
  status: 'started' | 'finished' | 'failed';
  detail?: string;
}

/** What a lifecycle hook or scenario may do. `own` and `spawn` record ownership before anything is used. */
export interface RunContext {
  candidate: Candidate;
  profile: EnvironmentProfile;
  testRoot: string;
  signal: AbortSignal;
  /** Records a resource this run created. Refused once the phase that asked has ended. */
  own(resource: OwnedResource): Promise<void>;
  /** Starts a process the run owns. Refused once the phase that asked has ended. */
  spawn(label: string, command: string, args: readonly string[], options?: SpawnOptions): Promise<ChildProcess>;
  /** Polls until `condition` is true. Running out of time is an assertion failure; abort is a cancellation. */
  waitFor(condition: () => boolean | Promise<boolean>, options?: { timeoutMs?: number; intervalMs?: number; description?: string }): Promise<void>;
}

export interface Lifecycle {
  install(ctx: RunContext): Promise<void>;
  /** Puts the application into a known state before it starts, e.g. by clearing its data. */
  reset(ctx: RunContext): Promise<void>;
  launch(ctx: RunContext): Promise<void>;
  cleanup(ctx: RunContext): Promise<void>;
}

export interface Scenario {
  id: string;
  requirement: Requirement;
  setup?(ctx: RunContext): Promise<void>;
  steps(ctx: RunContext): Promise<void>;
}

export interface ExecutionContext {
  candidate: Candidate;
  profile: EnvironmentProfile;
  testRoot: string;
  signal: AbortSignal;
  emit(event: ScenarioEvent): void | Promise<void>;
  lifecycle: Lifecycle;
  probes?: EnvironmentProbes;
  /**
   * Bounds in milliseconds; every wait is bounded, including probes and the event sink. `cleanupMs` applies to the
   * cleanup hook and, separately, to reaping the resources the run still owns. `abandonedGraceMs` is how long a hook
   * that was cut off gets to stop by itself before the environment is declared dirty.
   */
  timeouts?: { phaseMs?: number; stepsMs?: number; cleanupMs?: number; abandonedGraceMs?: number };
}

export type ResultReason =
  | 'not-a-test-environment'
  | 'environment-busy'
  | 'dirty-environment'
  | 'wrong-environment'
  | 'capability-missing'
  | 'assertion-failed'
  | 'cancelled'
  | 'timeout'
  | 'infrastructure-error';

export interface ScenarioResult {
  scenario: string;
  requirement: RequirementKey;
  outcome: Outcome;
  reason?: ResultReason;
  detail?: string;
  /** Capabilities the scenario needed and the machine lacks, when `reason` is `capability-missing`. */
  missing?: string[];
  environment?: MeasuredEnvironment;
  cleanup: { ok: boolean; failures: string[] };
  /** Resources still owned after cleanup, which keep the environment dirty until it is reset. */
  leftover: CleanupFailure[];
}

const DEFAULT_PHASE_MS = 120_000;
const DEFAULT_STEPS_MS = 300_000;
const DEFAULT_CLEANUP_MS = 60_000;
const DEFAULT_ABANDONED_GRACE_MS = 1_000;

/** Why a phase stopped early. These are reasons, not verdicts on the candidate. */
class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}
class TimedOut extends Error {
  readonly phase: Phase;
  readonly ms: number;
  constructor(phase: Phase, ms: number) {
    super(`${phase} timed out after ${ms} ms`);
    this.phase = phase;
    this.ms = ms;
  }
}
class SinkFailed extends Error {
  constructor(cause: unknown) {
    super(`event sink failed: ${message(cause)}`);
  }
}

const withEnvironment = (environment: MeasuredEnvironment | undefined): { environment?: MeasuredEnvironment } => (environment === undefined ? {} : { environment });
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Node's assert and most test libraries throw errors named AssertionError; those are assertions too. */
function isAssertionFailure(error: unknown): boolean {
  return error instanceof AssertionFailure || (error instanceof Error && (error.name === 'AssertionError' || (error as { code?: unknown }).code === 'ERR_ASSERTION'));
}

interface Stop {
  outcome: Outcome;
  reason: ResultReason;
  detail?: string;
}

/** Maps whatever stopped a phase to an outcome. Only an explicit assertion is a verdict on the candidate. */
function classify(phase: Phase, error: unknown): Stop {
  if (error instanceof Cancelled) return { outcome: 'cancelled', reason: 'cancelled', detail: `cancelled during ${phase}` };
  if (error instanceof TimedOut) return { outcome: 'interrupted', reason: 'timeout', detail: error.message };
  if (error instanceof SinkFailed) return { outcome: 'interrupted', reason: 'infrastructure-error', detail: error.message };
  if (isAssertionFailure(error)) return { outcome: 'failed', reason: 'assertion-failed', detail: message(error) };
  return { outcome: 'interrupted', reason: 'infrastructure-error', detail: `${phase}: ${message(error)}` };
}

/** Work that was cut off before it finished. It may still be doing things, which the run must not ignore. */
interface Abandoned {
  phase: Phase;
  settled: boolean;
  done: Promise<void>;
}

/**
 * Races `work` against a deadline and an outer abort. `onTimeout` supplies the error for the deadline. When the work
 * loses the race it is not stopped (JavaScript cannot), so it is reported through `abandoned` if it has not settled.
 */
function race<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, outer: AbortSignal, onTimeout: () => Error, phase: Phase, abandoned?: Abandoned[]): Promise<T> {
  const controller = new AbortController();
  const stop = (reason: Error): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onOuterAbort = (): void => stop(new Cancelled());
  outer.addEventListener('abort', onOuterAbort);
  const timer = setTimeout(() => stop(onTimeout()), ms);

  const record: Abandoned = { phase, settled: false, done: Promise.resolve() };
  const running = Promise.resolve().then(() => work(controller.signal));
  record.done = running.then(
    () => { record.settled = true; },
    () => { record.settled = true; },
  );
  const interrupted = new Promise<never>((_, reject) => {
    const fail = (): void => reject(controller.signal.reason);
    if (controller.signal.aborted) fail();
    else controller.signal.addEventListener('abort', fail, { once: true });
  });
  interrupted.catch(() => undefined); // no unhandled rejection when the work finishes first
  if (outer.aborted) stop(new Cancelled());

  return Promise.race([running, interrupted]).finally(() => {
    clearTimeout(timer);
    outer.removeEventListener('abort', onOuterAbort);
    if (controller.signal.aborted && !record.settled) abandoned?.push(record);
  });
}

/**
 * Runs one scenario against one candidate in a designated test environment.
 *
 * Outcomes: a prerequisite that is not met is `blocked` and nothing is installed; an assertion failure is `failed`;
 * a cancellation is `cancelled`; a timeout, a hook that breaks, or an unexpected error is `interrupted`, because
 * trouble in the infrastructure says nothing about the candidate. Only one run at a time may use a test root.
 * Cleanup runs whenever anything was started, and a cleanup that does not complete (including hooks that were cut
 * off and may still be running) leaves the environment marked dirty until it is reset.
 */
export async function executeScenario(context: ExecutionContext, scenario: Scenario): Promise<ScenarioResult> {
  const scenarioId = scenario.id;
  const base = { scenario: scenarioId, requirement: scenario.requirement.key, cleanup: { ok: true, failures: [] as string[] }, leftover: [] as CleanupFailure[] };
  const finish = (result: Pick<ScenarioResult, 'outcome'> & Partial<ScenarioResult>): ScenarioResult => ({ ...base, ...result });
  if (context.signal.aborted) return finish({ outcome: 'cancelled', reason: 'cancelled' });

  const phaseMs = context.timeouts?.phaseMs ?? DEFAULT_PHASE_MS;
  const stepsMs = context.timeouts?.stepsMs ?? DEFAULT_STEPS_MS;
  const cleanupMs = context.timeouts?.cleanupMs ?? DEFAULT_CLEANUP_MS;
  const graceMs = context.timeouts?.abandonedGraceMs ?? DEFAULT_ABANDONED_GRACE_MS;

  // Once the event sink fails, nothing more is sent to it: the run stops and the failure is reported. A sink that
  // never answers is cut off like anything else, so it cannot hold up cancellation or cleanup.
  let sinkFailure: Error | undefined;
  const emitOn = (signal: AbortSignal, limitMs: number) => async (phase: Phase, status: ScenarioEvent['status'], detail?: string): Promise<void> => {
    if (sinkFailure !== undefined) return;
    try {
      await race(
        () => Promise.resolve().then(() => context.emit({ scenario: scenarioId, phase, status, ...(detail === undefined ? {} : { detail }) })),
        limitMs,
        signal,
        () => new Error(`timed out after ${limitMs} ms`),
        phase,
      );
    } catch (error) {
      sinkFailure = error instanceof Cancelled ? error : new SinkFailed(error);
      throw sinkFailure;
    }
  };
  const emit = emitOn(context.signal, phaseMs);

  const abandoned: Abandoned[] = [];
  let lock: Extract<RootLock, { ok: true }> | undefined;
  let closed = false; // set when the run is over, so a late lock acquisition by cut-off work is given straight back
  let environment: MeasuredEnvironment | undefined;

  try {
    // -- Prerequisites: nothing is installed or launched unless all of these hold. ------------------------------
    type Prerequisites = { ready: true; root: string } | { ready: false; result: ScenarioResult };
    let prerequisites: Prerequisites;
    try {
      prerequisites = await race<Prerequisites>(
        async () => {
          await emit('prerequisites', 'started');
          const designated = await checkTestRoot(context.testRoot);
          if (!designated.ok) {
            await emit('prerequisites', 'failed', designated.reason);
            return { ready: false, result: finish({ outcome: 'blocked', reason: 'not-a-test-environment', detail: `${context.testRoot}: ${designated.reason}` }) };
          }
          const root = designated.root;

          const acquired = await acquireTestRoot(root);
          if (!acquired.ok) {
            await emit('prerequisites', 'failed', acquired.heldBy);
            return { ready: false, result: finish({ outcome: 'blocked', reason: 'environment-busy', detail: `the test root is in use by ${acquired.heldBy}` }) };
          }
          if (closed) {
            await acquired.release(); // the prerequisites were cut off and the run is over; do not keep a lock nobody will free
            return { ready: false, result: finish({ outcome: 'interrupted', reason: 'infrastructure-error' }) };
          }
          lock = acquired;

          const dirty = await dirtiness(root);
          if (dirty !== undefined) {
            await emit('prerequisites', 'failed', dirty);
            return { ready: false, result: finish({ outcome: 'blocked', reason: 'dirty-environment', detail: dirty }) };
          }

          const inspected = await inspectEnvironment(context.profile, context.probes ?? defaultProbes);
          environment = inspected.environment;
          if (inspected.profileMismatch !== undefined) {
            await emit('prerequisites', 'failed', inspected.profileMismatch);
            return { ready: false, result: finish({ outcome: 'blocked', reason: 'wrong-environment', detail: inspected.profileMismatch, ...withEnvironment(environment) }) };
          }
          const missing = scenario.requirement.capabilities.filter((c) => !inspected.environment.capabilities.includes(c)).sort();
          if (missing.length > 0) {
            await emit('prerequisites', 'failed', `missing: ${missing.join(', ')}`);
            return { ready: false, result: finish({ outcome: 'blocked', reason: 'capability-missing', missing, detail: `missing capabilities: ${missing.join(', ')}`, ...withEnvironment(environment) }) };
          }
          await emit('prerequisites', 'finished');
          return { ready: true, root };
        },
        phaseMs,
        context.signal,
        () => new TimedOut('prerequisites', phaseMs),
        'prerequisites',
        abandoned,
      );
    } catch (error) {
      return finish({ ...classify('prerequisites', error), ...withEnvironment(environment) });
    }
    if (!prerequisites.ready) return prerequisites.result;
    const root = prerequisites.root;

    // -- The lifecycle. Each phase is bounded and abortable; a phase that fails ends the run. --------------------
    const { lifecycle } = context;
    const contextFor = (signal: AbortSignal): RunContext => {
      // A phase that has ended can no longer create anything: a hook that was cut off but is still running must not
      // leave a process or a resource behind after cleanup has looked at the ledger.
      const assertActive = (): void => {
        if (signal.aborted) throw new Error('this run has been stopped and can no longer take ownership of anything');
      };
      return {
        candidate: context.candidate,
        profile: context.profile,
        testRoot: root,
        signal,
        own: async (resource) => {
          assertActive();
          await recordOwned(root, resource);
        },
        spawn: async (label, command, args, options) => {
          assertActive();
          return spawnOwned(root, label, command, args, options);
        },
        waitFor: (condition, options) => waitFor(signal, condition, options),
      };
    };

    const phases: Array<[Phase, number, (ctx: RunContext) => Promise<void>]> = [
      ['install', phaseMs, (ctx) => lifecycle.install(ctx)],
      ['reset', phaseMs, (ctx) => lifecycle.reset(ctx)],
      ['launch', phaseMs, (ctx) => lifecycle.launch(ctx)],
      ...(scenario.setup === undefined ? [] : [['setup', phaseMs, (ctx: RunContext) => scenario.setup!(ctx)] as [Phase, number, (ctx: RunContext) => Promise<void>]]),
      ['steps', stepsMs, (ctx) => scenario.steps(ctx)],
    ];

    let stop: Stop | undefined;
    let touched = false;
    for (const [phase, limitMs, run] of phases) {
      if (context.signal.aborted) {
        stop = { outcome: 'cancelled', reason: 'cancelled', detail: `cancelled before ${phase}` };
        break;
      }
      touched = true;
      try {
        await emit(phase, 'started');
        await race((signal) => run(contextFor(signal)), limitMs, context.signal, () => new TimedOut(phase, limitMs), phase, abandoned);
        await emit(phase, 'finished');
      } catch (error) {
        stop = classify(phase, error);
        await emit(phase, 'failed', stop.detail).catch(() => undefined);
        break;
      }
    }

    // -- Cleanup: on success, on failure and on cancellation, and never cancelled by the run's own signal. --------
    const noCancel = new AbortController().signal;
    const cleanup = touched
      ? await cleanUp(root, lifecycle, contextFor, { cleanupMs, graceMs }, emitOn(noCancel, cleanupMs), () => sinkFailure, abandoned)
      : { ok: true, failures: [] as string[], leftover: [] as CleanupFailure[] };

    return finish({
      outcome: stop?.outcome ?? 'passed',
      ...(stop === undefined ? {} : { reason: stop.reason, ...(stop.detail === undefined ? {} : { detail: stop.detail }) }),
      ...withEnvironment(environment),
      cleanup: { ok: cleanup.ok, failures: cleanup.failures },
      leftover: cleanup.leftover,
    });
  } finally {
    closed = true;
    await lock?.release().catch(() => undefined);
  }
}

async function dirtiness(root: string): Promise<string | undefined> {
  try {
    const marked = await readDirty(root);
    if (marked !== undefined) return `the environment was left dirty: ${marked}`;
    const owned = await readLedger(root);
    if (owned.length > 0) return `${owned.length} resource(s) from an earlier run are still owned: ${owned.map((r) => r.label).join(', ')}`;
    return undefined;
  } catch (error) {
    return `the record of owned resources cannot be read: ${message(error)}`;
  }
}

async function cleanUp(
  root: string,
  lifecycle: Lifecycle,
  contextFor: (signal: AbortSignal) => RunContext,
  limits: { cleanupMs: number; graceMs: number },
  emit: (phase: Phase, status: ScenarioEvent['status'], detail?: string) => Promise<void>,
  currentSinkFailure: () => Error | undefined,
  abandoned: readonly Abandoned[],
): Promise<{ ok: boolean; failures: string[]; leftover: CleanupFailure[] }> {
  const failures: string[] = [];
  const sinkFailedBefore = currentSinkFailure() !== undefined;
  await emit('cleanup', 'started').catch(() => undefined);

  // A hook that was cut off may still be running. Give it a moment to stop by itself; if it does not, nothing can
  // be said about what it is still doing to the environment, so the environment is not clean.
  if (abandoned.length > 0) {
    await Promise.race([Promise.all(abandoned.map((a) => a.done)), sleep(limits.graceMs)]);
    for (const hook of abandoned) if (!hook.settled) failures.push(`the ${hook.phase} hook was abandoned and is still running`);
  }

  try {
    // A fresh signal: the run may have been cancelled, but its cleanup must still be allowed to finish.
    await race((signal) => lifecycle.cleanup(contextFor(signal)), limits.cleanupMs, new AbortController().signal, () => new TimedOut('cleanup', limits.cleanupMs), 'cleanup');
  } catch (error) {
    failures.push(error instanceof TimedOut ? `cleanup hook ${error.message}` : `cleanup hook failed: ${message(error)}`);
  }

  // Whatever the run still owns is reaped by the runner, whatever the hook did or did not do. Reaping waits for each
  // process in turn, so it has its own deadline; what it does not finish stays on the ledger and keeps the
  // environment dirty.
  let leftover: CleanupFailure[] = [];
  try {
    const reaped = await race(() => cleanupOwnedResources(root), limits.cleanupMs, new AbortController().signal, () => new TimedOut('cleanup', limits.cleanupMs), 'cleanup');
    leftover = reaped.failures;
  } catch (error) {
    failures.push(error instanceof TimedOut ? `reaping owned resources timed out after ${limits.cleanupMs} ms; what is left stays on the ledger` : `could not clean up owned resources: ${message(error)}`);
  }
  for (const item of leftover) failures.push(`${item.resource.label}: ${item.reason}${item.detail === undefined ? '' : ` (${item.detail})`}`);

  await emit('cleanup', failures.length === 0 ? 'finished' : 'failed', failures.length === 0 ? undefined : failures.join('; ')).catch(() => undefined);
  // A record of the cleanup that could not be delivered means the record is incomplete, which is not a clean result.
  const sinkFailure = currentSinkFailure();
  if (sinkFailure !== undefined && !sinkFailedBefore) failures.push(sinkFailure.message);

  if (failures.length > 0) {
    try {
      await markDirty(root, `cleanup failed: ${failures.join('; ')}`);
    } catch (error) {
      // markDirty remembers the root in memory before it writes, so this process still refuses to reuse it.
      failures.push(`could not mark the environment dirty: ${message(error)}`);
    }
  }
  return { ok: failures.length === 0, failures, leftover };
}

/** Polls a condition, giving up at the deadline even if the condition itself never answers. */
async function waitFor(
  signal: AbortSignal,
  condition: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  const expired = (): AssertionFailure => new AssertionFailure(`timed out after ${timeoutMs} ms waiting for ${options.description ?? 'a condition'}`);

  for (;;) {
    if (signal.aborted) throw signal.reason;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw expired();
    // The condition may hang or answer late, so it is raced against the deadline and the abort like everything else.
    const answered = await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => { cleanUp(); reject(expired()); }, remaining);
      const onAbort = (): void => { cleanUp(); reject(signal.reason); };
      const cleanUp = (): void => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve().then(condition).then((value) => { cleanUp(); resolve(value); }, (error: unknown) => { cleanUp(); reject(error); });
    });
    if (answered) return;
    // The abort listener is removed as soon as the pause ends, or every poll would leave one behind.
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, intervalMs);
      signal.addEventListener('abort', done, { once: true });
    });
  }
}
