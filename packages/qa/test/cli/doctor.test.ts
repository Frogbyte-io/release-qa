import { describe, expect, test } from 'vitest';
import { runDoctor } from '../../src/cli/doctor.ts';
import type { Project } from '../../src/model/project.ts';
import { hostOs, hostProfile } from '../fixtures/processes.ts';

const project = (overrides: Partial<Project> = {}): Project => ({
  schemaVersion: 1,
  projectId: 'sample',
  releaseBranch: 'main',
  profiles: [hostProfile(), { id: 'other', os: hostOs() === 'windows' ? 'linux' : 'windows', arch: 'x86_64' }],
  requirements: [],
  suites: [],
  scenarioFiles: [],
  lifecycleModule: 'lifecycle.ts',
  workflows: { prepare: 'a.yml', gate: 'b.yml', publish: 'c.yml' },
  markers: { releaseNotes: 'release-notes', qa: 'qa' },
  ...overrides,
});

const probes = (display: boolean, audio: boolean) => ({ display: async () => display, audio: async () => audio });

describe('doctor', () => {
  test('an unknown profile id is a clear error listing the known ones', async () => {
    const result = await runDoctor(project(), 'macos', probes(true, true));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(hostOs());
    expect(!result.ok && result.error).toContain('macos');
  });

  test('a machine matching the requested profile is reported ready', async () => {
    const result = await runDoctor(project(), hostProfile().id, probes(true, true));
    expect(result.ok).toBe(true);
    expect(result.ok && result.report.ok).toBe(true);
    expect(result.ok && result.report.mismatch).toBeUndefined();
    expect(result.ok && result.report.machine.capabilities).toEqual(expect.arrayContaining(['audio', 'display']));
  });

  test('a profile this machine does not match is reported, not silently passed', async () => {
    const result = await runDoctor(project(), 'other', probes(true, true));
    expect(result.ok).toBe(true);
    expect(result.ok && result.report.ok).toBe(false);
    expect(result.ok && result.report.mismatch).toBeDefined();
  });

  test('reports the display kind alongside the raw capability list', async () => {
    const result = await runDoctor(project(), hostProfile().id, { display: async () => false, audio: async () => false });
    expect(result.ok && result.report.display.kind).toBe('none');
    expect(result.ok && result.report.machine.capabilities).toEqual([]);
  });
});
