# Privilege-Separated Gate Finalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep draft release reads and required-status publication out of the read-only evaluator while preserving the final candidate and PR identity check.

**Architecture:** The evaluator consumes brokered metadata and asset bytes, computes the gate result, and writes a bounded result artifact without publishing a status. A separate trusted finalizer receives that artifact with `contents:write` and `statuses:write`, rechecks the PR head, target tip, release-intent state, draft release, and active candidate asset, then publishes the single required status.

**Tech Stack:** TypeScript, Node.js, GitHub Actions, GitHub REST API, Vitest.

**Spec:** Task 3.3 live required-gate test and the existing read-only evaluator/broker privilege split.

## Global Constraints

- Evaluator job must retain only `contents:read` and `pull-requests:read`.
- Finalizer must execute only the trusted package revision, never code from the candidate PR.
- Publish `release-qa` only after final identity checks succeed.
- Preserve current blocked/success semantics and report the exact missing requirements.

## Review Focus

- Evaluator failure must still produce a final failing required status.
- Missing or malformed result artifacts must fail closed and publish a failing status when event identity is valid.
- Candidate, PR head, or target-branch changes between evaluation and finalization must block publication as success.
- Non-release PRs must remain green only while they remain non-release.
- Reruns must use attempt-specific artifacts to avoid immutable artifact collisions.

---

### Task 1: Produce a deferred evaluation result

**Files:**
- Modify: `packages/qa/src/github/pull-request-gate.ts`
- Modify: `packages/qa/src/github/gate-cli.ts`
- Test: `packages/qa/test/github/gate.test.ts`
- Test: `packages/qa/test/github/gate-cli.test.ts` (or the existing CLI test file)

**Interfaces:**
- Add an explicit deferred-finalization option to `evaluatePullRequest`.
- Include the evaluated `headSha`, `baseSha`, release ID, and candidate asset ID in the result artifact.
- When `RELEASE_QA_DEFER_FINALIZATION_FILE` is set, write the evaluation result and do not publish status or mutate PR body.

- [ ] Add a test showing deferred evaluation does not query the live draft-release endpoint and still returns the candidate/revision identity.
- [ ] Run the focused gate test and verify it fails because the deferred option is not implemented.
- [ ] Implement deferred evaluation and result-file serialization.
- [ ] Run the focused test and CLI tests; verify they pass.

### Task 2: Finalize and publish from the privileged job

**Files:**
- Create: `packages/qa/src/github/gate-finalize-cli.ts`
- Create: `packages/qa/test/github/gate-finalize.test.ts`
- Modify: `packages/qa/src/github/pull-request-gate.ts` only if a small shared identity helper is needed.

**Interfaces:**
- Consume the deferred result, event PR/head, current PR/base tip, trusted release policy, and current draft release metadata.
- Publish `release-qa` with failure on evaluation failure, malformed output, changed PR/base, changed release intent, changed release ID, or changed `candidate.json` asset ID.

- [ ] Add tests for an unchanged passing result, an evaluator-blocked result, a changed candidate, and a missing result file.
- [ ] Run the finalizer tests and verify the newly specified failure cases fail first.
- [ ] Implement fail-closed finalization and required-status publication.
- [ ] Run finalizer tests and typecheck; verify they pass.

### Task 3: Wire the trusted workflow handoff

**Files:**
- Modify: `.github/workflows/qa-gate.yml` in `Frogbyte-io/release-qa-gate-sandbox`.

- [ ] Broker job uploads a run-attempt-specific release snapshot.
- [ ] Read-only evaluator writes a run-attempt-specific result artifact and has no status-write permission.
- [ ] Finalizer runs after evaluator with `if: always()`, downloads the result when present, validates live identities, and alone has `contents:write` and `statuses:write`.
- [ ] Verify `release-qa` is the finalizer's only published status and run the consumer checks.

### Task 4: Verify the live candidate gate

- [ ] Prepare a candidate against the exact current main SHA, PR head SHA, and policy digest.
- [ ] Trigger one trusted gate run and verify the broker, evaluator, and finalizer sequence.
- [ ] Confirm the resulting `release-qa` status reflects the two missing manual requirements without treating the skipped second-account test as complete.
