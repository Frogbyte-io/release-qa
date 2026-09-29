import type { DashboardSnapshot } from '../src/shared/contract.ts';
import type { DashboardApi, SnapshotCache } from '../src/main/qa-commands.ts';

type Reply = { ok: true; value: unknown } | { ok: false; reason: 'logged-out' | 'missing-scope' | 'insufficient-role' | 'organization-rejected' | 'not-found' | 'network-error' };

/**
 * A GitHub transport that answers from a table of paths. A path with no entry is `not-found`, like GitHub's own 404, so
 * a test only states what the scenario needs. Writes are absent on purpose: Task 5.1 reads, and a read-only view that
 * tried to write would fail here.
 */
export function fixtureTransport(replies: Record<string, Reply>, options: { auth?: Reply; login?: string } = {}): DashboardApi {
  const answer = (path: string): Reply => replies[path] ?? { ok: false, reason: 'not-found' };
  const nothing = (): never => { throw new Error('the dashboard read view must not write'); };
  return {
    auth: async () => (options.auth ?? { ok: true, value: true }) as never,
    get: async (path: string) => answer(path),
    list: async (path: string) => {
      const reply = answer(path);
      return reply.ok ? { ok: true, value: reply.value as unknown[] } : reply;
    },
    currentUser: async () => ({ ok: true, value: options.login ?? 'maintainer' }),
    upload: nothing,
    download: nothing,
    dispatchReconciliation: nothing,
  } as unknown as DashboardApi;
}

export function memoryCache(initial?: DashboardSnapshot): SnapshotCache & { last: () => DashboardSnapshot | undefined } {
  let kept = initial;
  return {
    read: async () => kept,
    write: async (snapshot) => { kept = snapshot; },
    last: () => kept,
  };
}
