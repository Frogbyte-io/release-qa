# Decision: running a suite from a checkout (Task 2.2, part 3a)

Status: **implemented** for the CLI's `run`, `resume` and `reset`, against fixture consumer projects. Running the real sample (`examples/tauri-smoke`) through a Tauri driver adapter is part 3b.

## The local candidate manifest

`run --candidate <file>` takes a local manifest, not a GitHub candidate record:

```json
{
  "schemaVersion": 1,
  "id": "local-2026-09-23.1",
  "artifacts": [
    { "profile": "windows", "name": "setup.exe", "path": "dist/setup.exe", "sha256": "<64 lower-case hex>" }
  ]
}
```

- One artifact per profile; `path` is relative to the manifest's own directory and cannot leave it, lexically or through a link: the real location must be inside the manifest's real directory.
- Before anything is installed, the chosen profile's file is hashed at its real location and must match `sha256`; the location is re-checked after hashing. Other profiles' files are never read.
- It has no source or build provenance, so it can never stand in for a GitHub candidate at the merge gate (Stage 3). Hooks receive only `candidate.id` and the verified `artifact` (`name`, its real absolute `path` with no link left in it, `sha256`); a full GitHub candidate record also fits `candidate`.

## Consumer code

`qa/project.json` names a lifecycle module exporting `lifecycle` (`install`, `reset`, `launch`, `cleanup`) and scenario files exporting `scenarios` (`{ id, setup?, steps }[]`). A requirement key `<profile>/<id>` runs the scenario with that id. Running executes the project's code; the CLI does it only for a project the user points it at, and every problem (missing hook, undefined scenario, duplicate id, a module that throws while loading) is reported before anything is installed.

## State

- Default test root: `.release-qa` under the current directory; default state directory: `.release-qa/runs` (both gitignored). Each run is `runs/<run id>/` with `invocation.json` (what was asked, absolute paths, and the tested artifact's SHA-256), `events.jsonl` (the Task 1.3 journal) and `summary.json`.
- The machine is identified in run records by a random token kept in the state directory, never the host name.
- `run` announces `run <id> started` on stderr before anything runs, in every output mode, with the `resume` command to use (including a custom `--state`, quoted so it pastes safely in bash and PowerShell), so a run can be resumed even if the process dies.
- A run id is a run id, never a path: `resume --run` accepts only the journal's id grammar, which has no path separators (`/`, `\`, `:`).

## Journal and resume

Each scenario records a `scenario-started` checkpoint, then an attempt, then a `cleanup-failed` checkpoint if its cleanup failed. `resume --run <id>`:

- re-verifies the candidate: the same manifest id, and bytes whose SHA-256 is the one recorded when the run started (a manifest edited to name new bytes under the same id is refused: that is a different build);
- carries **passed** and **failed** forward (a failure cannot disappear by being run again), with any recorded cleanup failure;
- reruns anything else (blocked, cancelled, interrupted, never reached) as a retry (`retryOf`) of its latest attempt;
- turns a `scenario-started` with no attempt after it (the process died) into an explicit `interrupted` attempt first, so the crash stays in the run's history.

A run whose journal has conflicting or cyclic events, or cannot be read, is not continued.

## Outcomes and exit codes

One scenario failing does not stop the others; cancellation stops the running scenario (its cleanup still runs) and starts nothing further (`not-run`). Exit codes, highest rule first: any **failed** → `1`; any interrupted, cancelled or not-run, or any cleanup that failed (the environment was left dirty, however the scenario went) → `3`; any blocked or manual → `2`; otherwise `0`. Configuration and verification problems are `3` before anything runs.

## Reset

A crash can leave owned resources and a dirty marker in the test root, which blocks later runs. `reset` reaps the ledger and clears the marker only when that fully succeeds; it refuses an undesignated root and a root a run currently holds.

## Not verified

- Cancellation by a real signal is tested on Linux only (CI). On Windows a console Ctrl+C reaches the same handler, but a test cannot send one to another process.
- Evidence files (screenshots, logs) are not collected yet; attempts record `evidence: []`.
- The artifact's contents could still change after verification; only copying it into the run's own storage would close that. Links cannot redirect it, and the install hook consumes it at once.
- Consumer code runs in the CLI's own process: a scenario that calls `process.exit` takes the CLI with it. That is the crash `resume` recovers from, not something prevented.
