# GitHub gate experiments (Task 0.2)

Throwaway scripts that exercise the no-service merge gate against a disposable repository. Findings and the resulting decisions are in [`docs/decisions/github-gate.md`](../../docs/decisions/github-gate.md).

| Path | Purpose |
| --- | --- |
| `sandbox/` | Copies of the files that live in the sandbox repository: `qa-gate.yml`, `qa-submit.yml`, `qa-evaluate.mjs`, `qa/policy.json`. They are **not** active workflows in this repository. |
| `lib.sh` | Shared helpers (`REPO` defaults to `Frogbyte-io/release-qa-gate-sandbox`; override with `QA_REPO`). |
| `prepare-candidate.sh <pr>` | Replaces the active candidate, blocking readiness first. |
| `submit-report.sh <pr> <requirement> <passed\|failed\|blocked> [candidate-id]` | Uploads a result as a draft-release asset. |
| `submit-exception.sh <pr> <requirement> <reason> [claimed-actor]` | Uploads an exception record. |
| `refresh.sh <pr>` | Fires `pull_request: edited` by changing a marker in the PR body. |
| `wait-gate.sh <pr> [sha] [since]` | Waits for the newest `release-qa` check on a head SHA. |
| `run-core.sh` | End-to-end assertion run on a fresh release PR. |

Requires `gh` (scopes `repo`, `workflow`), `node`, `git`, and a clone of the sandbox at `$SANDBOX_DIR`. The scripts mutate the sandbox repository only.

`sandbox/qa/policy.json` `required` entries must equal the requirement strings that testers submit exactly; the evaluator logs (and ignores) submitted requirements that are not listed, but a typo in `required` blocks every release PR at `manual check required`.

**Do not deploy `sandbox/` as-is against untrusted PR authors**: the gate workflow is editable by the PR it gates. See the decision record.
