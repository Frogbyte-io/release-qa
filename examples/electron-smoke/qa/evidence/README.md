# Evidence: the Electron sample through `release-qa run` (issue #45)

One passing run per platform, kept as the CLI wrote it (the journal `events.jsonl`, `summary.json`, `report.html`, the
attempt's screenshots), for `windows/persistence` and `linux/persistence`. Each was driven end to end by
`node packages/qa/src/cli/main.ts run` with this directory's `project.json`, following
[the setup guide](../../../../docs/guides/run-the-electron-sample.md).

| | Windows | Linux |
| --- | --- | --- |
| Run | [`windows/run-20260929T100908Z-3085da`](windows/run-20260929T100908Z-3085da/report.html) | [`linux/run-20260929T101051Z-8434cd`](linux/run-20260929T101051Z-8434cd/report.html) |
| Machine | Windows 11 Pro 10.0.26200, the interactive desktop session of the laptop used for the other samples | Ubuntu 24.04.5 LTS in the `release-qa-sample` WSL2 distribution (kernel 5.15.167.4-microsoft-standard-WSL2), root user |
| Display | real (interactive session `Console`) | virtual (Xvfb serving `:99`; `WAYLAND_DISPLAY` unset) |
| Candidate | `release-qa-electron-smoke-win32.zip`, SHA-256 `3f7458894abd55fc9312e5130d1e55c4651f352d5d0e262ecb8143da84af730b`, built on that machine; the packaged `release-qa-electron-smoke.exe` inside is `c004368b…` | `release-qa-electron-smoke-linux.tar.gz`, SHA-256 `45179e688dd676e0a2d312998cb2b07663e26c9d1344ee0cf6198f4cf92bf4fb`, built there from commit `38ddbea` |
| Electron / ChromeDriver | 44.4.5 / 152.0.7977.130, `chromedriver.exe` SHA-256 `cccbdc0331378817433ec1c06a42882e040ccbeb86ec88e68ce044f5a3882d3e` | 44.4.5 / 152.0.7977.130, `chromedriver` SHA-256 `662b88ea69f6e1e0c0368b442d39d50c1534050ba703544f39e0f4ee6cd2e41a` |
| Node.js / WebdriverIO | 24.13.0 / 9.31.9 | 22.23.2 / 9.31.9 |
| App arguments | `--user-data-dir=<test root>\electron-user-data` | the same, plus `--no-sandbox` (`RELEASE_QA_ELECTRON_NO_SANDBOX=1`; see below) |
| Screenshot size | 1098 × 676 | 640 × 420 |
| Left behind | nothing: no app or ChromeDriver process after any run, and after the run above no unpacked app or data directory in the test root and nothing in `%APPDATA%` | nothing: no app or ChromeDriver process after any run |

Not the same package on both platforms: each was built on the machine it ran on.

## Other runs

- **Windows, a forced failure** (a scenario edited to wait for a value that never appears, then restored; not kept as a
  run): the attempt was `failed` with `timed out after 3000 ms waiting for the value to be cleared`, cleanup finished, no
  process was left. Besides the two screenshots taken before the failure, it kept `failure.png`, `failure-dom.html` and
  `failure-console.json` (`[]`: the page logged nothing). Checked by listing the run's evidence folder.
- **Linux, without `--no-sandbox`**: `interrupted` at launch (exit `3`) with `session not created: Chrome instance exited`;
  cleanup finished, no process was left. Running the packaged app by hand as root printed `Running as root without
  --no-sandbox is not supported`, which is the cause. The run is not kept.
- An earlier Windows run (the same package) and an earlier Linux run (a build from commit `94208ca`, SHA-256 `4627d10e…`)
  passed as well. The runs above are the second of each, after the ChromeDriver log was made opt-in: those first runs
  kept it as evidence, and it held the account's paths, which is why it is off by default.
- The Windows run was also made with `ELECTRON_RUN_AS_NODE=1` in the environment, which is how the CLI was started here;
  the run passed because the adapter removes the variable from the environment it starts ChromeDriver with.

## What was checked by looking

Every screenshot shows only the app's page (no desktop, window frame or other windows, no paths or account names); the ones
taken with the value saved show it, and the ones taken after Clear show an empty readout.

The Windows run's `invocation.json` held absolute paths under the account's profile directory. It is kept as
`invocation.redacted.json`, with the repository's location replaced by `%REPOSITORY%`: a record of what was asked, not a
file the CLI can `resume` from. Nothing else in either run was edited.

## Not shown here

- **A non-root Linux run**, macOS, another Electron version or a package built with electron-builder.
- **Repeated attempts at Stage 0's scale.** These runs show the scenario passing through the runner and CLI; they are not
  a reliability study.
- **Orbit Orchard.** It was not available to this work.
