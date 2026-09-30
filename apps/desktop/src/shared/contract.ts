import type { Evaluation } from '@frogbyte-io/release-qa/model';

/**
 * The only messages that cross from the window into the privileged process. Each channel is named here once; the main
 * process registers exactly these and the preload exposes exactly these, so a new capability is a reviewed change to
 * this file, not a string a renderer can invent.
 */
export const CHANNELS = {
  loadDashboard: 'qa:load-dashboard',
  prepareCandidate: 'qa:prepare-candidate',
  previewMerge: 'qa:preview-merge',
  mergePullRequest: 'qa:merge-pull-request',
  openPullRequest: 'qa:open-pull-request',
  loadManualCheck: 'qa:load-manual-check',
  pickEvidence: 'qa:pick-evidence',
  recordManualCheck: 'qa:record-manual-check',
  syncManualResult: 'qa:sync-manual-result',
  claimManualCheck: 'qa:claim-manual-check',
  runOnLinux: 'qa:run-on-linux',
  listRemoteRuns: 'qa:list-remote-runs',
  getCheckout: 'qa:get-checkout',
  chooseCheckout: 'qa:choose-checkout',
  previewRun: 'qa:preview-run',
  startRun: 'qa:start-run',
  cancelRun: 'qa:cancel-run',
  getRunStatus: 'qa:get-run-status',
  listRuns: 'qa:list-runs',
  syncRun: 'qa:sync-run',
} as const;

/** What the privileged process may push to the window. Named here for the same reason as `CHANNELS`: the preload allows exactly these. */
export const EVENTS = {
  runStatus: 'qa:run-status',
} as const;

export interface QaBridge {
  loadDashboard(): Promise<DashboardSnapshot>;
  loadManualCheck(target: ManualTarget): Promise<ManualCheckStateResult>;
  /** Opens the file dialog in the privileged process. What comes back are handles and names, never paths. */
  pickEvidence(): Promise<PickEvidenceResult>;
  recordManualCheck(request: ManualRecordRequest): Promise<ManualRecordResult>;
  /** Uploads one manual result recorded on this computer. Scoped to manual results; it is not a general sync. */
  syncManualResult(request: { runId: string }): Promise<ActionResult>;
  claimManualCheck(request: ManualClaimRequest): Promise<ActionResult>;
  prepareCandidate(target: PullTarget): Promise<ActionResult>;
  previewMerge(target: PullTarget): Promise<MergePreviewResult>;
  mergePullRequest(request: MergeRequest): Promise<ActionResult>;
  openPullRequest(target: Pick<PullTarget, 'repository' | 'number'>): Promise<ActionResult>;
  runOnLinux(request: RemoteRunRequest): Promise<ActionResult>;
  listRemoteRuns(target: Pick<PullTarget, 'repository' | 'number'>): Promise<RemoteRunsResult>;
  getCheckout(repository: string): Promise<CheckoutView>;
  chooseCheckout(repository: string): Promise<CheckoutView>;
  previewRun(request: RunRequest): Promise<RunPreviewResult>;
  startRun(request: RunConfirmation): Promise<ActionResult>;
  cancelRun(): Promise<ActionResult>;
  getRunStatus(): Promise<RunStatus>;
  listRuns(target: Pick<PullTarget, 'repository'> & { candidateId: string }): Promise<RunListResult>;
  syncRun(request: SyncRequest): Promise<ActionResult>;
  /** Subscribes to the run's state as it changes. Returns the way to stop listening. */
  onRunStatus(listener: (status: RunStatus) => void): () => void;
}

/** The local checkout of a consumer repository whose tests would run. Chosen in a folder dialog the main process owns. */
export type CheckoutView =
  | { status: 'none' }
  | { status: 'ready'; path: string }
  /** A folder that was chosen or remembered but is not usable; `error` says why. It is not remembered if it was just chosen. */
  | { status: 'invalid'; path: string; error: string };

/** What the window asks to run (or, with `runId`, to resume). The privileged side re-reads everything else. */
export interface RunRequest extends PullTarget {
  profile: string;
  suite: string;
  /** Resume this local run instead of starting a new one. */
  runId?: string;
}

/** What the person is shown before anything is installed, read fresh by the privileged process. */
export type RunPreviewResult =
  | {
      ok: true;
      repository: string;
      number: number;
      headSha: string;
      candidateId: string;
      candidateReleaseId: number;
      profile: string;
      suite: string;
      /** The file that would be installed. */
      artifactName: string;
      artifactSha256: string;
      checkout: string;
      /** The designated test root the run may install into and reset. */
      root: string;
      automated: string[];
      manual: string[];
      resumes?: string;
    }
  | { ok: false; error: string };

/** The person's confirmation: the request plus exactly what they were shown. Refused if any of it has changed. */
export interface RunConfirmation extends RunRequest {
  candidateId: string;
  root: string;
}

export interface SyncRequest extends PullTarget {
  runId: string;
}

/** One local run, for choosing what to resume or upload. `pending` above zero is the "not synced" state. */
export interface RunEntry {
  runId: string;
  candidateId: string;
  profile: string;
  suite: string;
  startedAt: string;
  results: Array<{ requirement: string; outcome: string }>;
  resumable: boolean;
  attempts: number;
  pending: number;
  /** The run being worked on right now in this app. */
  active: boolean;
  problem?: string;
}

export type RunListResult = { ok: true; runs: RunEntry[] } | { ok: false; error: string };

export interface RunProgressLine {
  scenario: string;
  phase: string;
  status: string;
  detail?: string;
}

/**
 * The one run this app is doing (or last did). It lives in the main process, so a window that is closed and opened again
 * asks for it and picks up where the run is; it never depends on the window that started it.
 */
export type RunStatus =
  | { state: 'idle' }
  | {
      state: 'preparing' | 'running' | 'finished' | 'failed';
      kind: 'start' | 'resume';
      repository: string;
      number: number;
      candidateId: string;
      profile: string;
      suite: string;
      runId?: string;
      /** A sentence for what is happening or what happened. */
      message: string;
      stopping: boolean;
      /** The latest progress, newest last, cut to a fixed length. */
      progress: RunProgressLine[];
      results?: Array<{ requirement: string; outcome: string }>;
      exitCode?: number;
    };

/** A pull request as the person saw it. The head is what they looked at; the privileged side refuses if it has moved. */
export interface PullTarget {
  repository: string;
  number: number;
  headSha: string;
}

/** A suite to run on a Linux runner through GitHub, for the head and candidate the person was looking at. */
export interface RemoteRunRequest extends PullTarget {
  candidateId: string;
  profile: string;
  suite: string;
}

/** Mirrors `RemoteRunState` in the shared package; declared here so the window's program does not import Node-side code. */
export type RemoteRunState = 'queued' | 'runner-unavailable' | 'running' | 'blocked' | 'completed';

export interface RemoteRunView {
  runId: number;
  attempt: number;
  url: string;
  createdAt: string;
  candidateId: string;
  profile: string;
  suite: string;
  headSha: string;
  /** Exactly one; see `remoteRunStatus` in the shared package for how each is decided and what the heuristics cannot know. */
  state: RemoteRunState;
  /** Only when `state` is `completed`. */
  conclusion?: string;
  detail: string;
}

/** Read from GitHub each time, never from what this app remembers. `configured: false` means the project has no run workflow. */
export type RemoteRunsResult = { ok: true; configured: boolean; runs: RemoteRunView[] } | { ok: false; error: string };

export type MergeMethod = 'merge' | 'squash' | 'rebase';
export const MERGE_METHODS: readonly MergeMethod[] = ['merge', 'squash', 'rebase'];

export interface MergeRequest extends PullTarget {
  method: MergeMethod;
  /** The candidate the person reviewed; a merge is refused if a different one is active by now. Absent for an ordinary PR. */
  candidateId?: string;
}

/** What a merge would do, read fresh from GitHub, for the confirmation the person sees before anything happens. */
export type MergePreviewResult =
  | {
      ok: true;
      headSha: string;
      baseRef: string;
      readiness: Evaluation['readiness'];
      candidateId?: string;
      candidateReleaseId?: number;
      /** True when this is a release pull request: merging is what authorizes publication of the tested binaries. */
      publishes: boolean;
      releaseIntent: string[];
    }
  | { ok: false; error: string };

/** `uncertain` marks a failure whose outcome is not known (a merge may or may not have gone through): re-read before acting again. */
export type ActionResult = { ok: true; message: string } | { ok: false; error: string; uncertain?: true };

/** One manual requirement of one pull request, as the person saw it. The privileged side finds the candidate itself. */
export interface ManualTarget extends PullTarget {
  requirement: string;
}

export type ManualOutcomeChoice = 'passed' | 'failed' | 'blocked';
export const MANUAL_OUTCOME_CHOICES: readonly ManualOutcomeChoice[] = ['passed', 'failed', 'blocked'];
/** The limits are enforced again by the shared recording; these only let the window say so before asking. */
export const MANUAL_NOTES_MAX = 5000;
export const MANUAL_EVIDENCE_MAX = 10;

/** A file the person chose. `token` is a handle held by the privileged process; the window never learns the path. */
export interface EvidenceChoice {
  token: string;
  name: string;
  bytes: number;
}
/** An empty list means the dialog was cancelled. */
export type PickEvidenceResult = { ok: true; files: EvidenceChoice[] } | { ok: false; error: string };

export interface ManualRecordRequest extends ManualTarget {
  outcome: ManualOutcomeChoice;
  notes: string;
  /** Handles from `pickEvidence`. */
  evidence: string[];
}

export interface ManualClaimRequest extends ManualTarget {
  intent: 'claim' | 'release';
}

/** A manual result recorded on this computer. `synced` is false until GitHub has it and the acknowledgement was verified. */
export interface ManualResultView {
  runId: string;
  outcome: ManualOutcomeChoice;
  /** The GitHub login the result was recorded under. */
  reporter: string;
  recordedAt: string;
  evidenceCount: number;
  synced: boolean;
  /** Set when the saved result is damaged and cannot be uploaded. */
  problem?: string;
}

export interface ClaimView {
  actor: string;
  action: 'claim' | 'takeover' | 'release';
  recordedAt: string;
  /** Older than the claim's own limit. A stale claim is still shown, and anyone may take over or ignore it. */
  stale: boolean;
  mine: boolean;
}

export interface ManualCheckState {
  /** Who GitHub says is signed in. Results are recorded as this login and cannot be recorded as anyone else. */
  login: string;
  requirement: RequirementView;
  candidateId: string;
  /** Advisory only: nothing here prevents anyone from recording a result. */
  owner?: ClaimView;
  results: ManualResultView[];
  readOnly: boolean;
}
export type ManualCheckStateResult = { ok: true; state: ManualCheckState } | { ok: false; error: string };
export type ManualRecordResult = { ok: true; message: string; result: ManualResultView } | { ok: false; error: string };

/** Repository permissions as the transport reports them. Only `write` and above may run, sync or merge. */
export type Role = 'admin' | 'maintain' | 'write' | 'triage' | 'read';

export interface RequirementView {
  key: string;
  title: string;
  mode: 'automated' | 'manual';
  profile: string;
}

/** What the shared evaluator returned for one pull request, untouched, plus where it came from. */
export type GateView =
  | {
      status: 'evaluated';
      /** The evaluator's own result. The window formats it; it never recomputes readiness from it. */
      evaluation: Evaluation;
      candidateId?: string;
      candidateReleaseId?: number;
    }
  | { status: 'unavailable'; error: string };

export interface PullRequestView {
  number: number;
  title: string;
  author: string;
  url: string;
  headRef: string;
  headSha: string;
  draft: boolean;
  /**
   * Why this is a release pull request; empty for an ordinary one. Absent when the gate could not be evaluated, because
   * then it is not known whether this is a release, and it must never be shown as one that is not.
   */
  releaseIntent?: string[];
  gate: GateView;
}

export interface ReleaseHistoryEntry {
  tag: string;
  name: string;
  publishedAt: string;
  url: string;
  /** `missing` is a release published without a QA record: shown, never hidden or treated as passed. */
  qa: 'recorded' | 'missing';
}

export type HistoryView = { status: 'ok'; releases: ReleaseHistoryEntry[] } | { status: 'unavailable'; reason: string };

export interface ProjectView {
  repository: string;
  projectId: string;
  releaseBranch: string;
  role: Role;
  /** Read-only users can look at everything and change nothing. */
  readOnly: boolean;
  profiles: string[];
  suites: Array<{ id: string; requirements: string[] }>;
  requirements: RequirementView[];
  /** Present only when the project declares `workflows.run`: the workflow, and the Linux (profile, suite) pairs it can run. */
  remoteRun?: { workflow: string; options: Array<{ profile: string; suite: string }> };
  pullRequests: { status: 'ok'; items: PullRequestView[] } | { status: 'unavailable'; reason: string };
  history: HistoryView;
}

export type AccountView = { status: 'signed-in'; login: string } | { status: 'signed-out'; reason: string };

export interface DashboardSnapshot {
  /** When this data was read from GitHub (or, for a stale snapshot, when the cached copy was). */
  loadedAt: string;
  /** True when GitHub could not be read and this is the last good copy. */
  stale: boolean;
  account: AccountView;
  projects: ProjectView[];
  /** Repositories that could not be read. Listed beside the projects that could. */
  problems: Array<{ repository: string; reason: string }>;
}
