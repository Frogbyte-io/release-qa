# Decision: no-service GitHub merge gate (Task 0.2)

Status: experiment complete for the single-account case; permission matrix and private-repo behaviour are **not** proven (see [Not proven](#not-proven)).

Date: 2026-09-20. Sandbox: [`Frogbyte-io/release-qa-gate-sandbox`](https://github.com/Frogbyte-io/release-qa-gate-sandbox) (public, organization on the free plan, one ruleset requiring `release-qa` on `main`). Repeatable check: [`experiments/github-gate/run-core.sh`](../../experiments/github-gate/run-core.sh), which passed end to end on sandbox PR #8.

## Decision

A `pull_request` workflow with a single job named `release-qa` is a workable required check without a GitHub App, hosted service, or custom Check Runs credentials. Testers submit results with their own `gh` credentials. The evaluator fails, never skips, until the current PR head has a complete matching set of results or authorized exceptions.

The design needs these changes from what the spec assumed. Each is backed by an observation below.

1. **Draft-release records need `contents: write` on the evaluator token.** With `contents: read` the token saw 0 releases (0 drafts) even though the draft existed. With `contents: write` it saw the draft. The evaluator therefore runs with write access to contents; it must be trusted code (see [Trust boundary](#trust-boundary)). Per GitHub documentation fork PRs receive a read-only token and would therefore not see draft records; this was not tested.
2. **The evaluator must read policy and code from the current tip of the target branch, not `pull_request.base.sha`.** After `main` advanced, the PR kept its old `base.sha` and old test-merge commit, and `edited` reruns re-executed the stale workflow and script.
3. **Candidates record `baseSha`; the evaluator blocks when it no longer matches the target-branch tip.** Nothing reruns the evaluator when the target branch moves. With non-strict required checks, a green PR stayed `CLEAN` after `main` advanced. Enable "require branches to be up to date" as well: with it the same PR reported `BEHIND`.
4. **Refreshing an evaluation must use one of two proven mechanisms:**
   - a PR event created with user credentials (`pull_request: edited`, by changing a managed marker in the PR body). Works at any age because it creates a new run, not a rerun;
   - `gh run rerun` of the existing `pull_request` run from an Actions job using only `GITHUB_TOKEN` and `actions: write`. Reruns evaluate live state, but GitHub limits reruns to 30 days.
5. **These do not work as refresh mechanisms:** a PR-body edit made with `GITHUB_TOKEN` (no run started: 20 runs before, 20 after) and a `workflow_dispatch` run of the gate (it completed successfully on the PR head SHA, but the PR's rollup ignored it and `mergeStateStatus` stayed `BLOCKED`).
6. **Preparing a new candidate must block first.** Replacing a candidate at the same source SHA left the old green check in place: the PR stayed `CLEAN` until an evaluation reran. `prepare-candidate.sh` therefore withdraws the active candidate, refreshes, waits for a blocking result, and only then selects the new candidate.
7. **Release intent must not depend on a label alone.** Removing the `release` label from a PR with no other release signal made it pass as a non-release PR. The evaluator also treats a release branch prefix or a changed file listed in `policy.releaseFiles` (here `VERSION`) as release intent; a PR that changes `VERSION` stayed gated after label removal. Changed files are read across all pages, so a PR touching more than 100 files cannot hide the version file.
8. **Exception authority comes from the verified uploader of the release asset, checked against repository permission at evaluation time.** A record claiming actor `octocat` but uploaded by an admin was accepted on the uploader's authority; the evaluator ignores the claimed name. Rejection of a non-maintainer uploader was not exercised.
9. **Merge with `--match-head-commit`.** A wrong expected head was rejected ("Head branch was modified"); the correct head merged.

## Observations

| Case | Observed |
| --- | --- |
| Non-release PR | `release-qa` passed under normal policy |
| Release PR, no candidate | Failed: `manual check required: no candidate release record` |
| One of two required results | Failed, naming the missing requirement |
| Both results, then evaluator refresh (`edited`) | Success; PR `CLEAN` |
| New commit on the PR | New head got its own failing check; PR `BLOCKED`. The old head's success does not transfer |
| Candidate replaced at same SHA, no refresh | Old green check remained and PR stayed `CLEAN` (the gap that decision 6 closes) |
| Old successful run re-run after replacement | Re-evaluated live state and failed |
| Two simultaneous submissions | Both uploads stored under unique names; both counted |
| Only a `blocked` result for a requirement | Failed: requirement treated as missing |
| Evaluator cancelled mid-run | Check concluded `cancelled`; PR stayed `BLOCKED` |
| Exception by admin uploader | `APPROVED WITH EXCEPTIONS` in the job summary/log only. The required check is an ordinary green `release-qa`, so **an exception is indistinguishable from complete QA in the merge view** (see [Not proven](#not-proven)) |
| Candidate built against an older base tip | Failed: `target branch moved` |
| Base advanced under a green PR, non-strict | PR stayed `CLEAN` with green check |
| Same, strict required checks | `BEHIND` |
| Label removed, no version change | Passed as non-release PR |
| Label removed, `VERSION` changed | Still gated |
| Wrong expected head on merge | Rejected |
| Correct expected head on merge | Merged |

SHA association: for `pull_request`, `GITHUB_SHA` is GitHub's test-merge commit (`merge_commit_sha`), while the check run attaches to the **PR head** SHA. Both were logged by every evaluation.

## Side findings for later tasks

- **Bots edit the PR body and each edit fires the gate.** The organization's AI reviewer rewrote sandbox PR bodies, which triggered `pull_request: edited` runs. Managed-section updates in Task 3.3 must refetch the body immediately before writing and tolerate foreign edits. Bot edits can also cause accidental refreshes that hide whether an intended refresh worked; identify a refresh by its triggering event type.
- **The API lags a push by a few seconds.** `pulls/{n}.head.sha` returned the old head immediately after pushing. Tools must compare against the SHA they pushed and wait, never trust the first read.
- **Non-required checks make an otherwise mergeable PR `UNSTABLE`.** Tests asserting "mergeable" must accept `CLEAN` and `UNSTABLE` unless they own every check.
- **Merges can wedge on GitHub.** Sandbox PRs #1 and #2 returned `502`/`Server Error` on merge and then `Merge already in progress` on every retry for roughly 4 minutes (PR #1) and 7 minutes (PR #2); PR #2 later reported an ordinary merge-conflict error, so the lock had cleared by about 15 minutes. PR #11 (the second `run-core.sh` run) hit the same 502 then lock and merged after four retries spaced 20 seconds apart, so a bounded retry that re-reads the PR state recovers from it. PRs #4, #5, #8 and #9 merged on the first attempt. Cause not identified. Publication must treat a failed or unconfirmed merge as recoverable and verify the merged state rather than assume it. PRs #1 and #2 were closed unmerged.

## Trust boundary

**The gate as built is not safe against untrusted PR authors.** The sandbox workflow has `contents: write`, and any same-repository PR can replace the job body with `exit 0` under the same `release-qa` name. Treat it as a proof of mechanism, and treat fork release PRs as out of scope until a maintainer-side evaluation path is proven.

For `pull_request` the workflow definition comes from the PR's test-merge commit, so a PR can edit `qa-gate.yml` itself. The sandbox mitigates the evaluator script (it is checked out from the target branch) but **not** the workflow file. This was not tested. Candidate mitigations: `CODEOWNERS` plus required review for `.github/workflows/`, or a `pull_request_target` variant that reports a commit status on the PR head. Neither has been exercised; choose and prove one before relying on the gate against untrusted PR authors.

## Not proven

- **Permission matrix.** Only one account (repository admin) was available. Behaviour for read, triage and write roles, fork PRs, and users without `gh` scopes was not exercised. Exception rejection for a non-maintainer uploader was not exercised.
- **Refresh beyond 30 days.** By construction the `edited` path creates a new run and does not depend on run age, but no evaluation was actually aged past the rerun window.
- **Deployment-event refresh.** Not needed once `edited` was proven; not tested.
- **Private repositories and plans.** The sandbox is public in a free-plan organization. Rulesets and required checks on private repositories on the same plan were not tested; verify before adopting a private consumer such as Dot X.
- **Concurrent-evaluator races.** The evaluator now re-reads the PR head, target tip and active candidate immediately before passing, which narrows the window. The race itself (an evaluator that started before a candidate replacement and finishes after it) was not provoked, so the narrowing is unmeasured. Publication must still revalidate independently, as the design requires.
- **Exceptions distinguishable in the merge view.** Whether a separate non-required check run or commit status (created with `GITHUB_TOKEN`, `checks: write`) can show `approved with exceptions` next to the green required check was not tested. Task 3.3 must provide this; until then an exception looks identical to a complete pass in required-check results.
- **Lost concurrent edits.** `refresh.sh` reads then patches the whole PR body; the REST API has no conditional update, so an edit landing between the two calls can be overwritten. Task 3.3 must design around this.
- **Custom check title.** A workflow job cannot title its result `approved with exceptions`. Whether a Check Runs API call using `GITHUB_TOKEN` with `checks: write` can, while still satisfying the required check name, was not tested.

## Reproducing

Prerequisites: a sandbox repository with `experiments/github-gate/sandbox/` contents on `main` and a ruleset requiring `release-qa` (strict, pull request required). Run `SANDBOX_DIR=<clone> experiments/github-gate/run-core.sh`. Individual scenarios use `prepare-candidate.sh`, `submit-report.sh`, `submit-exception.sh`, `refresh.sh` and `wait-gate.sh` in the same directory.
