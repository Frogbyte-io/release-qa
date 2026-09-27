import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { Project } from '../model/project.ts';
import type { Requirement } from '../model/requirement.ts';
import { waitFor, type RunContext } from '../runner/execute.ts';
import { processIdentity, type OwnedResource } from '../runner/resources.ts';
import { loadConsumerInProcess, type InProcessConsumer } from './consumer.ts';

type Inspect = { type: 'inspect'; id: number; projectPath: string; project: Project; requirements: Requirement[] };
type Invoke = {
  type: 'invoke'; id: number; phase: 'install' | 'reset' | 'launch' | 'cleanup' | 'setup' | 'steps'; scenarioId?: string;
  context: Pick<RunContext, 'candidate' | 'artifact' | 'profile' | 'testRoot'>;
};
type RpcResult = { type: 'rpc-result'; requestId: number; ok: boolean; error?: string };

let consumer: Extract<InProcessConsumer, { ok: true }> | undefined;
let nextRpc = 0;
const rpcReplies = new Map<number, { resolve(): void; reject(error: Error): void }>();
const active = new Map<number, AbortController>();

const send = (value: unknown): void => { if (process.send === undefined) throw new Error('consumer IPC channel closed'); process.send(value); };
const errorInfo = (error: unknown): { name: string; message: string; code?: string } => {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) };
  const code = (error as Error & { code?: unknown }).code;
  return { name: error.name, message: error.message, ...(typeof code === 'string' ? { code } : {}) };
};

function own(callId: number, resource: OwnedResource): Promise<void> {
  const requestId = ++nextRpc;
  return new Promise((resolve, reject) => {
    rpcReplies.set(requestId, { resolve, reject });
    send({ type: 'rpc', id: callId, requestId, operation: 'own', resource });
  });
}

/** The child starts its own helper, but the parent records its identity before the hook may use it. */
async function spawnFor(callId: number, label: string, command: string, args: readonly string[], options: SpawnOptions = {}): Promise<ChildProcess> {
  const child = spawn(command, [...args], options);
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });
  const pid = child.pid as number;
  let exited = false;
  child.once('exit', () => { exited = true; });
  const identity = await processIdentity(pid);
  if (exited || child.exitCode !== null || child.signalCode !== null) return child;
  if (identity === undefined) {
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ]);
    if (exited || child.exitCode !== null || child.signalCode !== null) return child;
    child.kill('SIGKILL');
    throw new Error(`could not identify the process started for "${label}"; it was stopped`);
  }
  try {
    await own(callId, { kind: 'process', pid, identity, label });
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
  return child;
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

process.on('message', (raw: Inspect | Invoke | RpcResult) => {
  if (raw.type === 'rpc-result') {
    const pending = rpcReplies.get(raw.requestId);
    if (pending === undefined) return;
    rpcReplies.delete(raw.requestId);
    if (raw.ok) pending.resolve();
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
