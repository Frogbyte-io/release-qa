import { at, Collector, item, parseVersioned, type FieldSpec, type ParseResult } from './validate.ts';

export interface Artifact {
  profile: string;
  name: string;
  sha256: string;
  assetId: number;
  actionsArtifactId: number;
}

export interface Candidate {
  schemaVersion: 1;
  id: string;
  repositoryId: number;
  pullRequest: number;
  sourceSha: string;
  baseSha: string;
  sourceTreeSha: string;
  testRevision: string;
  policyDigest: string;
  build: { workflowPath: string; runId: number; attempt: number };
  artifacts: Artifact[];
}

const SPEC: FieldSpec = {
  required: ['id', 'repositoryId', 'pullRequest', 'sourceSha', 'baseSha', 'sourceTreeSha', 'testRevision', 'policyDigest', 'build', 'artifacts'],
};
const BUILD_SPEC: FieldSpec = { required: ['workflowPath', 'runId', 'attempt'] };
const ARTIFACT_SPEC: FieldSpec = { required: ['profile', 'name', 'sha256', 'assetId', 'actionsArtifactId'] };

export function parseCandidate(input: unknown): ParseResult<Candidate> {
  return parseVersioned(input, SPEC, (c, rec) => {
    const build = c.record(rec.build, 'build', BUILD_SPEC);
    const artifactValues = c.array(rec.artifacts, 'artifacts', { min: 1 }) ?? [];
    const artifacts = artifactValues.map((value, i) => readArtifact(c, value, item('artifacts', i)));

    // An asset is one downloadable file; a profile cannot ship two files of the same name.
    c.unique(artifacts.map((a, i) => ({ value: a?.assetId === undefined ? undefined : String(a.assetId), path: at(item('artifacts', i), 'assetId') })));
    c.unique(artifacts.map((a, i) => ({ value: a?.profile === undefined || a.name === undefined ? undefined : `${a.profile}/${a.name}`, path: at(item('artifacts', i), 'name') })));

    return {
      schemaVersion: 1,
      id: c.id(rec.id, 'id'),
      repositoryId: c.int(rec.repositoryId, 'repositoryId'),
      pullRequest: c.int(rec.pullRequest, 'pullRequest'),
      sourceSha: c.gitSha(rec.sourceSha, 'sourceSha'),
      baseSha: c.gitSha(rec.baseSha, 'baseSha'),
      sourceTreeSha: c.gitSha(rec.sourceTreeSha, 'sourceTreeSha'),
      testRevision: c.gitSha(rec.testRevision, 'testRevision'),
      policyDigest: c.sha256(rec.policyDigest, 'policyDigest'),
      build: build && {
        workflowPath: c.relativePath(build.workflowPath, 'build.workflowPath'),
        runId: c.int(build.runId, 'build.runId'),
        attempt: c.int(build.attempt, 'build.attempt'),
      },
      artifacts,
    } as Candidate;
  });
}

function readArtifact(c: Collector, value: unknown, path: string): Artifact | undefined {
  const rec = c.record(value, path, ARTIFACT_SPEC);
  if (rec === undefined) return undefined;
  return {
    profile: c.profileId(rec.profile, at(path, 'profile')),
    name: c.fileName(rec.name, at(path, 'name')),
    sha256: c.sha256(rec.sha256, at(path, 'sha256')),
    assetId: c.int(rec.assetId, at(path, 'assetId')),
    actionsArtifactId: c.int(rec.actionsArtifactId, at(path, 'actionsArtifactId')),
  } as Artifact;
}
