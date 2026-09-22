import { readdir, readFile } from 'node:fs/promises';
import { platform as hostPlatform } from 'node:os';
import { basename } from 'node:path';

/**
 * `virtual`: a display server that is not a screen (Xvfb and friends). `real`: the machine's own graphical
 * session. `unknown`: something answers on a display but nothing shows which. `none`: no display at all.
 */
export type DisplayKind = 'none' | 'virtual' | 'real' | 'unknown';

/** What the machine says about its graphical session. Gathered separately so classification stays pure. */
export interface DisplayFacts {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  /** Command lines of the running processes (Linux only; empty elsewhere). */
  commandLines: readonly string[];
}

/** X servers that draw to memory or a remote viewer rather than to a screen. */
const VIRTUAL_SERVERS = new Set(['Xvfb', 'Xvnc', 'Xdummy']);

/**
 * Never guesses: it names a display virtual only when it can see the virtual server that serves it, and real only
 * when the session says it is a desktop session. Anything else that has a display is `unknown`, and the caller
 * decides what to do with that. The operating system's name alone never decides.
 */
export function classifyDisplay(facts: DisplayFacts): { kind: DisplayKind; detail: string } {
  if (facts.platform === 'win32') {
    // Services run in a session named "Services" with no desktop; an interactive one is "Console" or "RDP-Tcp#n".
    const session = facts.env.SESSIONNAME ?? '';
    return session !== '' && session !== 'Services' ? { kind: 'real', detail: `interactive session ${session}` } : { kind: 'none', detail: 'no interactive session' };
  }
  if (facts.platform !== 'linux') {
    // DISPLAY/WAYLAND_DISPLAY are not required by this platform's own native GUI apps, so their presence is only
    // weak evidence and their absence is not proof either way — except that with no evidence at all, a headless
    // host must not be handed a display capability it cannot back up.
    const { DISPLAY: otherDisplay, WAYLAND_DISPLAY: otherWayland } = facts.env;
    if (!otherDisplay && !otherWayland) return { kind: 'none', detail: `no display evidence on ${facts.platform}` };
    return { kind: 'unknown', detail: `cannot tell on ${facts.platform}` };
  }

  const { DISPLAY: display, WAYLAND_DISPLAY: wayland, XDG_SESSION_TYPE: session } = facts.env;
  if (!display && !wayland) return { kind: 'none', detail: 'neither DISPLAY nor WAYLAND_DISPLAY is set' };

  if (display) {
    const target = displayNumber(display);
    for (const line of facts.commandLines) {
      const [program = '', ...args] = line.trim().split(/\s+/);
      const name = basename(program);
      if (VIRTUAL_SERVERS.has(name) && target !== undefined && args.some((arg) => displayNumber(arg) === target)) return { kind: 'virtual', detail: `${name} serving ${display}` };
    }
  }
  if ((session === 'x11' && display) || (session === 'wayland' && (wayland || display))) return { kind: 'real', detail: `${session} desktop session` };
  return { kind: 'unknown', detail: `a display is set (${display ?? wayland}) but it is not evidently a desktop session or a virtual server` };
}

/**
 * The `:N` display number a DISPLAY-like string names, ignoring any host prefix and any `.screen` suffix: Xvfb's own
 * argument never carries a screen number (screens are configured separately, with `-screen`), but a client's
 * DISPLAY may still name one explicitly, and ":99.0" is the same endpoint as ":99".
 */
function displayNumber(raw: string): string | undefined {
  const match = /:(\d+)(?:\.\d+)?$/.exec(raw);
  return match === null ? undefined : `:${match[1]}`;
}

/** Reads what this machine says. Best effort: anything unreadable is simply absent from the facts. */
export async function readDisplayFacts(): Promise<DisplayFacts> {
  const platform = hostPlatform();
  return { platform, env: process.env, commandLines: platform === 'linux' ? await linuxCommandLines() : [] };
}

// Every process is read, not just the first few thousand: missing the one X server that happens to be serving this
// display would misclassify a virtual display as unknown or real. Read in bounded batches rather than opening every
// /proc/<pid>/cmdline at once, so a host with many thousands of processes cannot exhaust file descriptors.
const CMDLINE_BATCH_SIZE = 256;

async function linuxCommandLines(): Promise<string[]> {
  const entries = await readdir('/proc').catch(() => [] as string[]);
  const pids = entries.filter((name) => /^\d+$/.test(name));
  const lines: string[] = [];
  for (let start = 0; start < pids.length; start += CMDLINE_BATCH_SIZE) {
    const batch = pids.slice(start, start + CMDLINE_BATCH_SIZE);
    const read = await Promise.all(batch.map((pid) => readFile(`/proc/${pid}/cmdline`, 'utf8').then((text) => text.split('\0').join(' ').trim(), () => '')));
    lines.push(...read);
  }
  return lines.filter((line) => line !== '');
}
