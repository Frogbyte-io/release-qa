import {
  discoverProjects,
  evaluatePullRequest,
  inspectGitHubAccess,
  profileOf,
  type DiscoveredProject,
  type GateApi,
  type GitHubApi,
  type RepositoryApi,
} from '@frogbyte-io/release-qa';
import type { DashboardSnapshot, GateView, HistoryView, ProjectView, PullRequestView, RequirementView } from '../shared/contract.ts';

/** Everything the dashboard reads goes through this one transport; the real one is the GitHub CLI session. */
export type DashboardApi = GateApi & RepositoryApi & GitHubApi;

/** The last good snapshot, kept so an unreachable GitHub shows old data marked stale instead of an empty window. */
export interface SnapshotCache {
  read(): Promise<DashboardSnapshot | undefined>;
  write(snapshot: DashboardSnapshot): Promise<void>;
}

export interface DashboardDeps {
  api: DashboardApi;
  cache: SnapshotCache;
  now?: () => Date;
  /** The shared gate evaluation, the same function the required check and the CLI run. */
  evaluate?: typeof evaluatePullRequest;
}

const MAX_TEXT = 300;
const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value.slice(0, MAX_TEXT) : fallback);
const record = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
/** Only GitHub links are kept, so a repository's own text can never become a link to somewhere else. */
const githubUrl = (value: unknown): string => (typeof value === 'string' && /^https:\/\/github\.com\/[A-Za-z0-9_./#?=&%-]{1,400}$/.test(value) ? value : '');

/** A cache file from another build, or cut off mid-write, must be discarded rather than trusted. */
function validSnapshot(value: unknown): DashboardSnapshot | undefined {
  const snap = record(value);
  const account = record(snap?.account);
  if (snap === undefined || typeof snap.loadedAt !== 'string' || !Array.isArray(snap.projects) || !Array.isArray(snap.problems) || (account?.status !== 'signed-in' && account?.status !== 'signed-out')) return undefined;
  return value as DashboardSnapshot;
}

/**
 * Reads the accounts, projects, pull requests and release history the window shows. Readiness is never computed here:
 * every pull request's gate is the shared evaluator's result, passed through as data. A repository that cannot be read
 * is reported beside the ones that can be; it never empties the dashboard.
 */
export async function loadDashboard(deps: DashboardDeps): Promise<DashboardSnapshot> {
  const now = deps.now ?? (() => new Date());
  const evaluate = deps.evaluate ?? evaluatePullRequest;
  const { api } = deps;

  const fallback = async (reason: string, signedOut: boolean): Promise<DashboardSnapshot> => {
    const cached = validSnapshot(await deps.cache.read().catch(() => undefined));
    return {
      loadedAt: cached?.loadedAt ?? now().toISOString(),
      stale: cached !== undefined,
      account: signedOut ? { status: 'signed-out', reason } : cached?.account ?? { status: 'signed-out', reason },
      projects: cached?.projects ?? [],
      problems: cached === undefined ? [{ repository: '*', reason }] : [...cached.problems, { repository: '*', reason }],
    };
  };

  const auth = await api.auth();
  if (!auth.ok) return fallback(auth.reason, auth.reason === 'logged-out' || auth.reason === 'missing-scope' || auth.reason === 'organization-rejected');
  const user = await api.currentUser();
  if (!user.ok) return fallback(user.reason, user.reason === 'logged-out');

  // The sign-in was just checked; per-repository access checks reuse it instead of spawning gh again for each one.
  const session: GitHubApi = { auth: async () => auth, get: (path) => api.get(path) };
  const discovery = await discoverProjects(api);
  const listingFailed = discovery.problems.find((problem) => problem.repository === '*');
  if (listingFailed !== undefined) return fallback(listingFailed.reason, listingFailed.reason === 'logged-out');

  const problems = discovery.problems.filter((problem) => problem.repository !== '*');
  const projects: ProjectView[] = [];
  // A few projects at a time; within one, pull requests are read one at a time (see loadProject). Results keep discovery order.
  const loaded: Array<{ ok: true; project: ProjectView } | { ok: false; reason: string }> = new Array(discovery.projects.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, discovery.projects.length) }, async () => {
    while (next < discovery.projects.length) {
      const index = next++;
      loaded[index] = await loadProject(discovery.projects[index]!, deps.api, session, evaluate).catch(() => ({ ok: false as const, reason: 'network-error' }));
    }
  }));
  loaded.forEach((view, index) => {
    if (view.ok) projects.push(view.project);
    else problems.push({ repository: discovery.projects[index]!.repository, reason: view.reason });
  });

  const snapshot: DashboardSnapshot = { loadedAt: now().toISOString(), stale: false, account: { status: 'signed-in', login: user.value }, projects, problems };
  // Only a complete read replaces the cache: a partial one would erase the last good copy the stale view depends on.
  if (problems.length === 0) await deps.cache.write(snapshot).catch(() => undefined);
  return snapshot;
}

async function loadProject(
  { repository, project }: DiscoveredProject,
  api: DashboardApi,
  session: GitHubApi,
  evaluate: typeof evaluatePullRequest,
): Promise<{ ok: true; project: ProjectView } | { ok: false; reason: string }> {
  const access = await inspectGitHubAccess(repository, session);
  if (!access.ok) return { ok: false, reason: access.reason };
  const role = access.role as ProjectView['role'];
  const requirements: RequirementView[] = project.requirements.map((requirement) => ({ key: requirement.key, title: requirement.title, mode: requirement.mode, profile: profileOf(requirement.key) }));

  const listed = await api.list(`repos/${repository}/pulls?state=open&per_page=100`);
  let pullRequests: ProjectView['pullRequests'];
  if (listed.ok) {
    // One at a time: each evaluation runs several gh calls, and a burst of them is what gets a token rate-limited.
    const items: PullRequestView[] = [];
    for (const entry of listed.value) {
      const view = await pullRequestView(repository, entry, api, evaluate);
      if (view !== undefined) items.push(view);
    }
    pullRequests = { status: 'ok', items };
  } else pullRequests = { status: 'unavailable', reason: listed.reason };

  return {
    ok: true,
    project: {
      repository,
      projectId: project.projectId,
      releaseBranch: project.releaseBranch,
      role,
      readOnly: !['admin', 'maintain', 'write'].includes(role),
      profiles: project.profiles.map((profile) => profile.id),
      requirements,
      pullRequests,
      history: await historyView(repository, api),
    },
  };
}

async function pullRequestView(repository: string, entry: unknown, api: DashboardApi, evaluate: typeof evaluatePullRequest): Promise<PullRequestView | undefined> {
  const pull = record(entry);
  const head = record(pull?.head);
  const number = pull?.number;
  if (pull === undefined || typeof number !== 'number' || !Number.isSafeInteger(number) || typeof head?.sha !== 'string') return undefined;
  const result = await evaluate(repository, number, api).catch(() => undefined);
  let gate: GateView;
  let releaseIntent: string[] | undefined;
  if (result === undefined) gate = { status: 'unavailable', error: 'GitHub state could not be read' };
  else if (!result.ok) gate = { status: 'unavailable', error: result.error };
  else {
    releaseIntent = result.value.releaseIntent;
    gate = {
      status: 'evaluated',
      evaluation: result.value.evaluation,
      ...(result.value.candidateId === undefined ? {} : { candidateId: result.value.candidateId }),
      ...(result.value.candidateReleaseId === undefined ? {} : { candidateReleaseId: result.value.candidateReleaseId }),
    };
  }
  return {
    number,
    title: text(pull.title, `#${number}`),
    author: text(record(pull.user)?.login, 'unknown'),
    url: githubUrl(pull.html_url),
    headRef: text(head.ref),
    headSha: head.sha,
    draft: pull.draft === true,
    ...(releaseIntent === undefined ? {} : { releaseIntent }),
    gate,
  };
}

async function historyView(repository: string, api: DashboardApi): Promise<HistoryView> {
  const listed = await api.get(`repos/${repository}/releases?per_page=20`);
  if (!listed.ok) return { status: 'unavailable', reason: listed.reason };
  if (!Array.isArray(listed.value)) return { status: 'unavailable', reason: 'network-error' };
  const releases = listed.value.flatMap((entry) => {
    const release = record(entry);
    if (release === undefined || release.draft === true || typeof release.tag_name !== 'string') return [];
    const assets = Array.isArray(release.assets) ? release.assets.map(record) : [];
    return [{
      tag: text(release.tag_name),
      name: text(release.name, text(release.tag_name)),
      publishedAt: text(release.published_at),
      url: githubUrl(release.html_url),
      qa: assets.some((asset) => asset?.name === 'release-qa-record.json') ? ('recorded' as const) : ('missing' as const),
    }];
  });
  return { status: 'ok', releases };
}
