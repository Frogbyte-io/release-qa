# Release QA dashboard (Tasks 5.1 and 5.2)

An Electron + Vue window that shows the accounts, projects, pull requests, candidates, per-environment checks, manual
work, evidence and published history that the shared commands return (Task 5.1), and lets a maintainer prepare a
candidate, open the pull request and merge it (the first part of Task 5.2). Running a suite, resuming, syncing and manual
results are the rest of 5.2 and are not here yet.

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

## What is not proven

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
- **Linux jobs** are not triggered from the window: no generic Linux workflow exists in this repository, and the
  consumer's own workflows are not known to it. That, running suites, resume, sync and manual results are the rest of 5.2.
- **Packaging** (an installer for the dashboard itself) is not done; `npm start` runs it from a checkout.

## Evidence

`evidence/{before,after}-{repositories,release}.png` are real Electron window captures (`npm run capture`) of the built
app reading `fixtures/before.json` (a release blocked by a manual Windows check and a failed Linux check) and
`fixtures/after.json` (the same candidate after those results, passed). `scripts/make-fixtures.mjs` writes the fixtures.
The fixtures are recorded snapshots, not a live repository.
