import { execFile } from 'node:child_process';

export type AccessProblem = 'logged-out' | 'missing-scope' | 'insufficient-role' | 'organization-rejected' | 'not-found' | 'network-error';
export type ApiResult<T> = { ok: true; value: T } | { ok: false; reason: AccessProblem };
export interface GitHubApi {
  auth(): Promise<ApiResult<true>>;
  get(path: string): Promise<ApiResult<unknown>>;
}

const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** GitHub CLI is the credential boundary. Arguments are arrays; stderr is classified, never shown to a renderer. */
export class GhTransport implements GitHubApi {
  private readonly executable: string;
  private readonly prefixArgs: readonly string[];

  constructor(executable = 'gh', prefixArgs: readonly string[] = []) {
    this.executable = executable;
    this.prefixArgs = prefixArgs;
  }

  private run(args: readonly string[]): Promise<{ ok: true; output: string } | { ok: false; reason: AccessProblem }> {
    return new Promise((resolve) => {
      execFile(this.executable, [...this.prefixArgs, ...args], { windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error !== null) return resolve({ ok: false, reason: classifyGhError(stderr) });
        resolve({ ok: true, output: stdout });
      });
    });
  }

  async auth(): Promise<ApiResult<true>> {
    const result = await this.run(['auth', 'status', '--active']);
    return result.ok ? { ok: true, value: true } : result;
  }

  async get(path: string): Promise<ApiResult<unknown>> {
    const response = await this.run(['api', path]);
    if (!response.ok) return response;
    try { return { ok: true, value: JSON.parse(response.output) as unknown }; }
    catch { return { ok: false, reason: 'network-error' }; }
  }

  async list(path: string, projection = '.[]'): Promise<ApiResult<unknown[]>> {
    const response = await this.run(['api', '--paginate', path, '--jq', projection]);
    if (!response.ok) return response;
    try { return { ok: true, value: response.output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown) }; }
    catch { return { ok: false, reason: 'network-error' }; }
  }
}

function classifyGhError(stderr: string): AccessProblem {
  if (/SAML|SSO|organization.*(OAuth|access)|organization.*(forbid|restrict)/i.test(stderr)) return 'organization-rejected';
  if (/scope|X-OAuth-Scopes|Resource not accessible by integration/i.test(stderr)) return 'missing-scope';
  if (/not logged|not authenticated|HTTP 401|authentication required/i.test(stderr)) return 'logged-out';
  if (/HTTP 404|not found/i.test(stderr)) return 'not-found';
  if (/HTTP 403|permission|forbidden|must have.*access/i.test(stderr)) return 'insufficient-role';
  return 'network-error';
}

/** Inspection separates authentication, API access, and repository role. Read-only access is still discoverable. */
export async function inspectGitHubAccess(repository: string, api: GitHubApi = new GhTransport()): Promise<{ ok: true; repositoryId: number; role: string } | { ok: false; reason: AccessProblem }> {
  if (!repositoryName.test(repository)) return { ok: false, reason: 'not-found' };
  const auth = await api.auth();
  if (!auth.ok) return auth;
  const result = await api.get(`repos/${repository}`);
  if (!result.ok) return result;
  const info = result.value as { id?: unknown; permissions?: Record<string, unknown> };
  if (!Number.isSafeInteger(info?.id) || !info?.permissions?.pull) return { ok: false, reason: 'insufficient-role' };
  const permissions = info.permissions;
  const role = permissions.admin ? 'admin' : permissions.maintain ? 'maintain' : permissions.push ? 'write' : permissions.triage ? 'triage' : 'read';
  return { ok: true, repositoryId: info.id as number, role };
}
