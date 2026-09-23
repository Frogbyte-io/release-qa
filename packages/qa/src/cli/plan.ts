import type { EnvironmentProfile, Project } from '../model/project.ts';
import { profileOf, type Requirement } from '../model/requirement.ts';

export type Plan =
  | { ok: true; profile: EnvironmentProfile; automated: Requirement[]; manual: Requirement[] }
  | { ok: false; error: string };

/**
 * What one run covers: the suite's requirements for this profile, in suite order. Manual requirements are listed
 * but never run; they are work left for a person. A suite with nothing for the profile is refused rather than
 * reported as an empty pass.
 */
export function selectPlan(project: Project, profileId: string, suiteId: string): Plan {
  const profile = project.profiles.find((p) => p.id === profileId);
  if (profile === undefined) return { ok: false, error: `profile "${profileId}" is not defined by this project; known profiles: ${project.profiles.map((p) => p.id).join(', ')}` };
  const suite = project.suites.find((s) => s.id === suiteId);
  if (suite === undefined) return { ok: false, error: `suite "${suiteId}" is not defined by this project; known suites: ${project.suites.map((s) => s.id).join(', ') || '(none)'}` };

  const byKey = new Map(project.requirements.map((r) => [r.key, r]));
  const selected = suite.requirements.filter((key) => profileOf(key) === profileId).flatMap((key) => byKey.get(key) ?? []);
  if (selected.length === 0) return { ok: false, error: `suite "${suiteId}" has nothing for profile "${profileId}"` };
  return { ok: true, profile, automated: selected.filter((r) => r.mode === 'automated'), manual: selected.filter((r) => r.mode === 'manual') };
}
