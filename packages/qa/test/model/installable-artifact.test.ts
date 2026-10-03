import { describe, expect, test } from 'vitest';
import { installableArtifact, type Artifact } from '../../src/model/candidate.ts';
import { candidate } from '../fixtures/records.ts';

const file = (name: string, assetId: number, profile = 'windows'): Artifact => ({ profile, name, sha256: 'a'.repeat(64), assetId, actionsArtifactId: 9 });

describe('the installable artifact of a profile', () => {
  test('is the installer whichever order the record lists it in', () => {
    const installer = file('app.exe', 1);
    const blockmap = file('app.exe.blockmap', 2);
    expect(installableArtifact(candidate({ artifacts: [installer, blockmap] }), 'windows')).toEqual({ ok: true, artifact: installer });
    expect(installableArtifact(candidate({ artifacts: [blockmap, installer] }), 'windows')).toEqual({ ok: true, artifact: installer });
  });

  test('ignores files of other profiles', () => {
    const deb = file('app.deb', 3, 'linux');
    expect(installableArtifact(candidate({ artifacts: [file('app.exe', 1), deb] }), 'linux')).toEqual({ ok: true, artifact: deb });
  });

  test('refuses a profile with no file, with only a blockmap, or with two installable files', () => {
    expect(installableArtifact(candidate({ artifacts: [file('app.exe', 1)] }), 'linux')).toMatchObject({ ok: false, error: expect.stringContaining('no artifact for profile linux') });
    expect(installableArtifact(candidate({ artifacts: [file('app.exe.blockmap', 2)] }), 'windows')).toMatchObject({ ok: false, error: expect.stringContaining('ambiguous') });
    expect(installableArtifact(candidate({ artifacts: [file('a.exe', 1), file('b.exe', 2)] }), 'windows')).toMatchObject({ ok: false, error: expect.stringContaining('more than one installable') });
  });
});
