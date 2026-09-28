import { createHash } from 'node:crypto';
import { canonical } from '../model/canonical.ts';
import { parseReport, type Report } from '../model/result.ts';
import { parseRunEvent, type RunEvent } from '../runner/events.ts';

export interface SyncedObjectRef {
  name: string;
  sha256: string;
  path?: string;
}

/** Uploaded last; its presence means every referenced event and evidence object was uploaded first. */
export interface SyncedReportManifest {
  schemaVersion: 1;
  kind: 'release-qa-report';
  report: Report;
  events: SyncedObjectRef[];
  evidence: SyncedObjectRef[];
}

export interface SyncedEventRecord {
  schemaVersion: 1;
  kind: 'release-qa-event';
  event: RunEvent;
}

export interface SyncedEvidenceRecord {
  schemaVersion: 1;
  kind: 'release-qa-evidence';
  reportId: string;
  path: string;
  sha256: string;
  contentBase64: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export const objectSha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

export function parseSyncedReportManifest(input: unknown): Parsed<SyncedReportManifest> {
  const value = record(input);
  if (value?.schemaVersion !== 1 || value.kind !== 'release-qa-report' || !Array.isArray(value.events) || !Array.isArray(value.evidence)) {
    return { ok: false, error: 'invalid report manifest envelope' };
  }
  const parsedReport = parseReport(value.report);
  if (!parsedReport.ok) return { ok: false, error: `invalid report: ${parsedReport.error.message}` };
  const events = parseRefs(value.events);
  const evidence = parseRefs(value.evidence);
  if (!events.ok) return { ok: false, error: events.error };
  if (!evidence.ok) return { ok: false, error: evidence.error };
  const referencedEvidence = new Set(parsedReport.value.attempts.flatMap((attempt) => attempt.evidence));
  if (referencedEvidence.size !== evidence.value.length || evidence.value.some((item) => !referencedEvidence.has(item.path ?? ''))) {
    return { ok: false, error: 'manifest evidence does not exactly match the report references' };
  }
  return { ok: true, value: { schemaVersion: 1, kind: 'release-qa-report', report: parsedReport.value, events: events.value, evidence: evidence.value } };
}

export function parseSyncedEventRecord(input: unknown): Parsed<SyncedEventRecord> {
  const value = record(input);
  if (value?.schemaVersion !== 1 || value.kind !== 'release-qa-event') return { ok: false, error: 'invalid event envelope' };
  const event = parseRunEvent(value.event);
  return event.ok ? { ok: true, value: { schemaVersion: 1, kind: 'release-qa-event', event: event.value } } : { ok: false, error: event.error.message };
}

export function parseSyncedEvidenceRecord(input: unknown): Parsed<SyncedEvidenceRecord> {
  const value = record(input);
  if (value?.schemaVersion !== 1 || value.kind !== 'release-qa-evidence' || typeof value.reportId !== 'string' || typeof value.path !== 'string' || typeof value.sha256 !== 'string' || typeof value.contentBase64 !== 'string') {
    return { ok: false, error: 'invalid evidence envelope' };
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.contentBase64) || Buffer.from(value.contentBase64, 'base64').toString('base64') !== value.contentBase64) return { ok: false, error: 'invalid evidence encoding' };
  if (!/^[0-9a-f]{64}$/.test(value.sha256) || objectSha256(Buffer.from(value.contentBase64, 'base64')) !== value.sha256) {
    return { ok: false, error: 'evidence digest mismatch' };
  }
  return { ok: true, value: value as unknown as SyncedEvidenceRecord };
}

export function canonicalJson(value: unknown): string { return canonical(value); }

function parseRefs(values: unknown[]): Parsed<SyncedObjectRef[]> {
  const refs: SyncedObjectRef[] = [];
  const names = new Set<string>();
  for (const value of values) {
    const ref = record(value);
    if (typeof ref?.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,180}$/.test(ref.name) || ref.name.includes('..') || typeof ref.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(ref.sha256) || (ref.path !== undefined && typeof ref.path !== 'string')) return { ok: false, error: 'invalid object reference' };
    if (names.has(ref.name)) return { ok: false, error: 'duplicate object reference' };
    names.add(ref.name);
    refs.push({ name: ref.name, sha256: ref.sha256, ...(typeof ref.path === 'string' ? { path: ref.path } : {}) });
  }
  return { ok: true, value: refs };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
