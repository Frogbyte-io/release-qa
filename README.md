# Release QA

A planned desktop QA app and CLI for testing packaged application releases. Maintainers and coding agents share automated results, manual checks, and release approval through GitHub.

The first targets are Tauri applications on Windows and Linux, with Dot X as the first real consumer. The Windows dashboard and CLI will use the same runner. Approved releases will publish the exact binaries tested during QA.

## Planning

- [Design and agreed decisions](docs/superpowers/specs/2026-09-20-release-qa-design.md)
- [Implementation plan](docs/superpowers/plans/2026-09-20-release-qa.md)

## Status

Stage 0 (proving the assumptions) is under way; the tool itself is not built yet. Results so far:

- [Native automation](docs/decisions/native-automation.md): unchanged packaged Tauri apps can be driven on Windows and Ubuntu. The Dot X feasibility check is still open.
- [GitHub merge gate](docs/decisions/github-gate.md): a no-service required check works, with documented design changes and unproven items.
- [Tool layout and defaults](docs/decisions/tool-layout.md): runtime, package manager, baselines and repository structure.

## Development

Requires Node.js 22.18 or newer (the CLI needs no build step because Node strips types directly from that version on).

```sh
npm ci
npm run typecheck
npm test
```
