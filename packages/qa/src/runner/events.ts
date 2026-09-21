import { createHash } from 'node:crypto';
import { canonical } from '../model/canonical.ts';
import type { RequirementKey } from '../model/requirement.ts';
import { readAttempt, type Attempt } from '../model/result.ts';
import { at, Collector, parseVersioned, type FieldSpec, type ParseResult } from '../model/validate.ts';

interface EventBase {
  schemaVersion: 1;
  /** Stable, caller-chosen identity. Replaying an event reuses its id and content, so replays are idempotent. */
  id: string;
  /** The event this one follows. Ordering comes from these links, never from clocks. */
  prev?: string;
  /** ISO-8601 UTC. Informational only: it never decides which event wins or where an event sorts. */
  recordedAt: string;
}

export interface RunStarted {
  type: 'run-started';
  data: { runId: string; candidateId: string; profile: string; machineId: string };
}

/** A local test result the runner has accepted. Losing it silently is the failure this journal prevents. */
export interface AttemptRecorded {
  type: 'attempt-recorded';
  data: { attempt: Attempt };
}

/** Progress inside a stateful scenario. Never inferred: it exists only if it was recorded. */
export interface Checkpoint {
  type: 'checkpoint';
  data: { name: string; requirement?: RequirementKey };
}

/**
 * The server confirmed it stored an event, with the digest of what it stored. Only a matching digest makes
 * the event "synced"; until then it stays pending.
 */
export interface UploadAcknowledged {
  type: 'upload-acknowledged';
  data: { eventId: string; digest: string };
}

export type RunEvent = EventBase & (RunStarted | AttemptRecorded | Checkpoint | UploadAcknowledged);

const EVENT_TYPES = ['run-started', 'attempt-recorded', 'checkpoint', 'upload-acknowledged'] as const;
const SPEC: FieldSpec = { required: ['id', 'type', 'recordedAt', 'data'], optional: ['prev'] };
const RUN_STARTED_SPEC: FieldSpec = { required: ['runId', 'candidateId', 'profile', 'machineId'] };
const ATTEMPT_SPEC: FieldSpec = { required: ['attempt'] };
const CHECKPOINT_SPEC: FieldSpec = { required: ['name'], optional: ['requirement'] };
const ACK_SPEC: FieldSpec = { required: ['eventId', 'digest'] };

export function parseRunEvent(input: unknown): ParseResult<RunEvent> {
  return parseVersioned(input, SPEC, (c, rec) => {
    const id = c.id(rec.id, 'id');
    const prev = rec.prev === undefined ? undefined : c.id(rec.prev, 'prev');
    if (prev !== undefined && prev === id) c.add('invalid-value', 'prev', 'an event cannot follow itself');
    const type = c.oneOf(rec.type, 'type', EVENT_TYPES);
    const event: Record<string, unknown> = {
      schemaVersion: 1,
      id,
      recordedAt: c.timestamp(rec.recordedAt, 'recordedAt'),
      type,
      // With an unknown type the data cannot be interpreted, so it is not inspected; the type problem is reported.
      data: type === undefined ? undefined : readData(c, type, rec.data),
    };
    if (prev !== undefined) event.prev = prev;
    return event as unknown as RunEvent;
  });
}

function readData(c: Collector, type: (typeof EVENT_TYPES)[number], value: unknown): unknown {
  switch (type) {
    case 'run-started': {
      const d = c.record(value, 'data', RUN_STARTED_SPEC);
      return d && {
        runId: c.id(d.runId, 'data.runId'),
        candidateId: c.id(d.candidateId, 'data.candidateId'),
        profile: c.profileId(d.profile, 'data.profile'),
        machineId: c.text(d.machineId, 'data.machineId'),
      };
    }
    case 'attempt-recorded': {
      const d = c.record(value, 'data', ATTEMPT_SPEC);
      return d && { attempt: readAttempt(c, d.attempt, at('data', 'attempt')) };
    }
    case 'checkpoint': {
      const d = c.record(value, 'data', CHECKPOINT_SPEC);
      if (d === undefined) return undefined;
      const data: Record<string, unknown> = { name: c.text(d.name, 'data.name') };
      if (d.requirement !== undefined) data.requirement = c.requirementKey(d.requirement, 'data.requirement');
      return data;
    }
    case 'upload-acknowledged': {
      const d = c.record(value, 'data', ACK_SPEC);
      return d && { eventId: c.id(d.eventId, 'data.eventId'), digest: c.sha256(d.digest, 'data.digest') };
    }
  }
}

/** SHA-256 of the event's canonical JSON: the identity an acknowledgement must match. */
export function eventDigest(event: RunEvent): string {
  return createHash('sha256').update(canonical(event)).digest('hex');
}
