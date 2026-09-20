# Evidence

Curated records from the Task 0.1 runs. Findings are in [`docs/decisions/native-automation.md`](../../../docs/decisions/native-automation.md); package and driver hashes are in [`packages.json`](packages.json).

Each `<platform>-run<N>/` holds `environment.json`, `summary.json`, one `attempt-<n>.json` per attempt (every step with timing), `screenshot-hashes.json`, and the three screenshots of attempt 1 as samples. The other attempts' screenshots were captured but are not committed; their SHA-256 values are in `screenshot-hashes.json`.

The runs used the harness as it stood at the time, so their records differ by design:

| Run | Harness state |
| --- | --- |
| `*-run1` | First harness. No screenshot settle, no staleness step, no `display` field. |
| `*-run2` | Adds the 500 ms screenshot settle, the staleness step and the `display` field. |
| `*-run3` | The committed `run-attempts.mjs`: run of record. Adds the driver executable paths and hashes and confirmation that the driver exited. |

Runs 1 and 2 record `tauriDriver` as the raw line from `cargo install --list`, so the value ends in a colon (`tauri-driver v2.0.6:`); the colon is a parsing artifact, not part of the version. Run 3 records the executable and a stripped `reportedVersion`.

A run is never regenerated to match a later script. `linux-run1/stale-example-*.png` show a stale restart screenshot (blank readout) next to the cleared-state screenshot it is identical to.

The account name was redacted from recorded Windows paths (`%USERPROFILE%`).
