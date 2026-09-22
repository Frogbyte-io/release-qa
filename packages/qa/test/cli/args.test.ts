import { describe, expect, test } from 'vitest';
import { parseArgs } from '../../src/cli/args.ts';

const err = (argv: string[]): string => {
  const result = parseArgs(argv);
  if (result.ok) throw new Error(`expected an error, got ${JSON.stringify(result.command)}`);
  return result.error;
};

const failure = (argv: string[]): { error: string; json: boolean } => {
  const result = parseArgs(argv);
  if (result.ok) throw new Error(`expected an error, got ${JSON.stringify(result.command)}`);
  return result;
};

describe('no command', () => {
  test('an empty argument list names the valid commands', () => {
    expect(err([])).toMatch(/doctor.*designate.*status/);
  });

  test('an unrecognised first word names it and the valid commands', () => {
    expect(err(['fly'])).toMatch(/"fly"/);
    expect(err(['fly'])).toMatch(/doctor.*designate.*status/);
  });

  test('json is reported even when there is no valid command at all', () => {
    expect(failure(['fly', '--json']).json).toBe(true);
    expect(failure([]).json).toBe(false);
  });
});

describe('doctor', () => {
  test('reads --project and --profile, and defaults json to false', () => {
    const result = parseArgs(['doctor', '--project', 'qa/project.json', '--profile', 'windows']);
    expect(result).toEqual({ ok: true, command: { name: 'doctor', project: 'qa/project.json', profile: 'windows', json: false } });
  });

  test('--json sets json to true', () => {
    const result = parseArgs(['doctor', '--project', 'p.json', '--profile', 'w', '--json']);
    expect(result).toEqual({ ok: true, command: { name: 'doctor', project: 'p.json', profile: 'w', json: true } });
  });

  test('flags may come in any order', () => {
    const result = parseArgs(['doctor', '--json', '--profile', 'w', '--project', 'p.json']);
    expect(result).toEqual({ ok: true, command: { name: 'doctor', project: 'p.json', profile: 'w', json: true } });
  });

  test.each([['--project'], ['--profile']])('missing %s is an error naming it', (flag) => {
    const argv = flag === '--project' ? ['doctor', '--profile', 'w'] : ['doctor', '--project', 'p.json'];
    expect(err(argv)).toMatch(new RegExp(flag.replace('--', '')));
  });

  test('a flag this command does not have is an error', () => {
    expect(err(['doctor', '--project', 'p.json', '--profile', 'w', '--root', 'x'])).toMatch(/root/);
  });

  test('a flag repeated is an error, not silently the last value', () => {
    expect(err(['doctor', '--project', 'a.json', '--project', 'b.json', '--profile', 'w'])).toMatch(/project/);
  });

  test('a flag with nothing after it is an error', () => {
    expect(err(['doctor', '--project'])).toMatch(/project/);
  });

  test("a flag's value must not look like another flag, so a missing value is never silently swallowed", () => {
    // Without this guard, --project would swallow "--profile" as its value and "w" would be left over as an
    // unexplained extra argument, hiding that --profile itself never got a value.
    expect(err(['doctor', '--project', '--profile', 'w'])).toMatch(/project/);
  });

  test('an extra positional argument is an error', () => {
    expect(err(['doctor', '--project', 'p.json', '--profile', 'w', 'extra'])).toMatch(/extra/);
  });

  test('--json given twice is an error, not silently the same as once', () => {
    expect(err(['doctor', '--project', 'p.json', '--profile', 'w', '--json', '--json'])).toContain('json');
  });

  test('a malformed invocation that also asked for --json is still reported as wanting json', () => {
    // The caller decides how to render the error; parsing must not silently downgrade it to plain text.
    expect(failure(['doctor', '--project', 'p.json', '--profile', 'w', '--nope', '--json']).json).toBe(true);
    expect(failure(['doctor', '--project', 'p.json', '--profile', 'w', '--json', '--nope']).json).toBe(true);
  });

  test('a malformed invocation without --json is reported as not wanting json', () => {
    expect(failure(['doctor', '--project', 'p.json', '--profile', 'w', '--nope']).json).toBe(false);
  });
});

describe('designate', () => {
  test('--root is optional; absent means the caller decides the default', () => {
    expect(parseArgs(['designate'])).toEqual({ ok: true, command: { name: 'designate', root: undefined, json: false } });
  });

  test('--root is read when given', () => {
    expect(parseArgs(['designate', '--root', '.release-qa'])).toEqual({ ok: true, command: { name: 'designate', root: '.release-qa', json: false } });
  });
});

describe('status', () => {
  test('reads --root and --json like designate', () => {
    const result = parseArgs(['status', '--root', 'r', '--json']);
    expect(result).toEqual({ ok: true, command: { name: 'status', root: 'r', json: true } });
  });

  test('--root is optional here too', () => {
    expect(parseArgs(['status'])).toEqual({ ok: true, command: { name: 'status', root: undefined, json: false } });
  });
});
