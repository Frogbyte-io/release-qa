/**
 * Parses `process.argv.slice(2)`. Never throws: a malformed invocation is a `{ ok: false }` result the caller turns
 * into an exit code, not an exception that would print a stack trace instead of a usable message.
 */

export interface DoctorCommand {
  name: 'doctor';
  project: string;
  profile: string;
  json: boolean;
}

export interface DesignateCommand {
  name: 'designate';
  /** Absent means the caller applies its own default; parsing does not know or guess a working directory. */
  root: string | undefined;
  json: boolean;
}

export interface StatusCommand {
  name: 'status';
  root: string | undefined;
  json: boolean;
}

export type Command = DoctorCommand | DesignateCommand | StatusCommand;

export type ParsedArgs = { ok: true; command: Command } | { ok: false; error: string };

interface Spec {
  /** Flags that must be given a value. */
  required: readonly string[];
  /** Flags that may be given a value but need not be. */
  optional: readonly string[];
}

const SPECS: Record<Command['name'], Spec> = {
  doctor: { required: ['project', 'profile'], optional: [] },
  designate: { required: [], optional: ['root'] },
  status: { required: [], optional: ['root'] },
};

const COMMAND_NAMES = Object.keys(SPECS) as Command['name'][];

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [name, ...rest] = argv;
  if (name === undefined) return fail(`expected a command: ${COMMAND_NAMES.join(', ')}`);
  if (!isCommandName(name)) return fail(`unknown command "${name}"; expected one of ${COMMAND_NAMES.join(', ')}`);

  const flags = parseFlags(rest, SPECS[name]);
  if (!flags.ok) return flags;

  switch (name) {
    case 'doctor':
      return { ok: true, command: { name, project: flags.values.project as string, profile: flags.values.profile as string, json: flags.json } };
    case 'designate':
    case 'status':
      return { ok: true, command: { name, root: flags.values.root as string | undefined, json: flags.json } };
  }
}

function isCommandName(value: string): value is Command['name'] {
  return (COMMAND_NAMES as string[]).includes(value);
}

type FlagResult = { ok: true; values: Record<string, string | undefined>; json: boolean } | { ok: false; error: string };

/** `--json` is a boolean flag common to every command; every other flag takes exactly one value. */
function parseFlags(args: readonly string[], spec: Spec): FlagResult {
  const known = new Set([...spec.required, ...spec.optional]);
  const values: Record<string, string> = {};
  let json = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === undefined) break;
    if (token === '--json') {
      json = true;
      continue;
    }
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const flag = token.slice(2);
    if (!known.has(flag)) return fail(`unknown flag "--${flag}"`);
    if (Object.hasOwn(values, flag)) return fail(`--${flag} was given more than once`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) return fail(`--${flag} needs a value`);
    values[flag] = value;
    i += 1;
  }

  if (positional.length > 0) return fail(`unexpected argument "${positional[0]}"`);
  for (const flag of spec.required) if (values[flag] === undefined) return fail(`--${flag} is required`);
  return { ok: true, values, json };
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}
