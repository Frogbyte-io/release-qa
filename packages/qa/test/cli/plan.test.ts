import { describe, expect, test } from 'vitest';
import { selectPlan } from '../../src/cli/plan.ts';
import type { Project } from '../../src/model/project.ts';
import type { Requirement } from '../../src/model/requirement.ts';

const req = (key: `${string}/${string}`, mode: Requirement['mode'] = 'automated'): Requirement => ({ key, mode, title: key, capabilities: [] });

const project = (): Project => ({
  schemaVersion: 1,
  projectId: 'sample',
  releaseBranch: 'main',
  profiles: [
    { id: 'windows', os: 'windows', arch: 'x86_64' },
    { id: 'linux', os: 'linux', arch: 'x86_64' },
  ],
  requirements: [req('windows/persistence'), req('windows/audio', 'manual'), req('linux/persistence'), req('windows/startup')],
  suites: [
    { id: 'release', requirements: ['windows/persistence', 'windows/audio', 'linux/persistence'] },
    { id: 'linux-only', requirements: ['linux/persistence'] },
  ],
  scenarioFiles: [],
  lifecycleModule: 'lifecycle.ts',
  workflows: { prepare: 'a.yml', gate: 'b.yml', publish: 'c.yml' },
  markers: { releaseNotes: 'release-notes', qa: 'qa' },
});

describe('selecting what a run covers', () => {
  test('takes the suite\'s requirements for this profile only, split into automated and manual, in suite order', () => {
    const plan = selectPlan(project(), 'windows', 'release');
    expect(plan).toEqual({ ok: true, profile: project().profiles[0], automated: [req('windows/persistence')], manual: [req('windows/audio', 'manual')] });
  });

  test('requirements outside the suite are not included, even for the same profile', () => {
    const plan = selectPlan(project(), 'windows', 'release');
    expect(plan.ok && plan.automated.map((r) => r.key)).not.toContain('windows/startup');
  });

  test.each([
    ['an unknown profile', 'macos', 'release', /profile "macos".*windows, linux/],
    ['an unknown suite', 'windows', 'nightly', /suite "nightly".*release, linux-only/],
    ['a suite with nothing for this profile', 'windows', 'linux-only', /nothing for profile "windows"/],
  ])('%s is refused with a message saying what exists', (_label, profile, suite, pattern) => {
    const plan = selectPlan(project(), profile, suite);
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.error).toMatch(pattern);
  });
});
