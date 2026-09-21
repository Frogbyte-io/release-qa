import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { Candidate } from '../model/candidate.ts';
import type { EnvironmentProfile } from '../model/project.ts';
import type { Requirement, RequirementKey } from '../model/requirement.ts';
import type { MeasuredEnvironment, Outcome } from '../model/result.ts';
import { defaultProbes, inspectEnvironment, type EnvironmentProbes } from './environment.ts';
import { checkTestRoot, cleanupOwnedResources, markDirty, readDirty, readLedger, recordOwned, spawnOwned, type CleanupFailure, type OwnedResource } from './resources.ts';

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
  own(resource: OwnedResource): Promise<void>;
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
  /** Bounds in milliseconds. Every wait is bounded; these override the defaults. */
  timeouts?: { phaseMs?: number; stepsMs?: number; cleanupMs?: number };
}

export type ResultReason =
  | 'not-a-test-environment'
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

/** Why a phase stopped early. These are reasons, not verdicts on the candidate. */
class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}
class TimedOut extends Error {
  constructor(readonly phase: Phase, readonly ms: number) {
    super(`${phase} timed out after ${ms} ms`);
  }
}
class SinkFailed extends Error {
  constructor(cause: unknown) {
    super(`event sink failed: ${message(cause)}`);
  }
}

const withEnvironment = (environment: MeasuredEnvironment | undefined): { environment?: MeasuredEnvironment } => (environment === undefined ? {} : { environment });
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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

/**
 * Runs one scenario against one candidate in a designated test environment.
 *
 * Outcomes: a prerequisite that is not met is `blocked` and nothing is installed; an assertion failure is `failed`;
 * a cancellation is `cancelled`; a timeout, a hook that breaks, or an unexpected error is `interrupted`, because
 * trouble in the infrastructure says nothing about the candidate. Cleanup runs whenever anything was started, and
 * a cleanup that does not complete leaves the environment marked dirty until it is reset.
 */
export async function executeScenario(context: ExecutionContext, scenario: Scenario): Promise<ScenarioResult> {
  const scenarioId = scenario.id;
  const base = { scenario: scenarioId, requirement: scenario.requirement.key, cleanup: { ok: true, failures: [] as string[] }, leftover: [] as CleanupFailure[] };
  const finish = (result: Pick<ScenarioResult, 'outcome'> & Partial<ScenarioResult>): ScenarioResult => ({ ...base, ...result });
  if (context.signal.aborted) return finish({ outcome: 'cancelled', reason: 'cancelled' });

  // Once the event sink fails nothing more is sent to it: the run stops and the failure is reported.
  let sinkFailure: SinkFailed | undefined;
  const emit = async (phase: Phase, status: ScenarioEvent['status'], detail?: string): Promise<void> => {
    if (sinkFailure !== undefined) return;
    try {
      await context.emit({ scenario: scenarioId, phase, status, ...(detail === undefined ? {} : { detail }) });
    } catch (error) {
      sinkFailure = new SinkFailed(error);
      throw sinkFailure;
    }
  };

  // -- Prerequisites: nothing is installed or launched unless all of these hold. ------------------------------------
  let environment: MeasuredEnvironment | undefined;
  let root: string;
  try {
    await emit('prerequisites', 'started');
    const designated = await checkTestRoot(context.testRoot);
    if (!designated.ok) {
      await emit('prerequisites', 'failed', designated.reason);
      return finish({ outcome: 'blocked', reason: 'not-a-test-environment', detail: `${context.testRoot}: ${designated.reason}` });
    }
    root = designated.root;

    const dirty = await dirtiness(root);
    if (dirty !== undefined) {
      await emit('prerequisites', 'failed', dirty);
      return finish({ outcome: 'blocked', reason: 'dirty-environment', detail: dirty });
    }

    const inspected = await inspectEnvironment(context.profile, context.probes ?? defaultProbes);
    environment = inspected.environment;
    if (inspected.profileMismatch !== undefined) {
      await emit('prerequisites', 'failed', inspected.profileMismatch);
      return finish({ outcome: 'blocked', reason: 'wrong-environment', detail: inspected.profileMismatch, ...withEnvironment(environment) });
    }
    const missing = scenario.requirement.capabilities.filter((c) => !inspected.environment.capabilities.includes(c)).sort();
    if (missing.length > 0) {
      await emit('prerequisites', 'failed', `missing: ${missing.join(', ')}`);
      return finish({ outcome: 'blocked', reason: 'capability-missing', missing, detail: `missing capabilities: ${missing.join(', ')}`, ...withEnvironment(environment) });
    }
    await emit('prerequisites', 'finished');
  } catch (error) {
    return finish({ ...classify('prerequisites', error), ...withEnvironment(environment) });
  }

  // -- The lifecycle. Each phase is bounded and abortable; a phase that fails ends the run. -------------------------
  const phaseMs = context.timeouts?.phaseMs ?? DEFAULT_PHASE_MS;
  const stepsMs = context.timeouts?.stepsMs ?? DEFAULT_STEPS_MS;
  const cleanupMs = context.timeouts?.cleanupMs ?? DEFAULT_CLEANUP_MS;
  const { lifecycle } = context;
  const contextFor = (signal: AbortSignal): RunContext => ({
    candidate: context.candidate,
    profile: context.profile,
    testRoot: root,
    signal,
    own: (resource) => recordOwned(root, resource),
    spawn: (label, command, args, options) => spawnOwned(root, label, command, args, options),
    waitFor: (condition, options) => waitFor(signal, condition, options),
  });

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
      await bounded(phase, limitMs, context.signal, (signal) => run(contextFor(signal)));
      await emit(phase, 'finished');
    } catch (error) {
      stop = classify(phase, error);
      await emit(phase, 'failed', stop.detail).catch(() => undefined);
      break;
    }
  }

  // -- Cleanup: on success, on failure and on cancellation, and never cancelled by the run's own signal. ------------
  const cleanup = touched ? await cleanUp(root, lifecycle, contextFor, cleanupMs, emit) : { ok: true, failures: [] as string[], leftover: [] as CleanupFailure[] };

  return finish({
    outcome: stop?.outcome ?? 'passed',
    ...(stop === undefined ? {} : { reason: stop.reason, ...(stop.detail === undefined ? {} : { detail: stop.detail }) }),
    ...withEnvironment(environment),
    cleanup: { ok: cleanup.ok, failures: cleanup.failures },
    leftover: cleanup.leftover,
  });
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

/** Runs `work` with a deadline, abortable by `outer`. A hook that ignores its signal cannot hold the run up. */
async function bounded(phase: Phase, ms: number, outer: AbortSignal, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const controller = new AbortController();
  const abortWith = (reason: Error): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onOuterAbort = (): void => abortWith(new Cancelled());
  outer.addEventListener('abort', onOuterAbort);
  const timer = setTimeout(() => abortWith(new TimedOut(phase, ms)), ms);
  const interrupted = new Promise<never>((_, reject) => {
    const reject_ = (): void => reject(controller.signal.reason);
    if (controller.signal.aborted) reject_();
    else controller.signal.addEventListener('abort', reject_, { once: true });
  });
  interrupted.catch(() => undefined); // no unhandled rejection when the work finishes first
  const running = Promise.resolve().then(() => work(controller.signal));
  running.catch(() => undefined); // an abandoned hook may still fail later; that is no longer our concern
  try {
    if (outer.aborted) abortWith(new Cancelled());
    await Promise.race([running, interrupted]);
  } finally {
    clearTimeout(timer);
    outer.removeEventListener('abort', onOuterAbort);
  }
}

async function cleanUp(
  root: string,
  lifecycle: Lifecycle,
  contextFor: (signal: AbortSignal) => RunContext,
  ms: number,
  emit: (phase: Phase, status: ScenarioEvent['status'], detail?: string) => Promise<void>,
): Promise<{ ok: boolean; failures: string[]; leftover: CleanupFailure[] }> {
  const failures: string[] = [];
  await emit('cleanup', 'started').catch(() => undefined);
  try {
    // A fresh signal: the run may have been cancelled, but its cleanup must still be allowed to finish.
    await bounded('cleanup', ms, new AbortController().signal, (signal) => lifecycle.cleanup(contextFor(signal)));
  } catch (error) {
    failures.push(error instanceof TimedOut ? `cleanup hook ${error.message}` : `cleanup hook failed: ${message(error)}`);
  }

  // Whatever the run still owns is reaped by the runner, whatever the hook did or did not do.
  let leftover: CleanupFailure[] = [];
  try {
    leftover = (await cleanupOwnedResources(root)).failures;
  } catch (error) {
    failures.push(`could not clean up owned resources: ${message(error)}`);
  }
  for (const item of leftover) failures.push(`${item.resource.label}: ${item.reason}${item.detail === undefined ? '' : ` (${item.detail})`}`);

  if (failures.length > 0) {
    try {
      await markDirty(root, `cleanup failed: ${failures.join('; ')}`);
    } catch (error) {
      // The ledger still lists whatever was left, so the next run will see a dirty environment either way.
      failures.push(`could not mark the environment dirty: ${message(error)}`);
    }
  }
  const ok = failures.length === 0;
  await emit('cleanup', ok ? 'finished' : 'failed', ok ? undefined : failures.join('; ')).catch(() => undefined);
  return { ok, failures, leftover };
}

async function waitFor(
  signal: AbortSignal,
  condition: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal.aborted) throw signal.reason;
    if (await condition()) return;
    if (Date.now() >= deadline) throw new AssertionFailure(`timed out after ${timeoutMs} ms waiting for ${options.description ?? 'a condition'}`);
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
