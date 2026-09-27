import type { ApiResult } from './transport.ts';
import { parseProject, type Project } from '../model/project.ts';
import { GhTransport } from './transport.ts';

export interface RepositoryApi {
  get(path: string): Promise<ApiResult<unknown>>;
  list(path: string, projection?: string): Promise<ApiResult<unknown[]>>;
}

export interface DiscoveredProject { repository: string; project: Project }
export interface Discovery { projects: DiscoveredProject[]; problems: Array<{ repository: string; reason: string }> }

const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const listPath = 'user/repos?per_page=100&affiliation=owner,collaborator,organization_member';

function fromUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash) return undefined;
    const parts = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);
    if (parts.length !== 2) return undefined;
    const name = `${parts[0]}/${parts[1]!.replace(/\.git$/, '')}`;
    return repositoryName.test(name) ? name : undefined;
  } catch { return undefined; }
}

/** Reads only repository metadata and qa/project.json. Scenario imports are never evaluated during discovery. */
export async function discoverProjects(api: RepositoryApi = new GhTransport(), manualUrl?: string): Promise<Discovery> {
  const result: Discovery = { projects: [], problems: [] };
  let repositories: unknown[];
  if (manualUrl === undefined) {
    // Project at the API boundary so large paginated repository lists do not fill gh's output buffer with unused data.
    const listed = await api.list(listPath, '.[] | {full_name,default_branch}');
    if (!listed.ok) return { ...result, problems: [{ repository: '*', reason: listed.reason }] };
    repositories = listed.value;
  } else {
    const name = fromUrl(manualUrl);
    if (name === undefined) return { ...result, problems: [{ repository: manualUrl, reason: 'expected a GitHub repository URL' }] };
    const fetched = await api.get(`repos/${name}`);
    if (!fetched.ok) return { ...result, problems: [{ repository: name, reason: fetched.reason }] };
    repositories = [fetched.value];
  }

  const inspect = async (entry: unknown): Promise<{ project?: DiscoveredProject; problem?: { repository: string; reason: string } } | undefined> => {
    const repository = entry as { full_name?: unknown; default_branch?: unknown };
    if (typeof repository?.full_name !== 'string' || !repositoryName.test(repository.full_name) || typeof repository.default_branch !== 'string') return undefined;
    const name = repository.full_name;
    const path = `repos/${name}/contents/qa/project.json?ref=${encodeURIComponent(repository.default_branch)}`;
    let fetched: ApiResult<unknown>;
    try { fetched = await api.get(path); }
    catch { return { problem: { repository: name, reason: 'network-error' } }; }
    if (!fetched.ok) {
      return fetched.reason !== 'not-found' || manualUrl !== undefined ? { problem: { repository: name, reason: fetched.reason } } : undefined;
    }
    const file = fetched.value as { type?: unknown; encoding?: unknown; content?: unknown };
    if (file?.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string') {
      return { problem: { repository: name, reason: 'invalid project.json' } };
    }
    try {
      const parsed = parseProject(JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')) as unknown);
      return parsed.ok ? { project: { repository: name, project: parsed.value } } : { problem: { repository: name, reason: 'invalid project.json' } };
    } catch {
      return { problem: { repository: name, reason: 'invalid project.json' } };
    }
  };
  const scanned: Array<Awaited<ReturnType<typeof inspect>>> = new Array(repositories.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, repositories.length) }, async () => {
    while (next < repositories.length) {
      const index = next++;
      scanned[index] = await inspect(repositories[index]);
    }
  }));
  for (const entry of scanned) {
    if (entry?.project !== undefined) result.projects.push(entry.project);
    if (entry?.problem !== undefined) result.problems.push(entry.problem);
  }
  return result;
}
