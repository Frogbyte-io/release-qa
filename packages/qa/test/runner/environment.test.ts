import { release } from 'node:os';
import { describe, expect, test } from 'vitest';
import { defaultProbes, inspectEnvironment } from '../../src/runner/environment.ts';
import { hostArch, hostOs, hostProfile, otherArch } from '../fixtures/processes.ts';

const probes = (display: boolean, audio: boolean) => ({ display: async () => display, audio: async () => audio });

describe('inspectEnvironment', () => {
  test('measures the operating system, its version and the architecture of this machine', async () => {
    const { environment } = await inspectEnvironment(hostProfile(), probes(true, true), '1.2.3');
    expect(environment.os).toBe(hostOs());
    expect(environment.osVersion).toBe(release());
    expect(environment.arch).toBe(hostArch());
    expect(environment.toolVersion).toBe('1.2.3');
  });

  test('reports a capability only when its probe says the machine has it', async () => {
    expect((await inspectEnvironment(hostProfile(), probes(true, true))).environment.capabilities).toEqual(['audio', 'display']);
    expect((await inspectEnvironment(hostProfile(), probes(true, false))).environment.capabilities).toEqual(['display']);
    expect((await inspectEnvironment(hostProfile(), probes(false, true))).environment.capabilities).toEqual(['audio']);
    expect((await inspectEnvironment(hostProfile(), probes(false, false))).environment.capabilities).toEqual([]);
  });

  test('a probe that throws counts as the capability being absent, not as a crash', async () => {
    const broken = { display: async (): Promise<boolean> => { throw new Error('no session'); }, audio: async () => true };
    expect((await inspectEnvironment(hostProfile(), broken)).environment.capabilities).toEqual(['audio']);
  });

  test('a probe that throws before it even returns a promise is also just an absent capability', async () => {
    const boom = (): Promise<boolean> => { throw new Error('thrown synchronously'); };
    const inspected = await inspectEnvironment(hostProfile(), { display: boom, audio: boom });
    expect(inspected.environment.capabilities).toEqual([]);
  });

  test('reports no mismatch for the profile of this machine', async () => {
    const inspected = await inspectEnvironment(hostProfile(), probes(true, true));
    expect(inspected.environment.os).toBe(hostOs());
    expect(inspected.profileMismatch).toBeUndefined();
  });

  test('reports a mismatch when the profile asks for another operating system', async () => {
    const other = { ...hostProfile(), os: hostOs() === 'windows' ? ('linux' as const) : ('windows' as const) };
    const { profileMismatch } = await inspectEnvironment(other, probes(true, true));
    expect(profileMismatch).toContain(other.os);
    expect(profileMismatch).toContain(hostOs());
  });

  test('reports a mismatch when the profile asks for another architecture', async () => {
    // The profile type only allows x86_64 today; a profile for any architecture that is not this machine's must be refused.
    const other = { ...hostProfile(), arch: otherArch() } as unknown as ReturnType<typeof hostProfile>;
    const { profileMismatch } = await inspectEnvironment(other, probes(true, true));
    expect(profileMismatch).toContain(otherArch());
    expect(profileMismatch).toContain(hostArch());
  });

  test('the default probes answer with a boolean and never throw, whatever this machine has', async () => {
    expect(typeof (await defaultProbes.display())).toBe('boolean');
    expect(typeof (await defaultProbes.audio())).toBe('boolean');
  });
});
