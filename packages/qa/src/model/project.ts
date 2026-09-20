import { profileOf, readRequirement, type Requirement, type RequirementKey } from './requirement.ts';
import { at, Collector, item, parseVersioned, type FieldSpec, type ParseResult } from './validate.ts';

export interface EnvironmentProfile {
  id: string;
  os: 'windows' | 'linux';
  arch: 'x86_64';
}

export interface Suite {
  id: string;
  requirements: RequirementKey[];
}

/** The consumer's `qa/project.json`. Read as data only; discovery never executes project code. */
export interface Project {
  schemaVersion: 1;
  projectId: string;
  releaseBranch: string;
  profiles: EnvironmentProfile[];
  requirements: Requirement[];
  suites: Suite[];
  scenarioFiles: string[];
  lifecycleModule: string;
  workflows: { prepare: string; gate: string; publish: string };
  markers: { releaseNotes: string; qa: string };
}

const SPEC: FieldSpec = {
  required: ['projectId', 'releaseBranch', 'profiles', 'requirements', 'suites', 'scenarioFiles', 'lifecycleModule', 'workflows', 'markers'],
};
const PROFILE_SPEC: FieldSpec = { required: ['id', 'os', 'arch'] };
const SUITE_SPEC: FieldSpec = { required: ['id', 'requirements'] };
const WORKFLOWS_SPEC: FieldSpec = { required: ['prepare', 'gate', 'publish'] };
const MARKERS_SPEC: FieldSpec = { required: ['releaseNotes', 'qa'] };

export function parseProject(input: unknown): ParseResult<Project> {
  return parseVersioned(input, SPEC, (c, rec) => {
    const profiles = (c.array(rec.profiles, 'profiles', { min: 1 }) ?? []).map((v, i) => readProfile(c, v, item('profiles', i)));
    c.unique(profiles.map((p, i) => ({ value: p?.id, path: at(item('profiles', i), 'id') })));
    const profileIds = new Set(profiles.flatMap((p) => (p?.id === undefined ? [] : [p.id])));

    const requirements = (c.array(rec.requirements, 'requirements', { min: 1 }) ?? []).map((v, i) => readRequirement(c, v, item('requirements', i)));
    c.unique(requirements.map((r, i) => ({ value: r?.key, path: at(item('requirements', i), 'key') })));
    requirements.forEach((r, i) => {
      if (r?.key !== undefined && !profileIds.has(profileOf(r.key))) {
        c.add('unknown-reference', at(item('requirements', i), 'key'), `profile "${profileOf(r.key)}" is not defined by this project`);
      }
    });
    const definedKeys = new Set(requirements.flatMap((r) => (r?.key === undefined ? [] : [r.key])));

    const suites = (c.array(rec.suites, 'suites') ?? []).map((v, i) => readSuite(c, v, item('suites', i), definedKeys));
    c.unique(suites.map((s, i) => ({ value: s?.id, path: at(item('suites', i), 'id') })));

    const scenarioFiles = (c.array(rec.scenarioFiles, 'scenarioFiles') ?? []).map((v, i) => c.relativePath(v, item('scenarioFiles', i)));

    const workflows = c.record(rec.workflows, 'workflows', WORKFLOWS_SPEC);
    const markers = c.record(rec.markers, 'markers', MARKERS_SPEC);
    const releaseNotesMarker = markers && c.name(markers.releaseNotes, 'markers.releaseNotes');
    const qaMarker = markers && c.name(markers.qa, 'markers.qa');
    c.unique([
      { value: releaseNotesMarker, path: 'markers.releaseNotes' },
      { value: qaMarker, path: 'markers.qa' },
    ]);

    return {
      schemaVersion: 1,
      projectId: c.id(rec.projectId, 'projectId'),
      releaseBranch: c.branchName(rec.releaseBranch, 'releaseBranch'),
      profiles,
      requirements,
      suites,
      scenarioFiles,
      lifecycleModule: c.relativePath(rec.lifecycleModule, 'lifecycleModule'),
      workflows: workflows && {
        prepare: c.fileName(workflows.prepare, 'workflows.prepare'),
        gate: c.fileName(workflows.gate, 'workflows.gate'),
        publish: c.fileName(workflows.publish, 'workflows.publish'),
      },
      markers: markers && { releaseNotes: releaseNotesMarker, qa: qaMarker },
    } as Project;
  });
}

function readProfile(c: Collector, value: unknown, path: string): EnvironmentProfile | undefined {
  const rec = c.record(value, path, PROFILE_SPEC);
  if (rec === undefined) return undefined;
  return {
    id: c.profileId(rec.id, at(path, 'id')),
    os: c.oneOf(rec.os, at(path, 'os'), ['windows', 'linux']),
    arch: c.oneOf(rec.arch, at(path, 'arch'), ['x86_64']),
  } as EnvironmentProfile;
}

function readSuite(c: Collector, value: unknown, path: string, definedKeys: ReadonlySet<string>): Suite | undefined {
  const rec = c.record(value, path, SUITE_SPEC);
  if (rec === undefined) return undefined;
  const listPath = at(path, 'requirements');
  const keys = (c.array(rec.requirements, listPath, { min: 1 }) ?? []).map((v, i) => c.requirementKey(v, item(listPath, i)));
  c.unique(keys.map((k, i) => ({ value: k, path: item(listPath, i) })));
  keys.forEach((k, i) => {
    if (k !== undefined && !definedKeys.has(k)) c.add('unknown-reference', item(listPath, i), `"${k}" is not a requirement of this project`);
  });
  return { id: c.id(rec.id, at(path, 'id')), requirements: keys } as Suite;
}
