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

export interface ResetCommand {
  name: 'reset';
  root: string | undefined;
  json: boolean;
}

export interface RunCommand {
  name: 'run';
  project: string;
  candidate: string;
  profile: string;
  suite: string;
  /** The designated test root; absent means the caller's default. */
  root: string | undefined;
  /** Where run journals are kept; absent means the caller's default. */
  state: string | undefined;
  json: boolean;
}

/** Continues a run exactly as it was started: the project, candidate, profile, suite and root are the run's own. */
export interface ResumeCommand {
  name: 'resume';
  run: string;
  state: string | undefined;
  json: boolean;
}

/** Fetches the active candidate's file for a profile from its draft release, verifies it and writes a local manifest. */
export interface DownloadCandidateCommand {
  name: 'download-candidate';
  repo: string;
  pr: number;
  /** The pull request head the person reviewed; the command refuses if the pull request has moved. */
  head: string;
  /** The candidate the person was shown; the command refuses if another is active. */
  candidate: string;
  profile: string;
  /** The directory the verified file and `candidate.json` are written to. */
  out: string;
  json: boolean;
}

/** Uploads one local run's report, events and evidence to the active candidate's draft release. */
export interface SyncRunCommand {
  name: 'sync-run';
  repo: string;
  pr: number;
  head: string;
  candidate: string;
  run: string;
  state: string | undefined;
  json: boolean;
}

export type Command = DoctorCommand | DesignateCommand | StatusCommand | ResetCommand | RunCommand | ResumeCommand | DownloadCandidateCommand | SyncRunCommand;

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
  reset: { required: [], optional: ['root'] },
  run: { required: ['project', 'candidate', 'profile', 'suite'], optional: ['root', 'state'] },
  resume: { required: ['run'], optional: ['state'] },
  'download-candidate': { required: ['repo', 'pr', 'head', 'candidate', 'profile', 'out'], optional: [] },
  'sync-run': { required: ['repo', 'pr', 'head', 'candidate', 'run'], optional: ['state'] },
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
    case 'reset':
      return { ok: true, command: { name, root: flags.values.root, json } };
    case 'run': {
      const { project, candidate, profile, suite, root, state } = flags.values as Record<string, string>;
      return { ok: true, command: { name, project: project!, candidate: candidate!, profile: profile!, suite: suite!, root, state, json } };
    }
    case 'resume': {
      // The run id becomes a directory name under the state directory, so it must never be a path.
      const run = flags.values.run as string;
      if (!RUN_ID.test(run)) return fail(`--run must be a run id (letters, digits, ".", "_" or "-", starting with a letter or digit), not ${JSON.stringify(run)}`, json);
      return { ok: true, command: { name, run, state: flags.values.state, json } };
    }
    case 'download-candidate': {
      const { repo, pr, head, candidate, profile, out } = flags.values as Record<string, string>;
      const bad = checkTarget(repo!, pr!, head!, candidate!) ?? (PROFILE_ID.test(profile!) ? undefined : `--profile must be a profile id (lower-case letters, digits, ".", "_" or "-", starting with a letter or digit), not ${JSON.stringify(profile)}`);
      if (bad !== undefined) return fail(bad, json);
      if (out!.trim() === '') return fail('--out must name a directory', json);
      return { ok: true, command: { name, repo: repo!, pr: Number(pr), head: head!, candidate: candidate!, profile: profile!, out: out!, json } };
    }
    case 'sync-run': {
      const { repo, pr, head, candidate, run } = flags.values as Record<string, string>;
      const bad = checkTarget(repo!, pr!, head!, candidate!);
      if (bad !== undefined) return fail(bad, json);
      // The run id becomes a directory name under the state directory, so it must be exactly the shape a run gets.
      if (!SYNC_RUN_ID.test(run!)) return fail(`--run must be a run id such as run-20260101T000000Z-abc123, not ${JSON.stringify(run)}`, json);
      return { ok: true, command: { name, repo: repo!, pr: Number(pr), head: head!, candidate: candidate!, run: run!, state: flags.values.state, json } };
    }
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SYNC_RUN_ID = /^run-[0-9TZ]+-[0-9a-f]{6}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The arguments both GitHub commands share, each checked before anything is sent to GitHub or put in a path. */
function checkTarget(repo: string, pr: string, head: string, candidate: string): string | undefined {
  if (!REPOSITORY.test(repo) || repo.split('/').some((part) => part === '.' || part === '..')) return `--repo must be owner/name, not ${JSON.stringify(repo)}`;
  if (!/^[1-9][0-9]{0,8}$/.test(pr)) return `--pr must be a positive pull request number, not ${JSON.stringify(pr)}`;
  if (!/^[0-9a-f]{40}$/.test(head)) return '--head must be the full 40-character pull request head SHA, in lowercase';
  if (!ID.test(candidate)) return `--candidate must be a candidate id (letters, digits, ".", "_" or "-", starting with a letter or digit), not ${JSON.stringify(candidate)}`;
  return undefined;
}

const countJson = (argv: readonly string[]): number => argv.filter((token) => token === '--json').length;
/** The id grammar the journal uses; it has no path separators, so a run id can never climb out of the state directory. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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
