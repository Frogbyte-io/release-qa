import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

export type AccessProblem = 'logged-out' | 'missing-scope' | 'insufficient-role' | 'organization-rejected' | 'not-found' | 'network-error';
export type ApiResult<T> = { ok: true; value: T } | { ok: false; reason: AccessProblem };
export interface GitHubApi {
  auth(): Promise<ApiResult<true>>;
  get(path: string): Promise<ApiResult<unknown>>;
}

/** The dispatch of `qa-reconcile.yml` got a 404: the workflow is missing, or the token cannot see it. */
export const WORKFLOW_NOT_FOUND = 'workflow-not-found';
export const REPOSITORY_LOOKUP_FAILED = 'repository-lookup-failed';

const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** GitHub CLI is the credential boundary. Arguments are arrays; stderr is classified, never shown to a renderer. */
export class GhTransport implements GitHubApi {
  private readonly executable: string;
  private readonly prefixArgs: readonly string[];

  constructor(executable = 'gh', prefixArgs: readonly string[] = []) {
    this.executable = executable;
    this.prefixArgs = prefixArgs;
  }

  private run(args: readonly string[], input?: string | Buffer): Promise<{ ok: true; output: string } | { ok: false; reason: AccessProblem }> {
    return new Promise((resolve) => {
      const child = execFile(this.executable, [...this.prefixArgs, ...args], { windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error !== null) return resolve({ ok: false, reason: classifyGhError(stderr) });
        resolve({ ok: true, output: stdout });
      });
      if (input !== undefined) {
        // A fast API rejection may close stdin before the body is consumed; the exit callback classifies it.
        child.stdin?.on('error', () => {});
        child.stdin?.end(input);
      }
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

  async currentUser(): Promise<ApiResult<string>> {
    const result = await this.get('user');
    const login = result.ok && typeof result.value === 'object' && result.value !== null ? (result.value as { login?: unknown }).login : undefined;
    return typeof login === 'string' ? { ok: true, value: login } : result.ok ? { ok: false, reason: 'logged-out' } : result;
  }

  /** Uploads one immutable release asset using the authenticated gh session. */
  async upload(repository: string, releaseId: number, name: string, content: Buffer): Promise<ApiResult<{ id: number; name: string; state: string }>> {
    try {
      if (!Number.isSafeInteger(releaseId) || releaseId <= 0 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(name)) return { ok: false, reason: 'not-found' };
      const token = await this.authToken();
      if (!token.ok) return token;
      const response = await fetch(`https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token.value}`, accept: 'application/vnd.github+json', 'content-type': 'application/octet-stream' },
        body: content,
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return { ok: false, reason: classifyGhError(`HTTP ${response.status} ${response.statusText}`) };
      const value = await response.json() as { id?: unknown; name?: unknown; state?: unknown };
      if (!Number.isSafeInteger(value.id) || value.name !== name || typeof value.state !== 'string') return { ok: false, reason: 'network-error' };
      return { ok: true, value: { id: value.id as number, name, state: value.state } };
    } catch { return { ok: false, reason: 'network-error' }; }
  }

  /** Reads the active gh token into process memory only; callers never receive or persist it. */
  private authToken(): Promise<ApiResult<string>> {
    return new Promise((resolve) => {
      execFile(this.executable, [...this.prefixArgs, 'auth', 'token', '--hostname', 'github.com'], { windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 }, (error, stdout, stderr) => {
        if (error !== null) return resolve({ ok: false, reason: classifyGhError(stderr) });
        const token = stdout.trim();
        resolve(token ? { ok: true, value: token } : { ok: false, reason: 'logged-out' });
      });
    });
  }

  /**
   * Asks for `qa-reconcile.yml` to run. `workflow-not-found` means only that the dispatch request itself got a 404, which GitHub
   * also answers when the token cannot see the workflow. A failure of the preliminary repository lookup keeps its own reason
   * (a lookup that 404s is `repository-lookup-failed`, never `workflow-not-found`), so a caller cannot mistake it for a missing workflow.
   */
  async dispatchReconciliation(repository: string, releaseId: number): Promise<{ ok: true; value: true } | { ok: false; reason: AccessProblem | typeof WORKFLOW_NOT_FOUND | typeof REPOSITORY_LOOKUP_FAILED }> {
    const repo = await this.get(`repos/${repository}`);
    if (!repo.ok) return { ok: false, reason: repo.reason === 'not-found' ? REPOSITORY_LOOKUP_FAILED : repo.reason };
    const branch = typeof repo.value === 'object' && repo.value !== null ? (repo.value as { default_branch?: unknown }).default_branch : undefined;
    if (typeof branch !== 'string' || !branch) return { ok: false, reason: REPOSITORY_LOOKUP_FAILED };
    const response = await this.run(['api', '--method', 'POST', `repos/${repository}/actions/workflows/qa-reconcile.yml/dispatches`, '--input', '-', '--silent'], JSON.stringify({ ref: branch, inputs: { release_id: String(releaseId) } }));
    if (response.ok) return { ok: true, value: true };
    return { ok: false, reason: response.reason === 'not-found' ? WORKFLOW_NOT_FOUND : response.reason };
  }


  private async write(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<ApiResult<unknown>> {
    try {
      const args = ['api', '--method', method];
      let input: string | undefined;
      if (method !== 'DELETE') {
        input = JSON.stringify(body);
        if (typeof input !== 'string') return { ok: false, reason: 'network-error' };
        args.push('--input', '-');
      }
      const response = await this.run([...args, path], input);
      if (!response.ok) return response;
      return { ok: true, value: response.output.trim() ? JSON.parse(response.output) as unknown : null };
    } catch {
      return { ok: false, reason: 'network-error' };
    }
  }

  post(path: string, body: unknown): Promise<ApiResult<unknown>> { return this.write('POST', path, body); }
  patch(path: string, body: unknown): Promise<ApiResult<unknown>> { return this.write('PATCH', path, body); }
  put(path: string, body: unknown): Promise<ApiResult<unknown>> { return this.write('PUT', path, body); }
  delete(path: string): Promise<ApiResult<unknown>> { return this.write('DELETE', path); }

  /** Streams an exact release asset to a new file without buffering installer bytes in memory. */
  download(path: string, destination: string): Promise<ApiResult<true>> {
    return new Promise((resolve) => {
      const child = spawn(this.executable, [...this.prefixArgs, 'api', '-H', 'Accept: application/octet-stream', path], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15 * 60_000,
      });
      const output = createWriteStream(destination, { flags: 'wx' });
      let stderr = '';
      let childClosed = false;
      let outputClosed = false;
      let written = false;
      let failure: AccessProblem | undefined;
      const finish = (): void => {
        // On Windows the caller cannot remove its temporary directory until both handles have closed.
        if (childClosed && outputClosed) resolve(failure === undefined && written ? { ok: true, value: true } : { ok: false, reason: failure ?? 'network-error' });
      };
      child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString('utf8').slice(0, 4096 - stderr.length); });
      child.stdout.pipe(output);
      child.on('error', () => { failure = 'network-error'; output.destroy(); });
      child.on('close', (code) => {
        childClosed = true;
        if (code !== 0) { failure ??= classifyGhError(stderr); output.destroy(); }
        finish();
      });
      output.on('finish', () => { written = true; });
      output.on('error', () => { failure = 'network-error'; child.kill(); });
      output.on('close', () => { outputClosed = true; finish(); });
    });
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
