import type { ApiResult } from './transport.ts';
import { parseProject, type Project } from '../model/project.ts';
import { GhTransport } from './transport.ts';

export interface RepositoryApi {
  get(path: string): Promise<ApiResult<unknown>>;
  list(path: string): Promise<ApiResult<unknown[]>>;
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
    const listed = await api.list(listPath);
    if (!listed.ok) return { ...result, problems: [{ repository: '*', reason: listed.reason }] };
    repositories = listed.value;
  } else {
    const name = fromUrl(manualUrl);
    if (name === undefined) return { ...result, problems: [{ repository: manualUrl, reason: 'expected a GitHub repository URL' }] };
    const fetched = await api.get(`repos/${name}`);
    if (!fetched.ok) return { ...result, problems: [{ repository: name, reason: fetched.reason }] };
    repositories = [fetched.value];
  }

  for (const entry of repositories) {
    const repository = entry as { full_name?: unknown; default_branch?: unknown };
    if (typeof repository?.full_name !== 'string' || !repositoryName.test(repository.full_name) || typeof repository.default_branch !== 'string') continue;
    const name = repository.full_name;
    const path = `repos/${name}/contents/qa/project.json?ref=${encodeURIComponent(repository.default_branch)}`;
    const fetched = await api.get(path);
    if (!fetched.ok) {
      if (fetched.reason !== 'not-found' || manualUrl !== undefined) result.problems.push({ repository: name, reason: fetched.reason });
      continue;
    }
    const file = fetched.value as { type?: unknown; encoding?: unknown; content?: unknown };
    if (file?.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string') {
      result.problems.push({ repository: name, reason: 'invalid project.json' });
      continue;
    }
    try {
      const parsed = parseProject(JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')) as unknown);
      if (parsed.ok) result.projects.push({ repository: name, project: parsed.value });
      else result.problems.push({ repository: name, reason: 'invalid project.json' });
    } catch {
      result.problems.push({ repository: name, reason: 'invalid project.json' });
    }
  }
  return result;
}
