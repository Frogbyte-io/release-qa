# Release QA implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` for direct execution, or `superpowers:subagent-driven-development` if the maintainer selects that execution method. Complete one task and its acceptance checks before dependent work. Read the linked spec before starting.

**Goal:** Deliver a reusable Windows/Linux QA runner, a Windows desktop dashboard, and a GitHub release-PR workflow that publishes the exact candidate files verified by maintainers and agents.

**Architecture:** A shared TypeScript package owns execution, reports and GitHub integration. An Electron/Vue dashboard and CLI call that package. Consumer repositories own scenarios and release policy; GitHub holds shared records and Fleet Manager can later provide machines.

**Tech stack:** Proposed Electron + Vue 3 dashboard; TypeScript and Node.js 22+ runner; GitHub CLI authentication; Vitest; WebdriverIO external Tauri driver subject to Stage 0 evidence; Windows x86_64 and Ubuntu 24.04 x86_64 baseline.

**Spec:** [Release QA design](../specs/2026-09-20-release-qa-design.md).

**Status:** Review draft. Stage 0 is the first executable increment after approval. Later stages have task boundaries and acceptance contracts; driver-specific details must follow the Stage 0 decision. No implementation, installation, GitHub mutation or production release has been performed by writing this plan.

## Global constraints

- Dot X is the first real consumer. A small independent Tauri application proves that the tool does not require Dot X.
- The reusable tool belongs in its own repository.
- Do not silently add an embedded test server to a shipping app.
- A rebuild at the same source SHA is a new candidate.
- Hash the installer and updater files, not only the Actions artifact archive.
- Missing required capability is blocked, not passed or implicitly not applicable.
- Never kill an application by a process name shared with a production installation.
- Only approved binaries are presented as release downloads.
- No rebuild, version rewrite, or re-signing occurs after QA.
- Issue references do not imply test coverage.

## Review focus

1. Old results arriving after a new candidate must not change the current approval. Own in tasks 1.2, 3.2 and 3.3.
2. A signed build must remain byte-identical through QA and publication. Own in tasks 0.1, 3.1 and 4.1.
3. Concurrent testers, offline uploads and replayed requests must preserve evidence without losing failures. Own in tasks 1.3 and 3.2.
4. A runner crash or failed cleanup must not leave a machine falsely ready for another stateful test. Own in tasks 2.1 and 6.1.
5. PR edits, permission changes and a target-branch update between QA and merge must not bypass the gate. Own in tasks 0.2, 3.3 and 4.1.

## Delivery stages

| Stage | Deliverable | Depends on | Completion evidence |
| --- | --- | --- | --- |
| 0 | Packaged automation and GitHub gate feasibility | Review approval and designated test resources | Real packaged-app runs and a disposable protected-PR exercise |
| 1 | Candidate/report contract and evaluator | Stage 0 decisions | Deterministic contract, replay and stale-result tests |
| 2 | Windows/Linux CLI runner | Stage 1 | Same sample app scenario passes on both OS profiles |
| 3 | Shared GitHub QA and release PR gate | Stages 1-2 | Two testers, reruns, missing manual check and stale-head tests |
| 4 | Publication of approved files | Stage 3 | Merge publishes identical artifacts; interrupted publication recovers |
| 5 | Windows QA dashboard | Stages 2-4 | Maintainer can complete the sample release without terminal commands after setup |
| 6 | Dot X first useful flow | Stages 2-5 and Dot X build/signing readiness | Real Windows audio result, persistence, report and cleanup |
| 7 | Broader Dot X coverage and Linux adoption | Stage 6; actual Linux Dot X candidate for native Linux tasks | Explicit required coverage matrix and manual release evidence |
| 8 | Fleet Manager adapter | Independent runner plus implemented Fleet capabilities | Same suite runs on a provisioned/reset environment |

Stage 2 is the first useful tool milestone. Stages 3-4 provide a complete CLI release workflow. Stage 6 is the first useful Dot X dashboard milestone. Do not wait for Stage 7 or Fleet Manager before delivering earlier milestones.

## Repositories and file ownership

The tool repository is `Frogbyte-io/release-qa`, initially private, with a local checkout at `D:\release-qa`. Repository creation and the planning-document move are complete; application implementation has not started. Confirm package names before package publication. Do not move production Dot X files.

| Location | Owner and role |
| --- | --- |
| `packages/qa/src/model/*.ts` | Tool: schemas, identities, reports, evaluation |
| `packages/qa/src/runner/*.ts` | Tool: scenario execution, prerequisites, owned-resource cleanup |
| `packages/qa/src/drivers/tauri.ts` | Tool: selected native driver bridge |
| `packages/qa/src/github/*.ts` | Tool: gh transport, records, PR rendering, publication |
| `packages/qa/src/cli/*.ts` | Tool: stable CLI and JSON output |
| `apps/desktop/src/main/`, `preload/`, `renderer/` | Tool: privileged process, narrow IPC, Vue views |
| `examples/tauri-smoke/` | Tool: independent consumer with a real persisted setting |
| `.github/workflows/qa-*.yml` | Tool templates/reusable workflows and consumer wrappers |
| `qa/` in Dot X | Consumer: policy, lifecycle hooks, scenarios, fixtures |
| `src/`, `src-tauri/`, `plugin-sdk/` in Dot X | Consumer production code: only justified testability/correctness changes |

Commit each accepted task separately with scoped conventional titles. Preserve unrelated work. Run the repository's required checks before a push. Dot X changes retain its `yarn build` and Rust-change `cargo test --locked` requirements, plus applicable SDK generation/build checks.

## Stage 0: prove the assumptions

### Task 0.1: automate unchanged packaged Tauri applications

**Create in the tool repository:** `examples/tauri-smoke/`, `experiments/native-automation/`, `docs/decisions/native-automation.md`.

**Consumes:** designated Windows test machine, Ubuntu 24.04 environment, stable Tauri dependencies and signing setup where available. Tool installation follows the machine's existing approval rules.

**Produces:** a recorded driver decision, exact tested package hashes, versioned minimal reproducible test, and limits for each OS/profile.

- [ ] Create a Tauri sample with a named text input, Save button, visible saved value and persistence through the real native filesystem boundary. Use a unique sample application identity.
- [ ] Build normal distributables before starting automation. Record archive and inner-file hashes. Include the intended release-mode configuration; do not accept a debug-only proof.
- [ ] Attempt external WebdriverIO/Tauri automation on Windows and Linux/Xvfb. On Windows, compare Playwright/WebView2 if the external route fails or lacks required behavior. Record startup flags and whether any package change is required.
- [ ] Drive Save, exit the captured app process, relaunch, assert the saved value, then remove the value and repeat. Capture app-window evidence and actual on-disk persistence.
- [ ] Run 10 independent clean-profile attempts per available OS. One failed attempt must remain visible; investigate it rather than replacing its result with a rerun.
- [ ] Attempt a packaged Dot X launch on its designated Windows test machine. Identify an existing/external way to supply slider input without a physical device and independently read an audio session's volume. Check signing readiness without printing credentials.
- [ ] Record one of: unchanged release packages are automatable; platform-specific adapter required; or exact-package UI automation is unavailable. In the last case, stop dependent claims and present a revised split between automated source tests and manual package verification.

The evidence record must include this table, populated with observations:

```text
OS/session | package format | package SHA-256 | driver/version
launch | click/save | real native persistence | restart | cleanup
shipping binary changed? | flags used | limitations | evidence paths
```

**Exit:** both OS sample runs are proven, and Dot X's first-flow input/readback feasibility is known. Missing machine access is recorded as a blocked experiment, not inferred success.

### Task 0.2: prove the no-service GitHub merge gate

**Create:** `experiments/github-gate/`, `.github/workflows/qa-gate.yml`, `docs/decisions/github-gate.md` in a disposable integration repository or designated test repository.

**Consumes:** a repository with permission to configure required checks and test accounts representing the intended roles. Do not change Dot X branch protection for this experiment.

**Produces:** working eligible-event gate, exact SHA association, refresh mechanism, tested permission matrix and repeatable integration script.

- [ ] Add a PR-triggered, always-running `release-qa` evaluator and require it in the test repository. Initially fail with `manual check required`.
- [ ] Submit a result with user `gh` credentials. Re-run only the evaluator for the same PR event; demonstrate that success satisfies the required check without custom Check Runs credentials.
- [ ] Push a new commit. Verify old results cannot satisfy the new gate. Test the PR head and GitHub test-merge SHA association explicitly.
- [ ] Replace a candidate at the same source SHA. Make readiness blocking before selection/build changes; prove old green checks and delayed evaluator completions cannot approve the replacement.
- [ ] Exercise two submissions at once, a cancelled evaluator, missing hardware, exception approval, an edited PR body and a removed release label.
- [ ] Prove a non-mutating refresh event for an evaluation older than GitHub's rerun window. Candidate options are a PR `edited` event or a deployment event; choose only an option demonstrated to satisfy required checks. Never require a fake source commit to refresh results.
- [ ] Verify required-check freshness rules and evaluator refresh without holding a job open while a human tests. Missing manual work should finish with a blocking result; synchronization starts another short evaluation.
- [ ] Verify automated workflow chaining explicitly. Do not assume a `GITHUB_TOKEN`-generated event starts another workflow. Use an explicit dispatch or reusable workflow where needed.
- [ ] Record read/report/rerun/release-write/merge permissions and actual behavior of the selected private/public repository plan. If the required gate cannot be made reliable, stop and revise the integration before implementation.

**Exit:** a missing manual result really prevents merge; a current complete result permits it; stale or replacement-candidate results cannot bypass it.

### Task 0.3: lock the implementation defaults

**Create:** `docs/decisions/tool-layout.md`, root `package.json`, lockfile, `packages/qa/package.json`, `apps/desktop/package.json` as part of the first working package task.

- [ ] Record accepted driver, desktop shell, runtime/tool versions, package manager, repository identity and package names. Use Electron/Vue and npm workspaces unless review changes that proposal.
- [ ] Map the proven Stage 0 commands into reusable scripts. Pin a supported Ubuntu image/version and Windows baseline.
- [ ] Move experimental proof into repeatable smoke checks. Keep throwaway experiments clearly separate from shipped APIs.

**Exit:** Stage 1 has known dependencies; no external service or production app modification has been introduced merely to make the prototype work.

## Stage 1: records and decisions

### Task 1.1: versioned contracts and validation

**Create:** `packages/qa/src/model/{candidate,requirement,result,project}.ts`, `packages/qa/test/model/contracts.test.ts`, `packages/qa/test/fixtures/records.ts`.

**Interfaces:** export `parseProject`, `parseCandidate`, `parseReport` and `parseException`, accepting `unknown` and either returning validated records or a typed validation error. Freeze schema version `1` for the first tool release.

Use these semantic types as the starting contract; validators must enforce the constraints listed below rather than trusting TypeScript callers:

```ts
type Outcome = 'passed' | 'failed' | 'blocked' | 'cancelled' | 'interrupted';
type Readiness = 'blocked' | 'passed' | 'approved-with-exceptions';
type RequirementKey = `${string}/${string}`; // environment profile/scenario ID

interface Candidate {
  schemaVersion: 1;
  id: string;
  repositoryId: number;
  pullRequest: number;
  sourceSha: string;
  baseSha: string;
  sourceTreeSha: string;
  testRevision: string;
  policyDigest: string;
  build: { workflowPath: string; runId: number; attempt: number };
  artifacts: Array<{
    profile: string;
    name: string;
    sha256: string;
    assetId: number;
    actionsArtifactId: number;
  }>;
}

interface Attempt {
  id: string;
  requirement: RequirementKey;
  outcome: Outcome;
  retryOf?: string;
  evidence: string[];
}

interface Report {
  schemaVersion: 1;
  id: string;
  candidateId: string;
  policyDigest: string;
  testRevision: string;
  profile: string;
  actor: string;
  machineId: string;
  attempts: Attempt[];
}
```

- [ ] Write failing validation cases for unknown schema version, malformed hash, duplicate requirement/artifact IDs, path traversal in filenames, empty required fields and references outside the candidate.
- [ ] Implement parsing with named errors that the CLI/UI can display. Store measured environment details and upload provenance alongside the report; do not trust the report's claimed actor as proof of authority.
- [ ] Add representative fixture builders in `test/fixtures/records.ts`: `candidate()`, `requirement()`, `report()`, `exception()`. Builders accept overrides and use fixed IDs/hashes.
- [ ] Run `npm test --workspace packages/qa -- contracts.test.ts` and typecheck. Verify a report written on Windows parses identically on Linux.

**Exit:** malformed or future-schema records cannot enter aggregation silently.

### Task 1.2: one readiness evaluator

**Create:** `packages/qa/src/model/evaluate.ts`, `packages/qa/test/model/evaluate.test.ts`.

**Interface:** `evaluate(input: EvaluationInput): Evaluation`. Input contains the selected candidate, current PR head/base, required keys, eligible reports, authorized exceptions and explicitly acknowledged retry resolutions. Output contains readiness, reasons, accepted report IDs and exception IDs. The caller supplies verified upload/actor provenance.

- [ ] Write failing tests for each review-focus case and this initial assertion:

```ts
import { expect, test } from 'vitest';
import { evaluate } from '../../src/model/evaluate.js';
import { candidate, requirement } from '../fixtures/records.js';

test('missing manual evidence blocks readiness', () => {
  const selected = candidate();
  const result = evaluate({
    candidate: selected,
    currentHeadSha: selected.sourceSha,
    currentBaseSha: selected.baseSha,
    required: [requirement({ key: 'windows/device-feel', mode: 'manual' })],
    reports: [],
    exceptions: [],
    retryResolutions: [],
  });
  expect(result.readiness).toBe('blocked');
  expect(result.reasons).toContainEqual({
    code: 'missing-result', requirement: 'windows/device-feel',
  });
});
```

- [ ] Define `EvaluationInput` and `Evaluation` to match the test and spec. Keep the evaluator pure; no GitHub calls, local-clock ordering or filesystem reads.
- [ ] Require candidate, policy, test revision and environment match. Reject superseded uploads; preserve their history outside the current decision.
- [ ] Require explicit resolution of contradictory/retry attempts. Test that an unrelated passing attempt cannot erase a failure, and that authorized exceptions yield `approved-with-exceptions` rather than `passed`.
- [ ] Test new head, changed base, missing Linux result, unsupported profile, untrusted exception, duplicate report replay and a complete two-machine matrix.
- [ ] Run `npm test --workspace packages/qa -- evaluate.test.ts` and typecheck.

**Exit:** UI, CLI, PR gate and publisher can all consume this one decision function.

### Task 1.3: durable local run journal and reports

**Create:** `packages/qa/src/runner/{journal,report}.ts`, `packages/qa/test/runner/journal.test.ts`.

**Interfaces:** `appendEvent(runDir, event)`, `readRun(runDir)`, `renderReport(report)` and a stable event ID with optional predecessor ID. A report export produces JSON plus a self-contained HTML report with escaped text and relative evidence references.

- [ ] Test interruption during a write, duplicate event replay, reused ID with different content, out-of-order checkpoint delivery, missing evidence and offline restart.
- [ ] Append events durably and write materialized local summaries through atomic replacement. Recover complete events and identify truncated records; never invent a completed checkpoint.
- [ ] Track pending/synced uploads separately from test outcomes. Do not clear pending events until server acknowledgement has been verified.
- [ ] Test HTML escaping with test names/logs containing markup and secrets designated for redaction. Limit uploaded logs/evidence according to project policy.
- [ ] Run `npm test --workspace packages/qa -- journal.test.ts`.

**Exit:** a crash or network outage cannot silently lose an accepted local result or claim that it is shared.

## Stage 2: one runner on Windows and Linux

### Task 2.1: lifecycle execution and environment checks

**Create:** `packages/qa/src/runner/{execute,environment,resources}.ts`, `packages/qa/test/runner/execute.test.ts`.

**Interfaces:** `inspectEnvironment(profile)`, `executeScenario(context, scenario)` and `cleanupOwnedResources(handles)`. Context supplies candidate, profile, test root, abort signal and event sink. Lifecycle module exports `install`, `launch`, `reset`, `cleanup`.

- [ ] Write failing tests for missing display, missing audio capability, timeout, cancellation during install, launch failure and cleanup failure.
- [ ] Run scenarios only in an explicitly designated test environment. Resolve and check file roots before cleanup; record only spawned process handles/PIDs.
- [ ] Make install/launch/setup/steps/cleanup emit events. Use bounded waits and driver condition assertions. Execute cleanup on success, assertion failure and cancellation.
- [ ] Interrupt a helper process mid-test and verify the next run refuses the dirty environment until reset. Prove a separately launched unrelated process remains alive.
- [ ] Run `npm test --workspace packages/qa -- execute.test.ts` on Windows and Linux.

**Exit:** prerequisite failure is `blocked`, assertion failure is `failed`, infrastructure interruption is explicit, and cleanup does not target unrelated state.

### Task 2.2: sample consumer and CLI

**Create:** `packages/qa/src/drivers/tauri.ts`, `packages/qa/src/cli/main.ts`, `examples/tauri-smoke/qa/{project.json,lifecycle.ts,persistence.spec.ts}`, `packages/qa/test/cli.test.ts`.

**Consumes:** Stage 0's selected driver and Stage 1's records. **Produces:** working `doctor`, `run`, `resume` and local `status` commands, with human and JSON output.

- [ ] Implement the Stage 0 persistence scenario using the selected established test runner. Wrap result reporting, not its assertion engine.
- [ ] Define `release-qa doctor --project <path> --profile <id> --json` and `release-qa run --project <path> --candidate <manifest> --profile <id> --suite <id> --json`.
- [ ] Define exits: `0` passed, `1` scenario failure, `2` missing prerequisite/manual work, `3` infrastructure/configuration error. Exception approval is a gate operation, not a fabricated test pass.
- [ ] Test malformed args, missing candidate, unsupported profile and cancellation through the CLI executable.
- [ ] Run the same sample scenario on Windows and Ubuntu/Xvfb. Verify restart persistence through native storage and compatible JSON reports.
- [ ] Add a Linux desktop preflight that distinguishes a virtual display from the selected real graphical session; do not infer device availability from an OS label.

**Exit:** a maintainer or agent can run the sample on either OS without launching the dashboard. Reproduce the run on a clean test machine from the written setup guide.

## Stage 3: GitHub shared QA

### Task 3.1: authentication, discovery and candidate preparation

**Create:** `packages/qa/src/github/{transport,discover,candidate}.ts`, `packages/qa/test/github/candidate.test.ts`, consumer `.github/workflows/qa-prepare.yml`.

**Interfaces:** `inspectGitHubAccess(repository)`, `discoverProjects()`, `prepareCandidate(repository, pr, expectedHead)` and `downloadCandidate(candidate, profile)`.

- [ ] Use `gh` subprocess argument arrays and stdin/body files; never put credentials in command arguments or renderer messages. Distinguish logged out, missing scope, insufficient repository role and organization access rejection.
- [ ] Discover opted-in projects by paginated accessible-repository lookup and static `qa/project.json` inspection; support a manual URL. Never execute scenario imports during discovery.
- [ ] In the preparation workflow, validate the expected head and trusted release intent, invalidate readiness first, build/sign the intended final version, and record source/tree/test/policy/build identities.
- [ ] Upload exact files to Actions and the draft release, then verify inner-file hashes. Select the candidate only after all required artifacts exist.
- [ ] Test expired Actions artifacts with surviving draft assets, same-name assets with different hashes, wrong workflow/run, cancelled preparation and two simultaneous preparation requests.
- [ ] Run `npm test --workspace packages/qa -- candidate.test.ts`; then prepare a sample candidate through the real GitHub integration repository.

**Exit:** candidate selection is explicit and complete. An Actions artifact name or source SHA alone cannot identify a valid candidate.

### Task 3.2: multi-user synchronization and handoff

**Create:** `packages/qa/src/github/{reports,sync}.ts`, `packages/qa/test/github/sync.test.ts`, consumer `.github/workflows/qa-reconcile.yml`.

**Interfaces:** `syncRun(runId)`, `loadCandidateProgress(candidateId)` and `reconcileRelease(releaseId)`.

- [ ] Upload individual checkpoint/result objects under unique names. Verify reported identity against upload/workflow provenance; unrecognized reporters cannot satisfy required policy.
- [ ] Serialize active-candidate/summary updates in one coordinator, but make reconciliation complete and idempotent so coalesced notifications do not drop records.
- [ ] Implement advisory scenario ownership, explicit takeover, stale-claim display, and duplicate-attempt history. Do not present advisory ownership as exclusive hardware locking.
- [ ] Test two machines finishing different requirements, overlapping attempts, delayed stale uploads, a temporary 403/429/network failure and replay after restart.
- [ ] Pause an upload halfway through and reject any incomplete result/evidence set during aggregation. A checkpoint becomes shared only after its referenced evidence is present and verified.
- [ ] Test takeover on another machine: preserve completed independent scenarios, rerun setup for remaining scenarios, and restart an unfinished stateful scenario.
- [ ] Run `npm test --workspace packages/qa -- sync.test.ts`, followed by two distinct GitHub identities contributing to one sample candidate.

**Exit:** a third fresh checkout reconstructs the same shared progress without copying another tester's local files.

### Task 3.3: PR summary, changelog and required gate

**Create:** `packages/qa/src/github/{pull-request,gate}.ts`, `packages/qa/test/github/gate.test.ts`, consumer `.github/workflows/qa-gate.yml`.

**Interfaces:** `renderQaSection(evaluation)`, `updateManagedSections(body, sections)`, `evaluatePullRequest(repository, pr)`.

- [ ] Propose feature/issue references from merged PRs since the last release. Keep maintainer edits and distinguish release scope from verified scenario coverage.
- [ ] Add the reviewed changelog and generated QA marker blocks without violating the consumer's PR template. Test missing/duplicate markers, Unicode, manually edited text and concurrent prose edits. Refetch before updating; report a detected conflict rather than clobbering it.
- [ ] Port the proven eligible-event gate from Task 0.2. Always run its decision step even when dependent jobs fail. Missing required results produce a blocking conclusion, never neutral/skipped.
- [ ] Load current head, active candidate and requirements before evaluation, then recheck identities before publishing a success. Serialize candidate replacement and gate writes according to the proven Stage 0 protocol.
- [ ] Support authenticated explicit exceptions and retry resolutions. Validate authority at evaluation/publication, preserve the reason and show `approved with exceptions` prominently.
- [ ] Test removed label, policy change, source push, base-branch change, wrong SHA gate rerun, unauthorized exception and delayed success from an obsolete evaluator.
- [ ] Run `npm test --workspace packages/qa -- gate.test.ts`, then repeat the protected-PR test with real multi-user reports.

**Exit:** the PR summary is informative and the required check demonstrably enforces the same evaluator. Candidate failure details and remaining manual work are visible without opening the QA app.

## Stage 4: merge and publish the tested candidate

### Task 4.1: verified, retryable publication

**Create:** `packages/qa/src/github/publish.ts`, `packages/qa/test/github/publish.test.ts`, consumer `.github/workflows/qa-publish.yml`.

**Interfaces:** `verifyPublication(input)` returns a publication manifest or blocking reasons; `publishApprovedCandidate(manifest)` performs idempotent GitHub operations. `mergeReleasePr(repository, pr, expectedHead)` delegates to a head-matched normal merge without bypass.

- [ ] Write failing tests for changed binaries, source-tree mismatch after merge, changed policy, absent evidence, revoked exception authority, wrong tag, and merge of an unexpected head.
- [ ] Reevaluate current records on publication. Compare tested source tree with the actual merge tree and record both source and merge SHAs. Fail if the target branch changed the shipped tree.
- [ ] Snapshot the changelog from the reviewed PR at merge. If notes cannot be reliably identified, stop publication for repair rather than silently using later edits.
- [ ] Assemble final notes and QA record; remove superseded installable files from the final download list while keeping candidate/report history. Upload all final evidence before enabling immutable publication.
- [ ] Publish the existing tested files. Do not invoke compilation, version changes or signing in this workflow.
- [ ] Inject failure after tag creation, halfway through asset verification, and immediately after publish. Retry without producing a duplicate release or different bytes.
- [ ] Verify publication completes after a merge initiated inside the QA app and after a normal GitHub UI merge. Do not depend on an event suppressed by the workflow token.

**Exit:** in the integration repository, `SHA256(tested installer) == SHA256(published installer)` and equivalent equality holds for updater files. A broken publication shows a recoverable error after merge.

### Task 4.2: bootstrap and operator documentation

**Create:** `docs/{getting-started,authoring-tests,release-operations,permissions}.md`, `templates/consumer-qa/`.

- [ ] Document repository onboarding, workflow presence on the default branch, required permissions/check rules, package signing prerequisites and designated test profiles.
- [ ] Include explicit procedures for expired workflow reruns, abandoned candidates, unsynced results, failed cleanup, conflicting attempts, exception approval and partial publication.
- [ ] Test the template by onboarding a clean Tauri sample consumer using only the guide. Confirm historical releases show no recorded QA.
- [ ] Document public evidence handling and the distinction between administrator bypass and an enforced normal workflow.

**Exit:** a maintainer can complete one CLI-only release without undocumented author knowledge.

## Stage 5: Windows dashboard

### Task 5.1: repository and release views

**Create:** `apps/desktop/src/main/{index,qa-commands}.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/{App.vue,views/Repositories.vue,views/Release.vue}`, `apps/desktop/test/navigation.spec.ts`.

- [ ] Add Electron with context isolation and a typed allowlist of IPC commands. Keep GitHub credentials, file execution and subprocess access in the privileged process.
- [ ] Render active account, repository capabilities, opted-in repositories, upcoming PRs and published history from shared command results.
- [ ] Show candidate, per-environment checks, manual work, evidence, stale history and last synchronization time. Do not invent a second readiness calculation in Vue.
- [ ] Test loading, no configured projects, expired auth, read-only user, missing historical QA, stale cache and unsafe markup in repository text.
- [ ] Capture before/after app-window evidence for UI review; run automated dashboard interaction tests with a fixture GitHub transport.

**Exit:** the dashboard displays exactly the readiness returned by the CLI and handles inaccessible repositories without losing other projects.

### Task 5.2: run, hand off and merge from the dashboard

**Create:** `apps/desktop/src/renderer/views/{Run.vue,ManualCheck.vue}`, `apps/desktop/test/release-flow.spec.ts`.

- [ ] Wire Prepare candidate, Run suite, Resume, Sync, Open PR and Merge to shared commands. Show intended candidate, environment and consequences before a maintainer starts installation or publication-authorizing merge.
- [ ] Add manual results with required notes/evidence, explicit reporter identity, advisory ownership and a visible unsynced state.
- [ ] Trigger Linux jobs through GitHub while the UI runs on Windows. Distinguish job queued, runner unavailable, running, blocked and completed.
- [ ] Test close/reopen during remote execution, two users handing off scenarios, failed upload, permission loss, a candidate replacement while viewing it and a push immediately before merge.
- [ ] Run a real sample release through the dashboard after setup, with another tester contributing one checkpoint. Verify remote execution survives closing the app.

**Exit:** the agreed desktop workflow is usable without manual GitHub edits or a hosted service.

## Stage 6: Dot X first useful release QA

### Task 6.1: isolated Windows fixtures and full mapping flow

**Create in Dot X:** `qa/{project.json,package.json,lifecycle.ts}`, `qa/scenarios/mapping-persistence.spec.ts`, `qa/fixtures/{audio-session,volume-readback,slider-input}/`, `qa/README.md`.

**Inspect before changes:** `src/App.vue`, `src/ts/{appsToControl,volumeControl,decker}.ts`, `src/store/deckerStore.ts`, `src-tauri/src/{main,audio,decker}.rs`, `src-tauri/tauri.conf.json`. Update only required selectors or justified behavior, with normal Dot X review.

- [ ] Prepare a dedicated Windows profile/machine and backup/reset procedure. Assert no unrelated installed-app profile or device is touched by fixture setup.
- [ ] Implement a fixture that creates a uniquely identifiable real audio session and an independent OS readback helper. Prove session identity rather than assuming separate windows create separate audio sessions.
- [ ] Install the exact candidate, launch, discover the session, add a mapping and drive controlled production-path slider input using the mechanism proven in Task 0.1.
- [ ] Assert actual Windows volume at representative levels including zero. Change/remove a mapping and verify reverse behavior. Restart the app and verify intended persistence.
- [ ] Interrupt once during setup and once after mapping persistence. Verify cleanup/reset and that failed cleanup is visible. Capture only owned app windows/processes and fixture state.
- [ ] Run required frontend/Rust checks for any production code touched. Regenerate SDK types only if the plugin contract changes. Report unavailable hardware proof separately.

**Exit:** the first agreed end-to-end flow passes against the packaged Dot X candidate and fails when a deliberate fixture regression prevents the expected OS side effect.

### Task 6.2: Dot X release integration and GitHub updater migration

**Create:** Dot X `.github/workflows/qa-{prepare,gate,publish}.yml`, release PR marker/template integration and `qa/release-policy.json`.

**Inspect for the migration:** `src-tauri/tauri.conf.json`, `src/SettingsModal/About.vue`, `tools/bump-version.mjs`, current signing and external Anystack publication process. Verify live state again at implementation time.

- [ ] Integrate the first flow and required manual checklist into Dot X's release policy. Bootstrap workflows before relying on them for a release PR.
- [ ] Confirm repository/asset access for actual installed-app users. A private GitHub repository cannot be assumed to provide an unauthenticated updater feed; stop and choose an approved distribution arrangement if that applies.
- [ ] Prepare a separate reviewed change for GitHub updater metadata, signed updater artifacts, compatibility with the existing installed version, and old-channel transition. Preserve Aptabase telemetry.
- [ ] Exercise fresh install and old-version upgrade on a disposable Windows machine using exact candidate assets. Test missing/invalid signatures and unavailable metadata; no silent partial update.
- [ ] Confirm the existing distribution channel cannot announce an unapproved candidate. Coordinate the first migration release with maintainers rather than silently editing production endpoints.
- [ ] Run a complete release PR rehearsal. Do not publish a real user-facing release merely to satisfy this plan's acceptance check.

**Exit:** Dot X can adopt the QA release workflow, and updater migration has verified access/signature/upgrade behavior or remains a separately recorded release blocker.

## Stage 7: expand supported behavior

### Task 7.1: Windows feature and manual coverage

**Create in Dot X:** `qa/scenarios/{plugins,tray,reconnect,midi,brightness,upgrade}.spec.ts`, `qa/manual/*.md`, `qa/coverage.json`.

- [ ] Inventory entry points, Vue/Tauri/OS layers, plugin contracts, reverse states and documentation for each feature. Link scenarios to feature/issue IDs without claiming untested coverage.
- [ ] Add fixture-plugin install/enable/settings/restart/remove tests, tray continuity, unavailable sessions, reconnect behavior and upgrade/settings persistence.
- [ ] Add deterministic source-level tests where timing and error cases are cheaper to verify directly than through UI clicks. Keep native release checks for the actual integration outcomes.
- [ ] Write operator steps and pass criteria for physical slider response, LEDs, acoustic quality, unplug/replug, suspend/resume and monitor brightness where instrumentation is unavailable.
- [ ] Prove required manual tests block release and an explicitly authorized exception remains visible in PR and release reports.

**Exit:** policy names each required behavior and its evidence level. No percentage-coverage target replaces behavioral acceptance.

### Task 7.2: native Dot X Linux suites

**Create in Dot X:** `qa/profiles/ubuntu-24.04.json`, `qa/fixtures/linux/`, Linux candidate-build and desktop-run workflow jobs.

- [ ] Verify the actual Linux branch/PR integration and package readiness. This task does not include porting Dot X's native implementation.
- [ ] Add Ubuntu package install/launch/persistence tests using the released Linux package format. Record exact distribution, architecture, session and runtime versions.
- [ ] Add Linux audio readback/session fixtures and desktop checks only for implemented capabilities. Provision required D-Bus/audio/session/device permissions in the designated test environment.
- [ ] Add a separate real-desktop profile for Wayland coverage after its prerequisites are verified. Keep Xvfb results labeled as virtual-display results.
- [ ] Require native Linux results only for releases whose policy includes supported Linux artifacts. Missing required Linux prerequisites must block that profile, not silently drop it.

**Exit:** the shared tool runs Dot X on both OS families with explicit environment-specific evidence. Windows success never substitutes for Linux results.

## Stage 8: Fleet Manager integration

### Task 8.1: provision environments without changing tests

**Create in the tool:** `packages/qa/src/environments/fleet.ts`, `packages/qa/test/environments/fleet.test.ts`, `docs/fleet-integration.md`.

- [ ] Verify implemented Fleet APIs for acquire/readiness/execute/collect/release before binding to them. Linux, Windows GUI and USB readiness are separate capability prerequisites.
- [ ] Have Fleet provision a pinned environment and invoke the existing CLI with the same candidate/profile/suite contract. Keep test results in the same GitHub records.
- [ ] Collect evidence before releasing the lease. Handle provisioning timeout, guest crash, upload failure and cleanup failure without losing the run identity.
- [ ] Add exclusive USB ownership only when Fleet can enforce it. Test competing requests and detach/release failure; advisory scenario ownership is not sufficient for a physical port.
- [ ] Verify an unchanged sample suite on a prepared machine and a Fleet-created environment. Compare report meaning rather than incidental timing.

**Exit:** environments become disposable while test authors, the dashboard, and release policy keep the same contract.

## Verification strategy for the QA tool itself

| Test layer | What it proves |
| --- | --- |
| Pure contract/evaluator tests | Identity, policy, stale data, retries and exceptions |
| Filesystem/process integration | Durable journals, cancellation, isolation and cleanup |
| Fixture GitHub transport | Pagination, permission failures, races, replay and summaries |
| Real GitHub integration repository | Actual required-check enforcement and publication behavior |
| Packaged Tauri sample on Windows/Linux | Driver works against real native packages |
| Dashboard interaction tests | Maintainer controls call the same runner correctly |
| Real Dot X OS/hardware tests | Consumer-specific behavior, not merely the tool's logic |

Required fault cases are part of the owning tasks, not an optional final hardening pass. Run focused tests per task and full relevant checks at each stage exit. Do not repeatedly rerun a green suite without a change or new concern.

## Handoff and review

Review the spec and proposed defaults before implementation. The first action after approval is Stage 0, not building the dashboard. Its failures can change the driver or GitHub integration without wasting later work.

Recommended execution: direct implementation one task at a time for Stage 0, with explicit findings before dependent stages. The maintainer can choose delegated task implementation for later independent work. Repository creation, machine setup, production endpoint changes and real publication retain their respective approval boundaries.

Repository creation and the planning-document move are complete. No GitHub issues, PRs or releases were created. Task IDs can be copied into issues after the plan is accepted.
