import { fork, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Project } from '../model/project.ts';
import type { Requirement } from '../model/requirement.ts';
import { AssertionFailure, type OwnedChildProcess, type RunContext } from '../runner/execute.ts';

type Reply = { type: 'reply'; id: number; ok: boolean; value?: unknown; error?: { name: string; message: string; code?: string } };
type Rpc = { type: 'rpc'; id: number; requestId: number; operation: 'own'; resource: unknown } | { type: 'rpc'; id: number; requestId: number; operation: 'evidence'; name: string } | { type: 'rpc'; id: number; requestId: number; operation: 'spawn'; label: string; command: string; args: string[]; options: SpawnOptions } | { type: 'rpc'; id: number; requestId: number; operation: 'kill'; childId: number; signal?: NodeJS.Signals | number };
type Pending = { worker: ChildProcess; context?: RunContext; rpcs: Set<Promise<void>>; resolve(value: unknown): void; reject(error: Error): void; abort?: () => void };

const errorOf = (value: Reply['error']): Error => {
  if (value?.name === 'AssertionFailure') return new AssertionFailure(value.message);
  const error = new Error(value?.message ?? 'consumer process failed');
  error.name = value?.name ?? 'Error';
  if (value?.code !== undefined) (error as Error & { code: string }).code = value.code;
  return error;
};

/** Owns one consumer child at a time. The parent remains the runner, lock holder, journal writer and cleanup owner. */
export class ConsumerProcess {
  private worker: ChildProcess | undefined;
  private starting: Promise<{ setupIds: string[] }> | undefined;
  private ready: { setupIds: string[] } | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly children = new WeakMap<ChildProcess, Map<number, OwnedChildProcess>>();
  private readonly stopping = new WeakMap<ChildProcess, string>();
  private readonly projectPath: string;
  private readonly project: Project;
  private readonly requirements: readonly Requirement[];

  private readonly workerPath: string;

  constructor(projectPath: string, project: Project, requirements: readonly Requirement[], workerPath = fileURLToPath(new URL('./consumer-worker.ts', import.meta.url))) {
    this.workerPath = workerPath;
    this.projectPath = projectPath;
    this.project = project;
    this.requirements = requirements;
  }

  async inspect(): Promise<{ ok: true; setupIds: string[] } | { ok: false; error: string }> {
    try { return { ok: true, ...await this.ensure() }; }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }

  async invoke(phase: 'install' | 'reset' | 'launch' | 'cleanup' | 'setup' | 'steps', scenarioId: string | undefined, context: RunContext): Promise<void> {
    await this.ensure();
    const worker = this.worker;
    if (worker === undefined) throw new Error('consumer process exited before the phase started');
    await this.request(worker, { type: 'invoke', phase, scenarioId, context: {
      candidate: context.candidate, artifact: context.artifact, profile: context.profile, testRoot: context.testRoot,
    } }, context);
  }

  async close(): Promise<void> {
    const worker = this.worker;
    if (worker === undefined) return;
    this.worker = undefined;
    this.ready = undefined;
    this.terminate(worker, 'consumer process closed');
    if (worker.exitCode === null && worker.signalCode === null) {
      await new Promise<void>((resolve) => {
        worker.once('exit', () => resolve());
      });
    }
  }

  private ensure(): Promise<{ setupIds: string[] }> {
    if (this.worker !== undefined && this.ready !== undefined) return Promise.resolve(this.ready);
    if (this.starting !== undefined) return this.starting;
    const worker = fork(this.workerPath, [], {
      execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    });
    this.worker = worker;
    this.children.set(worker, new Map());
    worker.on('message', (message: Reply | Rpc) => void this.receive(worker, message));
    worker.on('error', (error) => this.terminate(worker, `consumer process failed: ${error.message}`));
    worker.on('exit', (code, signal) => this.stopped(worker, this.stopping.get(worker) ?? `consumer process exited (${code ?? signal ?? 'unknown'})`));
    const starting = this.request(worker, {
      type: 'inspect', projectPath: this.projectPath, project: this.project, requirements: this.requirements,
    }).then((value) => {
      const ready = value as { setupIds: string[] };
      if (this.worker === worker) this.ready = ready;
      return ready;
    });
    this.starting = starting;
    starting.catch(() => undefined).finally(() => { if (this.starting === starting) this.starting = undefined; });
    return starting;
  }

  private request(worker: ChildProcess, message: Record<string, unknown>, context?: RunContext): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const abort = context === undefined ? undefined : (): void => {
        this.terminate(worker, 'consumer process cancelled');
      };
      const pending: Pending = { worker, rpcs: new Set(), resolve, reject, ...(context === undefined ? {} : { context }), ...(abort === undefined ? {} : { abort }) };
      this.pending.set(id, pending);
      if (abort !== undefined) {
        context!.signal.addEventListener('abort', abort, { once: true });
        if (context!.signal.aborted) { abort(); return; }
      }
      worker.send({ ...message, id }, (error) => {
        if (error) this.terminate(worker, `consumer process could not receive a request: ${error.message}`);
      });
    });
  }

  private receive(worker: ChildProcess, message: Reply | Rpc): void {
    if (message.type === 'rpc') {
      if (message.operation === 'kill') {
        if (this.worker === worker) {
          const child = this.children.get(worker)?.get(message.childId);
          void (child === undefined ? Promise.resolve(false) : child.kill(message.signal)).then((killed) => {
            if (worker.connected) worker.send({ type: 'rpc-result', requestId: message.requestId, ok: true, value: killed }, () => undefined);
          }, (error: unknown) => {
            if (worker.connected) worker.send({ type: 'rpc-result', requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }, () => undefined);
          });
        }
        return;
      }
      const answer = (ok: boolean, value?: unknown, error?: string): void => {
        if (worker.connected) worker.send({ type: 'rpc-result', requestId: message.requestId, ok, ...(value === undefined ? {} : { value }), ...(error === undefined ? {} : { error }) }, () => undefined);
      };
      const pending = this.pending.get(message.id);
      // A request made through the context of a call that has returned (say, by a session object kept from the launch
      // hook) is refused out loud: left unanswered, the consumer code would wait for it forever.
      if (pending?.worker !== worker || pending.context === undefined) {
        answer(false, undefined, `the ${message.operation} request came from a phase that has ended; use the context of the phase that is running`);
        return;
      }
      const operation = (async (): Promise<unknown> => {
        if (message.operation === 'own') {
          await pending.context!.own(message.resource as Parameters<RunContext['own']>[0]);
          return undefined;
        }
        if (message.operation === 'evidence') return await pending.context!.evidence(message.name);
        if (message.operation === 'spawn') {
          const child = await pending.context!.spawn(message.label, message.command, message.args, message.options);
          const childId = message.requestId;
          if (child.exitCode === null && child.signalCode === null) {
            this.children.get(worker)?.set(childId, child);
            child.once('exit', (code, signal) => {
              this.children.get(worker)?.delete(childId);
              if (worker.connected) worker.send({ type: 'child-exit', childId, code, signal }, () => undefined);
            });
          }
          if (pending.context!.signal.aborted || !worker.connected) await child.kill('SIGKILL');
          return { childId, pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode };
        }
        return undefined;
      })();
      const tracked = operation.then(() => undefined, () => undefined);
      pending.rpcs.add(tracked);
      void operation.then(
        (value) => answer(true, value),
        (error: unknown) => answer(false, undefined, error instanceof Error ? error.message : String(error)),
      ).finally(() => pending.rpcs.delete(tracked));
      return;
    }
    if (message.type !== 'reply') return;
    const pending = this.pending.get(message.id);
    if (pending?.worker !== worker) return;
    this.pending.delete(message.id);
    if (pending.abort !== undefined) pending.context?.signal.removeEventListener('abort', pending.abort);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(errorOf(message.error));
  }

  private stopped(worker: ChildProcess, reason: string): void {
    if (this.worker === worker) {
      this.worker = undefined;
      this.ready = undefined;
    }
    for (const [id, pending] of this.pending) {
      if (pending.worker !== worker) continue;
      this.pending.delete(id);
      if (pending.abort !== undefined) pending.context?.signal.removeEventListener('abort', pending.abort);
      void Promise.allSettled([...pending.rpcs]).then(() => pending.reject(new Error(reason)));
    }
  }

  private terminate(worker: ChildProcess, reason: string): void {
    if (worker.exitCode !== null || worker.signalCode !== null || worker.pid === undefined) {
      this.stopped(worker, reason);
      return;
    }
    this.stopping.set(worker, reason);
    worker.kill('SIGKILL');
  }
}
