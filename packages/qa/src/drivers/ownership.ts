import type { RunContext } from '../runner/execute.ts';
import { processIdentity } from '../runner/resources.ts';

// What every WebDriver adapter needs to own what its driver chain starts indirectly.

export const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};
export const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
export async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await sleep(50);
  }
  return !alive(pid);
}

export interface TakeOverChecks {
  /** Whether `pid` is still below this run's driver chain; a pid that is not may have been reused by another process. */
  stillMine: (pid: number) => Promise<boolean>;
  /** Reads a process's identity; default `processIdentity`. */
  identityOf?: (pid: number) => Promise<string | undefined>;
}

/**
 * Makes processes the run started indirectly its own, so the runner reaps them. A process that can no longer be owned
 * (the phase that started it was cut off) or that is alive but cannot be identified is stopped instead, and this
 * throws: a process nobody owns must not be left running. One that exits while being identified needs nothing.
 *
 * A pid is only signalled while it is still the process that was found: one that could not be owned must still have
 * the identity read for it, and one that could never be identified must still be below the driver chain. A pid that
 * fails its check now belongs to someone else, so the process that was found has exited and there is nothing to stop.
 */
export async function takeOver(ctx: Pick<RunContext, 'own'>, pids: readonly number[], label: string, checks: TakeOverChecks): Promise<void> {
  const identityOf = checks.identityOf ?? processIdentity;
  const problems: string[] = [];
  const stop = async (pid: number, why: string): Promise<void> => {
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
    await goneWithin(pid, 5000);
    problems.push(`${label} ${pid} ${why}, so it was stopped`);
  };
  for (const pid of pids) {
    // Identifying a process that has just started can fail for a moment; keep trying while it runs.
    let identity = await identityOf(pid);
    const end = Date.now() + 2000;
    while (identity === undefined && alive(pid) && Date.now() < end) {
      await sleep(100);
      identity = await identityOf(pid);
    }
    if (identity === undefined) {
      if (alive(pid) && (await checks.stillMine(pid))) await stop(pid, 'could not be identified');
      continue;
    }
    try {
      await ctx.own({ kind: 'process', pid, identity, label });
    } catch (error) {
      if ((await identityOf(pid)) === identity) await stop(pid, `could not be owned (${message(error)})`);
    }
  }
  if (problems.length > 0) throw new Error(problems.join('; '));
}
