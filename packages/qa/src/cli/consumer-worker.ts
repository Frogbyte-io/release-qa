import type { SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Project } from '../model/project.ts';
import type { Requirement } from '../model/requirement.ts';
import { waitFor, type OwnedChildProcess, type RunContext } from '../runner/execute.ts';
import type { OwnedResource } from '../runner/resources.ts';
import { loadConsumerInProcess, type InProcessConsumer } from './consumer.ts';

type Inspect = { type: 'inspect'; id: number; projectPath: string; project: Project; requirements: Requirement[] };
type Invoke = {
  type: 'invoke'; id: number; phase: 'install' | 'reset' | 'launch' | 'cleanup' | 'setup' | 'steps'; scenarioId?: string;
  context: Pick<RunContext, 'candidate' | 'artifact' | 'profile' | 'testRoot'>;
};
type RpcResult = { type: 'rpc-result'; requestId: number; ok: boolean; value?: unknown; error?: string };
type ChildExit = { type: 'child-exit'; childId: number; code: number | null; signal: NodeJS.Signals | null };

let consumer: Extract<InProcessConsumer, { ok: true }> | undefined;
let nextRpc = 0;
const rpcReplies = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
const active = new Map<number, AbortController>();
const children = new Map<number, RemoteChild>();
const earlyExits = new Map<number, ChildExit>();

const send = (value: unknown): void => { if (process.send === undefined) throw new Error('consumer IPC channel closed'); process.send(value); };
const errorInfo = (error: unknown): { name: string; message: string; code?: string } => {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) };
  const code = (error as Error & { code?: unknown }).code;
  return { name: error.name, message: error.message, ...(typeof code === 'string' ? { code } : {}) };
};

function rpc(callId: number, message: Record<string, unknown>): Promise<unknown> {
  const requestId = ++nextRpc;
  return new Promise((resolve, reject) => {
    rpcReplies.set(requestId, { resolve, reject });
    send({ type: 'rpc', id: callId, requestId, ...message });
  });
}

function own(callId: number, resource: OwnedResource): Promise<void> {
  return rpc(callId, { operation: 'own', resource }).then(() => undefined);
}

class RemoteChild extends EventEmitter {
  readonly childId: number;
  readonly callId: number;
  readonly pid: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;

  constructor(childId: number, callId: number, state: { pid?: number; exitCode: number | null; signalCode: NodeJS.Signals | null }) {
    super();
    this.childId = childId;
    this.callId = callId;
    this.pid = state.pid;
    this.exitCode = state.exitCode;
    this.signalCode = state.signalCode;
  }

  async kill(signal?: NodeJS.Signals | number): Promise<boolean> {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    return await rpc(this.callId, { operation: 'kill', childId: this.childId, signal }) as boolean;
  }

  exited(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

/** The parent starts and records the helper before this proxy is returned to consumer code. */
async function spawnFor(callId: number, label: string, command: string, args: readonly string[], options: SpawnOptions = {}): Promise<OwnedChildProcess> {
  if (options.stdio !== 'ignore' && options.stdio !== 'inherit') {
    throw new Error('consumer child process bridge requires stdio: ignore or inherit');
  }
  if (options.signal !== undefined) throw new Error('consumer child process bridge does not support a spawn AbortSignal');
  if (options.cwd instanceof URL) throw new Error('consumer child process bridge requires a string cwd');
  const state = await rpc(callId, { operation: 'spawn', label, command, args: [...args], options }) as { childId: number; pid?: number; exitCode: number | null; signalCode: NodeJS.Signals | null };
  const child = new RemoteChild(state.childId, callId, state);
  children.set(state.childId, child);
  const early = earlyExits.get(state.childId);
  if (early !== undefined) {
    earlyExits.delete(state.childId);
    queueMicrotask(() => { child.exited(early.code, early.signal); children.delete(state.childId); });
  }
  return child as OwnedChildProcess;
}

async function invoke(message: Invoke): Promise<void> {
  if (consumer === undefined) throw new Error('consumer modules were not loaded');
  const controller = new AbortController();
  active.set(message.id, controller);
  const context: RunContext = {
    ...message.context,
    signal: controller.signal,
    own: (resource) => own(message.id, resource),
    spawn: (label, command, args, options) => spawnFor(message.id, label, command, args, options),
    waitFor: (condition, options) => waitFor(controller.signal, condition, options),
  };
  try {
    if (message.phase === 'setup' || message.phase === 'steps') {
      const scenario = consumer.scenarios.find((item) => item.id === message.scenarioId);
      if (scenario === undefined) throw new Error(`unknown scenario: ${message.scenarioId}`);
      if (message.phase === 'setup') await scenario.setup?.(context);
      else await scenario.steps(context);
    } else {
      await consumer.lifecycle[message.phase](context);
    }
  } finally {
    active.delete(message.id);
  }
}

process.on('message', (raw: Inspect | Invoke | RpcResult | ChildExit) => {
  if (raw.type === 'child-exit') {
    const child = children.get(raw.childId);
    if (child === undefined) earlyExits.set(raw.childId, raw);
    else { child.exited(raw.code, raw.signal); children.delete(raw.childId); }
    return;
  }
  if (raw.type === 'rpc-result') {
    const pending = rpcReplies.get(raw.requestId);
    if (pending === undefined) return;
    rpcReplies.delete(raw.requestId);
    if (raw.ok) pending.resolve(raw.value);
    else pending.reject(new Error(raw.error ?? 'parent refused ownership'));
    return;
  }
  void (async () => {
    try {
      if (raw.type === 'inspect') {
        const loaded = await loadConsumerInProcess(raw.projectPath, raw.project, raw.requirements);
        if (!loaded.ok) throw new Error(loaded.error);
        consumer = loaded;
        send({ type: 'reply', id: raw.id, ok: true, value: { setupIds: loaded.scenarios.filter((scenario) => scenario.setup !== undefined).map((scenario) => scenario.id) } });
      } else {
        await invoke(raw);
        send({ type: 'reply', id: raw.id, ok: true });
      }
    } catch (error) {
      send({ type: 'reply', id: raw.id, ok: false, error: errorInfo(error) });
    }
  })();
});

process.on('disconnect', () => process.exit(0));
