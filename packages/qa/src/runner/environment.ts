import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import type { EnvironmentProfile } from '../model/project.ts';
import type { MeasuredEnvironment } from '../model/result.ts';
import { classifyDisplay, readDisplayFacts, type DisplayKind } from './display.ts';

/** How the runner asks the machine what it can do. Injectable so tests need no display or sound card. */
export interface EnvironmentProbes {
  display(): Promise<boolean>;
  audio(): Promise<boolean>;
  /** What kind of display it is, when the probe can tell. Without it a display is of unknown kind. */
  describeDisplay?(): Promise<{ kind: DisplayKind; detail: string }>;
}

/**
 * Heuristics, not proof. `display` says a graphical session appears to be reachable and `describeDisplay` says
 * whether it looks virtual or real, or admits it cannot tell; `audio` says the sound subsystem appears to be
 * running. Neither checks that a particular device exists.
 */
export const defaultProbes: EnvironmentProbes = {
  async display() {
    return classifyDisplay(await readDisplayFacts()).kind !== 'none';
  },
  async describeDisplay() {
    return classifyDisplay(await readDisplayFacts());
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
  /** What the machine's display is, for reports and `doctor`. */
  display: { kind: DisplayKind; detail: string };
  /** Set when the machine is not what the profile asks for (operating system or architecture). */
  profileMismatch?: string;
}

const OS_NAMES: Record<string, string> = { win32: 'windows', linux: 'linux', darwin: 'macos' };
const ARCH_NAMES: Record<string, string> = { x64: 'x86_64', arm64: 'aarch64' };

/**
 * Measures this machine. A probe that throws means the capability is absent, never a crash of the run. A display
 * is a `display` capability, and only a display that is evidently a desktop session is also a `real-display`.
 */
export async function inspectEnvironment(profile: EnvironmentProfile, probes: EnvironmentProbes = defaultProbes, toolVersion = '0.0.0'): Promise<InspectedEnvironment> {
  // Run inside a promise so a probe that throws before returning one is caught too, not only one that rejects.
  const has = (probe: () => Promise<boolean>): Promise<boolean> => Promise.resolve().then(probe).catch(() => false);
  const [audio, display] = await Promise.all([has(() => probes.audio()), describeDisplay(probes)]);

  const os = OS_NAMES[platform()] ?? platform();
  const architecture = ARCH_NAMES[arch()] ?? arch();
  const environment: MeasuredEnvironment = {
    os,
    osVersion: release(),
    arch: architecture,
    capabilities: [...(audio ? ['audio'] : []), ...(display.kind !== 'none' ? ['display'] : []), ...(display.kind === 'real' ? ['real-display'] : [])],
    toolVersion,
  };

  const problems: string[] = [];
  if (os !== profile.os) problems.push(`this machine is ${os}, the profile expects ${profile.os}`);
  if (architecture !== profile.arch) problems.push(`this machine is ${architecture}, the profile expects ${profile.arch}`);
  return problems.length === 0 ? { environment, display } : { environment, display, profileMismatch: problems.join('; ') };
}

/** A probe that can only say yes or no describes a display of unknown kind; one that throws describes none. */
async function describeDisplay(probes: EnvironmentProbes): Promise<{ kind: DisplayKind; detail: string }> {
  try {
    if (probes.describeDisplay !== undefined) return await probes.describeDisplay();
    return (await probes.display()) ? { kind: 'unknown', detail: 'a display is present but its kind cannot be told' } : { kind: 'none', detail: 'no display' };
  } catch {
    return { kind: 'none', detail: 'the display probe failed' };
  }
}
