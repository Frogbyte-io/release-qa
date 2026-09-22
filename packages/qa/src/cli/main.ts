import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from './args.ts';
import { runDoctor, type DoctorReport } from './doctor.ts';
import { runDesignate, runStatus, type StatusReport } from './environment-commands.ts';
import { loadProject } from './project.ts';
import type { ValidationIssue } from '../model/validate.ts';

/**
 * `0` passed. `1` a scenario the candidate failed (not yet reachable: no command runs a scenario in this build).
 * `2` a missing prerequisite the tester, not the tool, must resolve (e.g. this machine does not match a profile).
 * `3` everything else that stops the command: bad usage, a file that cannot be read, an unknown profile.
 */
export const EXIT = { ok: 0, scenarioFailure: 1, missingPrerequisite: 2, infrastructure: 3 } as const;

export interface Io {
  log(line: string): void;
  error(line: string): void;
}

const defaultIo: Io = { log: (line) => console.log(line), error: (line) => console.error(line) };

/** Runs one CLI invocation and returns the process exit code; never throws and never touches `process` itself. */
export async function main(argv: readonly string[], io: Io = defaultIo, cwd: () => string = () => process.cwd()): Promise<number> {
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
  }
}

const defaultRoot = (cwd: () => string): string => join(cwd(), '.release-qa');

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
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
