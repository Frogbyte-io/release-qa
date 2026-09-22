import { inspectEnvironment, type EnvironmentProbes } from '../runner/environment.ts';
import type { DisplayKind } from '../runner/display.ts';
import type { Project } from '../model/project.ts';
import type { MeasuredEnvironment } from '../model/result.ts';

export interface DoctorReport {
  /** Whether this machine is what the requested profile expects; not whether any particular suite can run. */
  ok: boolean;
  profile: string;
  machine: MeasuredEnvironment;
  display: { kind: DisplayKind; detail: string };
  mismatch?: string;
}

export type DoctorResult = { ok: true; report: DoctorReport } | { ok: false; error: string };

/** Measures this machine against a profile the project declares. Never throws: an unknown profile is a result, not an exception. */
export async function runDoctor(project: Project, profileId: string, probes?: EnvironmentProbes): Promise<DoctorResult> {
  const profile = project.profiles.find((p) => p.id === profileId);
  if (profile === undefined) {
    const known = project.profiles.map((p) => p.id).join(', ') || '(none declared)';
    return { ok: false, error: `profile "${profileId}" is not defined by this project; known profiles: ${known}` };
  }

  const inspected = await inspectEnvironment(profile, probes);
  return {
    ok: true,
    report: {
      ok: inspected.profileMismatch === undefined,
      profile: profileId,
      machine: inspected.environment,
      display: inspected.display,
      ...(inspected.profileMismatch === undefined ? {} : { mismatch: inspected.profileMismatch }),
    },
  };
}
