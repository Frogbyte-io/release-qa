export interface ManagedSection {
  name: string;
  content: string;
  expected?: string;
}

export type UpdatedBody = { ok: true; body: string } | { ok: false; error: string };

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
