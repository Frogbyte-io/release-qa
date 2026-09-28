# Dot X first-flow feasibility probe (Task 0.1, issue #21)

Can the Stage 0 driver chain drive Dot X's first useful flow (launch, an audio session, mapping it, independent volume
readback, restart, persistence) without changing Dot X? The result and its constraints are recorded in
[`docs/decisions/native-automation.md`](../../docs/decisions/native-automation.md#dot-x); this directory is how it was
measured.

| File | What it is |
| --- | --- |
| [`explore.mjs`](explore.mjs) | Launches a Dot X build through tauri-driver and records the page, a screenshot and the window list; clicks nothing |
| [`probe.mjs`](probe.mjs) | `map`: launch, map the fixture's session to a slot through the app picker, check it in the UI and in `selectedApps.json`, record the fixture's volume while a person moves the slider. `verify`: launch again (the restart), check the mapping survived, record volume again, remove the mapping and check it is gone |
| [`AudioFixture.cs`](AudioFixture.cs) | `rqa-audio-fixture.exe`: a uniquely named process that loops an inaudible 440 Hz tone (amplitude 2 of 32767), so it has its own audio session |
| [`VolumeReadback.cs`](VolumeReadback.cs) | `rqa-volume-readback.exe <pid>`: that process's session volume and mute state, read from Windows Core Audio; shares no code with Dot X |
| [`evidence/`](evidence/) | The run of record: `map/` and `verify/` (log, every volume change the readback saw, picker screenshots) |

## Reproducing

Windows only, in the interactive desktop session, with the Decker connected and the installed Dot X **quit from the
tray** (a second instance hands over to the first, and both would share one profile and fight over the serial port).

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
   & $csc /nologo /out:<bin>\rqa-audio-fixture.exe AudioFixture.cs
   & $csc /nologo /out:<bin>\rqa-volume-readback.exe VolumeReadback.cs
   Copy-Item <bin>\rqa-audio-fixture.exe <fresh dir>; $fx = Start-Process <fresh dir>\rqa-audio-fixture.exe 10800 -WindowStyle Hidden -PassThru
   ```

   `probe.mjs` expects `rqa-volume-readback.exe` in `%TEMP%\dotx-probe\bin`.

4. **Run the two phases**, moving the slider during each watch window:

   ```powershell
   node probe.mjs map    "<build dir>\src-tauri\target\release\Dot X.exe" <msedgedriver.exe> $fx.Id <out> 4 60
   node probe.mjs verify "<build dir>\src-tauri\target\release\Dot X.exe" <msedgedriver.exe> $fx.Id <out> 4 45
   ```

5. **Stop the fixture by its pid, restore the profile** and check it against the manifests, then start the installed
   Dot X again.
