import { at, Collector, item, parseVersioned, type FieldSpec, type ParseResult } from './validate.ts';

/** One file to test for one environment profile, located relative to the manifest that lists it. */
export interface LocalArtifact {
  profile: string;
  name: string;
  /** Relative to the manifest's own directory, with `/` separators; it cannot leave that directory. */
  path: string;
  sha256: string;
}

/**
 * A candidate built outside GitHub, for running a suite from a checkout (`release-qa run --candidate`). It names
 * the files to test and their expected hashes; it carries none of the source or build provenance a GitHub
 * candidate does, so it can never stand in for one at the merge gate.
 */
export interface LocalCandidate {
  schemaVersion: 1;
  id: string;
  artifacts: LocalArtifact[];
}

const SPEC: FieldSpec = { required: ['id', 'artifacts'] };
const ARTIFACT_SPEC: FieldSpec = { required: ['profile', 'name', 'path', 'sha256'] };

export function parseLocalCandidate(input: unknown): ParseResult<LocalCandidate> {
  return parseVersioned(input, SPEC, (c, rec) => {
    const artifacts = (c.array(rec.artifacts, 'artifacts', { min: 1 }) ?? []).map((v, i) => readArtifact(c, v, item('artifacts', i)));
    c.unique(artifacts.map((a, i) => ({ value: a?.profile, path: at(item('artifacts', i), 'profile') })));
    return { schemaVersion: 1, id: c.id(rec.id, 'id'), artifacts } as LocalCandidate;
  });
}

function readArtifact(c: Collector, value: unknown, path: string): LocalArtifact | undefined {
  const rec = c.record(value, path, ARTIFACT_SPEC);
  if (rec === undefined) return undefined;
  return {
    profile: c.profileId(rec.profile, at(path, 'profile')),
    name: c.fileName(rec.name, at(path, 'name')),
    path: c.relativePath(rec.path, at(path, 'path')),
    sha256: c.sha256(rec.sha256, at(path, 'sha256')),
  } as LocalArtifact;
}
