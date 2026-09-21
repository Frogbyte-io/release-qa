import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import type { EnvironmentProfile } from '../model/project.ts';
import type { MeasuredEnvironment } from '../model/result.ts';

/** How the runner asks the machine what it can do. Injectable so tests need no display or sound card. */
export interface EnvironmentProbes {
  display(): Promise<boolean>;
  audio(): Promise<boolean>;
}

/**
 * Heuristics, not proof. `display` says a graphical session appears to be reachable; `audio` says the sound
 * subsystem appears to be running. Neither checks that a particular device exists or that a virtual display is
 * not standing in for a real one; a scenario that needs that must check it itself.
 */
export const defaultProbes: EnvironmentProbes = {
  async display() {
    if (platform() === 'win32') {
      // Services run in a non-interactive session, which is named "Services".
      const session = process.env.SESSIONNAME;
      return session !== undefined && session !== '' && session !== 'Services';
    }
    return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  },
  async audio() {
    if (platform() === 'win32') return (await run('sc', ['query', 'Audiosrv'])).includes('RUNNING');
    const cards = await readFile('/proc/asound/cards', 'utf8').catch(() => '');
    return cards.trim() !== '' && !cards.includes('no soundcards');
  },
};

function run(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, [...args], { timeout: 5000, windowsHide: true }, (error, stdout) => resolve(error ? '' : stdout));
  });
}

export interface InspectedEnvironment {
  environment: MeasuredEnvironment;
  /** Set when the machine is not what the profile asks for (operating system or architecture). */
  profileMismatch?: string;
}

const OS_NAMES: Record<string, string> = { win32: 'windows', linux: 'linux', darwin: 'macos' };
const ARCH_NAMES: Record<string, string> = { x64: 'x86_64', arm64: 'aarch64' };

/** Measures this machine. A probe that throws means the capability is absent, never a crash of the run. */
export async function inspectEnvironment(profile: EnvironmentProfile, probes: EnvironmentProbes = defaultProbes, toolVersion = '0.0.0'): Promise<InspectedEnvironment> {
  // Run inside a promise so a probe that throws before returning one is caught too, not only one that rejects.
  const has = (probe: () => Promise<boolean>): Promise<boolean> => Promise.resolve().then(probe).catch(() => false);
  const [display, audio] = await Promise.all([has(() => probes.display()), has(() => probes.audio())]);

  const os = OS_NAMES[platform()] ?? platform();
  const architecture = ARCH_NAMES[arch()] ?? arch();
  const environment: MeasuredEnvironment = {
    os,
    osVersion: release(),
    arch: architecture,
    capabilities: [...(audio ? ['audio'] : []), ...(display ? ['display'] : [])],
    toolVersion,
  };

  const problems: string[] = [];
  if (os !== profile.os) problems.push(`this machine is ${os}, the profile expects ${profile.os}`);
  if (architecture !== profile.arch) problems.push(`this machine is ${architecture}, the profile expects ${profile.arch}`);
  return problems.length === 0 ? { environment } : { environment, profileMismatch: problems.join('; ') };
}
