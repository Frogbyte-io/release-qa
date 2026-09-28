# Decision: automating unchanged packaged Tauri applications (Task 0.1)

Status: **complete.** The sample-app half is proven on Windows and on Ubuntu 24.04/Xvfb. The Dot X half was run on 2026-09-28: Dot X's first flow is **feasible with named constraints** (see [Dot X](#dot-x)).

Date: 2026-09-20. Sample: [`examples/tauri-smoke`](../../examples/tauri-smoke). Harness and reproduction steps: [`experiments/native-automation`](../../experiments/native-automation). Raw records: [`evidence/`](../../experiments/native-automation/evidence).

## Decision

For the sample app, **unchanged release packages are automatable on both platforms** with an external `tauri-driver` 2.0.6, WebdriverIO 9.31.9 (`remote()` API) and the platform's native driver: Microsoft Edge WebDriver on Windows, `WebKitWebDriver` on Linux. The installed binaries were launched as shipped; no flag, feature, embedded server or other change was made to the app or its package.

The same chain drives an unchanged Dot X release build on Windows; the constraints that come with Dot X are in [Dot X](#dot-x).

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
- **The sample is unsigned.** For Dot X's signing readiness see [Dot X](#dot-x).
- **Environment set by the drivers was not captured.** The app is launched by the drivers; I did not record the environment variables or arguments they set (for example a WebView2 remote-debugging port), so "no flags" is about what we passed, not proof that the driver adds nothing.
- **Harness safety checks were exercised by hand, not recorded.** With a copy of the app already running and a file in its profile, the harness refused (`already running: <pid>`), left the file and the running app untouched, and killed nothing; `COUNT=0` and `COUNT=abc` are rejected with exit 2. Those runs are not in `evidence/`. The interrupt (`SIGINT`/`SIGTERM`) cleanup and the per-user `HKCU` WebView2 lookup are implemented but were **not exercised**; this machine has the per-machine registry key.
- **Sample only, one app, one build.** Thirty attempts per platform show the mechanism works, not a failure rate.

## Dot X

Result: **feasible with named constraints.** An unchanged Dot X release build was driven through the same chain:
launched, an audio session discovered, mapped to a slider through the app picker, its volume read back independently
while the Decker's slider moved, the mapping found again after a restart, and removed again. Measured once, on
2026-09-28; harness, fixtures and reproduction steps in
[`experiments/dot-x-feasibility`](../../experiments/dot-x-feasibility), raw records in its
[`evidence/`](../../experiments/dot-x-feasibility/evidence).

| | Windows |
| --- | --- |
| Machine | the same everyday laptop and interactive session as above, WebView2 154.0.4258.37; the maintainer's Decker on USB serial `COM13` (VID `04D8`, PID `E626`) |
| Build | Dot X `v2` at `e595496` (version 2.0.0-1), `yarn tauri build --bundles nsis` in a separate worktree, **unsigned** (signing and updater artifacts turned off for that command; no repository file changed) |
| Package SHA-256 | installer `ecb705d2cd4f7e1786ee0a063ee73ff6812b49be025c87fb6992b53b03dbfb3d`; `Dot X.exe` `14b1b265c6bfd7794be92c299b75004671919763fcc2f2a79d6c3ed63a1cd210`, byte-identical to the copy inside the installer (extracted with 7-Zip) |
| What ran | that `Dot X.exe` from the build tree, **not installed** (see constraint 2) |
| Driver/version | tauri-driver 2.0.6 (Stage 0's binary, SHA-256 `61de0025…`), msedgedriver 154.0.4258.37, WebdriverIO 9.31.9, Node 24.13.0 |
| Launch | the window loaded and showed `Connected`: the build found and opened the Decker on its own |
| Audio session | [`rqa-audio-fixture.exe`](../../experiments/dot-x-feasibility/AudioFixture.cs), a uniquely named process playing an inaudible tone; Dot X listed it in the picker as `Rqa-Audio-Fixture` |
| Mapping | slot 4's picker: search, click; the fixture was ticked and written to `%APPDATA%\com.dot-x.dev\selectedApps.json` |
| Volume readback | [`rqa-volume-readback.exe`](../../experiments/dot-x-feasibility/VolumeReadback.cs) reads the fixture's session from Windows Core Audio, sharing no code with Dot X. Mapping alone moved it from 1.0 to 0.42 (the slider's position). While a person moved the slider it followed across the full range: 1.0 at the top, 0 **and muted** at the bottom (Dot X mutes below 1 %), about 0.43 in the middle; 31 changes in 60 s, and 16 in 45 s after the restart |
| Restart | a new session (the previous one's app had exited) found the mapping ticked and on disk, and slider moves still reached the fixture |
| Reverse state | unticking removed the mapping from the picker and from `selectedApps.json` |
| Cleanup | every process the probe started was stopped by its pid; the profile was restored from a backup and matched it file for file (SHA-256, 28 + 4002 files); the autostart entry was unchanged |

### Constraints

1. **Controlled slider input needs hardware.** Dot X reads sliders only from a USB serial device. The on-screen sliders
   are display-only, MIDI is output-only, and `get_devices` lists only ports whose type is USB, so a software virtual COM
   pair would not be offered or reconnected to. In this run **a person moved the Decker's slider**; only the readback was
   automated. An automated suite needs either that, or a USB CDC fixture (a programmable board speaking Decker's
   MessagePack slider messages) on the same production path. Nothing was mocked, and no scenario is claimed proven
   beyond what a person's slider input showed.
2. **No dedicated test machine or account yet.** The run used the maintainer's everyday profile, with their consent,
   because the Dot X installed there shares the product name and uninstall entry with the candidate and every Dot X
   build shares the one profile `com.dot-x.dev`. So the installer was **not run**: installation, uninstallation and
   what they leave behind are not proven for Dot X. The installed app was quit from the tray first and started again
   afterwards; the profile was backed up and restored. Stage 6 needs the dedicated account, machine or VM the design
   asks for.
3. **Signing is not ready.** The Frogbyte AS code-signing certificate configured in `tauri.conf.json` (Certum EV,
   thumbprint `CA2E93B1…`) **expired on 2026-07-04**. The build was unsigned, and so is the Dot X 2.0.0-1 installed on
   the laptop. A signed candidate needs a renewed certificate; the updater key was present in the environment but not
   used.
4. **Fixture details that matter.** Windows remembers per-application volume by executable path, so the fixture must
   start from a new path each attempt, or it starts at the volume Dot X last set. Dot X names a session by the
   executable's file description, so the fixture carries one. Dot X is single-instance and closes to the tray, so a run
   must first make sure no other Dot X is running and must stop what it started by pid.

What it does not show: a failure rate (one run of each phase), input latency (the readback polls roughly every 150 ms),
the plugins configured in the profile (not examined), and anything on Linux, where Dot X has no
release candidate.
