import type { Candidate } from './candidate.ts';
import type { RequirementKey } from './requirement.ts';
import type { Collector } from './validate.ts';

/** What a record is allowed to refer to. Parsing a record alone cannot know this, so callers supply it. */
export interface ReferenceContext {
  /** When given, the record must belong to this candidate. */
  candidate?: Candidate;
  /** When given, every requirement the record names must be one of these. */
  requirements?: readonly RequirementKey[];
}

/** A record that names a candidate must name the one it is being checked against. */
export function checkCandidateId(c: Collector, context: ReferenceContext, candidateId: string | undefined, path: string): void {
  if (context.candidate !== undefined && candidateId !== undefined && candidateId !== context.candidate.id) {
    c.add('unknown-reference', path, `belongs to candidate "${candidateId}", not "${context.candidate.id}"`);
  }
}

export function checkRequirementKnown(c: Collector, context: ReferenceContext, key: RequirementKey | undefined, path: string): void {
  if (context.requirements !== undefined && key !== undefined && !context.requirements.includes(key)) {
    c.add('unknown-reference', path, `"${key}" is not a required check`);
  }
}
