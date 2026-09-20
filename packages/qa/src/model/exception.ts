import { checkCandidateId, checkRequirementKnown, type ReferenceContext } from './context.ts';
import type { RequirementKey } from './requirement.ts';
import { item, parseVersioned, type FieldSpec, type ParseResult } from './validate.ts';

/** A request to accept named requirements as unmet for one candidate. It carries no authority by itself. */
export interface Exception {
  schemaVersion: 1;
  id: string;
  candidateId: string;
  requirements: RequirementKey[];
  reason: string;
  /** Claimed by the uploader; the maintainer's authority is verified separately. */
  actor: string;
  /** ISO-8601 UTC, e.g. `2026-09-20T12:00:00Z`. */
  createdAt: string;
}

const SPEC: FieldSpec = { required: ['id', 'candidateId', 'requirements', 'reason', 'actor', 'createdAt'] };

export function parseException(input: unknown, context: ReferenceContext = {}): ParseResult<Exception> {
  return parseVersioned(input, SPEC, (c, rec) => {
    const candidateId = c.id(rec.candidateId, 'candidateId');
    checkCandidateId(c, context, candidateId, 'candidateId');

    const requirements = (c.array(rec.requirements, 'requirements', { min: 1 }) ?? []).map((v, i) => c.requirementKey(v, item('requirements', i)));
    c.unique(requirements.map((key, i) => ({ value: key, path: item('requirements', i) })));
    requirements.forEach((key, i) => checkRequirementKnown(c, context, key, item('requirements', i)));

    return {
      schemaVersion: 1,
      id: c.id(rec.id, 'id'),
      candidateId,
      requirements,
      reason: c.text(rec.reason, 'reason', { max: 2000, multiline: true }),
      actor: c.text(rec.actor, 'actor'),
      createdAt: c.timestamp(rec.createdAt, 'createdAt'),
    } as Exception;
  });
}
