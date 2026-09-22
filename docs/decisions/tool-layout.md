# Decision: tool layout and implementation defaults (Task 0.3)

Status: accepted for Stage 1 and 2, with the exceptions listed under [Not settled](#not-settled). Date: 2026-09-20.

These defaults come from the plan's proposals and the Stage 0 results ([native automation](native-automation.md), [GitHub gate](github-gate.md)). Where Stage 0 did not test a proposal, the table says so.

## Defaults

| Area | Decision | Basis |
| --- | --- | --- |
| Repository | `Frogbyte-io/release-qa`, public | Created and made public before Stage 0 |
| Runtime | Node.js 22. `.node-version` pins **22.23.2** exactly; `engines.node` is the floor `>=22.18.0` | The harness ran on Node 22.23.2 (Linux) and 24.13.0 (Windows). 22.18.0 is the first 22.x with type stripping on by default and without an experimental warning (per Node's changelog). CI installs the version in `.node-version`; bump it deliberately |
| Package manager | npm workspaces, one root `package-lock.json` | Plan default; nothing in Stage 0 contradicted it |
| Language and test | TypeScript 7.0.2, Vitest 5.0.1, `@types/node` 22.20.4, all pinned exactly | Verified together in this change: `npm run typecheck` and `npm test` pass, and a deliberate type error fails the typecheck |
| Native driver (sample apps) | WebdriverIO 9.31.9 `remote()` API + external `tauri-driver` 2.0.6; Edge WebDriver on Windows, `WebKitWebDriver` on Linux | Proven on the sample: 60/60 attempts across three runs per platform |
| Desktop shell | Electron + Vue 3 + TypeScript, **unvalidated** | Still the plan's proposal. Nothing was built or tested. `apps/desktop` is an empty reserved workspace; its dependencies are added in Stage 5 |
| Linux baseline | Ubuntu 24.04 x86_64, Xvfb virtual display. CI runs `ubuntu-24.04` | Proven on Ubuntu 24.04.5 in WSL2 (not bare metal) |
| Windows baseline | Windows 11 x64, interactive session, WebView2 evergreen with a matching Edge WebDriver. CI runs `windows-2025` for tool logic only | Proven on Windows 11 10.0.26200 with WebView2 153.0.4234.48 |
| Package names | `@frogbyte-io/release-qa` (runner, contracts, GitHub integration) and `@frogbyte-io/release-qa-desktop`; CLI `release-qa` | Proposals. Both packages are `private: true`. **Confirm names before publishing anything** |

## Layout

```text
package.json                  npm workspaces: packages/*, apps/*
packages/qa/                  runner, contracts, reports, GitHub integration (Stage 1 onward)
apps/desktop/                 reserved for the Stage 5 dashboard
examples/tauri-smoke/         independent packaged consumer; NOT a workspace, keeps its own lockfile
experiments/                  throwaway Stage 0 proofs; NOT workspaces, never imported by shipped code
docs/decisions/               decision records
```

`examples/tauri-smoke` stays outside the workspace on purpose. The packages tested in Stage 0 were built with its own `package-lock.json`, and hoisting its build tooling into a root lockfile would change that resolution without a re-test. Revisit when the sample is consumed by the runner's own tests.

**No build step (decided in Task 2.2, part 1).** Node 22.18 or newer runs the TypeScript directly by stripping types, so a future CLI entry point can be run with a plain `node` invocation, needing no build step; that entry point does not exist yet (Task 2.2's next part adds `packages/qa/src/cli/`) and this record does not fix its path in advance. What is verified today is `packages/qa/src/index.ts`, which `test/no-build.test.ts` loads under plain Node on every CI runner and asserts prints no warning. This only works while the source uses *erasable* syntax (no enums, namespaces or constructor parameter properties), which `erasableSyntaxOnly` in `tsconfig.json` enforces at typecheck time. `packages/qa/tsconfig.json` keeps `noEmit`. This suits running from a checkout; **a published or installed distribution would still need a build or bundle**, and `bin`, `main` and `exports` stay out of `package.json` until that is decided.

## Stage 0 commands and where they go

The Stage 0 commands are not turned into npm scripts yet, because they need a designated machine, installed drivers and a built package rather than just `npm ci`. They stay documented and runnable in [`experiments/native-automation`](../../experiments/native-automation) until Stage 2 promotes them.

| Stage 0 command | Promoted to |
| --- | --- |
| `run-attempts.mjs` (launch, save, read disk, restart, clear) | `packages/qa/src/drivers/tauri.ts` and the runner (Task 2.1/2.2), driven by `release-qa run` |
| Driver/WebView2 version match, display presence, no already-running instance | `release-qa doctor` |
| Hash the installed file, not the build tree | Candidate preparation (Task 3.1) and the runner's install step |
| `experiments/github-gate/*.sh`, `sandbox/scripts/qa-evaluate.mjs` | `packages/qa/src/github/*` and consumer workflows (Tasks 3.1-3.3), applying the changes listed in [github-gate.md](github-gate.md) |

The repeatable smoke check for now is `experiments/native-automation/run-attempts.mjs` itself, plus `experiments/github-gate/run-core.sh`. Both are clearly separate from the shipped package: nothing under `packages/` or `apps/` imports from `experiments/` or `examples/`.

## CI

`.github/workflows/ci.yml` runs `npm ci`, `npm run typecheck` and `npm test` on `ubuntu-24.04` and `windows-2025` with the Node version from `.node-version`. It has read-only permissions, no secrets, a 15-minute job timeout, and its actions pinned to commit SHAs (bumped by hand; no Dependabot is configured). It tests tool logic only; packaged-app GUI runs need a designated machine and are not in CI. The runner labels are pinned by name, not `latest`, so a baseline change is a reviewed edit.

## Not settled

- **Dot X feasibility** is unknown (see [native-automation.md](native-automation.md#not-attempted)). Stage 6 stays blocked on it.
- **Electron + Vue** is untested. If the dashboard shell changes, only `apps/desktop` and Stage 5 move.
- **Node 24** works locally but is not in the CI matrix. Add it when a consumer needs it.
- **Windows baseline in CI** is Windows Server on a hosted runner, which is not the interactive Windows 11 desktop used for the Stage 0 GUI runs.
- **Gate trust boundary and permission matrix** remain open as recorded in [github-gate.md](github-gate.md).
