import type { DashboardSnapshot } from '../src/shared/contract.ts';
import type { DashboardApi, SnapshotCache } from '../src/main/qa-commands.ts';
import type { ActionApi } from '../src/main/release-actions.ts';

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

/** The read transport plus the two writes the dashboard makes, both recorded. A write answers from `writes`, or succeeds. */
export function actionTransport(replies: Record<string, Reply>, writes: { put?: Reply; post?: Reply } = {}): ActionApi & { puts: Array<{ path: string; body: unknown }>; posts: Array<{ path: string; body: unknown }> } {
  const puts: Array<{ path: string; body: unknown }> = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  return Object.assign(fixtureTransport(replies), {
    puts,
    posts,
    put: async (path: string, body: unknown) => { puts.push({ path, body }); return writes.put ?? { ok: true as const, value: { sha: 'c'.repeat(40), merged: true } }; },
    post: async (path: string, body: unknown) => { posts.push({ path, body }); return writes.post ?? { ok: true as const, value: null }; },
  }) as never;
}
