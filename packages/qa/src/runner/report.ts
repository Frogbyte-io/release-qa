import type { Attempt, Report } from '../model/result.ts';
import { Collector } from '../model/validate.ts';

export interface RenderOptions {
  /** Literal secrets to remove from both outputs before anything is rendered. Empty entries are ignored. */
  redact?: readonly string[];
  /** Most evidence links shown per attempt in the HTML. The JSON keeps every path. */
  maxEvidencePerAttempt?: number;
}

export interface RenderedReport {
  json: string;
  html: string;
}

/** Tried in order; the first that contains none of the configured secrets is used. */
const MARKERS = ['[redacted]', '[REDACTED]', '[removed]', '###', '█', '…'];
const KNOWN_OUTCOMES = new Set(['passed', 'failed', 'blocked', 'cancelled', 'interrupted']);

/**
 * Renders a report as JSON plus a self-contained HTML page. Redaction happens first, on the raw text, so a secret
 * cannot survive by being split up or escaped differently; every string is HTML-escaped when it is written out.
 * The output is a pure function of the input: no dates, no randomness.
 */
export function renderReport(report: Report, options: RenderOptions = {}): RenderedReport {
  const redacted = mapStrings(report, redactor(options.redact ?? []));
  return { json: `${JSON.stringify(redacted, null, 2)}\n`, html: renderHtml(redacted, report, options) };
}

/** More passes than any real input needs; hitting it means the secrets and the marker keep re-creating each other. */
const MAX_REDACTION_PASSES = 50;

/**
 * Replaces secrets longest first, in whole passes, and repeats until no secret is left: a replacement can
 * join with its neighbours into another configured secret, and a single pass would leave that one behind. The
 * marker is chosen so that it cannot itself contain a secret, so repeating never garbles it. If no marker
 * qualifies, or the passes do not converge, it refuses rather than leak.
 */
function redactor(redact: readonly string[]): (text: string) => string {
  const secrets = redact.filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  if (secrets.length === 0) return (text) => text;
  const marker = MARKERS.find((m) => !secrets.some((secret) => m.includes(secret)));
  if (marker === undefined) throw new RangeError('every redaction marker would contain a configured secret');
  const pattern = new RegExp(secrets.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return (text) => {
    let current = text;
    for (let pass = 0; pass < MAX_REDACTION_PASSES; pass++) {
      const next = current.replace(pattern, () => marker);
      if (next === current) return current;
      current = next;
    }
    throw new RangeError('redaction did not converge; the secrets and the marker keep re-creating each other');
  };
}

/** A deep copy with `fn` applied to every string value. Keys and non-strings are left alone. */
function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === 'string') return fn(value) as T;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)])) as T;
  }
  return value;
}

const escape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** `report` is the redacted report that is shown; `original` is the same report before redaction. */
function renderHtml(report: Report, original: Report, options: RenderOptions): string {
  const environment = report.environment;
  const facts: Array<[string, string]> = [
    ['Report', report.id],
    ['Candidate', report.candidateId],
    ['Profile', report.profile],
    ['Reported by (claimed)', report.actor],
    ['Machine', report.machineId],
    ['Operating system', `${environment.os} ${environment.osVersion} (${environment.arch})`],
    ['Capabilities', environment.capabilities.join(', ')],
    ['Tool version', environment.toolVersion],
    ['Policy digest', report.policyDigest],
    ['Test revision', report.testRevision],
  ];
  const limit = evidenceLimit(options.maxEvidencePerAttempt);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Release QA report ${escape(report.id)}</title>
<style>
body { font: 14px/1.4 system-ui, sans-serif; margin: 2rem; color: #1b1b1b; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; }
dt { font-weight: 600; }
table { border-collapse: collapse; width: 100%; margin-top: 1.5rem; }
th, td { border: 1px solid #c8c8c8; padding: 0.35rem 0.6rem; text-align: left; vertical-align: top; }
.outcome-passed { color: #0b6b2f; }
.outcome-failed, .outcome-blocked, .outcome-cancelled, .outcome-interrupted, .outcome-unknown { color: #a11d1d; font-weight: 600; }
.unsafe { color: #6a6a6a; }
</style>
</head>
<body>
<h1>Release QA report</h1>
<dl>
${facts.map(([name, value]) => `<dt>${escape(name)}</dt><dd>${escape(value)}</dd>`).join('\n')}
</dl>
<table>
<thead><tr><th>Requirement</th><th>Outcome</th><th>Attempt</th><th>Retry of</th><th>Evidence</th></tr></thead>
<tbody>
${report.attempts.map((attempt, i) => renderAttempt(attempt, original.attempts[i], limit)).join('\n')}
</tbody>
</table>
</body>
</html>
`;
}

function renderAttempt(attempt: Attempt, original: Attempt | undefined, limit: number): string {
  const outcomeClass = KNOWN_OUTCOMES.has(attempt.outcome) ? attempt.outcome : 'unknown';
  // A path that redaction rewrote no longer names a real file, so it must not become a link.
  const shown = attempt.evidence.slice(0, limit).map((path, i) => renderEvidence(path, original?.evidence[i] !== path));
  const hidden = attempt.evidence.length - shown.length;
  if (hidden > 0) shown.push(`<span>${hidden} more not shown</span>`);
  return `<tr><td>${escape(attempt.requirement)}</td><td class="outcome-${outcomeClass}">${escape(attempt.outcome)}</td><td>${escape(attempt.id)}</td><td>${escape(attempt.retryOf ?? '')}</td><td>${shown.join('<br>')}</td></tr>`;
}

/** A relative link when the path is safe; otherwise the text alone, so a hostile path can never become a URL. */
function renderEvidence(path: string, rewrittenByRedaction: boolean): string {
  const href = rewrittenByRedaction || new Collector().relativePath(path, '') === undefined ? undefined : encodeHref(path);
  return href === undefined ? `<span class="unsafe">${escape(path)} (not linked)</span>` : `<a href="${escape(href)}">${escape(path)}</a>`;
}

/** Percent-encodes each segment. Text with a lone surrogate cannot be encoded, and then it is not linked. */
function encodeHref(path: string): string | undefined {
  try {
    return path.split('/').map(encodeURIComponent).join('/');
  } catch {
    return undefined;
  }
}

function evidenceLimit(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value) ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(value));
}
