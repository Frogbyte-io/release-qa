import { describe, expect, test } from 'vitest';
import { runDoctor, type DoctorReport } from '../../src/cli/doctor.ts';
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

/** Unwraps a successful result so a failure surfaces its own message instead of a confusing matcher error. */
async function report(...args: Parameters<typeof runDoctor>): Promise<DoctorReport> {
  const result = await runDoctor(...args);
  if (!result.ok) throw new Error(result.error);
  return result.report;
}

describe('doctor', () => {
  test('an unknown profile id is a clear error listing the known ones', async () => {
    const result = await runDoctor(project(), 'macos', probes(true, true));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(hostOs());
    expect(!result.ok && result.error).toContain('macos');
  });

  test('a machine matching the requested profile is reported ready', async () => {
    const doctorReport = await report(project(), hostProfile().id, probes(true, true));
    expect(doctorReport.ok).toBe(true);
    expect(doctorReport.mismatch).toBeUndefined();
    expect(doctorReport.machine.capabilities).toEqual(expect.arrayContaining(['audio', 'display']));
  });

  test('a profile this machine does not match is reported, not silently passed', async () => {
    const doctorReport = await report(project(), 'other', probes(true, true));
    expect(doctorReport.ok).toBe(false);
    expect(doctorReport.mismatch).toBeDefined();
  });

  test('reports the display kind alongside the raw capability list', async () => {
    const doctorReport = await report(project(), hostProfile().id, { display: async () => false, audio: async () => false });
    expect(doctorReport.display.kind).toBe('none');
    expect(doctorReport.machine.capabilities).toEqual([]);
  });
});
