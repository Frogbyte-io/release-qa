# Electron feasibility (issue #45)

Two ways to drive a **packaged** Electron app with the repository's pinned WebdriverIO (9.31.9), measured against the
sample in [`examples/electron-smoke`](../../examples/electron-smoke). The decision they support is in
[`docs/decisions/electron-automation.md`](../../docs/decisions/electron-automation.md); this page is how to repeat them.

| Probe | What it drives |
| --- | --- |
| [`probe-service.mjs`](probe-service.mjs) | the supported WebdriverIO integration, `@wdio/electron-service` 10.3.0 in standalone mode (`startWdioSession`) |
| [`probe-chromedriver.mjs`](probe-chromedriver.mjs) | Electron's own chromedriver (`electron-chromedriver` 44.4.5) with the repository's `remote()` and no service |

Each writes one JSON file to [`evidence/`](evidence) (home directory replaced by `%USERPROFILE%`). Both stop anything
they leave running and report how many processes that was.

## Repeat it

Windows or Linux, Node.js 22.18+, from a clone:

```sh
(cd examples/electron-smoke && npm ci && npm run package)
cd experiments/electron-feasibility
npm ci
node prepare.mjs        # copies the package to output/app and output/app-hardened (fuses turned off), prints both paths
```

`node probe-service.mjs <exe> <name>.json` and `node probe-chromedriver.mjs <exe> <name>.json [--keep-env]`, with
`output/app/release-qa-electron-smoke[.exe]` or `output/app-hardened/...`. `--keep-env` leaves `ELECTRON_RUN_AS_NODE` in
the driver's environment. The probes were run on the Windows 11 laptop below, in an interactive session, as:

```sh
APP=output/app/release-qa-electron-smoke.exe            # no .exe on Linux
HARDENED=output/app-hardened/release-qa-electron-smoke.exe
ELECTRON_RUN_AS_NODE=1 node probe-service.mjs $APP service-run-as-node-set.json
node probe-service.mjs $APP service.json
node probe-service.mjs $HARDENED service-hardened.json
node probe-chromedriver.mjs $APP chromedriver.json
ELECTRON_RUN_AS_NODE=1 node probe-chromedriver.mjs $HARDENED chromedriver-hardened-run-as-node-set.json --keep-env
ELECTRON_RUN_AS_NODE=1 node probe-chromedriver.mjs $APP chromedriver-run-as-node-set.json --keep-env
```

Run the ones that do not name `ELECTRON_RUN_AS_NODE` after `unset ELECTRON_RUN_AS_NODE`. It was set in the shell the
work was done from (a tool that is itself an Electron app), which is how the variable was found.

## Results

Windows 11 Pro 10.0.26200, Node.js 24.13.0, Electron 44.4.5 (Chromium 152), ChromeDriver 152.0.7977.130. `$HARDENED` has the
`RunAsNode`, `EnableNodeCliInspectArguments` and `EnableNodeOptionsEnvironmentVariable` fuses off and `OnlyLoadAppFromAsar`
on (`@electron/fuses`).

| | default package | hardened package | `ELECTRON_RUN_AS_NODE=1` inherited |
| --- | --- | --- | --- |
| **chromedriver + `remote()`** | session in 0.48-0.55 s in 5 sessions (the run recorded in `chromedriver.json` was a cold first start and took 6.5 s); page, click, screenshot, DOM and console all work; app gone about 1 s after `deleteSession`; relaunch shows the saved value | session in 0.5 s; same | default package: **session not created**; hardened package: works (the fuse makes Electron ignore the variable) |
| **`@wdio/electron-service`** | session in 1.5-3.0 s over 6 sessions; page, click and screenshot work; `browser.electron.execute` works; app gone after cleanup | session in 1.6 s, page works; **`browser.electron.execute` is disabled** ("CDP bridge is not available") | **session not created** |

Also measured ([`chromedriver.json`](evidence/chromedriver.json), [`service.json`](evidence/service.json)):

- ChromeDriver starts the app with a fresh temporary `--user-data-dir` per session unless one is passed; the service's
  session reported `userData` under the account's temp directory. Persistence across a restart needs `--user-data-dir`
  in `goog:chromeOptions.args`; with it the relaunched app showed the saved value.
- With `browserName: 'chrome'`, ChromeDriver attaches to an empty `about:blank` page (title `""`, one window handle) and
  the app's page is never reached; leaving `browserName` out attaches to the app's window. `browserName: 'electron'` is
  refused by ChromeDriver ("No matching capabilities found"): the service rewrites its capabilities, a direct client must
  not send it.
- 4 processes run from the app's executable, all below chromedriver (plus `conhost.exe` on Windows). If chromedriver is
  killed without ending the session, **all 4 keep running**: something else must own them.
- The service loads its own `webdriverio` (9.30.1 here) beside the repository's 9.31.9. Its chromedriver is started by
  the WebdriverIO utilities inside the calling process, and it downloads one matching the app's Chromium (cache
  directory: the OS temp directory unless `WEBDRIVER_CACHE_DIR` or `cacheDir` says otherwise) unless
  `wdio:chromedriverOptions.binary` names one.
- `getLogs('browser')` returns the renderer's console entries (each once), `getPageSource()` the current DOM, and
  ChromeDriver's `--log-path` its own log, which repeats the session's capabilities and so carries local paths.

## Not measured

macOS. Linux was run through Release QA itself ([sample evidence](../../examples/electron-smoke/qa/evidence)), not with
these probes. Electron versions other than 44.4.5. Apps that open more than one window, `<webview>` tags or use
`BrowserView`.
