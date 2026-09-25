# Release QA

A planned desktop QA app and CLI for testing packaged application releases. Maintainers and coding agents share automated results, manual checks, and release approval through GitHub.

The first targets are Tauri applications on Windows and Linux, with Dot X as the first real consumer. The Windows dashboard and CLI will use the same runner. Approved releases will publish the exact binaries tested during QA.

## Planning

- [Design and agreed decisions](docs/superpowers/specs/2026-09-20-release-qa-design.md)
- [Implementation plan](docs/superpowers/plans/2026-09-20-release-qa.md)

## Status

Stage 0 (proving the assumptions) is complete. The runner (environment checks, scenario execution, the durable run
journal), the CLI's local commands (`doctor`, `designate`, `status`, `reset`, `run`, `resume`), the Tauri driver adapter
and a runnable sample consumer exist: the sample passes through `release-qa run` on Windows and on Ubuntu 24.04 with
Xvfb ([guide](docs/guides/run-the-sample.md), [evidence](examples/tauri-smoke/qa/evidence/)). The dashboard and the
GitHub integration do not exist yet.

- [Native automation](docs/decisions/native-automation.md): unchanged packaged Tauri apps can be driven on Windows and Ubuntu. The Dot X feasibility check is still open.
- [GitHub merge gate](docs/decisions/github-gate.md): a no-service required check works, with documented design changes and unproven items.
- [Tool layout and defaults](docs/decisions/tool-layout.md): runtime, package manager, baselines and repository structure.
- [Local runs](docs/decisions/local-runs.md): the local candidate manifest, run state, resume rules and exit codes.

## CLI

Run it straight from a checkout; no build step (see [tool layout](docs/decisions/tool-layout.md)):

```sh
node packages/qa/src/cli/main.ts designate [--root <path>] [--json]   # marks a directory safe to install and delete into
node packages/qa/src/cli/main.ts status [--root <path>] [--json]      # reports what a designated root holds, dirty or clean
node packages/qa/src/cli/main.ts reset [--root <path>] [--json]       # reaps what a crashed run left, clears the dirty marker
node packages/qa/src/cli/main.ts doctor --project <qa/project.json> --profile <id> [--json]
node packages/qa/src/cli/main.ts run --project <qa/project.json> --candidate <candidate.json> --profile <id> --suite <id> [--root <path>] [--state <dir>] [--json]
node packages/qa/src/cli/main.ts resume --run <run id> [--state <dir>] [--json]
```

`doctor` and `run` need a consumer's `qa/project.json`; the sample's is [`examples/tauri-smoke/qa`](examples/tauri-smoke/qa),
and [the setup guide](docs/guides/run-the-sample.md) takes a fresh machine to a passing run.
`run` also needs a [local candidate manifest](docs/decisions/local-runs.md#the-local-candidate-manifest) naming the
file to test and its SHA-256, which is checked before anything is installed.

`--root` defaults to `.release-qa` and `--state` to `.release-qa/runs`, under the current directory (gitignored).
Results go to stdout, problems and progress to stderr; `--json` makes the result one line of JSON. `run` prints its
run id on stderr before anything runs, so an interrupted run can be continued with `resume`. Interrupting `run` once
(Ctrl+C) cancels it cleanly; a second interrupt exits at once.

Exit codes: `0` passed/ready; `1` a scenario the candidate failed; `2` a missing prerequisite or manual work left (this
machine does not meet the profile, a scenario was blocked, a manual check remains); `3` anything else that stopped the
command or left a run unfinished (bad usage, a file that cannot be read or does not verify, an unknown profile or
suite, an interrupted or cancelled scenario, a cleanup that failed and left the environment dirty, a reset that could not
clean everything). A run takes the highest rule
that applies: any failure is `1` even if something else was also interrupted.

## Development

Requires Node.js 22.18 or newer (the CLI needs no build step because Node strips types directly from that version on).

```sh
npm ci
npm run typecheck
npm test
```
