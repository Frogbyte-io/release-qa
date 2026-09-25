# Evidence: the sample through `release-qa run` (Task 2.2)

One passing run per platform, kept as the CLI wrote it (`invocation.json`, the journal `events.jsonl`, and
`summary.json`). Each was driven end to end by `node packages/qa/src/cli/main.ts run` with this directory's
`project.json`, following [the setup guide](../../../../docs/guides/run-the-sample.md).

| | Windows | Linux |
| --- | --- | --- |
| Machine | Windows 11 Pro 10.0.26200, the interactive desktop session of the laptop used in Stage 0 | A fresh Ubuntu 24.04.5 LTS WSL2 distribution (kernel 5.15.167.4-microsoft-standard-WSL2), installed for this run, set up by following the guide literally, then removed |
| Display | real (interactive session `Console`) | virtual (Xvfb serving `:99`; `WAYLAND_DISPLAY` unset, see the guide) |
| Candidate | Stage 0's NSIS installer, SHA-256 `f2e9663903d3345f11e3b2bba3ecfd18a688b7c5124b3ad7186e63af248ff5dd` (candidate id `local-stage0-nsis-0.1.0`) | Built on that machine from this branch (commit `15e62628`): `.deb` SHA-256 `63e244ad765eb9031b6a941cd31383e03c4954b3eaf1db885806e90985f9e622` ([manifest record](linux/candidate-record.json)) |
| App binary | installed into the test root with `/S /D=<root>\smoke-app` | unpacked with `dpkg-deb -x`: SHA-256 `618eb56fdbc15323f5ea6fcdaf4e704e4f07c7324721647b15af1e399074a620`, byte for byte what `apt-get install` put in `/usr/bin` on the same machine, and the same as Stage 0's installed binary |
| tauri-driver | 2.0.6, SHA-256 `61de00257e7b1b5d2aa1326d21cd914a3590a030fd3339a8caad2c75873e9e1e` (Stage 0's) | 2.0.6 built there with `cargo install --locked`, SHA-256 `0f4d1c9c71432f1fc7601798fe741fbaaadfa86d65e42faef218067c945ca88f` |
| Native driver | Microsoft Edge WebDriver 153.0.4234.48 for WebView2 153.0.4234.48, SHA-256 `4ae19c1db425d12f30952bc6b02abf4e61a84f82b33bb17721b4150fafc0402e` (Stage 0's) | `webkit2gtk-driver` 2.52.6-0ubuntu0.24.04.1, `WebKitWebDriver` SHA-256 `488118541ba1dbeaca658073af84322900485b9435bc4fbb43eb1faf21db8b70` |
| Node.js | 24.13.0 | 22.23.2 (official build, checksum verified) |
| Runs | 2 passing (this is the second); plus one with the disk assertion deliberately broken (`failed`, exit 1, cleanup ok) and one with a missing native driver (`interrupted`, exit 3, cleanup ok); and, after a run was killed mid-scenario and the root `reset`, one passing run that first removed the uninstall entry, remembered-directory key and shortcuts the killed run had left | 3 passing (this is the first) |
| Left behind | nothing: no uninstall entry, shortcuts, registry keys, app data, install directory or processes (checked after every run) | nothing: no app data, install directory or processes (checked after every run) |

The Linux `.deb` hash differs from Stage 0's (`3e7852…`), but the app binary inside it is identical to Stage 0's:
the package's own metadata changed between builds, the binary did not.

## Not shown here

- **Evidence files.** Attempts record `evidence: []`: the scenario does not take screenshots yet. The DOM checks and
  the independent read of `setting.txt` are what prove state, as in Stage 0. Tracked in [#19](https://github.com/Frogbyte-io/release-qa/issues/19).
- **Repeated attempts at Stage 0's scale.** Stage 0 ran 10 attempts in each of 3 runs per platform. These runs show
  the same scenario passing through the runner and CLI; they are not a new reliability study.
- **A runnable Linux candidate.** [`linux/candidate-record.json`](linux/candidate-record.json) is the manifest that
  run used, kept as a record. The `.deb` it names was not committed, so it cannot be passed to `--candidate`; build
  the sample and write a manifest for your own build (see the guide).
