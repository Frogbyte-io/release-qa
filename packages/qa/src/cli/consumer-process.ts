import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Project } from '../model/project.ts';
import type { Requirement } from '../model/requirement.ts';
import { AssertionFailure, type RunContext } from '../runner/execute.ts';

type Reply = { type: 'reply'; id: number; ok: boolean; value?: unknown; error?: { name: string; message: string; code?: string } };
type Rpc = { type: 'rpc'; id: number; requestId: number; operation: 'own'; resource: unknown };
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
  private readonly projectPath: string;
  private readonly project: Project;
  private readonly requirements: readonly Requirement[];

  constructor(projectPath: string, project: Project, requirements: readonly Requirement[]) {
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
    worker.kill();
    if (worker.exitCode === null && worker.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 2000);
        worker.once('exit', () => { clearTimeout(timeout); resolve(); });
      });
    }
  }

  private ensure(): Promise<{ setupIds: string[] }> {
    if (this.worker !== undefined && this.ready !== undefined) return Promise.resolve(this.ready);
    if (this.starting !== undefined) return this.starting;
    const worker = fork(fileURLToPath(new URL('./consumer-worker.ts', import.meta.url)), [], {
      execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    });
    this.worker = worker;
    worker.on('message', (message: Reply | Rpc) => void this.receive(worker, message));
    worker.on('error', (error) => this.stopped(worker, `consumer process failed: ${error.message}`));
    worker.on('exit', (code, signal) => this.stopped(worker, `consumer process exited (${code ?? signal ?? 'unknown'})`));
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
        if (this.worker === worker) {
          this.worker = undefined;
          this.ready = undefined;
        }
        worker.kill();
        this.stopped(worker, 'consumer process cancelled');
      };
      const pending: Pending = { worker, rpcs: new Set(), resolve, reject, ...(context === undefined ? {} : { context }), ...(abort === undefined ? {} : { abort }) };
      this.pending.set(id, pending);
      if (abort !== undefined) {
        context!.signal.addEventListener('abort', abort, { once: true });
        if (context!.signal.aborted) { abort(); return; }
      }
      worker.send({ ...message, id }, (error) => {
        if (error) this.stopped(worker, `consumer process could not receive a request: ${error.message}`);
      });
    });
  }

  private receive(worker: ChildProcess, message: Reply | Rpc): void {
    if (message.type === 'rpc') {
      const pending = this.pending.get(message.id);
      if (pending?.worker !== worker || pending.context === undefined) return;
      const recorded = pending.context.own(message.resource as Parameters<RunContext['own']>[0]);
      pending.rpcs.add(recorded);
      const answer = (ok: boolean, error?: string): void => {
        if (worker.connected) worker.send({ type: 'rpc-result', requestId: message.requestId, ok, ...(error === undefined ? {} : { error }) }, () => undefined);
      };
      void recorded.then(
        () => answer(true),
        (error: unknown) => answer(false, error instanceof Error ? error.message : String(error)),
      ).finally(() => pending.rpcs.delete(recorded));
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
}
