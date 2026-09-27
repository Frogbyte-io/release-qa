# Getting started with Release QA

This page takes a new machine from a fresh clone to a passing `release-qa run` of a project's own test suite, and
explains the commands you will use day to day. It covers what exists today: local runs from a checkout. GitHub
onboarding, permissions and publication are later stages and are not documented here.

For a complete worked example — prerequisites, tool versions and a sample app — see
[running the sample](guides/run-the-sample.md). This page does not repeat that guide's per-platform setup; it explains the
commands themselves. The reasoning behind local runs (candidate manifests, journals, resume rules, exit codes) is in
the [local runs decision](decisions/local-runs.md).

## 1. Designate a machine

Release QA installs, launches and deletes software during a run, so it only does that inside a directory a human has
marked as a test root. From the checkout:

```sh
node packages/qa/src/cli/main.ts designate
```

This marks `.release-qa` under the current directory (the default root). A different directory:

```sh
node packages/qa/src/cli/main.ts designate --root C:\qa\roots\demo
```

Designating is idempotent. The marker file it writes (`.release-qa-test-root`) is what later commands check; a root
without it is refused, so a run can never install into a directory nobody agreed to.

## 2. Check the machine with `doctor`

`doctor` measures the machine against one profile of a project and reports whether it matches:

```sh
node packages/qa/src/cli/main.ts doctor --project examples/tauri-smoke/qa/project.json --profile windows
```

On a Windows 11 machine with a desktop session this prints something like:

```
profile: windows
ready: true
os: windows 10.0.26200
arch: x86_64
capabilities: audio, display, real-display
display: real (interactive session Console)
```

`ready: false` means the machine does not match the profile (for example `doctor --profile linux` on Windows), and the
`mismatch` line says why. The command still exits `2` in that case — a missing prerequisite is the tester's to fix,
not an error of the tool:

| Exit | Meaning |
| --- | --- |
| `0` | the machine matches the profile |
| `2` | it does not (`mismatch` explains) |
| `3` | bad usage, or the project file could not be read or parsed |

An unknown profile is also `3`:

```
profile "macos" is not defined by this project; known profiles: windows, linux
```

`--json` makes every command print one line of JSON on stdout instead; problems go to stderr either way. Results go
to stdout, progress and problems to stderr, so pipes see only the result.

## 3. What a project needs

A consumer project keeps its QA files in a `qa/` directory:

- `qa/project.json` — which profiles exist, which requirements are checked, which suites group them, and which
  modules hold the code. See [authoring tests](authoring-tests.md) for the file's fields and the code it names.
- `qa/lifecycle.ts` (or whatever `lifecycleModule` names) — how to install, reset, launch and clean up the app.
- scenario files (`scenarioFiles`) — the checks themselves.

`doctor` and `run` read `project.json` as data first; a malformed file is reported with the exact fields that are
wrong before any code of the project is executed.

## 4. Provide a candidate

A run tests a file, not a commit. The file is named by a **local candidate manifest** — a small JSON file next to the
built package:

```json
{
  "schemaVersion": 1,
  "id": "local-2026-09-27.1",
  "artifacts": [
    { "profile": "windows", "name": "setup.exe", "path": "dist/setup.exe", "sha256": "<64 lower-case hex>" }
  ]
}
```

`path` is relative to the manifest's own directory and may not leave it. Before anything is installed, the runner
hashes the file at its real location and refuses a mismatch:

```
the artifact ...\setup.exe does not match the candidate: expected SHA-256 eeee…, found 9649…
```

That check is the point of the manifest: what is tested is provably the bytes recorded, not whatever is in the build
tree today. The sample ships a helper that builds the manifest from its bundle output
([`examples/tauri-smoke/scripts/write-candidate.mjs`](../examples/tauri-smoke/scripts/write-candidate.mjs)); a
project can do the same in a few lines, or write the JSON by hand.

## 5. Run a suite

```sh
node packages/qa/src/cli/main.ts run --project examples/tauri-smoke/qa/project.json --candidate candidate.json --profile windows --suite release
```

`run` checks everything it can before touching the machine — project, plan, candidate bytes, the consumer's code —
then installs, resets, launches and runs each of the suite's automated requirements for the profile. Progress lines
appear on stderr as each phase starts and finishes; the summary on stdout looks like:

```
run run-20260927T120747Z-41621e (candidate local-demo-1, profile windows, suite release)
  windows/check: passed
```

Before anything runs, `run` announces on stderr:

```
run run-20260927T120747Z-41621e started; if it is interrupted, continue it with: resume --run run-20260927T120747Z-41621e
```

Useful flags:

- `--root <path>` — test root (default `.release-qa` under the current directory).
- `--state <dir>` — where run journals are kept (default `.release-qa/runs`).
- `--json` — the summary as one line of JSON.

### Exit codes

Highest rule wins:

| Exit | Meaning |
| --- | --- |
| `0` | every requirement passed |
| `1` | at least one scenario **failed** — the candidate misbehaved (an assertion did not hold) |
| `2` | a missing prerequisite or work left for a person: the machine does not match, a scenario was **blocked**, a **manual** requirement remains |
| `3` | everything else that stopped the command or left the run unfinished: bad usage, a file that cannot be read or verify, an interrupted or cancelled scenario, a cleanup that failed |

An assertion failure and an infrastructure error are deliberately different exits. A scenario that throws because the
driver went away is `3` (`interrupted`); a scenario that finds the saved value missing is `1` (`failed`). In a
scenario, use `ctx.waitFor` for anything that takes time — a wait that runs out is an **assertion failure** (the
candidate did not behave), while a read error from a not-yet-loaded page is an infrastructure error. See
[authoring tests](authoring-tests.md#waiting-and-asserting).

### Where results live

Each run writes `.release-qa/runs/<run id>/`:

- `invocation.json` — what was asked: absolute paths to the project and candidate, profile, suite, root, and the
  SHA-256 of the artifact that was verified.
- `events.jsonl` — the journal: one JSON line per event, appended and flushed as it happens.
- `summary.json` — the run's attempts and outcomes.

## 6. Resume an interrupted run

If the process dies (crash, closed terminal, second Ctrl+C), the journal knows exactly where the run stopped:

```sh
node packages/qa/src/cli/main.ts resume --run run-20260927T120747Z-41621e
```

`resume` repeats the run's own invocation (the project, candidate, profile, suite and root are the run's, not
re-typed), re-verifies the candidate bytes, and:

- carries **passed** and **failed** requirements forward — a failure cannot disappear by being run again;
- reruns everything else (blocked, cancelled, interrupted, never reached) as a retry of its latest attempt;
- records an explicit `interrupted` attempt for a scenario that was started but never finished.

A resumed run that only carries results prints them marked `(from earlier)`:

```
run run-20260927T120758Z-696e07 (candidate local-demo-1, profile windows, suite release)
  windows/check: failed (from earlier)
```

If the run used a custom `--state`, the announcement includes it: paste the whole `resume --run … --state …` line it
prints.

## 7. Inspect and clean the test root with `status` and `reset`

`status` reports what a root is and holds, changing nothing:

```sh
node packages/qa/src/cli/main.ts status
```

```
root: C:\...\demo\.release-qa
designated: true
owned: 0 resource(s)
```

After a run whose cleanup failed, the root is marked dirty and the reason is shown:

```
root: C:\...\demo\.release-qa
designated: true
dirty: cleanup failed: cleanup hook failed: the uninstaller crashed
owned: 0 resource(s)
```

A dirty root refuses further runs. Fix the cause, then clear it:

```sh
node packages/qa/src/cli/main.ts reset
```

```
reset C:\...\demo\.release-qa
```

`reset` reaps whatever the ledger still says the run owned (processes by identity, paths inside the root) and then
clears the dirty marker. It refuses an undesignated root and a root a live run still holds. A reset that cannot
clean everything keeps the marker and exits `3`.

## 8. Cancellation

One Ctrl+C cancels a run cleanly: the running scenario stops, its cleanup runs, nothing further starts and the
remaining requirements are recorded as `not-run`. A second Ctrl+C exits at once; the journal and the root's ledger
still say what was left, for `reset` and `resume`.

## Next

To write your own `qa/` directory — project file, lifecycle, scenarios — see
[authoring tests](authoring-tests.md). To take a fresh machine all the way to a passing run of the sample, see
[running the sample](guides/run-the-sample.md).
