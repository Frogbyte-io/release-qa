# Running the sample through Release QA

This guide takes a fresh machine to a passing `release-qa run` of the sample app's persistence scenario
([`examples/tauri-smoke`](../../examples/tauri-smoke)): the packaged app is installed, saved to, checked on disk,
restarted, cleared, restarted again and removed, all driven through WebDriver as proven in Stage 0
([decision](../decisions/native-automation.md)).

It needs a **designated machine**: an interactive Windows desktop session, or Linux with a display (Xvfb is enough
for this sample). Hosted CI runners are not used for this; see [tool layout](../decisions/tool-layout.md#ci).

The same four pieces are needed everywhere, pinned to what Stage 0 proved:

| Piece | Version | Why pinned |
| --- | --- | --- |
| Node.js | 22.18 or newer (`.node-version` has the exact CI version) | runs the CLI with no build step |
| `tauri-driver` | 2.0.6, `cargo install --locked` | the driver chain Stage 0 proved |
| Native driver | Windows: Microsoft Edge WebDriver **matching the installed WebView2 runtime**; Linux: `WebKitWebDriver` from `webkit2gtk-driver` | a mismatched Edge WebDriver refuses to start sessions |
| The sample's package | built on the same machine type: NSIS installer (Windows), `.deb` (Linux) | the candidate is the file you built |

## Windows 11

Prerequisites: Git, Node.js, [Rust](https://rustup.rs), and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/)
(Microsoft C++ Build Tools; WebView2 is part of Windows 11). In PowerShell, from a clone of this repository:

```powershell
cargo install tauri-driver --locked --version 2.0.6

# The Edge WebDriver must match the WebView2 runtime exactly. Read its version, then fetch that driver.
# A machine-wide WebView2 registers under HKLM, a per-user one under HKCU; the first one set is the installed runtime.
$v = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
     'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' |
  ForEach-Object { (Get-ItemProperty $_ -ErrorAction SilentlyContinue).pv } |
  Where-Object { $_ -and $_ -ne '0.0.0.0' } | Select-Object -First 1
if (-not $v) { throw 'WebView2 Runtime is not installed' }
$tools = "$env:LOCALAPPDATA\release-qa\tools\msedgedriver-$v"
New-Item -ItemType Directory -Force $tools | Out-Null
Invoke-WebRequest "https://msedgedriver.microsoft.com/$v/edgedriver_win64.zip" -OutFile "$tools\edgedriver_win64.zip"
Expand-Archive "$tools\edgedriver_win64.zip" -DestinationPath $tools -Force
Get-FileHash "$tools\msedgedriver.exe" -Algorithm SHA256   # record it with your run
$env:RELEASE_QA_NATIVE_DRIVER = "$tools\msedgedriver.exe"

npm ci
cd examples\tauri-smoke
npm ci
npm run build:windows
$candidate = node scripts\write-candidate.mjs
cd ..\..

node packages\qa\src\cli\main.ts designate
node packages\qa\src\cli\main.ts doctor --project examples\tauri-smoke\qa\project.json --profile windows
node packages\qa\src\cli\main.ts run --project examples\tauri-smoke\qa\project.json --candidate $candidate --profile windows --suite release
```

The app window opens and closes three times. Leave the machine alone while it runs.

The sample must not already be installed for your user: the run refuses, rather than taking over an installation it did
not make. The installer goes into the test root (`/S /D=<root>\smoke-app`); outside it, it adds an uninstall entry,
Start Menu and Desktop shortcuts, and `HKCU\Software\frogbyte\Release QA Smoke`. Cleanup runs the uninstaller in place
and removes that key, which the uninstaller leaves behind.

## Ubuntu 24.04

A fresh machine, a VM or a WSL2 distribution all work; the sample only needs a virtual display. From a clone of this
repository:

```sh
sudo apt-get update
sudo apt-get install -y build-essential curl wget file pkg-config libwebkit2gtk-4.1-dev libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev xvfb webkit2gtk-driver git
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && . "$HOME/.cargo/env"
cargo install tauri-driver --locked --version 2.0.6
# Node.js: any 22.18+ install; for example the official build pinned in .node-version
```

Then:

```sh
npm ci
(cd examples/tauri-smoke && npm ci && npm run build:linux)
candidate=$(node examples/tauri-smoke/scripts/write-candidate.mjs)

node packages/qa/src/cli/main.ts designate
xvfb-run -a -s "-screen 0 1280x1024x24" node packages/qa/src/cli/main.ts doctor --project examples/tauri-smoke/qa/project.json --profile linux
xvfb-run -a -s "-screen 0 1280x1024x24" node packages/qa/src/cli/main.ts run --project examples/tauri-smoke/qa/project.json --candidate "$candidate" --profile linux --suite release
```

On **WSL2**, WSLg sets `WAYLAND_DISPLAY`, and GTK then draws through WSLg instead of the virtual X display; run
`unset WAYLAND_DISPLAY` first so the run really uses Xvfb (a headless Ubuntu machine has no `WAYLAND_DISPLAY` to begin
with). `doctor` shows which display the run sees.

`RELEASE_QA_NATIVE_DRIVER` defaults to `/usr/bin/WebKitWebDriver` on Linux. The `.deb` is **unpacked** into the test
root with `dpkg-deb -x` rather than installed with `apt`: the app binary is the packaged one byte for byte, no root
access is needed, and nothing is installed system-wide, but the package manager's own steps and desktop integration are
not exercised.

## What a run leaves

- A passing run exits `0` and prints `linux/persistence: passed` (or `windows/...`). The run's journal and summary are
  under `.release-qa/runs/<run id>/`.
- The app, its data directory (`%APPDATA%\dev.frogbyte.releaseqa.smoke` or `~/.local/share/dev.frogbyte.releaseqa.smoke`)
  and everything the installer created are removed. The sample's data directory is wiped at the start and end of
  every run, so do not use the sample app for anything else on that machine.
- If a run is interrupted, `resume --run <id>` continues it; if cleanup could not finish, `reset` clears what it left
  once you have fixed the cause. See [local runs](../decisions/local-runs.md).
