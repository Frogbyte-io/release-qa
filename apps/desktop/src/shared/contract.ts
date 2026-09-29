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
} as const;

export interface QaBridge {
  loadDashboard(): Promise<DashboardSnapshot>;
  prepareCandidate(target: PullTarget): Promise<ActionResult>;
  previewMerge(target: PullTarget): Promise<MergePreviewResult>;
  mergePullRequest(request: MergeRequest): Promise<ActionResult>;
  openPullRequest(target: Pick<PullTarget, 'repository' | 'number'>): Promise<ActionResult>;
}

/** A pull request as the person saw it. The head is what they looked at; the privileged side refuses if it has moved. */
export interface PullTarget {
  repository: string;
  number: number;
  headSha: string;
}

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

export type ActionResult = { ok: true; message: string; url?: string } | { ok: false; error: string };

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
  requirements: RequirementView[];
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
