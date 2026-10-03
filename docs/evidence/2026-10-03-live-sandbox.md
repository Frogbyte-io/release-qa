# Live sandbox run of the dashboard and CLI flows (issue #20)

Date: 2026-10-03 (the runs below happened between 23:14 UTC on 2026-10-02 and 23:35 UTC, the laptop's clock being UTC+2).
Machine: the maintainer's Windows 11 laptop, signed in with `gh` as `Andreas-Froyland` (admin on the sandbox; token scopes
`gist`, `read:org`, `repo`, `workflow`). Code under test: `origin/main` at `33172e3` plus the fixes in this branch.
Only `Frogbyte-io/release-qa-gate-sandbox` was written to. No ruleset, setting, secret or branch protection was changed and
nothing was merged.

Everything below was observed; where something was not, it says NOT DONE and why.

## What the sandbox is

`qa/project.json` of the sandbox (`orbit-orchard`): profiles `windows` and `linux`; two **manual** requirements,
`windows/persistence` and `windows/device-feel`; `"suites": []`, no scenario files, an empty lifecycle; `workflows` has
`prepare`, `gate` and `publish` but **no `run`**. `qa/policy.json` requires both keys. The required check is `release-qa`,
published by `qa-gate.yml` (pinned to `Frogbyte-io/release-qa` at `c94e528`).

Because the sandbox declares no automated suite, the "suite" in A and B is a scratch consumer kept outside both repositories
(`D:\live-scratch\consumer\qa`): same `projectId` and the same two requirement keys, declared `automated`, with one suite
`live`. Its scenarios are stand-ins and say so in their titles: `persistence` checks that the verified candidate file starts
with `MZ`, `device-feel` checks that it is over 1 MB (and, while a flag file exists, waits, so the run can be interrupted).
The lifecycle installs and launches nothing. This proves the CLI, journal, sync and gate path against real candidate
bytes; it does **not** prove that Orbit Orchard persists a score or feels smooth. The gate accepted these reports because it
matches report requirement keys against the policy, not their mode.

Throwaway pull request: <https://github.com/Frogbyte-io/release-qa-gate-sandbox/pull/27> (`release/live-20261003`, head
`d794a1b70a4cb636c9515e478da3a8188e21c4b9`, VERSION and package version `0.1.2`; a release branch with a VERSION change, so it
has release intent). It was created by the Contents API from `main` at `348c17f` and is closed, never merged.

## A. Local Windows run, then sync: PROVEN

1. **Prepare a candidate.** `prepareCandidate('Frogbyte-io/release-qa-gate-sandbox', 27, <head>)` (the shared function behind
   the window's Prepare button; the CLI has no command for it) passed its preflight and dispatched `qa-prepare.yml`:
   run <https://github.com/Frogbyte-io/release-qa-gate-sandbox/actions/runs/37076612506>, success. It created the draft release
   `QA PR #27` (release id 402215575, tag `qa-pr-27`) and selected `cand-37076612506-1`.
   Before it, the gate said `manual check required: no draft candidate release for this pull request`; after it,
   `evaluatePullRequest` returned `blocked` with `missing-result` for both requirements. The dashboard showed the same
   (read in the first successful live capture; that PNG was replaced by the later one below).
2. **Download.** `download-candidate --repo Frogbyte-io/release-qa-gate-sandbox --pr 27 --head d794a1b... --candidate
   cand-37076612506-1 --profile windows --out ./candidate` printed `verified (SHA-256 89fd50d2...6a7f)`. See C.
3. **Run.** `designate`, `doctor --profile windows` (ready: true, real display) and
   `run --project D:/live-scratch/consumer/qa/project.json --candidate candidate/candidate.json --profile windows --suite live`:
   run `run-20261002T232041Z-2bc373`, both requirements `passed`, exit 0.
4. **Sync.** `sync-run --repo ... --pr 27 --head ... --candidate cand-37076612506-1 --run run-20261002T232041Z-2bc373`
   uploaded 6 files (report manifest, 5 events) to the draft release as `Andreas-Froyland`.
   This first returned **exit 3** with `reconciliation dispatch failed and should be retried: not-found`. That is bug 1 below.
5. **Gate.** `evaluatePullRequest` then returned `readiness: passed`, `acceptedReportIds: [run-20261002T232041Z-2bc373]`.
   The `release-qa` commit status on the pull request stayed at its old failure, because `qa-gate.yml` runs only on
   pull-request events. After a body edit it reran (<https://github.com/Frogbyte-io/release-qa-gate-sandbox/actions/runs/37077346754>)
   and the status became `SUCCESS`. So the real required check, not only the library call, reflects the synced result.

## B. Resume: PROVEN

A second candidate was prepared (run <https://github.com/Frogbyte-io/release-qa-gate-sandbox/actions/runs/37077444229>,
`cand-37077444229-1`). The gate went back to `blocked` for it, with no accepted report: the earlier candidate's result did
not carry over. A run was started with the slow flag set. After `windows/persistence` passed and `windows/device-feel` had
started, the process tree was killed with `taskkill /F /T` (run `run-20261002T232754Z-32af8d`). The journal ended with a
`scenario-started` checkpoint and no attempt for `device-feel`. Then `resume --run run-20261002T232754Z-32af8d` (flag removed)
printed `windows/persistence: passed (from earlier)` and `windows/device-feel: passed`, exit 0. The journal shows the crash kept
in history: attempt `.a2` `interrupted`, then `.a3` `passed` with `retryOf` `.a2`. `sync-run` of that run uploaded 8 files and
exit 0; the gate returned `passed` with only `run-20261002T232754Z-32af8d` accepted (the first run's report, for the
replaced candidate, is not counted). After a body edit the check reran
(<https://github.com/Frogbyte-io/release-qa-gate-sandbox/actions/runs/37077815641>) and the status was `SUCCESS`.

## C. `download-candidate` and `sync-run`: PROVEN

- `download-candidate`, windows: wrote `cand-37076612506-1-Orbit-Orchard-0.1.2-win-x64.exe` (111,355,765 bytes) and
  `candidate.json` (one artifact, the profile, name, relative path and SHA-256). `sha256sum` of the file independently gave
  `89fd50d2a15d504b0f72e716e98bc19023947236b42e8f696c2f6cc6453e6a7f`, the value in the candidate record and in the manifest.
  The same for the second candidate (`9574d29f...e813`) and for the Linux `.deb` with `--json`.
- Refusals observed live: a second run into the same `--out` (`candidate.json already exists; it is not replaced`, exit 3);
  `--candidate cand-1-1` (`the active candidate is cand-37076612506-1, not cand-1-1; it was replaced after it was reviewed`,
  exit 3).
- A hash mismatch against live bytes was **not** provoked (it would need a tampered release asset); it remains covered only by
  the unit test.
- `sync-run`: see A.4 and B. It also repeated safely: re-running it for the same run after the fix uploaded the same immutable
  objects again and exited 0.

## D. Dashboard against live GitHub: PROVEN

The built app was started unpackaged with no fixture (`electron .`, `RELEASE_QA_CAPTURE_DIR` set). It read GitHub with the
signed-in `gh` session and listed `Frogbyte-io/release-qa-gate-sandbox` (project `orbit-orchard`, role admin, the two
published releases with "QA recorded") and pull request #27.

- Candidate prepared, no result: Blocked, `windows/persistence` and `windows/device-feel` "has no passing result", candidate
  `cand-37076612506-1`, both listed under Manual work. (Observed; not committed.)
- After B: **Passed**, candidate `cand-37077444229-1` (draft release 402215575), "The evaluator lists nothing blocking",
  evidence `run-20261002T232754Z-32af8d`. This is the same verdict the CLI/library printed in B.
- Screenshots: `live-sandbox/live-passed-repositories.png`, `live-sandbox/live-passed-release.png`,
  `live-sandbox/live-passed-run.png`. I looked at each. The Run page is reachable but empty of choices live: no checkout and
  an empty Suite list, because the sandbox declares no suite. A run was **not** started or synced from the window.
- Bug 2 (below): the first live attempt produced PNGs of the Loading screen.
- Not covered: read-only account, many repositories, expired sign-in, SSO. The first live capture took 89 s end to end for one
  repository with one pull request.

## E. Linux run through GitHub: RUN PROVEN, SYNC WAITING FOR THE TOKEN

At first the sandbox had no `workflows.run`, no `qa-run.yml` and no Linux requirement. Sandbox PR #28 (merged as
`e318101`) added:
- an automated `linux/persistence` requirement (required by the policy), suite `release` and its scenario: the candidate's
  verified `.deb` is unpacked with `dpkg-deb -x`, a round of the game is played under Xvfb, the best score is checked on
  disk, the app is restarted and must show it again;
- `.github/workflows/qa-run.yml`, adapted from the example, with the tool pinned to `ee8f706`.

Review of that PR found two faults that were also in the example, fixed in both:
1. The `run-name` was unquoted, so YAML read everything from ` #` on as a comment and the title lost what the dashboard
   looks a run up by. It is quoted now; the live run's title came through whole.
2. A draft release's assets are visible only to push-capable tokens, so a `contents: read` GITHUB_TOKEN would not reach
   the candidate. A separate `download` job now holds `contents: write`, runs only the pinned tool (the pull request is
   never checked out there) and hands the verified file on as an artifact; the `run` job stays read-only and re-checks the
   SHA-256. A `contents: read` download was not tried.

Live run, against sandbox release PR #29 (0.1.2, candidate `cand-37150948200-1` from prepare run 37150948200): qa-run
37151109740, title `qa-run PR #29 cand-37150948200-1 linux/release f05c9c9…`.
- `download`: success; the `.deb` verified against the candidate record.
- `run`: success; the re-check matched (`70a0ccbc…`), `linux/persistence: passed`, cleanup ok. The app started on the
  runner with `--no-sandbox`, as a normal user.
- `sync`: failed as expected, because `QA_SYNC_TOKEN` does not exist yet. The error read
  `cannot read pull request: network-error`, which hid the cause; `gh`'s "set the GH_TOKEN environment variable" (and
  "gh auth login") are now classified as `logged-out`.

Still to prove once the user has created `QA_SYNC_TOKEN` (a fine-grained token for the sandbox only): the upload, and that
the gate counts it. The `qa-reconcile.yml` the tool dispatches after a sync is missing in the sandbox (see bug 1).

## F. Packaged app: NOT DONE

`apps/desktop/package.json` has `build`, `start`, `typecheck`, `test` and `capture` and no packaging script (no
electron-builder or similar). Nothing to build; the unpackaged window in D is the closest thing exercised.

## Bugs found

1. **`sync-run` failed (exit 3) after a complete, verified upload when the repository has no `qa-reconcile.yml`.** The
   shared `syncRun` ends by dispatching that workflow and treated any failure, including 404, as "retry". Retrying could never
   succeed, and the gate does not need reconciliation. Fixed in `packages/qa/src/github/sync.ts` and `transport.ts`: a 404 to
   the dispatch request itself (`workflow-not-found`; GitHub also answers 404 when the token cannot see the workflow) now
   returns success with a `notice`, the CLI prints it on stderr (and in `--json`). A failed repository lookup before the
   dispatch is `repository-lookup-failed` and, like every other dispatch failure, still reports an error to retry. Tests:
   `sync.test.ts` (two), `candidate.test.ts` (the real `GhTransport` with a stand-in `gh`) and `ci-commands.test.ts` (one). The dashboard's manual
   upload uses the same function and benefits the same way.
2. **Live capture photographed the Loading screen.** `captureViews` waited a fixed 1.2 s, enough for a fixture only, and always
   opened the first listed pull request. Fixed in `apps/desktop/src/main/capture.ts`: it waits for the loading line to clear
   (180 s limit, then fails), a failed read fails the capture with its message instead of photographing it, and
   `RELEASE_QA_CAPTURE_OPEN=<repo>-<number>` picks the pull request (empty counts as unset); a missing one is an error
   instead of a silent skip. Test: `apps/desktop/test/capture.spec.ts`.
3. **`download-candidate` took the first artifact of the profile.** Windows candidates carry two (the installer and its
   `.blockmap`), listed installer first, which is the only reason it worked. Fixed with `installableArtifact` in
   `packages/qa/src/model/candidate.ts`, used by `download-candidate`, `downloadCandidate` and the dashboard's run: the
   `.blockmap` is never chosen, and a profile left with zero or several installable files is refused as ambiguous. Tests:
   `test/model/installable-artifact.test.ts` and `ci-commands.test.ts` (blockmap listed first; two installers).

## Observations that are not fixed

- The `release-qa` commit status is refreshed only by pull-request events. After a sync it stays stale until the pull
  request is edited (A.5). Checked in the code: `qa-reconcile.yml` does not refresh it either. It runs with
  `contents: read` and `reconcile-cli.ts` only writes a step summary; the status is posted only by `gate-cli.ts` and
  `gate-finalize.ts`. So a sync that should turn the status green needs the gate rerun (an edit, a push, or a re-run of
  the gate workflow); the `sync-run` notice says so. I did not check whether it also stays green after a new candidate replaces a passing one; that
  needs the gate to rerun from `qa-prepare` or a sync, which is the consumer workflow's design.
- The local disk (C:) was almost full (60 MB free at one point), so the first `run` failed cleanly with
  `ENOSPC ... copyfile` before anything ran (exit 3, run id announced). That was the machine, not the tool; scratch files were
  moved to D:.

## Test results

- `npm test --workspace packages/qa`: 930 passed, 1 failed on the first full run
  (`test/cli/manual.test.ts`, "a failed reconciliation dispatch is not synced...", a 5000 ms timeout under load on a disk that was
  nearly full). That file alone passed (14 of 14) on rerun.
- `npm test --workspace apps/desktop`: 238 passed (11 files).
- `npm run typecheck --workspace apps/desktop`: clean.

## Left in the sandbox as evidence

- Draft release `QA PR #27` (id 402215575): both candidates' files, `candidate.json`, `qa-report-*` and `qa-event-*` assets for
  both runs. It is the record of this run.
- Actions runs `37076612506`, `37077444229` (prepare), and the gate runs `37076605495` (blocked, at open), `37077346754` and
  `37077815641` (passed).
- Closed pull request #27 (its head branch `release/live-20261003` was deleted).
