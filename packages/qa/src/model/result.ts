import type { Candidate } from './candidate.ts';
import { checkCandidateId, checkRequirementKnown, type ReferenceContext } from './context.ts';
import { profileOf, type RequirementKey } from './requirement.ts';
import { at, Collector, item, parseUnversioned, parseVersioned, type FieldSpec, type ParseResult } from './validate.ts';

export type { ReferenceContext } from './context.ts';

export type Outcome = 'passed' | 'failed' | 'blocked' | 'cancelled' | 'interrupted';
export type Readiness = 'blocked' | 'passed' | 'approved-with-exceptions';

export interface Attempt {
  id: string;
  requirement: RequirementKey;
  outcome: Outcome;
  /** The attempt this one retries. It may live in another report, so only self-reference is checked here. */
  retryOf?: string;
  /** Relative paths of evidence files stored next to the report. */
  evidence: string[];
}

/** Facts the runner measured about the environment. Descriptive, never proof of authority. */
export interface MeasuredEnvironment {
  os: string;
  osVersion: string;
  arch: string;
  capabilities: string[];
  toolVersion: string;
}

export interface Report {
  schemaVersion: 1;
  id: string;
  candidateId: string;
  policyDigest: string;
  testRevision: string;
  profile: string;
  /** Claimed by the uploader. Authority comes from {@link UploadProvenance}, never from this field. */
  actor: string;
  machineId: string;
  environment: MeasuredEnvironment;
  attempts: Attempt[];
}

/** Recorded by the GitHub layer when it stores an upload; a report cannot attest to its own origin. */
export interface UploadProvenance {
  uploader: string;
  uploadedAt: string;
  assetId: number;
}

const OUTCOMES = ['passed', 'failed', 'blocked', 'cancelled', 'interrupted'] as const;
const SPEC: FieldSpec = {
  required: ['id', 'candidateId', 'policyDigest', 'testRevision', 'profile', 'actor', 'machineId', 'environment', 'attempts'],
};
const ENVIRONMENT_SPEC: FieldSpec = { required: ['os', 'osVersion', 'arch', 'capabilities', 'toolVersion'] };
const ATTEMPT_SPEC: FieldSpec = { required: ['id', 'requirement', 'outcome', 'evidence'], optional: ['retryOf'] };
const PROVENANCE_SPEC: FieldSpec = { required: ['uploader', 'uploadedAt', 'assetId'] };

export function parseReport(input: unknown, context: ReferenceContext = {}): ParseResult<Report> {
  return parseVersioned(input, SPEC, (c, rec) => {
    const id = c.id(rec.id, 'id');
    const candidateId = c.id(rec.candidateId, 'candidateId');
    const policyDigest = c.sha256(rec.policyDigest, 'policyDigest');
    const testRevision = c.gitSha(rec.testRevision, 'testRevision');
    const profile = c.profileId(rec.profile, 'profile');
    const environment = readEnvironment(c, rec.environment, 'environment');

    const attempts = (c.array(rec.attempts, 'attempts', { min: 1 }) ?? []).map((v, i) => readAttempt(c, v, item('attempts', i)));
    c.unique(attempts.map((a, i) => ({ value: a?.id, path: at(item('attempts', i), 'id') })));
    attempts.forEach((a, i) => {
      const path = at(item('attempts', i), 'requirement');
      if (a?.requirement !== undefined && profile !== undefined && profileOf(a.requirement) !== profile) {
        c.add('mismatch', path, `requirement is for profile "${profileOf(a.requirement)}", the report is for "${profile}"`);
      }
      checkRequirementKnown(c, context, a?.requirement, path);
    });

    checkCandidateId(c, context, candidateId, 'candidateId');
    checkAgainstCandidate(c, context.candidate, { policyDigest, testRevision, profile });

    return {
      schemaVersion: 1,
      id,
      candidateId,
      policyDigest,
      testRevision,
      profile,
      actor: c.text(rec.actor, 'actor'),
      machineId: c.text(rec.machineId, 'machineId'),
      environment,
      attempts,
    } as Report;
  });
}

function checkAgainstCandidate(
  c: Collector,
  candidate: Candidate | undefined,
  report: { policyDigest: string | undefined; testRevision: string | undefined; profile: string | undefined },
): void {
  if (candidate === undefined) return;
  if (report.policyDigest !== undefined && report.policyDigest !== candidate.policyDigest) c.add('mismatch', 'policyDigest', 'made against a different policy than the candidate');
  if (report.testRevision !== undefined && report.testRevision !== candidate.testRevision) c.add('mismatch', 'testRevision', 'made against different tests than the candidate');
  if (report.profile !== undefined && !candidate.artifacts.some((a) => a.profile === report.profile)) {
    c.add('unknown-reference', 'profile', `the candidate has no artifact for profile "${report.profile}"`);
  }
}

function readEnvironment(c: Collector, value: unknown, path: string): MeasuredEnvironment | undefined {
  const rec = c.record(value, path, ENVIRONMENT_SPEC);
  if (rec === undefined) return undefined;
  const capabilitiesPath = at(path, 'capabilities');
  return {
    os: c.text(rec.os, at(path, 'os')),
    osVersion: c.text(rec.osVersion, at(path, 'osVersion')),
    arch: c.text(rec.arch, at(path, 'arch')),
    capabilities: (c.array(rec.capabilities, capabilitiesPath) ?? []).map((v, i) => c.name(v, item(capabilitiesPath, i))),
    toolVersion: c.text(rec.toolVersion, at(path, 'toolVersion')),
  } as MeasuredEnvironment;
}

function readAttempt(c: Collector, value: unknown, path: string): Attempt | undefined {
  const rec = c.record(value, path, ATTEMPT_SPEC);
  if (rec === undefined) return undefined;
  const id = c.id(rec.id, at(path, 'id'));
  const retryOf = rec.retryOf === undefined ? undefined : c.id(rec.retryOf, at(path, 'retryOf'));
  if (retryOf !== undefined && retryOf === id) c.add('invalid-value', at(path, 'retryOf'), 'an attempt cannot be a retry of itself');
  const evidencePath = at(path, 'evidence');
  const attempt: Record<string, unknown> = {
    id,
    requirement: c.requirementKey(rec.requirement, at(path, 'requirement')),
    outcome: c.oneOf(rec.outcome, at(path, 'outcome'), OUTCOMES),
    evidence: (c.array(rec.evidence, evidencePath) ?? []).map((v, i) => c.relativePath(v, item(evidencePath, i))),
  };
  if (retryOf !== undefined) attempt.retryOf = retryOf;
  return attempt as unknown as Attempt;
}

export function parseUploadProvenance(input: unknown): ParseResult<UploadProvenance> {
  return parseUnversioned(input, PROVENANCE_SPEC, (c, rec) => ({
    uploader: c.text(rec.uploader, 'uploader'),
    uploadedAt: c.timestamp(rec.uploadedAt, 'uploadedAt'),
    assetId: c.int(rec.assetId, 'assetId'),
  }) as UploadProvenance);
}
