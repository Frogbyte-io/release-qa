# Decision: automating unchanged packaged Tauri applications (Task 0.1)

Status: **partly complete.** The sample-app half is proven on Windows and on Ubuntu 24.04/Xvfb. The Dot X first-flow feasibility check was **not attempted** (see [Not attempted](#not-attempted)), so the task's exit condition is not fully met.

Date: 2026-09-20. Sample: [`examples/tauri-smoke`](../../examples/tauri-smoke). Harness and reproduction steps: [`experiments/native-automation`](../../experiments/native-automation). Raw records: [`evidence/`](../../experiments/native-automation/evidence).

## Decision

For the sample app, **unchanged release packages are automatable on both platforms** with an external `tauri-driver` 2.0.6, WebdriverIO 9.31.9 (`remote()` API) and the platform's native driver: Microsoft Edge WebDriver on Windows, `WebKitWebDriver` on Linux. The installed binaries were launched as shipped; no flag, feature, embedded server or other change was made to the app or its package.

This decision is about the sample only. It does not establish the same for Dot X (different window, plugins, signing, and audio behaviour).

## Evidence record

```text
OS/session | package format | package SHA-256 | driver/version
launch | click/save | real native persistence | restart | cleanup
shipping binary changed? | flags used | limitations | evidence paths
```

| | Windows | Linux |
| --- | --- | --- |
| OS/session | Windows 11 Pro 10.0.26200 x64, interactive desktop session of an everyday laptop, WebView2 153.0.4234.48 | Ubuntu 24.04.5 LTS x86_64 in a throwaway WSL2 distro (kernel 5.15.167.4-microsoft-standard-WSL2), root user, Xvfb `:99` 1280x1024x24, WebKitGTK 2.52.6 |
| Package format | NSIS installer, per-user, release mode, unsigned | `.deb`, release mode, installed with `apt-get install ./file.deb` |
| Package SHA-256 | installer `f2e9663903d3345f11e3b2bba3ecfd18a688b7c5124b3ad7186e63af248ff5dd`; installed binary `8db9f967b949d039d6a5e6194f8136cb2948f8f6e767279f31b5c0283095e4b5` | `.deb` `3e785299c185c3fca524c3dd4a8ad66fd0bbb30672fd5db0967b235ca9833203`; installed binary `618eb56fdbc15323f5ea6fcdaf4e704e4f07c7324721647b15af1e399074a620` (all in [`packages.json`](../../experiments/native-automation/evidence/packages.json)) |
| Driver/version | tauri-driver 2.0.6, msedgedriver 153.0.4234.48, WebdriverIO 9.31.9, Node 24.13.0 | tauri-driver 2.0.6, webkit2gtk-driver 2.52.6-0ubuntu0.24.04.1, WebdriverIO 9.31.9, Node 22.23.2 |
| Launch | 10/10 in each of 3 runs | 10/10 in each of 3 runs |
| Click/save | Text typed, Save clicked, readout showed the value (including `åäö ✓`) | Same |
| Real native persistence | File read straight from `%APPDATA%\dev.frogbyte.releaseqa.smoke\setting.txt` matched | File read from `~/.local/share/dev.frogbyte.releaseqa.smoke/setting.txt` matched |
| Restart | Session ended, app process gone (polled by exact install path), relaunch showed the persisted value; Clear removed the file; a third launch showed the cleared state | Same |
| Cleanup | No app process left in any attempt; the harness only inspects processes by exact path and never kills by name | Same |
| Shipping binary changed? | No | No |
| Flags used | `tauri-driver --native-driver <msedgedriver.exe> --port 4444 --native-port 4445`; the app was started by the driver with no arguments from us | Same with `WebKitWebDriver` |
| Evidence paths | [`windows-run1`](../../experiments/native-automation/evidence/windows-run1/), [`windows-run2`](../../experiments/native-automation/evidence/windows-run2/), [`windows-run3`](../../experiments/native-automation/evidence/windows-run3/) | [`linux-run1`](../../experiments/native-automation/evidence/linux-run1/), [`linux-run2`](../../experiments/native-automation/evidence/linux-run2/), [`linux-run3`](../../experiments/native-automation/evidence/linux-run3/) |

Each run is 10 independent attempts from a clean profile, with the harness as it stood at the time:

- **Run 1**: first harness. No screenshot settle and no staleness check, and no `display` field in `environment.json`.
- **Run 2**: adds the 500 ms screenshot settle and the staleness check (Finding 4).
- **Run 3**: the harness as committed, after review hardening (preflight before any deletion, exact-path ownership of cleanup, awaiting the driver exit, count validation, driver executable hashes). **This is the run of record**; runs 1 and 2 are kept as history, not replaced.

Two single-attempt probes were run first to debug the harness and are not counted. All 60 attempts passed; no attempt was replaced by a rerun. Attempt durations: Windows 7.6-10.9 s, Linux 2.8-5.1 s. Only attempt 1's three screenshots are kept per run as samples; `screenshot-hashes.json` in each run records the SHA-256 of every screenshot. The account name was redacted from recorded paths (`%USERPROFILE%`).

## Findings

1. **Hash the installed file, not the build tree.** `target/release/<app>` is not the shipped file: the packager stamps a bundle-type marker into the packaged copy. On Windows the installed binary differs from the build-tree binary in exactly 3 bytes (`UNK` vs `NSS`, verified byte for byte). On Linux the hashes also differ (cause not inspected). The chain of custody must be package hash, then the hash of the installed inner file. Byte-for-byte reproducibility of rebuilds was not tested; treat a rebuild as a new candidate, as the spec already requires.
2. **The Windows driver must match the WebView2 runtime version.** Edge WebDriver 153.0.4234.48 matched runtime 153.0.4234.48 and was downloaded manually. WebView2 is evergreen and updates on its own, so the driver can fall out of step with no change to the app. What happens on a mismatch was not tested. The runner needs a doctor check that compares the two versions.
3. **`tauri-driver` has no `--version` flag** and `WebKitWebDriver` has none either; versions came from `cargo install --list` and `dpkg-query`.
4. **WebKitGTK screenshots can lag the DOM.** In linux-run1, 6 of 10 restart screenshots and 1 of 10 saved screenshots were byte-identical to the cleared-state screenshot (blank readout) although the DOM assertions had already passed. The retained attempt 1 is the saved-screenshot case; attempt 7 is a restart case. Windows showed 0 of 10 in every run. The harness now waits 500 ms before each screenshot and fails an attempt whose saved or restarted screenshot equals the cleared one. Linux runs 2 and 3 had 0 of 10 stale in both categories. With 10 samples per run this shows the settle delay plus the check works here, not that the delay is the sole cause. The counts are reproducible from `screenshot-hashes.json` in each run (`summary.savedEqualsCleared`, `summary.restartedEqualsCleared`); run 1 has no staleness step in its attempt records because the check was added afterwards. The DOM assertion, not the screenshot, is the proof of state. Examples: [`stale-example-*.png`](../../experiments/native-automation/evidence/linux-run1/).
5. **Xvfb prints `your 131072x1 screen size is bogus` under WSL2.** The effective screen was verified as 1280x1024 through Xlib. Treat the message as startup noise here.
6. **Playwright/WebView2 was not needed.** The plan called for that comparison only if the external route failed or lacked behaviour.

## Limitations

- **The Windows machine is an everyday laptop, not a dedicated test machine.** The maintainer chose it after being told the design advises against it. The app was installed per-user into a directory on `D:`. The installer created an `HKCU` uninstall key and a Start menu shortcut; the silent uninstaller removed both and the binary, but **left the app-data directories** (`%APPDATA%` and the `%LOCALAPPDATA%` WebView2 profile), which were then deleted by hand. Only directories named exactly after the sample's unique identifier were ever cleaned or deleted. A "clean profile" here means deleting those directories, not a fresh OS profile.
- **The Linux environment is a throwaway WSL2 distro, not bare metal.** WSLg also adds a Start menu shortcut for the distro's installed app on the host, which disappears when the distro is unregistered. The kernel is Microsoft's. Only a virtual display was used, so nothing here says anything about real Wayland, tray, audio devices or suspend/resume, as the design already states.
- **The sample is unsigned.** Signing readiness for Dot X was not checked.
- **Environment set by the drivers was not captured.** The app is launched by the drivers; I did not record the environment variables or arguments they set (for example a WebView2 remote-debugging port), so "no flags" is about what we passed, not proof that the driver adds nothing.
- **Harness safety checks were exercised by hand, not recorded.** With a copy of the app already running and a file in its profile, the harness refused (`already running: <pid>`), left the file and the running app untouched, and killed nothing; `COUNT=0` and `COUNT=abc` are rejected with exit 2. Those runs are not in `evidence/`. The interrupt (`SIGINT`/`SIGTERM`) cleanup and the per-user `HKCU` WebView2 lookup are implemented but were **not exercised**; this machine has the per-machine registry key.
- **Sample only, one app, one build.** Thirty attempts per platform show the mechanism works, not a failure rate.

## Not attempted

The plan's Dot X bullet was not run:

- Launch the packaged Dot X on its designated Windows test machine.
- Find an existing or external way to supply slider input without a physical device.
- Independently read an audio session's volume.
- Check signing readiness.

No Dot X build or designated test machine was available in this session (the registered `windows-dev` host has guardrails requiring approval for package changes), and this repository does not contain Dot X. Dot X's first-flow input and readback feasibility is therefore **unknown**, and any Stage 6 claim that depends on it stays blocked. Task 0.1 should not be treated as fully closed until this is done or explicitly re-scoped.

## Consequences for later tasks

- Task 0.3 can adopt WebdriverIO + external `tauri-driver` as the driver for the sample-app milestone (Stage 2).
- The Stage 2 runner must record installed-file hashes and add doctor checks for driver/runtime version match (Windows) and for a display session (Linux).
- Screenshots are supporting evidence only; assertions must use DOM/native state.
