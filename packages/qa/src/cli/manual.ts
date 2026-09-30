import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Candidate } from '../model/candidate.ts';
import type { EnvironmentProfile } from '../model/project.ts';
import { profileOf, type Requirement } from '../model/requirement.ts';
import { parseReport, type MeasuredEnvironment, type Report } from '../model/result.ts';
import { defaultProbes, inspectEnvironment, type EnvironmentProbes } from '../runner/environment.ts';
import type { RunEvent } from '../runner/events.ts';
import { appendEvent, readRun, writeFileAtomic } from '../runner/journal.ts';
import { syncRun, type SyncApi, type SyncRunResult } from '../github/sync.ts';
import { machineId } from './run.ts';

/** The outcomes a person can record. Cancelled and interrupted are things that happen to a run, not a person's verdict. */
export const MANUAL_OUTCOMES = ['passed', 'failed', 'blocked'] as const;
export type ManualOutcome = (typeof MANUAL_OUTCOMES)[number];

export const MAX_NOTES_LENGTH = 5000;
export const MAX_EVIDENCE_FILES = 10;
export const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;

const REPORT_FILE = 'report.json';
const META_FILE = 'manual.json';
const NOTES_FILE = 'notes.md';
const RUN_PREFIX = 'manual-';
const RUN_ID = /^manual-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$/;

/** Where a manual result was recorded for, kept beside the run so a later sync goes where the result belongs. */
export interface ManualRunMeta {
  schemaVersion: 1;
  repository: string;
  releaseId: number;
  pullRequest: number;
  requirement: string;
  recordedAt: string;
}

export interface ManualCheckInput {
  /** Where runs live, one directory per run (the same layout `run` uses). */
  stateDir: string;
  repository: string;
  pullRequest: number;
  /** The draft release the candidate lives on; syncing uploads there. */
  releaseId: number;
  candidate: Candidate;
  profile: EnvironmentProfile;
  requirement: Requirement;
  outcome: ManualOutcome;
  notes: string;
  /** Absolute paths of files the tester chose. They are copied into the run; the originals are never referenced again. */
  evidence: readonly string[];
  /** Only `currentUser` is used: the reporter is whoever GitHub says is signed in, never a name passed in. */
  api: Pick<SyncApi, 'currentUser'>;
  probes?: EnvironmentProbes;
  now?: () => Date;
}

export type ManualCheckResult = { ok: true; runId: string; runDirectory: string; report: Report; meta: ManualRunMeta } | { ok: false; error: string };

const refuse = (error: string): { ok: false; error: string } => ({ ok: false, error });
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const stamp = (date: Date): string => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const timestamp = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Records a person's verdict on a manual requirement as a real run: a journal with a start and one attempt, its evidence
 * (the notes and the files the tester attached) inside the run directory, and a report that `syncRun` accepts and the
 * evaluator counts like any other. Nothing is uploaded here. Never throws; a refused or failed recording leaves no run behind.
 */
export async function recordManualCheck(input: ManualCheckInput): Promise<ManualCheckResult> {
  const now = input.now ?? (() => new Date());
  const { requirement, candidate, profile } = input;
  if (requirement.mode !== 'manual') return refuse(`${requirement.key} is not a manual check.`);
  if (profileOf(requirement.key) !== profile.id) return refuse(`${requirement.key} is not for the ${profile.id} profile.`);
  if (!candidate.artifacts.some((artifact) => artifact.profile === profile.id)) return refuse(`The candidate has no ${profile.id} build, so this check cannot count for it.`);
  if (!MANUAL_OUTCOMES.includes(input.outcome)) return refuse('The outcome must be passed, failed or blocked.');
  const notes = input.notes.trim();
  if (notes === '') return refuse('Notes are required: say what you did and what you saw.');
  if (notes.length > MAX_NOTES_LENGTH) return refuse(`Notes are longer than ${MAX_NOTES_LENGTH} characters.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(notes)) return refuse('Notes contain control characters.');
  if (input.evidence.length === 0) return refuse('Attach at least one evidence file (a screenshot, a photo or a log).');
  if (input.evidence.length > MAX_EVIDENCE_FILES) return refuse(`Attach at most ${MAX_EVIDENCE_FILES} evidence files.`);

  const login = await input.api.currentUser();
  if (!login.ok) return refuse(`Cannot tell who you are signed in as (${login.reason}); sign in with "gh auth login" and try again.`);

  // A person at another kind of machine did not exercise this profile, however honest the notes are.
  const inspected = await inspectEnvironment(profile, input.probes ?? defaultProbes);
  if (inspected.profileMismatch !== undefined) return refuse(`This machine cannot record a ${profile.id} check: ${inspected.profileMismatch}.`);

  for (const source of input.evidence) {
    const info = await stat(source).catch(() => undefined);
    if (info === undefined || !info.isFile()) return refuse(`Evidence file ${basename(source)} cannot be read.`);
    if (info.size === 0) return refuse(`Evidence file ${basename(source)} is empty.`);
    if (info.size > MAX_EVIDENCE_BYTES) return refuse(`Evidence file ${basename(source)} is larger than ${MAX_EVIDENCE_BYTES / (1024 * 1024)} MiB.`);
  }

  const recordedAt = now();
  const runId = `${RUN_PREFIX}${stamp(recordedAt)}-${randomBytes(3).toString('hex')}`;
  const runDirectory = join(input.stateDir, runId);
  const attemptId = `${runId}.a1`;
  const evidenceDirectory = `evidence/${attemptId}`;
  try {
    await mkdir(join(runDirectory, evidenceDirectory), { recursive: true });
    const evidence: string[] = [`${evidenceDirectory}/${NOTES_FILE}`];
    await writeFile(join(runDirectory, evidence[0]!), `${notes}\n`, { flag: 'wx' });
    for (const [index, source] of input.evidence.entries()) {
      // The number keeps names unique and keeps a name like "con" from being a device name; the rest is what the person chose.
      const safe = basename(source).replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.+$/, '').slice(-80);
      const relative = `${evidenceDirectory}/${index + 1}-${safe === '' ? 'file' : safe}`;
      await copyFile(source, join(runDirectory, relative), constants.COPYFILE_EXCL);
      evidence.push(relative);
    }

    const measured: MeasuredEnvironment = {
      ...inspected.environment,
      // Hardware and the like cannot be probed; the person at the device attests to what the requirement needs.
      capabilities: [...new Set([...inspected.environment.capabilities, ...requirement.capabilities])].sort(),
    };
    const machine = await machineId(input.stateDir);
    const report: Report = {
      schemaVersion: 1,
      id: runId,
      candidateId: candidate.id,
      policyDigest: candidate.policyDigest,
      testRevision: candidate.testRevision,
      profile: profile.id,
      actor: login.value,
      machineId: machine,
      environment: measured,
      attempts: [{ id: attemptId, requirement: requirement.key, outcome: input.outcome, evidence }],
    };
    const parsed = parseReport(report, { candidate, requirements: [requirement.key] });
    if (!parsed.ok) throw new Error(`the result is not a valid report: ${parsed.error.message}`);

    const at = timestamp(recordedAt);
    const start: RunEvent = { schemaVersion: 1, id: `${runId}.e1`, recordedAt: at, type: 'run-started', data: { runId, candidateId: candidate.id, profile: profile.id, machineId: machine } };
    const attempt: RunEvent = { schemaVersion: 1, id: `${runId}.e2`, prev: start.id, recordedAt: at, type: 'attempt-recorded', data: { attempt: parsed.value.attempts[0]! } };
    for (const event of [start, attempt]) {
      const appended = await appendEvent(runDirectory, event);
      if (!appended.ok) throw appended.error;
    }
    const meta: ManualRunMeta = { schemaVersion: 1, repository: input.repository, releaseId: input.releaseId, pullRequest: input.pullRequest, requirement: requirement.key, recordedAt: at };
    await writeFileAtomic(join(runDirectory, META_FILE), `${JSON.stringify(meta, null, 2)}\n`);
    // Last: a directory with a report is a complete result. Anything else is an unfinished recording and is not listed.
    await writeFileAtomic(join(runDirectory, REPORT_FILE), `${JSON.stringify(parsed.value, null, 2)}\n`);
    return { ok: true, runId, runDirectory, report: parsed.value, meta };
  } catch (error) {
    await rm(runDirectory, { recursive: true, force: true }).catch(() => undefined);
    return refuse(`The result could not be saved: ${message(error)}`);
  }
}

export interface ManualRunSummary {
  runId: string;
  meta: ManualRunMeta;
  report: Report;
  /** The single attempt's outcome. */
  outcome: ManualOutcome;
  evidence: string[];
  /** True once every recorded event has a verified upload acknowledgement. Until then the result exists only on this machine. */
  synced: boolean;
  /** Set when the journal or its evidence is damaged; such a result cannot be synced. */
  problem?: string;
}

/** Reads one recorded manual result back from disk. `undefined` when there is no complete result under that id. */
export async function readManualRun(stateDir: string, runId: string): Promise<ManualRunSummary | undefined> {
  if (!RUN_ID.test(runId)) return undefined;
  const directory = join(stateDir, runId);
  try {
    const report = parseReport(JSON.parse(await readFile(join(directory, REPORT_FILE), 'utf8')) as unknown);
    const meta = JSON.parse(await readFile(join(directory, META_FILE), 'utf8')) as ManualRunMeta;
    const attempt = report.ok ? report.value.attempts[0] : undefined;
    if (!report.ok || report.value.id !== runId || attempt === undefined || meta.schemaVersion !== 1) return undefined;
    if (!MANUAL_OUTCOMES.includes(attempt.outcome as ManualOutcome)) return undefined;
    const state = await readRun(directory);
    const damaged = !state.exists || state.truncated !== null || state.corrupt.length > 0 || state.conflicts.length > 0 || state.missingPredecessors.length > 0 || state.cyclic.length > 0 || state.missingEvidence.length > 0;
    return {
      runId,
      meta,
      report: report.value,
      outcome: attempt.outcome as ManualOutcome,
      evidence: attempt.evidence,
      synced: state.exists && state.pending.length === 0,
      ...(damaged ? { problem: 'The saved result is incomplete or has been changed on disk.' } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Every complete manual result on this machine, oldest first. */
export async function listManualRuns(stateDir: string): Promise<ManualRunSummary[]> {
  const names = await readdir(stateDir).catch(() => [] as string[]);
  const runs = await Promise.all(names.filter((name) => RUN_ID.test(name)).map((name) => readManualRun(stateDir, name)));
  return runs.flatMap((run) => (run === undefined ? [] : [run])).sort((a, b) => a.runId.localeCompare(b.runId));
}

/**
 * Uploads one recorded manual result with the shared `syncRun`, to the release it was recorded for. The report's actor must be
 * the signed-in user (checked by `syncRun`), so a result recorded by someone else on this machine is refused, not re-labelled.
 * A failure leaves the local result exactly as it was; syncing again replays safely.
 */
export async function syncManualRun(stateDir: string, runId: string, api: SyncApi): Promise<SyncRunResult> {
  const run = await readManualRun(stateDir, runId);
  if (run === undefined) return { ok: false, error: 'There is no saved manual result with that id.' };
  if (run.problem !== undefined) return { ok: false, error: run.problem };
  return syncRun({ repository: run.meta.repository, releaseId: run.meta.releaseId, runId, runDirectory: join(stateDir, runId), report: run.report, api });
}
