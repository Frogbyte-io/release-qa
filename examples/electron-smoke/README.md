# Release QA Electron Smoke (sample consumer)

A deliberately tiny Electron application used to prove that Release QA can drive an **unchanged, packaged** Electron app. It
mirrors [`tauri-smoke`](../tauri-smoke): one text input, **Save** and **Clear** buttons and a "Saved value" readout. Save
writes the value to `setting.txt` in the app's `userData` directory through the main process; the readout is always read
back from disk, so it shows what is there.

The renderer is sandboxed with context isolation and a preload script exposing three IPC calls; nothing in the app is
test-specific: no embedded test server, no debug flags, no changed fuses.

| Platform | Where the app keeps `setting.txt` by default | Where a Release QA run keeps it |
| --- | --- | --- |
| Windows | `%APPDATA%\release-qa-electron-smoke` | `<test root>\electron-user-data` |
| Linux | Electron's default `~/.config/release-qa-electron-smoke` (not checked) | `<test root>/electron-user-data` |

A run passes `--user-data-dir` to the app: ChromeDriver would otherwise give each session a temporary profile, and nothing
could persist across a restart ([decision](../../docs/decisions/electron-automation.md)).

## Package it

```sh
npm ci
npm run package       # Windows: out/release-qa-electron-smoke-win32.zip; Linux: out/release-qa-electron-smoke-linux.tar.gz
node scripts/write-candidate.mjs   # writes out/candidate.json for `release-qa run --candidate`, prints its path
```

The archive is what `@electron/packager` produces: Electron's own binary renamed to the app, with the code in
`resources/app.asar`. `npm ci` also downloads the ChromeDriver built for this Electron release (`electron-chromedriver`).
Then follow [the setup guide](../../docs/guides/run-the-electron-sample.md). Byte-for-byte reproducibility of rebuilds was
not tested, so hash the file you built: the candidate manifest does.
