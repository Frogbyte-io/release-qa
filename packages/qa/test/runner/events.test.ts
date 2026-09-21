import { describe, expect, test } from 'vitest';
import { eventDigest, parseRunEvent } from '../../src/runner/events.ts';
import type { ParseResult } from '../../src/model/validate.ts';
import { acknowledged, attemptRecorded, checkpoint, runStarted } from '../fixtures/events.ts';

function codes(result: ParseResult<unknown>): Array<[string, string]> {
  return result.ok ? [] : result.error.issues.map((i) => [i.path, i.code]);
}

describe('parseRunEvent', () => {
  test.each([
    ['run-started', runStarted()],
    ['attempt-recorded', attemptRecorded('ev-1', { evidence: ['evidence/a.png'], retryOf: 'earlier' })],
    ['checkpoint', checkpoint('ev-1', 'installed', 'ev-0')],
    ['upload-acknowledged', acknowledged('ev-ack', attemptRecorded('ev-1'))],
  ])('accepts a valid %s event and returns it unchanged', (_type, event) => {
    const result = parseRunEvent(event);
    expect(result.ok, JSON.stringify(codes(result))).toBe(true);
    expect(result.ok && result.value).toEqual(event);
  });

  test('rejects an unknown event type', () => {
    expect(codes(parseRunEvent({ ...runStarted(), type: 'run-finished' }))).toContainEqual(['type', 'invalid-value']);
  });

  test('rejects an unknown schema version by itself', () => {
    expect(codes(parseRunEvent({ ...runStarted(), schemaVersion: 2 }))).toEqual([['schemaVersion', 'unknown-schema-version']]);
  });

  test('rejects an id that is empty or could escape a directory', () => {
    expect(codes(parseRunEvent({ ...runStarted(), id: '' }))).toContainEqual(['id', 'empty']);
    expect(codes(parseRunEvent({ ...runStarted(), id: '../x' }))).toContainEqual(['id', 'malformed-id']);
  });

  test('rejects an event that names itself as its predecessor', () => {
    expect(codes(parseRunEvent({ ...checkpoint('ev-1'), prev: 'ev-1' }))).toContainEqual(['prev', 'invalid-value']);
  });

  test('rejects an attempt with evidence that leaves the run directory', () => {
    expect(codes(parseRunEvent(attemptRecorded('ev-1', { evidence: ['../secret.png'] })))).toContainEqual(['data.attempt.evidence[0]', 'unsafe-path']);
  });

  test('rejects an acknowledgement whose digest is not a sha256', () => {
    expect(codes(parseRunEvent(acknowledged('ev-ack', attemptRecorded('ev-1'), 'abc')))).toContainEqual(['data.digest', 'malformed-hash']);
  });

  test('rejects a malformed timestamp', () => {
    expect(codes(parseRunEvent({ ...runStarted(), recordedAt: 'yesterday' }))).toContainEqual(['recordedAt', 'malformed-timestamp']);
  });

  test('rejects fields it does not know, in the event and in its data', () => {
    expect(codes(parseRunEvent({ ...runStarted(), extra: 1 }))).toContainEqual(['extra', 'unknown-field']);
    expect(codes(parseRunEvent({ ...checkpoint('ev-1'), data: { name: 'x', extra: 1 } }))).toContainEqual(['data.extra', 'unknown-field']);
  });

  test.each([null, 'text', 42, []])('rejects the non-object %j without throwing', (input) => {
    expect(codes(parseRunEvent(input))).toContainEqual(['', 'invalid-type']);
  });
});

describe('eventDigest', () => {
  test('is 64 lower-case hex characters', () => {
    expect(eventDigest(runStarted())).toMatch(/^[0-9a-f]{64}$/);
  });

  test('does not depend on key order', () => {
    const event = attemptRecorded('ev-1');
    const reordered = { data: event.data, recordedAt: event.recordedAt, type: event.type, id: event.id, schemaVersion: event.schemaVersion } as typeof event;
    expect(eventDigest(event)).toMatch(/^[0-9a-f]{64}$/);
    expect(eventDigest(reordered)).toBe(eventDigest(event));
  });

  test('changes when any content changes', () => {
    expect(eventDigest(attemptRecorded('ev-1', { outcome: 'failed' }))).not.toBe(eventDigest(attemptRecorded('ev-1', { outcome: 'passed' })));
    expect(eventDigest(checkpoint('ev-1', 'a'))).not.toBe(eventDigest(checkpoint('ev-1', 'b')));
  });
});
