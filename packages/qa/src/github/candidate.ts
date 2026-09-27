import type { Candidate } from '../model/candidate.ts';

export interface BuildRun {
  id: number;
  run_attempt: number;
  path: string;
  head_sha: string;
  conclusion: string | null;
  repository: { id: number };
}

export interface ReleaseAsset {
  id: number;
  name: string;
  state: string;
  digest?: string;
}

export interface ActionsArtifact {
  id: number;
  name: string;
  expired: boolean;
  workflow_run: { id: number; repository_id: number; head_sha: string };
}

/** Checks identities from the API; a caller must still hash downloaded bytes before use or selection. */
export function verifyCandidateAssets(candidate: Candidate, run: BuildRun, releases: readonly ReleaseAsset[], actions: readonly ActionsArtifact[]): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const workflowPath = run.path.split('@')[0];
  if (run.id !== candidate.build.runId || run.run_attempt !== candidate.build.attempt ||
      workflowPath === undefined || !workflowPath.endsWith(`/${candidate.build.workflowPath}`) ||
      run.head_sha !== candidate.sourceSha || run.repository.id !== candidate.repositoryId || run.conclusion !== 'success') {
    issues.push('recorded build run does not match a successful candidate preparation');
  }
  for (const artifact of candidate.artifacts) {
    const release = releases.find((item) => item.id === artifact.assetId);
    if (release === undefined || release.name !== artifact.name || release.state !== 'uploaded' || release.digest !== `sha256:${artifact.sha256}`) {
      issues.push(`${artifact.profile}/${artifact.name}: draft release asset identity or SHA-256 differs`);
    }
    const action = actions.find((item) => item.id === artifact.actionsArtifactId);
    // An expired archive is not needed for download once the exact release asset survives, but its recorded origin is.
    if (action === undefined || action.workflow_run.id !== candidate.build.runId ||
        action.workflow_run.repository_id !== candidate.repositoryId || action.workflow_run.head_sha !== candidate.sourceSha) {
      issues.push(`${artifact.profile}/${artifact.name}: Actions artifact is not from the recorded build`);
    }
  }
  return { ok: issues.length === 0, issues };
}
