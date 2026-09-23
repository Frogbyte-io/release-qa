import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ValidationIssue } from '../model/validate.ts';
import type { ScenarioEvent } from '../runner/execute.ts';
import { parseArgs } from './args.ts';
import { runDoctor, type DoctorReport } from './doctor.ts';
import { runDesignate, runReset, runStatus, type StatusReport } from './environment-commands.ts';
import { loadProject } from './project.ts';
import { resumeRun, startRun, type RunOptions, type RunSummary } from './run.ts';

/**
 * `0` passed. `1` a scenario the candidate failed. `2` a missing prerequisite or manual work the tester, not the
 * tool, must resolve (this machine does not match a profile, a scenario was blocked, a manual check is left).
 * `3` everything else that stops the command or leaves a run unfinished: bad usage, a file that cannot be read or
 * does not verify, an unknown profile, an interrupted or cancelled scenario, an environment reset that failed.
 */
export const EXIT = { ok: 0, scenarioFailure: 1, missingPrerequisite: 2, infrastructure: 3 } as const;

export interface Io {
  log(line: string): void;
  error(line: string): void;
}

const defaultIo: Io = { log: (line) => console.log(line), error: (line) => console.error(line) };

/**
 * Runs one CLI invocation and returns the process exit code; never throws and never touches `process` itself.
 * `signal` cancels a run in progress: the running scenario stops, is cleaned up, and nothing further starts.
 */
export async function main(
  argv: readonly string[],
  io: Io = defaultIo,
  cwd: () => string = () => process.cwd(),
  signal: AbortSignal = new AbortController().signal,
): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    reportError(io, parsed.json, parsed.error);
    return EXIT.infrastructure;
  }
  const { command } = parsed;

  switch (command.name) {
    case 'doctor': {
      const loaded = await loadProject(command.project);
      if (!loaded.ok) {
        reportError(io, command.json, loaded.error, loaded.issues);
        return EXIT.infrastructure;
      }
      const result = await runDoctor(loaded.project, command.profile);
      if (!result.ok) {
        reportError(io, command.json, result.error);
        return EXIT.infrastructure;
      }
      printDoctor(io, command.json, result.report);
      return result.report.ok ? EXIT.ok : EXIT.missingPrerequisite;
    }

    case 'designate': {
      const root = command.root ?? defaultRoot(cwd);
      const result = await runDesignate(root);
      if (!result.ok) {
        reportError(io, command.json, result.error);
        return EXIT.infrastructure;
      }
      io.log(command.json ? JSON.stringify(result) : `designated ${result.root}`);
      return EXIT.ok;
    }

    case 'status': {
      const root = command.root ?? defaultRoot(cwd);
      const result = await runStatus(root);
      if (!result.ok) {
        reportError(io, command.json, result.error);
        return EXIT.infrastructure;
      }
      // What status finds (undesignated, dirty) is a fact it reports, never a failure of the status command itself.
      printStatus(io, command.json, result.report);
      return EXIT.ok;
    }

    case 'reset': {
      const result = await runReset(command.root === undefined ? defaultRoot(cwd) : resolve(cwd(), command.root));
      if (!result.ok) {
        reportError(io, command.json, result.error);
        return EXIT.infrastructure;
      }
      if (command.json) io.log(JSON.stringify(result));
      else if (result.failures.length === 0) io.log(`reset ${result.root}`);
      else io.error([`could not reset ${result.root}; it stays dirty:`, ...result.failures.map((f) => `  ${f}`)].join('\n'));
      return result.failures.length === 0 ? EXIT.ok : EXIT.infrastructure;
    }

    case 'run':
    case 'resume': {
      const stateDir = command.state === undefined ? join(defaultRoot(cwd), 'runs') : resolve(cwd(), command.state);
      const customState = command.state === undefined ? undefined : stateDir;
      const options: RunOptions = {
        stateDir,
        signal,
        // Announced before anything runs, on stderr in every mode: if the process dies, this is how to resume it.
        onStart: (runId: string) => io.error(`run ${runId} started; if it is interrupted, continue it with: ${resumeHint(runId, customState)}`),
        // Progress goes to stderr, so stdout carries only the summary.
        ...(command.json ? {} : { onEvent: (event: ScenarioEvent) => io.error(`${event.scenario}: ${event.phase} ${event.status}${event.detail === undefined ? '' : ` (${event.detail})`}`) }),
      };
      const result =
        command.name === 'run'
          ? await startRun(
              {
                project: resolve(cwd(), command.project),
                candidate: resolve(cwd(), command.candidate),
                profile: command.profile,
                suite: command.suite,
                root: command.root === undefined ? defaultRoot(cwd) : resolve(cwd(), command.root),
              },
              options,
            )
          : await resumeRun(command.run, options);
      if (!result.ok) {
        reportError(io, command.json, result.error);
        return EXIT.infrastructure;
      }
      printRun(io, command.json, result.summary);
      return result.summary.exitCode;
    }
  }
}

const defaultRoot = (cwd: () => string): string => join(cwd(), '.release-qa');

/**
 * The command that continues a run. With a custom state directory it must name it, and pasting it must not expand
 * anything: a plain path goes in as it is, anything else in single quotes (literal in both bash and PowerShell), and a
 * path that itself contains a single quote is named in prose rather than put into a command it would break.
 */
export function resumeHint(runId: string, stateDir: string | undefined): string {
  const command = `resume --run ${runId}`;
  if (stateDir === undefined) return command;
  if (/^[A-Za-z0-9_.:\\/-]+$/.test(stateDir)) return `${command} --state ${stateDir}`;
  if (!stateDir.includes("'")) return `${command} --state '${stateDir}'`;
  return `${command} --state <the state directory>, which is: ${stateDir}`;
}

function printRun(io: Io, json: boolean, summary: RunSummary): void {
  if (json) {
    io.log(JSON.stringify(summary));
    return;
  }
  io.log(
    [
      `run ${summary.runId} (candidate ${summary.candidateId}, profile ${summary.profile}, suite ${summary.suite})`,
      ...summary.results.map((r) => `  ${r.requirement}: ${r.outcome}${r.carried === true ? ' (from earlier)' : ''}${r.detail === undefined ? '' : ` - ${r.detail}`}`),
      ...summary.results.filter((r) => r.cleanup !== undefined && !r.cleanup.ok).map((r) => `  cleanup after ${r.requirement} failed: ${r.cleanup?.failures.join('; ')}`),
    ].join('\n'),
  );
}

/** `issues` is always present in JSON output, empty when there are none, so a consumer can key on it unconditionally. */
function reportError(io: Io, json: boolean, error: string, issues?: readonly ValidationIssue[]): void {
  io.error(json ? JSON.stringify({ ok: false, error, issues: issues ?? [] }) : error);
}

function printDoctor(io: Io, json: boolean, report: DoctorReport): void {
  if (json) {
    io.log(JSON.stringify(report));
    return;
  }
  io.log(
    [
      `profile: ${report.profile}`,
      `ready: ${report.ok}`,
      `os: ${report.machine.os} ${report.machine.osVersion}`,
      `arch: ${report.machine.arch}`,
      `capabilities: ${report.machine.capabilities.join(', ') || '(none)'}`,
      `display: ${report.display.kind} (${report.display.detail})`,
      ...(report.mismatch === undefined ? [] : [`mismatch: ${report.mismatch}`]),
    ].join('\n'),
  );
}

function printStatus(io: Io, json: boolean, report: StatusReport): void {
  if (json) {
    io.log(JSON.stringify(report));
    return;
  }
  io.log(
    [
      `root: ${report.root}`,
      `designated: ${report.designated}`,
      ...(report.reason === undefined ? [] : [`reason: ${report.reason}`]),
      ...(report.dirty === undefined ? [] : [`dirty: ${report.dirty}`]),
      `owned: ${report.owned.length} resource(s)`,
    ].join('\n'),
  );
}

// Runs only when this file is the process's entry point (`node packages/qa/src/cli/main.ts ...`), never when a test
// imports it as a module.
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  // The first interrupt cancels: the running scenario stops and its cleanup runs. A second one exits at once; the
  // journal and the test root's ledger and dirty marker still say what was left, for `reset` and `resume`.
  const controller = new AbortController();
  const interrupt = (): void => {
    if (controller.signal.aborted) process.exit(EXIT.infrastructure);
    controller.abort();
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  main(process.argv.slice(2), defaultIo, () => process.cwd(), controller.signal).then(
    (code) => {
      process.exitCode = code;
    },
    // main never rejects by design; if a bug makes it, report it as an infrastructure error, not a bare stack trace.
    (error: unknown) => {
      console.error(`release-qa stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = EXIT.infrastructure;
    },
  );
}
