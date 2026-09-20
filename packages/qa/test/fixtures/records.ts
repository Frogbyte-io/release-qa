// Representative record builders. Every builder returns a valid record built from fixed IDs and
// hashes, and accepts shallow overrides so a test changes only what it is about.
import type { Artifact, Candidate } from '../../src/model/candidate.ts';
import type { Exception } from '../../src/model/exception.ts';
import type { Project } from '../../src/model/project.ts';
import type { Requirement } from '../../src/model/requirement.ts';
import type { Report } from '../../src/model/result.ts';

export const SHA1 = {
  source: '1'.repeat(40),
  base: '2'.repeat(40),
  tree: '3'.repeat(40),
  tests: '4'.repeat(40),
} as const;
export const SHA256 = { policy: 'a'.repeat(64), windowsInstaller: 'b'.repeat(64), linuxPackage: 'c'.repeat(64) } as const;

export function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    profile: 'windows',
    name: 'Release QA Smoke_0.1.0_x64-setup.exe',
    sha256: SHA256.windowsInstaller,
    assetId: 101,
    actionsArtifactId: 201,
    ...overrides,
  };
}

export function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    schemaVersion: 1,
    id: 'cand-0001',
    repositoryId: 1,
    pullRequest: 7,
    sourceSha: SHA1.source,
    baseSha: SHA1.base,
    sourceTreeSha: SHA1.tree,
    testRevision: SHA1.tests,
    policyDigest: SHA256.policy,
    build: { workflowPath: '.github/workflows/qa-prepare.yml', runId: 5000, attempt: 1 },
    artifacts: [
      artifact(),
      artifact({ profile: 'linux', name: 'release-qa-smoke_0.1.0_amd64.deb', sha256: SHA256.linuxPackage, assetId: 102, actionsArtifactId: 202 }),
    ],
    ...overrides,
  };
}

export function requirement(overrides: Partial<Requirement> = {}): Requirement {
  return {
    key: 'windows/persistence',
    mode: 'automated',
    title: 'The saved setting survives a restart',
    capabilities: [],
    ...overrides,
  };
}

export function project(overrides: Partial<Project> = {}): Project {
  const persistence = requirement();
  const deviceFeel = requirement({ key: 'windows/device-feel', mode: 'manual', title: 'Sliders feel right', capabilities: ['hardware'] });
  const linuxPersistence = requirement({ key: 'linux/persistence' });
  return {
    schemaVersion: 1,
    projectId: 'tauri-smoke',
    releaseBranch: 'main',
    profiles: [
      { id: 'windows', os: 'windows', arch: 'x86_64' },
      { id: 'linux', os: 'linux', arch: 'x86_64' },
    ],
    requirements: [persistence, deviceFeel, linuxPersistence],
    suites: [
      { id: 'smoke', requirements: [persistence.key, linuxPersistence.key] },
      { id: 'release', requirements: [persistence.key, deviceFeel.key, linuxPersistence.key] },
    ],
    scenarioFiles: ['scenarios/persistence.spec.ts'],
    lifecycleModule: 'lifecycle.ts',
    workflows: { prepare: 'qa-prepare.yml', gate: 'qa-gate.yml', publish: 'qa-publish.yml' },
    markers: { releaseNotes: 'release-notes', qa: 'qa' },
    ...overrides,
  };
}

export function report(overrides: Partial<Report> = {}): Report {
  return {
    schemaVersion: 1,
    id: 'report-0001',
    candidateId: 'cand-0001',
    policyDigest: SHA256.policy,
    testRevision: SHA1.tests,
    profile: 'windows',
    actor: 'tester',
    machineId: 'lab-win-01',
    environment: { os: 'windows', osVersion: '10.0.26200', arch: 'x86_64', capabilities: ['display', 'audio'], toolVersion: '0.0.0' },
    attempts: [{ id: 'attempt-0001', requirement: 'windows/persistence', outcome: 'passed', evidence: ['evidence/persistence.png'] }],
    ...overrides,
  };
}

export function exception(overrides: Partial<Exception> = {}): Exception {
  return {
    schemaVersion: 1,
    id: 'exception-0001',
    candidateId: 'cand-0001',
    requirements: ['windows/device-feel'],
    reason: 'No slider hardware available in the lab',
    actor: 'maintainer',
    createdAt: '2026-09-20T12:00:00Z',
    ...overrides,
  };
}
