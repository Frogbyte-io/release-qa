export interface ManagedSection {
  name: string;
  content: string;
  expected?: string;
}

export type UpdatedBody = { ok: true; body: string } | { ok: false; error: string };

/** Adds empty managed blocks after an existing template, or fails on any partially present/ambiguous marker. */
export function ensureManagedSections(body: string, names: readonly string[]): UpdatedBody {
  if (new Set(names).size !== names.length || names.some((name) => !/^[a-z][a-z0-9-]*$/.test(name))) return { ok: false, error: 'invalid or repeated section name' };
  const newline = body.includes('\r\n') ? '\r\n' : '\n';
  let updated = body;
  for (const name of names) {
    const startMarker = `<!-- ${name}:start -->`;
    const endMarker = `<!-- ${name}:end -->`;
    const starts = updated.split(startMarker).length - 1;
    const ends = updated.split(endMarker).length - 1;
    if (starts === 0 && ends === 0) {
      const separator = updated.length === 0 ? '' : `${newline}${newline}`;
      updated += `${separator}${startMarker}${newline}${newline}${endMarker}`;
    } else if (starts !== 1 || ends !== 1 || updated.indexOf(startMarker) > updated.indexOf(endMarker)) {
      return { ok: false, error: `${name} section has missing, duplicate or reversed markers` };
    }
  }
  return { ok: true, body: updated };
}

/** Reads one complete managed block without interpreting or altering its human-authored content. */
export function readManagedSection(body: string, name: string): { ok: true; content: string } | { ok: false; error: string } {
  const startMarker = `<!-- ${name}:start -->`;
  const endMarker = `<!-- ${name}:end -->`;
  const start = body.indexOf(startMarker);
  const end = body.indexOf(endMarker);
  if (start < 0 || end < 0 || start > end || body.indexOf(startMarker, start + startMarker.length) >= 0 || body.indexOf(endMarker, end + endMarker.length) >= 0) {
    return { ok: false, error: `${name} section has missing, duplicate or reversed markers` };
  }
  const innerStart = start + startMarker.length;
  const newline = body.startsWith('\r\n', innerStart) ? '\r\n' : '\n';
  const inner = body.slice(innerStart, end);
  if (!inner.startsWith(newline) || !inner.endsWith(newline)) return { ok: false, error: `${name} section markers must be on separate lines` };
  return { ok: true, content: inner.slice(newline.length, -newline.length) };
}

export interface PullRequestBodyApi {
  get(path: string): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }>;
  patch(path: string, body: unknown): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }>;
}

export interface ReleaseNotesApi {
  get(path: string): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }>;
  list(path: string): Promise<{ ok: true; value: unknown[] } | { ok: false; reason: string }>;
}

export type ReleaseNotesProposal = { ok: true; tag: string; content: string; pullRequests: number[] } | { ok: false; error: string };

/** Suggests release notes from merged PRs newer than the latest published release; it never edits maintainer text. */
export async function proposeReleaseNotes(api: ReleaseNotesApi, repository: string): Promise<ReleaseNotesProposal> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return { ok: false, error: 'invalid repository name' };
  const release = await api.get(`repos/${repository}/releases/latest`);
  if (!release.ok) return { ok: false, error: `cannot read latest release: ${release.reason}` };
  const releaseRecord = objectOf(release.value);
  const tag = releaseRecord?.tag_name;
  const publishedAt = releaseRecord?.published_at;
  if (typeof tag !== 'string' || !tag || typeof publishedAt !== 'string' || Number.isNaN(Date.parse(publishedAt))) {
    return { ok: false, error: 'latest release has invalid tag or publication date' };
  }
  const pulls = await api.list(`repos/${repository}/pulls?state=closed&per_page=100&sort=updated&direction=desc`);
  if (!pulls.ok) return { ok: false, error: `cannot list merged pull requests: ${pulls.reason}` };
  const since = Date.parse(publishedAt);
  const entries = pulls.value.flatMap((value) => {
    const pull = objectOf(value);
    if (pull === undefined || !Number.isSafeInteger(pull.number) || typeof pull.title !== 'string' || typeof pull.merged_at !== 'string' || Number.isNaN(Date.parse(pull.merged_at)) || Date.parse(pull.merged_at) <= since) return [];
    const body = typeof pull.body === 'string' ? pull.body : '';
    const references = [...new Set([...body.matchAll(/(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+#(\d+)/gi)].map((match) => `#${match[1]}`))];
    const number = pull.number as number;
    return [{ number, line: `- ${pull.title.replace(/[\r\n]+/g, ' ')} (#${number}${references.length ? `; ${references.join(', ')}` : ''})`, mergedAt: pull.merged_at }];
  }).sort((a, b) => a.mergedAt.localeCompare(b.mergedAt) || a.number - b.number);
  return { ok: true, tag, content: entries.map((entry) => entry.line).join('\n'), pullRequests: entries.map((entry) => entry.number) };
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * Updates generated sections only if the PR body is unchanged between the initial read and the final pre-write read.
 * GitHub's REST update has no conditional-write token, so a human edit in the final GET/PATCH interval cannot be
 * excluded atomically; callers should serialize automated writers and treat detected changes as conflicts.
 */
export async function updatePullRequestBody(
  api: PullRequestBodyApi,
  repository: string,
  pullRequest: number,
  sections: readonly ManagedSection[],
): Promise<UpdatedBody> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !Number.isSafeInteger(pullRequest) || pullRequest <= 0) {
    return { ok: false, error: 'invalid repository or pull request number' };
  }
  const path = `repos/${repository}/pulls/${pullRequest}`;
  const first = await api.get(path);
  if (!first.ok) return { ok: false, error: `cannot read pull request: ${first.reason}` };
  const firstBody = bodyOf(first.value);
  if (firstBody === undefined) return { ok: false, error: 'pull request response has no readable body' };
  const initialized = ensureManagedSections(firstBody, sections.map((section) => section.name));
  if (!initialized.ok) return initialized;
  const updated = updateManagedSections(initialized.body, sections);
  if (!updated.ok || updated.body === firstBody) return updated;

  const latest = await api.get(path);
  if (!latest.ok) return { ok: false, error: `cannot re-read pull request before update: ${latest.reason}` };
  if (bodyOf(latest.value) !== firstBody) return { ok: false, error: 'PR body changed while the managed update was being prepared' };
  const saved = await api.patch(path, { body: updated.body });
  if (!saved.ok) return { ok: false, error: `cannot update pull request body: ${saved.reason}` };
  return updated;
}

function bodyOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const body = (value as { body?: unknown }).body;
  return body === null ? '' : typeof body === 'string' ? body : undefined;
}

/** Replaces only complete, unique HTML-comment sections; callers must refetch the PR body before writing it. */
export function updateManagedSections(body: string, sections: readonly ManagedSection[]): UpdatedBody {
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  const names = new Set<string>();
  for (const section of sections) {
    const { name } = section;
    if (!/^[a-z][a-z0-9-]*$/.test(name) || names.has(name)) return { ok: false, error: `invalid or repeated section name: ${name}` };
    names.add(name);
  }
  const markers = [...names].flatMap((name) => [`<!-- ${name}:start -->`, `<!-- ${name}:end -->`]);
  for (const section of sections) {
    const { name } = section;
    const begin = `<!-- ${name}:start -->`;
    const finish = `<!-- ${name}:end -->`;
    const start = body.indexOf(begin);
    const end = body.indexOf(finish);
    if (start < 0 || end < 0 || start > end || body.indexOf(begin, start + begin.length) >= 0 || body.indexOf(finish, end + finish.length) >= 0) {
      return { ok: false, error: `${name} section has missing, duplicate or reversed markers` };
    }
    const innerStart = start + begin.length;
    const newline = body.startsWith('\r\n', innerStart) ? '\r\n' : '\n';
    const inner = body.slice(innerStart, end);
    if (!inner.startsWith(newline) || !inner.endsWith(newline)) return { ok: false, error: `${name} section markers must be on separate lines` };
    const current = inner.slice(newline.length, -newline.length);
    if (section.expected !== undefined && current !== section.expected) return { ok: false, error: `${name} section changed since it was read` };
    if (markers.some((marker) => section.content.includes(marker))) return { ok: false, error: `${name} section content contains a managed marker` };
    edits.push({ start: innerStart, end, replacement: `${newline}${section.content.replace(/\r?\n/g, newline)}${newline}` });
  }
  const ordered = [...edits].sort((a, b) => a.start - b.start);
  if (ordered.some((edit, index) => index > 0 && edit.start < ordered[index - 1]!.end)) {
    return { ok: false, error: 'managed sections overlap' };
  }
  let updated = body;
  for (const edit of ordered.reverse()) updated = updated.slice(0, edit.start) + edit.replacement + updated.slice(edit.end);
  return { ok: true, body: updated };
}
