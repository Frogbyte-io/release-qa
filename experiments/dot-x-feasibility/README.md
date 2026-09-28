# Dot X first-flow feasibility probe (Task 0.1, issue #21)

Can the Stage 0 driver chain drive Dot X's first useful flow (launch, an audio session, mapping it, independent volume
readback, restart, persistence) without changing Dot X? The result and its constraints are recorded in
[`docs/decisions/native-automation.md`](../../docs/decisions/native-automation.md#dot-x); this directory is how it was
measured.

| File | What it is |
| --- | --- |
| [`driver.mjs`](driver.mjs) | Starts tauri-driver on free ports (refusing occupied ones), opens the session, and stops everything the session started, by pid and start time, also on Ctrl+C |
| [`explore.mjs`](explore.mjs) | Launches a Dot X build through tauri-driver and records the page, a screenshot and the window list; clicks nothing |
| [`probe.mjs`](probe.mjs) | `map`: launch, map the fixture's session to a slot through the app picker, check it in the UI and in `selectedApps.json`, record the fixture's volume while a person moves the slider. `verify`: launch again (the restart), check the mapping survived, record volume again, remove the mapping and check it is gone |
| [`AudioFixture.cs`](AudioFixture.cs) | `rqa-audio-fixture.exe`: a uniquely named process that loops an inaudible 440 Hz tone (amplitude 2 of 32767), so it has its own audio session |
| [`VolumeReadback.cs`](VolumeReadback.cs) | `rqa-volume-readback.exe <pid>`: that process's session volume and mute state, read from Windows Core Audio; shares no code with Dot X |
| [`evidence/`](evidence/) | The run of record: `map/` and `verify/` (log, every volume change the readback saw, picker screenshots) |

The run of record was made with these scripts as first committed (`57d4298`). Review then hardened them without
changing what they measure: `driver.mjs` took over starting and stopping the chain, a watch window now fails unless it
sees the whole range (the recorded windows did), and the readback marshals the mute flag as a 4-byte `BOOL` and checks
every call's result. The recorded mute values stand: `BOOL` is 0 or 1, which the earlier 2-byte read also gets right.

## Reproducing

Windows only, in the interactive desktop session, with the Decker connected and the installed Dot X **quit from the
tray** (a second instance hands over to the first, and both would share one profile and fight over the serial port).

Prerequisites: a checkout of this repository with `npm ci` run at its root (the scripts use the root's `webdriverio`, so
run them from inside the checkout), `tauri-driver` 2.0.6 on `PATH` (`cargo install tauri-driver --locked --version
2.0.6`), and the Microsoft Edge WebDriver matching the installed WebView2 runtime (see
[the setup guide](../../docs/guides/run-the-sample.md)).

1. **Build the candidate** from a separate worktree of Dot X, without the production signing certificate or updater key
   (the probe does not need them, and Certum signing can stop for a PIN prompt):

   ```powershell
   git -C <dot-x> worktree add --detach <build dir> <commit>
   cd <build dir>; yarn install --frozen-lockfile
   '{"bundle":{"createUpdaterArtifacts":false,"windows":{"certificateThumbprint":null}}}' | Set-Content <config file>
   Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
   yarn tauri build --bundles nsis --config <config file>
   ```

   The build regenerates the tracked license reports in that worktree; discard them.

2. **Back up the Dot X profile** (`%APPDATA%\com.dot-x.dev` and `%LOCALAPPDATA%\com.dot-x.dev`) with SHA-256 manifests.
   Every Dot X build on the machine uses that one profile: the probe writes a mapping into it.

3. **Compile the fixtures** with the .NET Framework compiler that ships with Windows, and start the audio fixture **from a
   new directory each time**: Windows remembers a per-application volume by executable path, so a copy that ran before
   starts at whatever volume Dot X last gave it.

   ```powershell
   $csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
   $bin = "$env:TEMP\dotx-probe\bin"   # probe.mjs runs the readback from here
   New-Item -ItemType Directory -Force $bin | Out-Null
   & $csc /nologo /out:"$bin\rqa-audio-fixture.exe" AudioFixture.cs
   & $csc /nologo /out:"$bin\rqa-volume-readback.exe" VolumeReadback.cs
   Copy-Item "$bin\rqa-audio-fixture.exe" <fresh dir>; $fx = Start-Process <fresh dir>\rqa-audio-fixture.exe 10800 -WindowStyle Hidden -PassThru
   ```

4. **Run the two phases**, moving the slider during each watch window. A window passes only if the readback sees the
   top (1.0) and the bottom (0, muted), so move the slider all the way both ways:

   ```powershell
   node probe.mjs map    "<build dir>\src-tauri\target\release\Dot X.exe" <msedgedriver.exe> $fx.Id <out> 4 60
   node probe.mjs verify "<build dir>\src-tauri\target\release\Dot X.exe" <msedgedriver.exe> $fx.Id <out> 4 45
   ```

5. **Stop the fixture by its pid, restore the profile** and check it against the manifests, then start the installed
   Dot X again.
