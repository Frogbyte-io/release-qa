# Release QA

A planned desktop QA app and CLI for testing packaged application releases. Maintainers and coding agents share automated results, manual checks, and release approval through GitHub.

The first targets are Tauri applications on Windows and Linux, with Dot X as the first real consumer. The Windows dashboard and CLI will use the same runner. Approved releases will publish the exact binaries tested during QA.

## Planning

- [Design and agreed decisions](docs/superpowers/specs/2026-09-20-release-qa-design.md)
- [Implementation plan](docs/superpowers/plans/2026-09-20-release-qa.md)

## Status

Stage 0 (proving the assumptions) is complete. The runner (environment checks, scenario execution, the durable run
journal) and a first slice of the CLI (`doctor`, `designate`, `status`) exist; running an actual scenario from the
CLI (`run`, `resume`), the Tauri driver, the dashboard and the GitHub integration do not yet.

- [Native automation](docs/decisions/native-automation.md): unchanged packaged Tauri apps can be driven on Windows and Ubuntu. The Dot X feasibility check is still open.
- [GitHub merge gate](docs/decisions/github-gate.md): a no-service required check works, with documented design changes and unproven items.
- [Tool layout and defaults](docs/decisions/tool-layout.md): runtime, package manager, baselines and repository structure.

## CLI

Run it straight from a checkout; no build step (see [tool layout](docs/decisions/tool-layout.md)). `designate` and
`status` work as they stand, against any directory:

```sh
node packages/qa/src/cli/main.ts designate [--root <path>] [--json]   # marks a directory safe to install and delete into
node packages/qa/src/cli/main.ts status [--root <path>] [--json]      # reports what a designated root holds, dirty or clean
```

`doctor` needs a `qa/project.json` from a project that has one (this repository does not ship a sample yet — that
lands with the CLI's `run`/`resume` commands):

```sh
node packages/qa/src/cli/main.ts doctor --project path/to/qa/project.json --profile windows [--json]
```

`--root` defaults to `.release-qa` under the current directory (gitignored) when not given. Every command prints to
stdout on success and to stderr on failure; `--json` switches both to one line of machine-readable JSON. Exit codes:
`0` passed/ready, `1` a scenario the candidate failed (not reachable yet — no command runs a scenario), `2` this
machine does not meet a requested profile, `3` anything else that stopped the command (bad usage, an unreadable or
invalid project file, a profile the project does not declare).

## Development

Requires Node.js 22.18 or newer (the CLI needs no build step because Node strips types directly from that version on).

```sh
npm ci
npm run typecheck
npm test
```
