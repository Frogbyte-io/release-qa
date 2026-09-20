# Release QA Smoke (sample consumer)

A deliberately tiny Tauri 2 application used to prove that Release QA can drive an **unchanged, packaged** application. It is independent of Dot X and has its own identity, `dev.frogbyte.releaseqa.smoke`.

It has one text input, **Save** and **Clear** buttons and a "Saved value" readout. Save writes the value to `setting.txt` in the app data directory through a native Rust command; the readout is always read back through the native command, so it shows what is on disk.

| Platform | Persisted file |
| --- | --- |
| Windows | `%APPDATA%\dev.frogbyte.releaseqa.smoke\setting.txt` |
| Linux | `~/.local/share/dev.frogbyte.releaseqa.smoke/setting.txt` |

The frontend is static HTML with `withGlobalTauri`, so there is no JavaScript build step. Nothing in the app is test-specific in behaviour: no embedded test server, no debug flags, no feature toggles. The markup carries one inert `data-testid` attribute on the readout that the harness does not use (it selects by `id`); it is kept so the committed source is exactly what was built and tested.

## Build a distributable

Release mode is the default for `tauri build`.

```sh
npm install
npm run build:windows   # NSIS installer, on Windows
npm run build:linux     # .deb, on Linux
```

Prerequisites are the [Tauri 2 system dependencies](https://v2.tauri.app/start/prerequisites/). The packager stamps a bundle-type marker into the packaged binary, so it differs from `target/release`: **hash the installed file, not the build tree** (see [`docs/decisions/native-automation.md`](../../docs/decisions/native-automation.md)). Byte-for-byte reproducibility of rebuilds was not tested.

`npm run icons` regenerates the icon set from a generated placeholder image.
