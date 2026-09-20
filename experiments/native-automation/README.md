# Native automation experiment (Task 0.1)

Drives the **unchanged, installed** sample app (`examples/tauri-smoke`) through an external WebDriver and checks persistence at the real filesystem boundary. Findings and the driver decision are in [`docs/decisions/native-automation.md`](../../docs/decisions/native-automation.md); raw records from the runs are in [`evidence/`](evidence/).

`run-attempts.mjs` runs N independent attempts. Each starts from a clean profile (only directories named after the sample's identifier are ever deleted), then: launch, type and Save, read the file from disk, end the session (the app process must exit), relaunch and assert the persisted value, Clear, relaunch and assert it is gone. It also fails an attempt if a screenshot is byte-identical to the cleared-state screenshot (stale capture). A failed attempt stays failed; nothing is retried.

## Windows

Prerequisites: Node 22+, Rust, the Tauri prerequisites, and an `msedgedriver.exe` **matching the installed WebView2 runtime version** (the `pv` value under `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`, or the same key under `HKCU\Software\Microsoft\EdgeUpdate\Clients` for a per-user install; the harness checks those two and `HKLM\SOFTWARE\Microsoft\EdgeUpdate\Clients`, and records `unknown` if none exists; download the driver from `https://msedgedriver.microsoft.com/<version>/edgedriver_win64.zip`).

```powershell
$ErrorActionPreference = 'Stop'   # stop on the first failing cmdlet
function Check { if ($LASTEXITCODE -ne 0) { throw "failed with exit code $LASTEXITCODE" } }   # native commands do not stop on their own
cargo install tauri-driver --locked --version 2.0.6; Check
cd examples\tauri-smoke; npm ci; Check; npm run build:windows; Check
# Do not run an installer left over from an earlier build: the harness would test a stale package.
& ".\src-tauri\target\release\bundle\nsis\Release QA Smoke_0.1.0_x64-setup.exe" /S /D=D:\some\install\dir; Check
cd ..\..\experiments\native-automation; npm ci; Check
$env:APP_EXE = 'D:\some\install\dir\release-qa-tauri-smoke.exe'
$env:NATIVE_DRIVER = 'D:\path\to\msedgedriver.exe'
$env:COUNT = '10'; node run-attempts.mjs
```

## Linux (Ubuntu 24.04, Xvfb)

```sh
sudo apt-get install -y build-essential curl wget file pkg-config libwebkit2gtk-4.1-dev libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev xvfb webkit2gtk-driver
# Node 22+ and Rust (rustup) as usual, then:
cargo install tauri-driver --locked --version 2.0.6
cd examples/tauri-smoke && npm ci && npm run build:linux
sudo apt-get install -y "./src-tauri/target/release/bundle/deb/Release QA Smoke_0.1.0_amd64.deb"
cd ../../experiments/native-automation && npm ci
APP_EXE=/usr/bin/release-qa-tauri-smoke NATIVE_DRIVER=/usr/bin/WebKitWebDriver COUNT=10 \
  xvfb-run -a -s "-screen 0 1280x1024x24" node run-attempts.mjs
```

Environment variables: `APP_EXE`, `NATIVE_DRIVER` (required); `TAURI_DRIVER` (default `tauri-driver`, resolved from `PATH`), `COUNT` (default 10, must be a positive integer), `OUT` (default `output/<timestamp>`, git-ignored), `SETTLE_MS` (screenshot settle delay, default 500).
