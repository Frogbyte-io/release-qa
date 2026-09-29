# Decision: automating packaged Electron applications (issue #45)

Status: **complete for the sample app** on Windows 11 and Ubuntu 24.04/Xvfb. Orbit Orchard, the intended real consumer, was
not available to this work (no repository or build of it was reachable), so nothing here has been run against it; see
[Not proven](#not-proven).

Sample: [`examples/electron-smoke`](../../examples/electron-smoke). Probes and raw results:
[`experiments/electron-feasibility`](../../experiments/electron-feasibility). Real runs:
[`examples/electron-smoke/qa/evidence`](../../examples/electron-smoke/qa/evidence). Adapter:
[`packages/qa/src/drivers/electron.ts`](../../packages/qa/src/drivers/electron.ts).

## Decision

Drive a packaged Electron app with **Electron's own ChromeDriver and the repository's `remote()`** (WebdriverIO 9.31.9),
started and owned by an `ElectronApp` adapter that has the same shape as `TauriApp`: `start(ctx, options)`, `browser`,
`screenshot`, `restart(ctx)`, `close()`. It launches the exact packaged executable, needs no change to the app, and does not
depend on the Node inspector (`EnableNodeCliInspectArguments`) that the WebdriverIO service's main-process API needs.

The supported WebdriverIO integration, `@wdio/electron-service`, was tried first and works for the sample. It is not used
as the adapter's base, for reasons that are all measured (below).

## Requirements

| | |
| --- | --- |
| Driver | the ChromeDriver built for the app's Electron release: the `electron-chromedriver` package at the **same version as `electron`** (44.4.5 here; ChromeDriver 152.0.7977.130). A ChromeDriver for a different Chromium major than the app's was not tried |
| Client | WebdriverIO `remote()` against `127.0.0.1:9515`, no service, no `browserName` (see below) |
| Windows | interactive desktop session (the `display` capability). Nothing else: no installer, no registry, no elevated rights |
| Linux | a display (Xvfb is enough) and Electron's runtime libraries (`libgtk-3`, `libnss3`, `libasound2`, `libgbm1` and the rest of the list in [the guide](../guides/run-the-electron-sample.md#ubuntu-2404)). The sample's runs were as **root**, which Electron refuses unless started with `--no-sandbox`; the sample's lifecycle adds it only when `RELEASE_QA_ELECTRON_NO_SANDBOX=1`. A non-root run was not measured |
| macOS | not attempted |
| Candidate | an archive of the packaged app (`@electron/packager` output: Electron's binary renamed, code in `resources/app.asar`), unpacked into the test root: `.zip` on Windows, `.tar.gz` on Linux |

## What the adapter does that the probes showed it must

1. **Removes `ELECTRON_RUN_AS_NODE` from the driver's environment.** With it set, an Electron executable is a Node.js
   interpreter: launched with `--remote-debugging-port` it prints `bad option` and exits, ChromeDriver reports "Chrome
   failed to start: crashed", and no window ever opens. A process started from another Electron app can inherit the
   variable: the shell this work was done from had it, and the planned dashboard is an Electron app. A package with the `RunAsNode` fuse
   off ignores the variable (measured).
2. **Pins `--user-data-dir`.** ChromeDriver otherwise gives each session a fresh temporary profile, so nothing the app
   saves would survive a restart. The caller passes a directory inside the test root, so the run also never reads or writes
   the machine user's real profile (`%APPDATA%\<app name>` / `~/.config/<app name>`).
3. **Sends no `browserName`.** With `"chrome"`, ChromeDriver attaches to an empty `about:blank` page instead of the app's
   window; with `"electron"` it refuses the session. Both were measured.
4. **Owns the app's processes.** The app is 4 processes from one executable, all children of ChromeDriver, and killing
   ChromeDriver first leaves all 4 running. The adapter starts ChromeDriver with `ctx.spawn`, finds the app's processes
   below it after every launch and records each with `ctx.own`, exactly as `TauriApp` does; `close()` returns only once
   nothing runs from the executable. A process that cannot be owned is stopped and the launch fails.
5. **Refuses to drive an instance it did not start**: an executable that already runs, or a busy port, fails before
   anything starts.

## Why not `@wdio/electron-service`

All measured on the same package ([results](../../experiments/electron-feasibility/README.md#results)):

- Its main-process API needs the Node inspector: with `EnableNodeCliInspectArguments` off (a common hardening step) that
  API is disabled, though renderer sessions still start (measured). ChromeDriver needs no fuse.
- It starts its own ChromeDriver inside the calling process through WebdriverIO's utilities, not through `ctx.spawn`, so
  the runner does not know about it. It downloads a matching ChromeDriver at run time unless one is named.
- It loads a second WebdriverIO (9.30.1 beside the repository's 9.31.9).
- A session took 1.5-3.0 s (6 sessions) against 0.48-0.55 s (5 sessions; one cold first start took 6.5 s).

What it offers that the adapter does not: mocking and executing code in the **main process** (`browser.electron.execute`).
A scenario that needs that has to come from a later, separate decision; the renderer is what the adapter reaches, and the
files and side effects a scenario checks independently (as the sample checks `setting.txt`).

## Evidence in a run report

The Electron sample's runs are ordinary Release QA runs: a `windows/persistence` or `linux/persistence` attempt recorded in
the journal (`events.jsonl`), `summary.json`, `report.html`, and the attempt's evidence files (a screenshot after each
change). A scenario that fails additionally keeps the screenshot, the page's DOM and the renderer's console
(`captureFailureEvidence`); a forced failure was run to check that (the Windows evidence folder's README). Policy gates
consume the attempt outcome as they do for the Tauri sample. Nothing about the report format changed.

## Not proven

- **Orbit Orchard.** Its real packaging (electron-builder, installer, code signing, auto-update, multiple windows) is not
  represented by the sample. The adapter takes an executable path, so an installed or unpacked build fits; how Orbit
  Orchard is installed and reset is its own lifecycle module, as it is for any consumer.
- **A non-root Linux run**, macOS, other Electron versions, and packages built with electron-builder rather than
  `@electron/packager`.
- **Multi-window apps.** ChromeDriver attaches to one window; switching windows uses the standard WebDriver commands and
  was not exercised.
- **The main process.** Its stdout/stderr and console are not reachable through WebDriver and are not recorded.
- **Evidence content.** The screenshots, DOM and console are the app's own; an app that shows a user's data will put it in
  evidence that may be published. The adapter's ChromeDriver log is off by default for the same reason (it carries local
  paths).
- **Stability at scale.** Two passing runs per platform (plus, on Windows, a forced failure and, on Linux, a run without
  `--no-sandbox` that was interrupted, both described in the evidence README); not a reliability study like Stage 0's.
