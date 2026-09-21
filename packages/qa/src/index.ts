/** Public entry point of the Release QA package. */
export const toolName = 'release-qa';

export { parseCandidate, type Artifact, type Candidate } from './model/candidate.ts';
export { parseException, type Exception } from './model/exception.ts';
export { parseProject, type EnvironmentProfile, type Project, type Suite } from './model/project.ts';
export { parseRequirement, type ExecutionMode, type Requirement, type RequirementKey } from './model/requirement.ts';
export {
  parseReport,
  parseUploadProvenance,
  type Attempt,
  type MeasuredEnvironment,
  type Outcome,
  type Readiness,
  type ReferenceContext,
  type Report,
  type UploadProvenance,
} from './model/result.ts';
export { ValidationError, type IssueCode, type ParseResult, type ValidationIssue } from './model/validate.ts';
export {
  evaluate,
  type AuthorizedException,
  type EligibleReport,
  type Evaluation,
  type EvaluationInput,
  type Ignored,
  type IgnoredReason,
  type Reason,
  type RetryResolution,
} from './model/evaluate.ts';
export { eventDigest, parseRunEvent, type AttemptRecorded, type Checkpoint, type RunEvent, type RunStarted, type UploadAcknowledged } from './runner/events.ts';
export { appendEvent, JournalError, readRun, writeSummary, type AppendResult, type JournalErrorCode, type RunState } from './runner/journal.ts';
export { renderReport, type RenderedReport, type RenderOptions } from './runner/report.ts';
