# Running the Electron sample through Release QA

This guide takes a fresh machine to a passing `release-qa run` of the Electron sample
([`examples/electron-smoke`](../../examples/electron-smoke)): the packaged app is unpacked, saved to, checked on disk,
restarted, cleared, restarted again and removed, driven through Electron's ChromeDriver
([decision](../decisions/electron-automation.md)). It mirrors [running the Tauri sample](run-the-sample.md); read that page
for what a designated machine is and what a run leaves behind. Unlike the Tauri sample, nothing is installed: the package is
an archive unpacked into the test root, and the app's data directory is pinned there too, so a run touches nothing outside
the test root.

| Piece | Version | Why pinned |
| --- | --- | --- |
| Node.js | 22.18 or newer (`.node-version` has the exact CI version) | runs the CLI with no build step |
| Electron | 44.4.5 (`examples/electron-smoke/package.json`) | the app being packaged |
| `electron-chromedriver` | 44.4.5, the same version as Electron | ChromeDriver must be built for the app's Chromium; `npm ci` downloads it |
| The sample's package | built on the same machine type: a `.zip` (Windows), a `.tar.gz` (Linux) | the candidate is the file you built |

`ELECTRON_RUN_AS_NODE` may be set in your shell: a process started from an Electron app can inherit it (it was set in the
shell this sample was developed from). The run removes it from the environment it starts ChromeDriver with; you do not need to unset it.

## Windows 11

Prerequisites: Git and Node.js. In PowerShell, from a clone of this repository:

```powershell
npm ci
cd examples\electron-smoke
npm ci
npm run package
$candidate = node scripts\write-candidate.mjs
cd ..\..

node packages\qa\src\cli\main.ts designate
node packages\qa\src\cli\main.ts doctor --project examples\electron-smoke\qa\project.json --profile windows
node packages\qa\src\cli\main.ts run --project examples\electron-smoke\qa\project.json --candidate $candidate --profile windows --suite release
```

The app window opens and closes three times. Leave the machine alone while it runs. To override the ChromeDriver, set
`RELEASE_QA_CHROMEDRIVER` to a build made for the same Electron release.

The archive is unpacked with Windows' own `tar.exe` (`%SystemRoot%\System32\tar.exe`), named by path because Git for
Windows puts a GNU `tar` first on `PATH` that reads `C:\...` as a remote host.

## Ubuntu 24.04

A fresh machine, a VM or a WSL2 distribution all work; the sample only needs a virtual display. From a clone of this
repository:

```sh
sudo apt-get update
sudo apt-get install -y libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libxss1 libxtst6 libatk-bridge2.0-0t64 \
  libcups2t64 libdrm2 libxkbcommon0 libxdamage1 libxrandr2 libpango-1.0-0 xvfb git curl
# Node.js: any 22.18+ install; for example the official build pinned in .node-version
```

Then:

```sh
npm ci
(cd examples/electron-smoke && npm ci && npm run package)
candidate=$(node examples/electron-smoke/scripts/write-candidate.mjs)

node packages/qa/src/cli/main.ts designate
xvfb-run -a -s "-screen 0 1280x1024x24" node packages/qa/src/cli/main.ts doctor --project examples/electron-smoke/qa/project.json --profile linux
xvfb-run -a -s "-screen 0 1280x1024x24" node packages/qa/src/cli/main.ts run --project examples/electron-smoke/qa/project.json --candidate "$candidate" --profile linux --suite release
```

**Running as root** (a fresh WSL2 distribution is): Electron refuses to start as root with Chromium's sandbox on
("Running as root without --no-sandbox is not supported"), and the run is then `interrupted` (exit `3`) at launch. Set
`RELEASE_QA_ELECTRON_NO_SANDBOX=1` to start the app with `--no-sandbox`, knowing the app then runs unsandboxed; the sample's
runs did. A non-root user was not tried. On WSL2 also `unset WAYLAND_DISPLAY`, as in the Tauri guide, so the run really uses
Xvfb.

## What a run leaves

- A passing run exits `0` and prints `windows/persistence: passed` (or `linux/...`). The run's journal and summary are under
  `.release-qa/runs/<run id>/`, with a screenshot of the app after each change in `evidence/<attempt id>/`; open
  `report.html` there.
- A failing scenario also keeps `failure.png`, `failure-dom.html` and `failure-console.json` (what the page showed, its
  current DOM and the renderer's console entries since the last read).
- Nothing else: the unpacked app and the data directory are inside the test root and removed, no process is left, and
  nothing is written to `%APPDATA%` or `~/.config`.
- If a run is interrupted, `resume --run <id>` continues it; if cleanup could not finish, `reset` clears what it left.
  See [local runs](../decisions/local-runs.md).

## Testing by hand (manual fallback)

Release QA has **no command yet to submit a manual pass as a policy-gate report**. Until it has, testing an Electron
package by hand finds problems and documents them; it does **not** make a requirement pass, and notes like these must not
be treated as a passing automated gate.

To do it: unpack the package (`tar -xf release-qa-electron-smoke-win32.zip -C <folder>` on Windows, `tar -xzf` on Linux),
start `release-qa-electron-smoke[.exe]`, and follow the scenario: type a value, **Save**, see it under "Saved value", quit
and start the app again, see it still there, **Clear**, quit, start, see it empty. By hand the app keeps its data in
Electron's default profile: `%APPDATA%\release-qa-electron-smoke\setting.txt` on Windows (`~/.config/release-qa-electron-smoke`
on Linux is Electron's default and was not checked). Delete that folder before and after so you start clean.

Record, for investigation: the package name and SHA-256, the OS and version, each step and what you saw, the outcome, and
screenshots.

| A person can verify | The runner can record |
| --- | --- |
| how it looks and feels: layout, window frame and title, menus, fonts, scaling, focus, animation | a screenshot of the page only (no window frame, menus or other windows), after each change |
| the app's real profile location, and that an installed or double-clicked package starts like a user's would | that the value is on disk in the run's pinned data directory, and gone after Clear, checked by the scenario itself |
| native behaviour outside the page: dialogs, notifications, tray, file associations, signing warnings | nothing outside the page: those are not reachable through WebDriver |
| that nothing odd happened, by watching | the renderer's console and the page's DOM, on failure only |
| how a crash or a hang looks | that the app started, restarted and exited, and that no process was left behind |
| the main process's own output (run from a terminal) | not recorded: WebDriver does not reach it |

A pass by hand and a pass by the runner are different claims: the runner's is repeatable and is what a gate can consume; a
person's covers what the runner cannot see.
