# Release QA dashboard (Tasks 5.1 and 5.2)

An Electron + Vue window that shows the accounts, projects, pull requests, candidates, per-environment checks, manual
work, evidence and published history that the shared commands return (Task 5.1), and lets a maintainer prepare a
candidate, open the pull request and merge it, record manual check results with notes and evidence, start a suite on
a Linux runner through GitHub and watch it, and run a suite locally, resume an interrupted run and sync its results
(Task 5.2, parts 1 to 4; see "Running a suite" below for the local part).

```text
npm run build       # main, preload and renderer into dist/
npm start           # build, then open the window (needs `gh auth login`)
npm test            # window and privileged-side tests, with a fixture GitHub transport
npm run typecheck   # two programs: Node (main, preload, shared) and DOM (renderer)
npm run capture     # after a build: window pixels for the recorded before/after snapshots -> evidence/
```

## How it is split

| Part | Runs as | May do |
| --- | --- | --- |
| `src/main/` | Electron main process | Everything privileged: the GitHub CLI session (`GhTransport`), the shared `discoverProjects` and `evaluatePullRequest`, the snapshot cache. Nothing in the window can reach it except by the allowlist |
| `src/preload/` | Sandboxed preload | Exposes `window.qa`, built from `CHANNELS` in `src/shared/contract.ts`. No generic `send` or `invoke` |
| `src/renderer/` | Sandboxed, context-isolated page | Draws a `DashboardSnapshot`. No Node, no credentials, no subprocesses |

The main process only answers messages from the dashboard page itself, refuses navigation away from it, opens only
`https://github.com/` links (in the browser), and the page has a Content Security Policy with no inline script.

## One readiness calculation

`src/main/qa-commands.ts` calls `evaluatePullRequest`, the function the required check runs, and passes its `Evaluation`
through as data. The window formats it (`src/renderer/format.ts` turns a reason into a sentence and groups reasons by the
environment in the requirement key). It never decides whether something is ready. Nothing is listed as passing that the
evaluator did not return: a check with no reason listed is simply absent from "Checks by environment", and the page says
"The evaluator lists nothing blocking" instead of ticking boxes. When the gate cannot be evaluated (no candidate, a
malformed record), the pull request shows **Status unavailable** with the evaluator's own error, never a verdict.

The test `shows the evaluator result exactly, without computing readiness itself` checks that the object the
evaluator returned is the object the snapshot carries.

## Actions (Task 5.2, first part)

Three commands are on the allowlist besides reading, all in `src/main/release-actions.ts`. The window sends only a
repository, a pull request number, the head SHA it was looking at and, for a merge, a method and the candidate id it
reviewed; every argument is validated again on the privileged side.

| Action | What the window shows first | What the privileged side checks |
| --- | --- | --- |
| Prepare candidate | The workflow it starts (`qa-prepare`, from the default branch), the exact head, that the result becomes the active candidate and earlier results stop counting for it, and that nothing is installed or published | Write access, then the shared `prepareCandidate` preflight (release intent, same-repository PR, head unchanged, target unchanged) |
| Merge | A fresh read: QA state, head, candidate, and whether this authorizes publication (a release PR) or publishes nothing (an ordinary one). Only an ordinary PR offers a merge method | Write access; the gate evaluated again for the exact head; QA not blocked; the candidate still the one reviewed. A **release** PR is then merged by the shared `mergeReleasePr` (saves the reviewed release notes with the candidate, merge commit, outcome re-read), the same function publication relies on; an ordinary PR gets a PUT pinned to the head, and a lost reply is resolved by re-reading the PR |
| Open pull request | Nothing; it is a link | The link is built from a validated repository and number, never a URL from the window |

A blocked or unevaluated gate disables Merge with the reason, and the merge is refused on the privileged side even if the
button were forced. If the head or candidate moved while the confirmation was open, the window says so and offers no
Merge button; a refresh that brings a new head closes an old confirmation.

## Manual checks (Task 5.2, part 3)

In the Release view, each manual requirement the evaluator lists as blocking has a **Record or claim…** button (only when
the pull request has an active candidate). It opens `views/ManualCheck.vue`. Design: [docs/decisions/manual-checks.md](../../docs/decisions/manual-checks.md).

| Part | What it does |
| --- | --- |
| Reporter | "Recorded as `<login>`", read from GitHub (`currentUser()`) by the privileged side. Neither the window nor the shared recording accepts a name |
| Result | An outcome (passed, failed, blocked), required notes and at least one evidence file. The privileged side saves it as a real run (journal, `report.json`) under the app data folder, `manual-runs/` |
| Evidence files | Chosen in a file dialog opened by the main process. The window gets a random handle and a name, never a path; the files are copied into the saved result |
| Not synced | A saved result is listed as **Not synced** until an upload is acknowledged and verified. **Upload to GitHub** calls the shared `syncRun` (channel `syncManualResult`, scoped to manual results; the repository and release come from the saved result, not the window). A failed upload keeps the result and shows the error |
| Claim / Release | Advisory ownership through the shared `recordScenarioClaim` and `claimStatus`: the current owner, whether the claim is stale (after four hours) and a Claim, Take over or Release button. Claims never block a result |

Recording, claiming and uploading each need write access at the moment they happen; an account that lost it can still see
the saved results, marked **Not synced**, with the reason.
## Linux runs through GitHub

A project that declares the optional `workflows.run` in `qa/project.json` gets a **Run on Linux** action. The dashboard
runs on Windows; the suite runs on a GitHub Linux runner, so the remote run belongs to GitHub and not to the window.

| Piece | What it does |
| --- | --- |
| Confirmation | Shows candidate, profile, suite, the exact head, the workflow it starts, that it runs on GitHub (not on this computer), that it uses Actions minutes and that its results count only once synced and accepted by the gate. Disabled, with the reason, for a read-only account, a project without `workflows.run` and a pull request with no active candidate |
| Privileged side (`src/main/remote-runs.ts`) | Re-validates every field; write access; the project's `qa/project.json` from the default branch must offer that Linux profile and suite; the gate is evaluated again with the head pinned and the candidate must still be the active one; then the shared `dispatchSuiteRun` (from the default branch only, verifies the returned run by id, workflow file, event, title, workflow revision and repository) |
| Runs list | The window never keeps the list. `listRemoteRuns` reads the workflow's `workflow_dispatch` runs on the default branch from GitHub, keeps those whose title names this pull request, and reads each unfinished run's jobs. Closing and reopening the app, or opening it on another machine, shows the same runs. It polls every 15 s while the release view is open and stops when it closes; a run keeps going on GitHub regardless |
| States | Exactly one of Queued, Runner unavailable, Running, Blocked, Completed (with GitHub's conclusion), from the shared `remoteRunStatus`. Blocked is a run or job GitHub holds for approval, an environment protection rule or a concurrency group, or a finished run with conclusion `action_required` |

**Runner unavailable is a guess.** GitHub does not say "no runner matches" or "all runners are busy"; both look like a job
queued with no runner assigned. The dashboard shows Runner unavailable when a job has had no runner for 5 minutes, and
names the labels the job needs. A slow hosted runner also crosses that line, and a self-hosted runner that comes online
clears it. Listing runners would need admin rights and is not attempted.

**Completed is not a pass.** A finished job says nothing about QA readiness: that still comes only from reports synced to
the candidate and accepted by the evaluator. A run for a different head or candidate than the one on screen is tagged as such.

If a read fails (sign-in expired, access lost, network), the runs already shown stay, with the reason and "last successful
read"; a first read that fails is an error, never "no runs". The list is a status view: any writer can dispatch the
workflow, so a run's title is not evidence of who started it or what it ran.

The consumer's workflow contract (inputs, and the `run-name` the dashboard searches for) is in
[`docs/authoring-tests.md`](../../docs/authoring-tests.md); a template is
`examples/tauri-smoke/.github/workflows/qa-run.yml`.

## States

| State | What the window shows |
| --- | --- |
| Loading | A status line and a disabled Refresh |
| Data cannot be read at all | An alert and Refresh to retry |
| Nothing set up | An explanation naming `qa/project.json` |
| Expired or missing GitHub sign-in | A banner saying to run `gh auth login`; the last good projects stay visible and are marked stale |
| GitHub unreachable | The last good snapshot, marked stale with its own read time. A cache of an unexpected shape is discarded, and only a read with no problems replaces the cache (written by rename) |
| Gate cannot be evaluated | Status unavailable with the evaluator's error. Whether it is a release is then unknown, so it is never labelled "Not a release" |
| Read-only user | A Read-only tag and notice on the project and the release |
| One repository unreadable (SSO, not found, network) | Listed under "Not available" beside the projects that loaded |
| Published release without a QA record | Flagged **No QA record**; never shown as passed |
| Repository text with markup | Rendered as text. There is no `v-html`; the privileged side keeps only `https://github.com/` links and cuts text at 300 characters |

## Running a suite (Task 5.2, part 2)

The Run page (from the release view) runs one suite for one environment against the active candidate, on this machine.

- The person chooses the local checkout in a folder dialog the main process owns; the window never names a path. The folder
  must hold a `qa/project.json` of the same project as the repository, be a git working copy at exactly the candidate's
  test revision with no changed tracked files, and contain a `.release-qa` test root the person designated once with
  `release-qa designate`. The consumer's scenario and lifecycle code in that folder runs, so it must be one the person trusts.
- Before anything is installed the window shows the candidate, file and SHA-256, the scenarios, the test root and the
  consequence. Confirming sends back what was shown; main refuses if the candidate or root changed. The candidate file is
  downloaded by asset id and verified by the shared code, into the app's data folder.
- One run at a time. The run belongs to the main process: closing the window does not stop it, the app stays open until it
  ends, and a new window reads the current state. Stop aborts and cleanup still runs.
- Local runs of the candidate are listed from their own journals with what exists only on this machine (**Not synced**).
  Resume repeats the environment and suite of the run and refuses if the active candidate changed. Sync uploads through the
  shared sync using the signed-in identity; a failure is reported as uncertain, keeps the local results and can be repeated.
- Everything is off while a recorded snapshot is shown (`RELEASE_QA_DASHBOARD_FIXTURE`).

## What is not proven

- **Running a suite was proven only with a fake consumer on the development machine.** The tests run the real shared
  runner against a scratch checkout whose scenarios do nothing. No real packaged Electron app has been installed, launched
  and driven from the Run page, and the folder dialog, the single-instance lock, keeping the app open during a run, and
  the bundled consumer worker (`consumer-worker.mjs`) in a built app have not been exercised.
- **Sync and resume have not run against live GitHub.** The upload goes through the shared `syncRun` with a fake transport in
  tests; a real draft release, permissions and network failure mid-upload are unproven.
- **Nobody has used it.** Whether the workflow is usable without manual GitHub edits or a hosted service (the issue's
  exit criterion) needs a person doing a real release.
- **Not run against live GitHub.** Every test and the captured window use recorded data or a fixture transport. The
  privileged side is the same code the CLI gate runs, but a live sign-in, a real repository listing and a large account
  have not been exercised.
- **"Last synchronization time"** is when the dashboard read GitHub (`loadedAt`). The evaluator does not return when
  reports were uploaded, so no report-level sync time is shown.
- **Candidate details** are the id and draft release number the gate returns. Artifacts appear only in publication mode of
  the evaluator, which this read view does not use.
- **`.vue` files are not type-checked.** `tsc` handles the `.ts` files and the tests exercise the components; `vue-tsc`
  has not been tried against TypeScript 7.
- **Load time.** Projects load three at a time and each pull request runs the gate's several `gh` calls, so an account with many open pull requests waits on the Loading screen; nothing is shown until the read finishes. A release-intent pre-check or streaming partial results would help; neither is done.
- **Actions have not run against live GitHub.** `prepareCandidate`, `mergeReleasePr`, the ordinary merge and the refusal
  messages are tested with fakes. For an ordinary pull request the merge method list is not restricted to what the
  repository allows; a disallowed one fails with GitHub's refusal, which the transport does not detail.
- **Manual checks have not run against live GitHub or in the real window.** Tests use a fake release (assets, permissions,
  two signed-in users) with the real shared recording, sync and claim code, and the component tests use a fake bridge. The
  file dialog, the app data folder and a live draft release have not been exercised, and nobody has confirmed that a
  manually recorded report is counted by the required check on a real pull request (the evaluator accepts it in tests).
- **Manual reports carry attested capabilities.** Things like `hardware` cannot be probed, so the requirement's capabilities
  are added to the measured environment: the person at the device vouches for them.
- **Recording needs a machine of the profile's kind** (a Windows check cannot be recorded from a Linux machine).
- **Not synced is shown in the manual check view only**, not in the release's Manual work list, so a saved result for a
  check you have not reopened is not flagged there.
- **A failed manual result cannot be retried or resolved from the window**: the evaluator wants a retry recorded against the
  failure and an acknowledgement, and neither has a screen. Nor can a saved result be deleted or edited.
- **Claims are read from GitHub with a full progress load** (every report and claim asset), which is slow on a candidate with
  many reports, and each open of the view repeats it.
- **If reconciliation dispatch fails after a successful upload**, the result is marked synced (its acknowledgements are saved)
  while the upload reports an error to retry; the window then no longer offers Upload for it.
- **Linux runs have never touched a live GitHub runner.** `dispatchSuiteRun`, `remoteRunStatus` and the runs list are
  tested with fake API responses shaped after GitHub's documented fields. Not observed: the real `run-name`/`display_title`
  after a dispatch, real job `status`/`runner_id`/`labels` values in each state (`waiting` for environment approval,
  `action_required`), how long real runners take to pick up a job, and rate use of polling.
- **The example workflow has never run.** `examples/tauri-smoke/.github/workflows/qa-run.yml` is a template. Its steps to
  download and verify the candidate and to sync the report are marked NOT IMPLEMENTED and fail on purpose: the tool has no
  command line for either yet. Until they exist, a Linux run started here cannot produce a QA result.
- **Remote runs are not connected to results.** The window lists GitHub Actions runs; it does not yet show which
  requirements a run's synced report satisfied. Resume, sync from the window and manual results are the rest of 5.2, as is
  the live "another tester contributes a checkpoint" check.
- **Packaging** (an installer for the dashboard itself) is not done; `npm start` runs it from a checkout.

## Evidence

`evidence/{before,after}-{repositories,release}.png` are real Electron window captures (`npm run capture`) of the built
app reading `fixtures/before.json` (a release blocked by a manual Windows check and a failed Linux check) and
`fixtures/after.json` (the same candidate after those results, passed). `scripts/make-fixtures.mjs` writes the fixtures.
The fixtures are recorded snapshots, not a live repository.
