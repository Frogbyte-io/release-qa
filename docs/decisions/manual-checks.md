# Decision: recording manual checks (Task 5.2, part 3)

Status: **implemented** in `packages/qa/src/cli/manual.ts` and used by the dashboard (`apps/desktop`). Tested with fakes; not run against live GitHub.

## Problem

A manual requirement (`mode: 'manual'`) is planned and reported as `manual` and never run, so nothing could record a person's verdict. The evaluator only counts attempts in reports uploaded by their own author, so a manual result has to be a report like any other.

## Decision

A manual result is **its own run**: one directory per result, `manual-<timestamp>-<random>` in the same state layout as `run`, holding

- `events.jsonl`: the Task 1.3 journal with `run-started` and one `attempt-recorded` (the same events an automated run writes);
- `evidence/<attempt id>/`: `notes.md` (the notes, always first) and the files the tester attached, copied in and renamed to a safe `<n>-<name>`;
- `report.json`: the `Report` `syncRun` uploads, and `manual.json`: which repository, pull request and draft release it was recorded for.

`report.json` is written last, so a directory without one is an unfinished recording and is not listed. A refused or failed recording removes its directory.

### No contract change

- **Notes** are stored as an evidence file (`notes.md`) instead of a new `Attempt` field. That keeps `Attempt`, the events, the report manifest and the evaluator unchanged, and the notes are uploaded and hash-checked with the other evidence. The recording function, not the schema, requires them (non-empty, at most 5000 characters, no control characters).
- **Evidence**: at least one attached file (at most 10, each non-empty and at most 25 MiB, because `syncRun` uploads each as one base64 asset). Paths stay relative and inside the run directory; the original files are never referenced again.
- **Outcome**: `passed`, `failed` or `blocked`. `cancelled` and `interrupted` are things that happen to a run, not a person's verdict.

### Identity

`recordManualCheck` takes a transport and asks `currentUser()`; the login it returns is the report's `actor`. The input type has no reporter field, and the dashboard's request has none either. `syncRun` then checks again that the actor is the authenticated uploader, so a result recorded under one login cannot be uploaded by another; it stays on disk, unsynced, with that error.

### What makes the evaluator count it

The report is built from the verified candidate the gate returned (`PullRequestGateEvaluation.candidate`, added for this): its `policyDigest` and `testRevision`, the profile of the requirement, and a measured environment (`inspectEnvironment`) whose OS and architecture must match the profile, or recording is refused. Capabilities cannot be probed for things like `hardware`, so the requirement's own capabilities are added to the measured ones: the person at the device attests to them. That is the one place a manual report says more than was measured, and it is why a manual requirement's capabilities are part of the report. The result is parsed with `parseReport` against the candidate before anything is saved, and a test feeds the recorded (and the synced-and-reloaded) report through `evaluate` and gets `passed`, or `unresolved-failure` / `not-passed` for failed / blocked.

### Synced or not

"Synced" means every event in the run's journal has a verified `upload-acknowledged` (the existing `RunState.pending`). Until then the dashboard shows **Not synced**. `syncManualRun` is `syncRun` for a recorded manual result; the repository and release come from `manual.json` on disk, never from the window. A failed upload changes nothing locally, and uploading again is safe (immutable names, replay-safe).

## Advisory ownership

The dashboard uses `recordScenarioClaim` and `claimStatus` unchanged. The privileged side picks the action: `claim` when nobody holds the check, `takeover` when someone else does (fresh or stale), `release` only for the holder. A claim is stale after four hours, decided by `claimStatus`; staleness is only displayed. Nothing checks a claim before recording or uploading a result.

## Not done

- Retrying a failed manual result (`retryOf`, and the person's acknowledgement the evaluator requires to clear a failure) has no dashboard path.
- No size or type check of an attachment beyond "a regular, non-empty file within the limit"; there is no preview.
- One result per run: a second verdict on the same check is a second run, and the evaluator's usual rules decide.
