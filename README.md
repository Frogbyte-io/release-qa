# Release QA

A planned desktop QA app and CLI for testing packaged application releases. Maintainers and coding agents share automated results, manual checks, and release approval through GitHub.

The first targets are Tauri applications on Windows and Linux, with Dot X as the first real consumer. The Windows dashboard and CLI will use the same runner. Approved releases will publish the exact binaries tested during QA.

## Planning

- [Design and agreed decisions](docs/superpowers/specs/2026-09-20-release-qa-design.md)
- [Implementation plan](docs/superpowers/plans/2026-09-20-release-qa.md)

This repository currently contains planning documents only. The first implementation stage proves packaged Tauri automation and GitHub merge-gate behavior before building the rest of the tool.
