import { describe, expect, test } from 'vitest';
import { classifyDisplay, readDisplayFacts, type DisplayFacts } from '../../src/runner/display.ts';

const linux = (env: Record<string, string>, commandLines: string[] = []): DisplayFacts => ({ platform: 'linux', env, commandLines });
const windows = (env: Record<string, string>): DisplayFacts => ({ platform: 'win32', env, commandLines: [] });

describe('Linux', () => {
  test('no display variables at all means no display', () => {
    expect(classifyDisplay(linux({})).kind).toBe('none');
    expect(classifyDisplay(linux({ XDG_SESSION_TYPE: 'tty' })).kind).toBe('none');
    // ...and it is the variables that decide, not the platform.
    expect(classifyDisplay(linux({ DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' })).kind).not.toBe('none');
  });

  test('a display served by Xvfb is virtual, and says which server', () => {
    const result = classifyDisplay(linux({ DISPLAY: ':99' }, ['Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp -auth /tmp/xvfb-run.x/Xauthority']));
    expect(result.kind).toBe('virtual');
    expect(result.detail).toContain('Xvfb');
    expect(result.detail).toContain(':99');
  });

  test.each([['Xvnc :1 -geometry 1280x800'], ['/usr/bin/Xvfb :1 -screen 0 800x600x24'], ['Xdummy :1']])('%s is a virtual display server', (line) => {
    expect(classifyDisplay(linux({ DISPLAY: ':1' }, [line])).kind).toBe('virtual');
  });

  test('a virtual server is recognised even when the session type says tty (e.g. started over ssh)', () => {
    expect(classifyDisplay(linux({ DISPLAY: ':99', XDG_SESSION_TYPE: 'tty' }, ['Xvfb :99 -screen 0 1024x768x24'])).kind).toBe('virtual');
  });

  test('a virtual server on a different display number does not make this display virtual', () => {
    expect(classifyDisplay(linux({ DISPLAY: ':99' }, ['Xvfb :98 -screen 0 1024x768x24'])).kind).toBe('unknown');
  });

  test('an explicit screen number in DISPLAY still matches the Xvfb serving that display', () => {
    // Xvfb's own argument never carries a screen number (screens are configured separately, with `-screen`); a
    // client's DISPLAY may still name one explicitly (":99.0" is the same endpoint as ":99").
    expect(classifyDisplay(linux({ DISPLAY: ':99.0' }, ['Xvfb :99 -screen 0 1280x1024x24'])).kind).toBe('virtual');
  });

  test('a screen number on either side of the comparison is ignored, but the display number must still match', () => {
    expect(classifyDisplay(linux({ DISPLAY: ':99' }, ['Xvfb :99.0 -screen 0 1280x1024x24'])).kind).toBe('virtual');
    expect(classifyDisplay(linux({ DISPLAY: ':99.0' }, ['Xvfb :98.0 -screen 0 1280x1024x24'])).kind).toBe('unknown');
  });

  test('a desktop session is real', () => {
    expect(classifyDisplay(linux({ DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' })).kind).toBe('real');
    expect(classifyDisplay(linux({ WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland' })).kind).toBe('real');
  });

  test('Xwayland on a Wayland desktop is a real session, not a virtual display', () => {
    const facts = linux({ DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland' }, ['/usr/bin/Xwayland :0 -auth /run/user/1000/x']);
    expect(classifyDisplay(facts).kind).toBe('real');
  });

  test('a display that is neither a known virtual server nor a desktop session is reported as unknown, never guessed', () => {
    // For example X forwarding over ssh: something is listening, but it is not evidently this machine's own desktop.
    expect(classifyDisplay(linux({ DISPLAY: 'localhost:10.0', XDG_SESSION_TYPE: 'tty' })).kind).toBe('unknown');
    expect(classifyDisplay(linux({ DISPLAY: ':0' })).kind).toBe('unknown');
    expect(classifyDisplay(linux({ WAYLAND_DISPLAY: 'wayland-0' })).kind).toBe('unknown');
  });

  test('a process merely mentioning Xvfb in its arguments does not make the display virtual', () => {
    expect(classifyDisplay(linux({ DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' }, ['/usr/bin/vim notes-about-Xvfb :0.txt'])).kind).toBe('real');
  });
});

describe('Windows', () => {
  test.each([['Console'], ['RDP-Tcp#0']])('the interactive session %s is real', (session) => {
    expect(classifyDisplay(windows({ SESSIONNAME: session })).kind).toBe('real');
  });

  test.each([['Services'], ['']])('the non-interactive session %j has no display', (session) => {
    expect(classifyDisplay(windows({ SESSIONNAME: session })).kind).toBe('none');
    expect(classifyDisplay(windows({ SESSIONNAME: 'Console' })).kind).toBe('real');
  });

  test('an unknown session name is not assumed to be a desktop', () => {
    expect(classifyDisplay(windows({})).kind).toBe('none');
    expect(classifyDisplay(windows({ SESSIONNAME: 'Console' })).kind).toBe('real');
  });
});

describe('other platforms', () => {
  // DISPLAY/WAYLAND_DISPLAY are not required by this platform's own native GUI apps, so their presence or absence
  // is weak evidence at best; a headless host here still reports none rather than being handed a display capability
  // it cannot back up.
  test('no display evidence at all is reported as none, not guessed as a working display', () => {
    expect(classifyDisplay({ platform: 'darwin', env: {}, commandLines: [] }).kind).toBe('none');
  });

  test('some display evidence, without a way to classify it further, is reported as unknown', () => {
    expect(classifyDisplay({ platform: 'darwin', env: { DISPLAY: ':0' }, commandLines: [] }).kind).toBe('unknown');
    expect(classifyDisplay({ platform: 'darwin', env: { WAYLAND_DISPLAY: 'wayland-0' }, commandLines: [] }).kind).toBe('unknown');
  });
});

describe('reading this machine', () => {
  test('reports the platform and the environment it really has', async () => {
    const facts = await readDisplayFacts();
    expect(facts.platform).toBe(process.platform);
    expect(facts.env.PATH ?? facts.env.Path).toBeDefined();
  });

  test.skipIf(process.platform !== 'linux')('on Linux it reads the command lines of running processes from /proc, including this one', async () => {
    const facts = await readDisplayFacts();
    expect(facts.commandLines.length).toBeGreaterThan(0);
    expect(facts.commandLines.some((line) => line.includes(process.execPath) || /node/.test(line))).toBe(true);
  });

  test.skipIf(process.platform === 'linux')('off Linux it does not pretend to have process command lines', async () => {
    expect((await readDisplayFacts()).commandLines).toEqual([]);
  });
});
