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
  if (facts.platform !== 'linux') return { kind: 'unknown', detail: `cannot tell on ${facts.platform}` };

  const { DISPLAY: display, WAYLAND_DISPLAY: wayland, XDG_SESSION_TYPE: session } = facts.env;
  if (!display && !wayland) return { kind: 'none', detail: 'neither DISPLAY nor WAYLAND_DISPLAY is set' };

  if (display) {
    for (const line of facts.commandLines) {
      const [program = '', ...args] = line.trim().split(/\s+/);
      const name = basename(program);
      if (VIRTUAL_SERVERS.has(name) && args.includes(display)) return { kind: 'virtual', detail: `${name} serving ${display}` };
    }
  }
  if ((session === 'x11' && display) || (session === 'wayland' && (wayland || display))) return { kind: 'real', detail: `${session} desktop session` };
  return { kind: 'unknown', detail: `a display is set (${display ?? wayland}) but it is not evidently a desktop session or a virtual server` };
}

/** Reads what this machine says. Best effort: anything unreadable is simply absent from the facts. */
export async function readDisplayFacts(): Promise<DisplayFacts> {
  const platform = hostPlatform();
  return { platform, env: process.env, commandLines: platform === 'linux' ? await linuxCommandLines() : [] };
}

async function linuxCommandLines(): Promise<string[]> {
  const entries = await readdir('/proc').catch(() => [] as string[]);
  const lines = await Promise.all(
    entries
      .filter((name) => /^\d+$/.test(name))
      .slice(0, 5000)
      .map((pid) => readFile(`/proc/${pid}/cmdline`, 'utf8').then((text) => text.split('\0').join(' ').trim(), () => '')),
  );
  return lines.filter((line) => line !== '');
}
