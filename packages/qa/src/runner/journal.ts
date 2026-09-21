import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Attempt } from '../model/result.ts';
import { compare } from '../model/canonical.ts';
import { eventDigest, parseRunEvent, type RunEvent } from './events.ts';

const LOG_FILE = 'events.jsonl';
const SUMMARY_FILE = 'summary.json';

export type JournalErrorCode = 'id-conflict' | 'invalid-event';

export class JournalError extends Error {
  readonly code: JournalErrorCode;
  constructor(code: JournalErrorCode, message: string) {
    super(message);
    this.name = 'JournalError';
    this.code = code;
  }
}

export type AppendResult = { ok: true; status: 'appended' | 'duplicate' } | { ok: false; error: JournalError };

export interface RunState {
  /** False when the run's log does not exist yet. */
  exists: boolean;
  /** Valid, de-duplicated events in causal order. */
  events: RunEvent[];
  /** Local results accepted so far, in causal order. */
  attempts: Attempt[];
  /** An unterminated final record: a write that was interrupted. It is reported, never repaired into an event. */
  truncated: { line: number; bytes: number } | null;
  /** Complete lines that are not valid events. */
  corrupt: Array<{ line: number; reason: string }>;
  /** Event ids that appear with two different contents. The first copy is kept. */
  conflicts: string[];
  /** Events whose predecessor has not arrived (out-of-order delivery). Kept, and placed after the ordered ones. */
  missingPredecessors: Array<{ eventId: string; prev: string }>;
  /** Events caught in a predecessor cycle. */
  cyclic: string[];
  /** Events with no verified acknowledgement yet, in causal order. */
  pending: string[];
  /** Events whose acknowledgement matched their digest. */
  synced: string[];
  /** Events the server acknowledged with a different digest than the local one. They stay pending. */
  ackMismatches: string[];
  /** Acknowledgements for event ids this journal does not contain. */
  orphanAcks: string[];
  /** Evidence files referenced by accepted attempts that are not on disk. */
  missingEvidence: Array<{ eventId: string; path: string }>;
}

/**
 * Appends one event and returns only after it has been flushed to disk. One process writes a run's log at a
 * time; that is the runner's contract, and the log is not locked.
 *
 * The same id with the same content is a no-op (a replay). The same id with different content is refused and
 * the original is left untouched.
 */
export async function appendEvent(runDir: string, event: RunEvent): Promise<AppendResult> {
  const parsed = parseRunEvent(event);
  if (!parsed.ok) return { ok: false, error: new JournalError('invalid-event', parsed.error.message) };
  const valid = parsed.value;

  await mkdir(runDir, { recursive: true });
  const path = join(runDir, LOG_FILE);
  const existing = await readText(path);

  const known = scan(existing ?? '').events.find((e) => e.id === valid.id);
  if (known !== undefined) {
    return eventDigest(known) === eventDigest(valid)
      ? { ok: true, status: 'duplicate' }
      : { ok: false, error: new JournalError('id-conflict', `event "${valid.id}" already exists with different content`) };
  }

  // A crash can leave a final record without its newline. Terminate it first so the new event starts on its
  // own line; the partial record then shows up as a corrupt line instead of swallowing the new event.
  const needsNewline = existing !== undefined && existing.length > 0 && !existing.endsWith('\n');
  const handle = await open(path, 'a');
  try {
    await handle.write(`${needsNewline ? '\n' : ''}${JSON.stringify(valid)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (existing === undefined) await syncDirectory(runDir);
  return { ok: true, status: 'appended' };
}

/**
 * Reads a run back from disk. It never throws on the content of the log: every line is classified, and
 * nothing that was not completely written is turned into an event or a checkpoint.
 */
export async function readRun(runDir: string): Promise<RunState> {
  const text = await readText(join(runDir, LOG_FILE));
  const scanned = scan(text ?? '');
  const { ordered, missingPredecessors, cyclic } = orderCausally(scanned.events);
  const sync = trackSync(ordered);

  return {
    exists: text !== undefined,
    events: ordered,
    attempts: ordered.flatMap((e) => (e.type === 'attempt-recorded' ? [e.data.attempt] : [])),
    truncated: scanned.truncated,
    corrupt: scanned.corrupt,
    conflicts: scanned.conflicts,
    missingPredecessors,
    cyclic,
    ...sync,
    missingEvidence: await findMissingEvidence(runDir, ordered),
  };
}

interface Scan {
  events: RunEvent[];
  truncated: RunState['truncated'];
  corrupt: RunState['corrupt'];
  conflicts: string[];
}

/** Splits a log into lines and classifies each one. Events keep file order; the first copy of an id wins. */
function scan(text: string): Scan {
  const events: RunEvent[] = [];
  const digests = new Map<string, string>();
  const corrupt: Scan['corrupt'] = [];
  const conflicts = new Set<string>();
  let truncated: Scan['truncated'] = null;

  const lines = text.split('\n');
  const unterminated = text.length > 0 && !text.endsWith('\n');
  lines.forEach((raw, index) => {
    const line = index + 1;
    const isLastUnterminated = unterminated && index === lines.length - 1;
    if (raw.trim() === '') return;

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      if (isLastUnterminated) truncated = { line, bytes: Buffer.byteLength(raw) };
      else corrupt.push({ line, reason: 'not valid JSON' });
      return;
    }
    const parsed = parseRunEvent(json);
    if (!parsed.ok) {
      corrupt.push({ line, reason: parsed.error.issues.map((i) => `${i.path || '<root>'}: ${i.code}`).join('; ') });
      return;
    }
    const digest = eventDigest(parsed.value);
    const seen = digests.get(parsed.value.id);
    if (seen === undefined) {
      digests.set(parsed.value.id, digest);
      events.push(parsed.value);
    } else if (seen !== digest) {
      conflicts.add(parsed.value.id);
    }
  });
  return { events, truncated, corrupt, conflicts: [...conflicts].sort(compare) };
}

/** Orders events by their predecessor links. Events that cannot be placed keep file order at the end. */
function orderCausally(events: readonly RunEvent[]): { ordered: RunEvent[]; missingPredecessors: RunState['missingPredecessors']; cyclic: string[] } {
  const known = new Set(events.map((e) => e.id));
  const placed = new Set<string>();
  const ordered: RunEvent[] = [];
  let remaining = [...events];

  for (let progress = true; progress; ) {
    progress = false;
    const stillWaiting: RunEvent[] = [];
    for (const event of remaining) {
      if (event.prev === undefined || placed.has(event.prev)) {
        ordered.push(event);
        placed.add(event.id);
        progress = true;
      } else {
        stillWaiting.push(event);
      }
    }
    remaining = stillWaiting;
  }

  const byId = new Map(remaining.map((e) => [e.id, e]));
  const inCycle = (start: RunEvent): boolean => {
    let current: RunEvent | undefined = start;
    for (let steps = 0; steps <= remaining.length && current?.prev !== undefined; steps++) {
      current = byId.get(current.prev);
      if (current?.id === start.id) return true;
    }
    return false;
  };
  return {
    ordered: [...ordered, ...remaining],
    missingPredecessors: remaining.flatMap((e) => (e.prev !== undefined && !known.has(e.prev) ? [{ eventId: e.id, prev: e.prev }] : [])),
    cyclic: remaining.filter(inCycle).map((e) => e.id),
  };
}

/**
 * Sync state is derived from the log, kept apart from test outcomes. An event is synced only when an
 * acknowledgement carries the digest of exactly what is stored locally; anything else leaves it pending.
 */
function trackSync(events: readonly RunEvent[]): Pick<RunState, 'pending' | 'synced' | 'ackMismatches' | 'orphanAcks'> {
  const acks = events.flatMap((e) => (e.type === 'upload-acknowledged' ? [e.data] : []));
  const ids = new Set(events.map((e) => e.id));
  const pending: string[] = [];
  const synced: string[] = [];
  const ackMismatches: string[] = [];

  for (const event of events) {
    if (event.type === 'upload-acknowledged') continue;
    const forThis = acks.filter((a) => a.eventId === event.id);
    if (forThis.some((a) => a.digest === eventDigest(event))) {
      synced.push(event.id);
    } else {
      pending.push(event.id);
      if (forThis.length > 0) ackMismatches.push(event.id);
    }
  }
  const orphanAcks = [...new Set(acks.filter((a) => !ids.has(a.eventId)).map((a) => a.eventId))].sort(compare);
  return { pending, synced, ackMismatches, orphanAcks };
}

async function findMissingEvidence(runDir: string, events: readonly RunEvent[]): Promise<RunState['missingEvidence']> {
  const root = resolve(runDir);
  const missing: RunState['missingEvidence'] = [];
  for (const event of events) {
    if (event.type !== 'attempt-recorded') continue;
    for (const path of event.data.attempt.evidence) {
      const file = resolve(root, path);
      const inside = file.startsWith(root + sep);
      const present = inside && (await stat(file).then((s) => s.isFile(), () => false));
      if (!present) missing.push({ eventId: event.id, path });
    }
  }
  return missing;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Makes a new file's directory entry durable. Not every platform can open a directory; that is not an error. */
async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    /* Windows cannot open a directory for sync; the file's own flush already happened. */
  }
}

export interface FileOps {
  open: typeof open;
  rename: typeof rename;
  unlink: typeof unlink;
}

/** Replaces `path` with `data` so a reader sees the old content or the new content, never a mixture. */
export async function writeFileAtomic(path: string, data: string, ops: FileOps = { open, rename, unlink }): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await ops.open(temporary, 'w');
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await ops.rename(temporary, path);
  } catch (error) {
    await ops.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Writes a materialized view of the run next to its log. The log stays the source of truth; nothing reads this back. */
export async function writeSummary(runDir: string, state: RunState): Promise<void> {
  const summary = {
    schemaVersion: 1,
    events: state.events.length,
    attempts: state.attempts.map((a) => ({ id: a.id, requirement: a.requirement, outcome: a.outcome })),
    pending: state.pending,
    synced: state.synced,
    ackMismatches: state.ackMismatches,
    orphanAcks: state.orphanAcks,
    missingEvidence: state.missingEvidence,
    corrupt: state.corrupt.length,
    truncated: state.truncated !== null,
    conflicts: state.conflicts,
    missingPredecessors: state.missingPredecessors,
    cyclic: state.cyclic,
  };
  await mkdir(runDir, { recursive: true });
  await writeFileAtomic(join(runDir, SUMMARY_FILE), `${JSON.stringify(summary, null, 2)}\n`);
}
