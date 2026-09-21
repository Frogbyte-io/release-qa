// Event builders for journal tests. IDs are fixed so a test names exactly the events it is about.
import type { Attempt } from '../../src/model/result.ts';
import { eventDigest, type RunEvent } from '../../src/runner/events.ts';

const AT = '2026-09-20T12:00:00Z';

export function runStarted(id = 'ev-start', prev?: string): RunEvent {
  const event: RunEvent = {
    schemaVersion: 1,
    id,
    recordedAt: AT,
    type: 'run-started',
    data: { runId: 'run-0001', candidateId: 'cand-0001', profile: 'windows', machineId: 'lab-win-01' },
  };
  return prev === undefined ? event : { ...event, prev };
}

export function attemptRecorded(id: string, overrides: Partial<Attempt> = {}, prev?: string): RunEvent {
  const attempt: Attempt = { id: `attempt-of-${id}`, requirement: 'windows/persistence', outcome: 'passed', evidence: [], ...overrides };
  const event: RunEvent = { schemaVersion: 1, id, recordedAt: AT, type: 'attempt-recorded', data: { attempt } };
  return prev === undefined ? event : { ...event, prev };
}

export function checkpoint(id: string, name = 'installed', prev?: string): RunEvent {
  const event: RunEvent = { schemaVersion: 1, id, recordedAt: AT, type: 'checkpoint', data: { name } };
  return prev === undefined ? event : { ...event, prev };
}

/** The server's acknowledgement of `target`, echoing the digest of what it stored. */
export function acknowledged(id: string, target: RunEvent, digest: string = eventDigest(target)): RunEvent {
  return { schemaVersion: 1, id, recordedAt: AT, type: 'upload-acknowledged', data: { eventId: target.id, digest } };
}
