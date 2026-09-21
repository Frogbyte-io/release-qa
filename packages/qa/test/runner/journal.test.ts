import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile, open, rename, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { eventDigest, type RunEvent } from '../../src/runner/events.ts';
import { appendEvent, readRun, writeFileAtomic, writeSummary, type AppendResult } from '../../src/runner/journal.ts';
import { acknowledged, attemptRecorded, checkpoint, runStarted } from '../fixtures/events.ts';

let runDir: string;
beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), 'qa-journal-'));
});
afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});

const logPath = () => join(runDir, 'events.jsonl');
const ids = (events: readonly RunEvent[]) => events.map((e) => e.id);
async function appendAll(...events: RunEvent[]): Promise<void> {
  for (const event of events) {
    const result = await appendEvent(runDir, event);
    expect(result.ok, `appending ${event.id}`).toBe(true);
  }
}
const rejection = (result: AppendResult) => (result.ok ? undefined : result.error.code);

describe('appending and reading', () => {
  test('a run that has not started reads as empty', async () => {
    const state = await readRun(join(runDir, 'does-not-exist'));
    expect(state.exists).toBe(false);
    expect(state.events).toEqual([]);
  });

  test('appendEvent creates the run directory and the event is on disk when it returns', async () => {
    const nested = join(runDir, 'runs', 'run-0001');
    expect(await appendEvent(nested, runStarted())).toEqual({ ok: true, status: 'appended' });
    const text = await readFile(join(nested, 'events.jsonl'), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(text)).toEqual(runStarted());
  });

  test('events read back in the order they were recorded, with accepted attempts extracted', async () => {
    await appendAll(runStarted('ev-1'), checkpoint('ev-2', 'installed', 'ev-1'), attemptRecorded('ev-3', { outcome: 'failed' }, 'ev-2'));
    const state = await readRun(runDir);
    expect(state.exists).toBe(true);
    expect(ids(state.events)).toEqual(['ev-1', 'ev-2', 'ev-3']);
    expect(state.attempts.map((a) => [a.id, a.outcome])).toEqual([['attempt-of-ev-3', 'failed']]);
  });

  test('rejects an invalid event without writing anything', async () => {
    const result = await appendEvent(runDir, { ...runStarted(), id: '../x' });
    expect(rejection(result)).toBe('invalid-event');
    expect(await readdir(runDir)).toEqual([]);
    // A rejected event leaves the journal usable and empty.
    await appendAll(runStarted('ev-1'));
    expect(ids((await readRun(runDir)).events)).toEqual(['ev-1']);
  });
});

describe('replay and reused ids', () => {
  test('appending the same event again is a no-op', async () => {
    await appendAll(runStarted('ev-1'));
    expect(await appendEvent(runDir, runStarted('ev-1'))).toEqual({ ok: true, status: 'duplicate' });
    expect((await readFile(logPath(), 'utf8')).trim().split('\n')).toHaveLength(1);
    expect(ids((await readRun(runDir)).events)).toEqual(['ev-1']);
  });

  test('an id reused with different content is an error and the original is preserved', async () => {
    await appendAll(attemptRecorded('ev-1', { outcome: 'failed' }));
    const before = await readFile(logPath(), 'utf8');
    const result = await appendEvent(runDir, attemptRecorded('ev-1', { outcome: 'passed' }));
    expect(rejection(result)).toBe('id-conflict');
    expect(await readFile(logPath(), 'utf8')).toBe(before);
    expect((await readRun(runDir)).attempts.map((a) => a.outcome)).toEqual(['failed']);
  });

  test('replayed lines already in the log are read once', async () => {
    const line = `${JSON.stringify(runStarted('ev-1'))}\n`;
    await writeFile(logPath(), line + line);
    const state = await readRun(runDir);
    expect(ids(state.events)).toEqual(['ev-1']);
    expect(state.conflicts).toEqual([]);
  });

  test('two different contents for one id already in the log are reported and the first copy is kept', async () => {
    const failed = JSON.stringify(attemptRecorded('ev-1', { outcome: 'failed' }));
    const passed = JSON.stringify(attemptRecorded('ev-1', { outcome: 'passed' }));
    await writeFile(logPath(), `${failed}\n${passed}\n`);
    const state = await readRun(runDir);
    expect(state.conflicts).toEqual(['ev-1']);
    expect(state.attempts.map((a) => a.outcome)).toEqual(['failed']);
  });
});

describe('interrupted writes', () => {
  test('a record cut off mid-write is reported as truncated and never becomes an event', async () => {
    await appendAll(runStarted('ev-1'), checkpoint('ev-2', 'installed', 'ev-1'));
    const whole = JSON.stringify(checkpoint('ev-3', 'mapping-saved', 'ev-2'));
    const partial = whole.slice(0, Math.floor(whole.length / 2));
    await appendFile(logPath(), partial);

    const state = await readRun(runDir);
    expect(ids(state.events)).toEqual(['ev-1', 'ev-2']);
    expect(state.truncated).toEqual({ line: 3, bytes: Buffer.byteLength(partial) });
    expect(state.events.some((e) => e.type === 'checkpoint' && e.data.name === 'mapping-saved')).toBe(false);
  });

  test('appending after an interrupted write does not glue the new event onto the partial one', async () => {
    await appendAll(runStarted('ev-1'));
    await appendFile(logPath(), '{"schemaVersion":1,"id":"ev-2","type":"chec');
    await appendAll(checkpoint('ev-3', 'installed', 'ev-1'));

    const state = await readRun(runDir);
    expect(ids(state.events)).toEqual(['ev-1', 'ev-3']);
    expect(state.corrupt).toHaveLength(1);
    expect(state.corrupt[0]?.line).toBe(2);
    expect(state.truncated).toBeNull();
  });

  test('a corrupt line in the middle is reported and the events after it are still read', async () => {
    await writeFile(logPath(), `${JSON.stringify(runStarted('ev-1'))}\nthis is not json\n${JSON.stringify(checkpoint('ev-3'))}\n`);
    const state = await readRun(runDir);
    expect(ids(state.events)).toEqual(['ev-1', 'ev-3']);
    expect(state.corrupt).toEqual([{ line: 2, reason: expect.any(String) }]);
  });

  test('a line that is JSON but not a valid event is reported with its reason', async () => {
    await writeFile(logPath(), `${JSON.stringify({ schemaVersion: 1, id: 'ev-1', type: 'run-finished', recordedAt: '2026-09-20T12:00:00Z', data: {} })}\n`);
    const state = await readRun(runDir);
    expect(state.events).toEqual([]);
    expect(state.corrupt[0]?.line).toBe(1);
    expect(state.corrupt[0]?.reason).toContain('type');
  });

  test('an evidence path that escapes the run directory makes the event invalid, so it is never read from disk', async () => {
    await writeFile(logPath(), `${JSON.stringify(attemptRecorded('ev-1', { evidence: ['../../secret.txt'] }))}\n`);
    const state = await readRun(runDir);
    expect(state.events).toEqual([]);
    expect(state.missingEvidence).toEqual([]);
    expect(state.corrupt).toHaveLength(1);
  });

  test('a log written with Windows line endings reads the same', async () => {
    const lines = [runStarted('ev-1'), checkpoint('ev-2', 'installed', 'ev-1')].map((e) => JSON.stringify(e));
    await writeFile(logPath(), `${lines.join('\r\n')}\r\n`);
    expect(ids((await readRun(runDir)).events)).toEqual(['ev-1', 'ev-2']);
  });
});

describe('out-of-order delivery', () => {
  test('an event that arrives before its predecessor is kept and flagged, then ordered once the predecessor arrives', async () => {
    const first = runStarted('ev-1');
    const second = checkpoint('ev-2', 'installed', 'ev-1');
    const third = checkpoint('ev-3', 'mapping-saved', 'ev-2');
    await appendAll(third, second);

    let state = await readRun(runDir);
    expect(state.missingPredecessors).toEqual([{ eventId: 'ev-2', prev: 'ev-1' }]);
    expect(ids(state.events)).toContain('ev-3');

    await appendAll(first);
    state = await readRun(runDir);
    expect(state.missingPredecessors).toEqual([]);
    expect(ids(state.events)).toEqual(['ev-1', 'ev-2', 'ev-3']);
  });

  test('a predecessor cycle terminates and is reported', async () => {
    const a = JSON.stringify(checkpoint('ev-a', 'x', 'ev-b'));
    const b = JSON.stringify(checkpoint('ev-b', 'y', 'ev-a'));
    await writeFile(logPath(), `${a}\n${b}\n${JSON.stringify(runStarted('ev-1'))}\n`);
    const state = await readRun(runDir);
    expect(state.cyclic.sort()).toEqual(['ev-a', 'ev-b']);
    expect(ids(state.events)).toEqual(['ev-1', 'ev-a', 'ev-b']);
  });
});

describe('pending and synced uploads', () => {
  test('every recorded event is pending until the server acknowledges it', async () => {
    await appendAll(runStarted('ev-1'), attemptRecorded('ev-2', { outcome: 'failed' }, 'ev-1'));
    const state = await readRun(runDir);
    expect(state.pending).toEqual(['ev-1', 'ev-2']);
    expect(state.synced).toEqual([]);
  });

  test('a verified acknowledgement makes an event synced and does not touch its outcome', async () => {
    const failed = attemptRecorded('ev-2', { outcome: 'failed' }, 'ev-1');
    await appendAll(runStarted('ev-1'), failed, acknowledged('ack-1', failed));
    const state = await readRun(runDir);
    expect(state.synced).toEqual(['ev-2']);
    expect(state.pending).toEqual(['ev-1']);
    expect(state.attempts.map((a) => a.outcome)).toEqual(['failed']);
  });

  test('an acknowledgement with a different digest does not clear the event', async () => {
    const attempt = attemptRecorded('ev-1');
    await appendAll(attempt, acknowledged('ack-1', attempt, 'f'.repeat(64)));
    const state = await readRun(runDir);
    expect(state.pending).toEqual(['ev-1']);
    expect(state.synced).toEqual([]);
    expect(state.ackMismatches).toEqual(['ev-1']);
  });

  test('an acknowledgement for an event this journal does not have is reported, not trusted', async () => {
    await appendAll(acknowledged('ack-1', attemptRecorded('ev-unknown')));
    const state = await readRun(runDir);
    expect(state.orphanAcks).toEqual(['ev-unknown']);
  });

  test('the same state is recovered after a restart with no network', async () => {
    const attempt = attemptRecorded('ev-2', { outcome: 'passed' }, 'ev-1');
    await appendAll(runStarted('ev-1'), attempt);
    const beforeRestart = await readRun(runDir);
    // A new process reads only the disk.
    const afterRestart = await readRun(runDir);
    expect(afterRestart).toEqual(beforeRestart);
    expect(afterRestart.pending).toEqual(['ev-1', 'ev-2']);

    await appendAll(acknowledged('ack-1', attempt));
    expect((await readRun(runDir)).pending).toEqual(['ev-1']);
  });

  test('an acknowledgement is itself just an event: it is never lost when read back', async () => {
    const attempt = attemptRecorded('ev-1');
    await appendAll(attempt, acknowledged('ack-1', attempt));
    expect(ids((await readRun(runDir)).events)).toEqual(['ev-1', 'ack-1']);
  });
});

describe('evidence', () => {
  test('an attempt whose evidence file is not on disk is flagged until the file exists', async () => {
    await appendAll(attemptRecorded('ev-1', { evidence: ['evidence/persistence.png', 'evidence/log.txt'] }));
    await mkdir(join(runDir, 'evidence'), { recursive: true });
    await writeFile(join(runDir, 'evidence', 'log.txt'), 'ok');

    let state = await readRun(runDir);
    expect(state.missingEvidence).toEqual([{ eventId: 'ev-1', path: 'evidence/persistence.png' }]);

    await writeFile(join(runDir, 'evidence', 'persistence.png'), 'png');
    state = await readRun(runDir);
    expect(state.missingEvidence).toEqual([]);
  });

  test('a directory does not count as an evidence file', async () => {
    await appendAll(attemptRecorded('ev-1', { evidence: ['evidence/a.png'] }));
    await mkdir(join(runDir, 'evidence', 'a.png'), { recursive: true });
    expect((await readRun(runDir)).missingEvidence).toEqual([{ eventId: 'ev-1', path: 'evidence/a.png' }]);
  });
});

describe('summaries and atomic replacement', () => {
  test('writeSummary materializes the state as JSON next to the log', async () => {
    const attempt = attemptRecorded('ev-2', { outcome: 'failed' }, 'ev-1');
    await appendAll(runStarted('ev-1'), attempt);
    await writeSummary(runDir, await readRun(runDir));
    const summary = JSON.parse(await readFile(join(runDir, 'summary.json'), 'utf8'));
    expect(summary.schemaVersion).toBe(1);
    expect(summary.pending).toEqual(['ev-1', 'ev-2']);
    expect(summary.attempts).toEqual([{ id: 'attempt-of-ev-2', requirement: 'windows/persistence', outcome: 'failed' }]);
    expect(summary.truncated).toBe(false);
  });

  test('the summary is only a view: reading the run ignores it', async () => {
    await appendAll(runStarted('ev-1'));
    await writeFile(join(runDir, 'summary.json'), '{"pending":[],"garbage":true}');
    expect((await readRun(runDir)).pending).toEqual(['ev-1']);
  });

  test('a failed replacement leaves the previous file intact and no temporary file behind', async () => {
    const target = join(runDir, 'summary.json');
    await writeFile(target, 'previous');
    const failingRename = async () => { throw new Error('disk removed'); };
    await expect(writeFileAtomic(target, 'new content', { open, rename: failingRename as unknown as typeof rename, unlink })).rejects.toThrow('disk removed');
    expect(await readFile(target, 'utf8')).toBe('previous');
    expect(await readdir(runDir)).toEqual(['summary.json']);
  });

  test('a successful replacement swaps the whole content and leaves no temporary file', async () => {
    const target = join(runDir, 'summary.json');
    await writeFile(target, 'previous');
    await writeFileAtomic(target, 'new content');
    expect(await readFile(target, 'utf8')).toBe('new content');
    expect(await readdir(runDir)).toEqual(['summary.json']);
  });

  test('digests of appended events match what an acknowledgement needs', async () => {
    const attempt = attemptRecorded('ev-1');
    await appendAll(attempt);
    const stored = JSON.parse((await readFile(logPath(), 'utf8')).trim());
    expect(eventDigest(stored)).toBe(eventDigest(attempt));
  });
});
