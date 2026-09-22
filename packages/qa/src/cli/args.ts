/**
 * Parses `process.argv.slice(2)`. Never throws: a malformed invocation is a `{ ok: false }` result the caller turns
 * into an exit code, not an exception that would print a stack trace instead of a usable message. `--json` is
 * decided by a single scan of the whole invocation, independent of where it appears and of everything else that
 * might be wrong with it, so the caller can render even a parse failure as JSON when that is what was asked for.
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

export type ParsedArgs = { ok: true; command: Command } | { ok: false; error: string; json: boolean };

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
  const json = countJson(argv) === 1;
  const [name, ...rest] = argv;
  if (name === undefined) return fail(`expected a command: ${COMMAND_NAMES.join(', ')}`, json);
  if (!isCommandName(name)) return fail(`unknown command "${name}"; expected one of ${COMMAND_NAMES.join(', ')}`, json);
  if (countJson(argv) > 1) return fail('--json was given more than once', true);

  const flags = parseFlags(rest, SPECS[name]);
  if (!flags.ok) return fail(flags.error, json);

  switch (name) {
    case 'doctor':
      return { ok: true, command: { name, project: flags.values.project as string, profile: flags.values.profile as string, json } };
    case 'designate':
    case 'status':
      return { ok: true, command: { name, root: flags.values.root as string | undefined, json } };
  }
}

const countJson = (argv: readonly string[]): number => argv.filter((token) => token === '--json').length;

function isCommandName(value: string): value is Command['name'] {
  return (COMMAND_NAMES as string[]).includes(value);
}

type FlagResult = { ok: true; values: Record<string, string | undefined> } | { ok: false; error: string };

/** `--json` is handled by the caller; every other token is a `--flag value` pair or an unexpected extra. */
function parseFlags(args: readonly string[], spec: Spec): FlagResult {
  const known = new Set([...spec.required, ...spec.optional]);
  const values: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === undefined || token === '--json') continue;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const flag = token.slice(2);
    if (!known.has(flag)) return failFlags(`unknown flag "--${flag}"`);
    if (Object.hasOwn(values, flag)) return failFlags(`--${flag} was given more than once`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) return failFlags(`--${flag} needs a value`);
    values[flag] = value;
    i += 1;
  }

  if (positional.length > 0) return failFlags(`unexpected argument "${positional[0]}"`);
  for (const flag of spec.required) if (values[flag] === undefined) return failFlags(`--${flag} is required`);
  return { ok: true, values };
}

function failFlags(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function fail(error: string, json: boolean): { ok: false; error: string; json: boolean } {
  return { ok: false, error, json };
}
