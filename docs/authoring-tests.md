# Authoring tests

How to write the `qa/` directory a `release-qa run` executes: the project file, the lifecycle that installs and
launches your application, and the scenarios that check it. This page covers what exists today — local runs from a
checkout. The commands themselves (`doctor`, `run`, `resume`, `reset`, `status`, exit codes) are in
[getting started](getting-started.md); the sample this page draws its examples from is
[`examples/tauri-smoke/qa/`](../examples/tauri-smoke/qa/), and
[running the sample](guides/run-the-sample.md) takes a machine from empty to a passing run of it.

The runner loads your code as **consumer code**. It runs in a supervised child process: the CLI keeps the journal,
the test-root lock and the resource ledger, and your hooks and scenarios call back into it for anything that must be
owned (`ctx.own`, `ctx.spawn`). Everything your code creates must be owned by the run or undone by cleanup.

## `qa/project.json`

```json
{
  "schemaVersion": 1,
  "projectId": "release-qa-tauri-smoke",
  "releaseBranch": "main",
  "profiles": [
    { "id": "windows", "os": "windows", "arch": "x86_64" },
    { "id": "linux", "os": "linux", "arch": "x86_64" }
  ],
  "requirements": [
    { "key": "windows/persistence", "mode": "automated", "title": "A saved setting survives a restart and Clear removes it", "capabilities": ["display"] },
    { "key": "linux/persistence", "mode": "automated", "title": "A saved setting survives a restart and Clear removes it", "capabilities": ["display"] }
  ],
  "suites": [{ "id": "release", "requirements": ["windows/persistence", "linux/persistence"] }],
  "scenarioFiles": ["persistence.spec.ts"],
  "lifecycleModule": "lifecycle.ts",
  "workflows": { "prepare": "qa-prepare.yml", "gate": "qa-gate.yml", "publish": "qa-publish.yml" },
  "markers": { "releaseNotes": "release-notes", "qa": "qa" }
}
```

Fields:

- `schemaVersion` — `1`.
- `projectId` — the project's identity, used in records. Letters, digits, `.`, `_`, `-`; starts with a letter or digit.
- `releaseBranch` — the branch releases come from (used by the later GitHub stages).
- `profiles` — the environments a run can target: `id` plus `os` (`windows` or `linux`) and `arch` (`x86_64`).
- `requirements` — the checks. The `key` is `<profile>/<scenario id>`, e.g. `windows/persistence`: the part before
  `/` selects which profile the check runs on, the part after names the scenario that implements it. `mode` is
  `automated` (the runner executes it) or `manual` (listed in the summary, never run — work for a person).
  `capabilities` names what the machine must provide, e.g. `display`; a machine missing one gets the requirement
  **blocked**, not failed. `title` is human-readable text.
- `suites` — named groups of requirement keys. `run --suite release` selects the suite's requirements for the
  requested profile, in suite order. A suite with nothing for the profile is refused rather than reported as an
  empty pass.
- `scenarioFiles` — modules exporting `scenarios`, relative to `qa/`.
- `lifecycleModule` — the module exporting `lifecycle`, relative to `qa/`.
- `workflows` and `markers` — GitHub-stage wiring; required by the schema, unused by local runs.

The file is parsed as data before any of your code runs. A malformed file is reported field by field (for example
`projectId: missing-field`) and nothing is installed.

## The lifecycle module

Export a `lifecycle` object with four hooks. `install`, `reset` and `launch` are each bounded (2 minutes by default)
and abortable:

```ts
import type { Lifecycle } from '../packages/qa/src/runner/execute.ts';

export const lifecycle: Lifecycle = { install, reset, launch, cleanup };
```

- `install(ctx)` — put the candidate on the machine. The artifact's verified file is `ctx.artifact.path` (absolute;
  the runner checked its SHA-256 before calling you). Install **into `ctx.testRoot`**, the designated directory the
  run owns: the sample installs there (`/S /D=<root>\smoke-app` on Windows, `dpkg-deb -x` into `<root>` on Linux)
  and refuses if the target already exists — an install this run did not make cannot be taken over.
- `reset(ctx)` — put the application into a known state before it starts, e.g. by removing its data directory.
- `launch(ctx)` — start the application. For a Tauri app, use the driver adapter:
  `app.session = await TauriApp.start(ctx, { application, nativeDriver })` — see the sample's
  [`lifecycle.ts`](../examples/tauri-smoke/qa/lifecycle.ts). It starts `tauri-driver` through `ctx.spawn` and owns
  the native driver and the app process, so the runner can stop them even if a hook never returns.
- `cleanup(ctx)` — undo everything: close the session, uninstall, remove data. Every step should run even if an
  earlier one failed; collect failures and throw one error listing them at the end (the sample does this). A cleanup
  that does not finish marks the test root **dirty**; `reset` clears it once the cause is fixed.

Everything install and the app create must be either inside the test root or removed by cleanup. Record anything
outside your immediate control with `ctx.own` (below) so the runner can reap it.

### Owning resources: `ctx.own` and `ctx.spawn`

- `ctx.own({ kind: 'path', path, label })` records a path the run created; the runner's cleanup removes it.
  `ctx.own({ kind: 'process', pid, identity, label })` records a process; cleanup stops it by identity.
- `ctx.spawn(label, command, args, options?)` starts a process the run owns and returns a handle with `pid`,
  `exitCode`, `kill()` and `on('exit')`. Use `stdio: 'ignore'` or `'inherit'` (piped stdio is not bridged) and
  cancel through `ctx.signal` or the handle's `kill`, not a `SpawnOptions.signal`.

- `ctx.evidence(name)` reserves a file for evidence, such as a screenshot, and returns the absolute path to write it
  to. `name` is a plain file name, unique within the attempt. Whatever exists at that path when the attempt ends is
  recorded as the attempt's evidence and linked from the run's `report.html`.

`own`, `spawn` and `evidence` are refused once the phase that asked has ended, so a hook that was cut off cannot leave resources
behind after cleanup has looked at the ledger. If your consumer code exits mid-run, the runner records an
interrupted attempt and starts a fresh child for cleanup — which has no in-memory state, so cleanup must work from
persisted paths and the ledger, not from module-level variables alone.

## Scenario files

Each scenario file exports `scenarios`: an array of `{ id, setup?, steps }`. The requirement key
`windows/persistence` runs the scenario with id `persistence` on the `windows` profile.

```ts
import type { RunContext } from '../packages/qa/src/runner/execute.ts';

export const scenarios = [
  {
    id: 'persistence',
    async steps(ctx: RunContext): Promise<void> {
      // …
    },
  },
];
```

`setup` runs after launch and before `steps`, per scenario. The steps deadline is 5 minutes by default; the
install/reset/launch/setup phases get 2 minutes each, and cleanup (and reaping what the run still owns) gets 1
minute.

### Waiting and asserting

This distinction is the most important rule in this page:

- **A wait that runs out is an assertion failure.** `ctx.waitFor(condition, options)` polls `condition` until it is
  true, then returns; running out of time throws `AssertionFailure` and the scenario is **failed** — the candidate
  did not behave. Use it for anything that takes time: a readout to change, a window to come back after a restart.

  ```ts
  await ctx.waitFor(async () => (await readout()) === expected, { timeoutMs: 20_000, intervalMs: 200, description: 'the saved value to be shown' });
  ```

  Defaults: 10 s timeout, 50 ms interval. `description` appears in the failure: `timed out after 20000 ms waiting
  for the saved value to be shown`.

- **An error thrown by your code is an infrastructure error, not a verdict.** A thrown `Error` (the driver went
  away, a file could not be read) makes the scenario **interrupted** and the run exits `3`. Only assertions decide
  the candidate.

- **Direct checks use `node:assert`.** Anything you can check immediately — a file exists, its content matches —
  assert it: `assert.equal(readFileSync(settingFile(), 'utf8'), value)`. A failed `assert` is an assertion failure
  (`failed`, exit `1`), which is what you want: a Save that wrote nothing is the candidate failing, not a read
  error.

The pattern the sample follows: wait for UI state with `ctx.waitFor`, assert on-disk truth with `node:assert`, and
never let a not-yet-loaded page turn into a false verdict — a read that may fail while loading returns `undefined`
and the `waitFor` keeps polling instead.

### Driving the app

Scenario code sees the same `ctx` as the hooks (`ctx.artifact`, `ctx.testRoot`, `ctx.signal`, `ctx.own`,
`ctx.spawn`, `ctx.waitFor`, `ctx.evidence`). The application itself is reached through the session your `launch` hook stored; the
sample's scenario finds elements by id:

```ts
await (await session().browser.$('#setting-input')).setValue(value);
await (await session().browser.$('#save-button')).click();
await session().restart(ctx);
await session().screenshot(await ctx.evidence('2-restarted.png'));
```

`session().browser` is the WebdriverIO browser. `restart(ctx)` ends the session, waits for the app to exit and
launches it again; pass the running phase's `ctx`, because the new instance is owned through it (the context the
launch hook received belongs to a phase that has ended, and using it is refused). `screenshot(path)` waits 500 ms,
saves a PNG of the app's page (the webview only, no desktop or window frame) and returns its SHA-256. A screenshot is
a record of what was seen; assert state through the DOM and on disk, never through the screenshot. See the sample's
[`persistence.spec.ts`](../examples/tauri-smoke/qa/persistence.spec.ts) for a
complete scenario: save, verify on disk, restart, verify again, clear, restart, verify gone.

## Worked example

[`examples/tauri-smoke/qa/`](../examples/tauri-smoke/qa/) is a complete, passing consumer:

| File | What it shows |
| --- | --- |
| [`project.json`](../examples/tauri-smoke/qa/project.json) | two profiles, one automated requirement per profile, one suite |
| [`lifecycle.ts`](../examples/tauri-smoke/qa/lifecycle.ts) | NSIS install into the test root, `dpkg-deb -x` on Linux, owned launch, cleanup that attempts every step and reports failures together |
| [`app.ts`](../examples/tauri-smoke/qa/app.ts) | shared paths, `runToEnd` over `ctx.spawn`, Windows registry cleanup, refusing an install the run did not make |
| [`persistence.spec.ts`](../examples/tauri-smoke/qa/persistence.spec.ts) | `ctx.waitFor` for UI state, `node:assert` for the file on disk, a screenshot after each change with a check that none is stale |

To write a one-scenario suite for another Tauri app, copy that directory, change `projectId`, the profile list, the
requirement keys and the paths in `app.ts`, and point `run --project` at the new `qa/project.json`.
