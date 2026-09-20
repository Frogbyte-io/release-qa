#!/usr/bin/env bash
# Repeatable core gate check against the sandbox repository. Creates a release PR, drives it
# through blocked -> green -> stale (new commit) -> replaced candidate -> green, then performs a
# head-matched merge. Exits non-zero on the first unexpected outcome.
#
# Requires: gh (authenticated with repo + workflow), node, git, and a clone of the sandbox at
# $SANDBOX_DIR (default ../../../release-qa-gate-sandbox) whose main already carries qa-gate.yml.
. "$(dirname "$0")/lib.sh"
here="$(cd "$(dirname "$0")" && pwd)"
sandbox="${SANDBOX_DIR:-$here/../../../release-qa-gate-sandbox}"
branch="release/itest-$(date -u +%Y%m%d%H%M%S)"
zero=0000000000000000000000000000000000000000

step() { printf '\n== %s\n' "$*"; }
fail() { echo "FAIL: $*"; exit 1; }
expect_gate() { # pr sha since expected
  local out; out="$("$here/wait-gate.sh" "$1" "$2" "$3")" || true; echo "$out"
  case "$out" in *"completed $4"*) ;; *) fail "expected gate to complete with $4";; esac
}
# mergeStateStatus is computed separately from the check run; poll until it leaves UNKNOWN.
merge_state() {
  local s=UNKNOWN
  for _ in $(seq 1 30); do
    s="$(gh api graphql -f query="{repository(owner:\"${REPO%/*}\",name:\"${REPO#*/}\"){pullRequest(number:$1){mergeStateStatus}}}" --jq .data.repository.pullRequest.mergeStateStatus)"
    [ "$s" != UNKNOWN ] && break; sleep 2
  done
  echo "$s"
}
complete_candidate() { # pr -> prepares a candidate, submits both results, refreshes; prints since-timestamp
  "$here/prepare-candidate.sh" "$1" >/dev/null 2>&1
  "$here/submit-report.sh" "$1" windows/persistence passed >/dev/null
  "$here/submit-report.sh" "$1" windows/device-feel passed >/dev/null
  "$here/refresh.sh" "$1"
}

cd "$sandbox"
[ -z "$(git status --porcelain)" ] || fail "sandbox clone has uncommitted changes; refusing to run"
git fetch -q origin && git switch -q -c "$branch" origin/main
echo "itest $(date -u +%s)" > VERSION
git add VERSION
git commit -qm "chore: release itest"
git push -q -u origin "$branch"
pr="$(gh pr create -R "$REPO" --base main --head "$branch" --title "itest $branch" --body "integration test" | sed 's|.*/||')"
head="$(pr_head "$pr")"; echo "PR #$pr head $head"

step "1. no candidate: gate must block"
expect_gate "$pr" "$head" "" failure

step "2. complete results: gate must pass and PR be mergeable (CLEAN, or UNSTABLE while non-required bot checks are pending)"
since="$(complete_candidate "$pr")"; expect_gate "$pr" "$head" "$since" success
state="$(merge_state "$pr")"
case "$state" in CLEAN|UNSTABLE) ;; *) fail "expected mergeable (CLEAN/UNSTABLE), got $state";; esac

step "3. new commit: new head must be blocked"
echo "late" >> VERSION
git add VERSION
git commit -qm "fix: late change"
git push -q origin "$branch"
new="$(git rev-parse HEAD)"
for _ in $(seq 1 30); do [ "$(pr_head "$pr")" = "$new" ] && break; sleep 2; done # the API lags a push by a few seconds
[ "$(pr_head "$pr")" = "$new" ] || fail "PR head never updated to the pushed commit"
expect_gate "$pr" "$new" "" failure

step "4. complete again, then replace the candidate: PR must be BLOCKED before the new candidate exists"
since="$(complete_candidate "$pr")"; expect_gate "$pr" "$new" "$since" success
"$here/prepare-candidate.sh" "$pr" >/dev/null 2>&1
state="$(merge_state "$pr")"
[ "$state" = BLOCKED ] || fail "replacement left PR $state instead of BLOCKED"

step "5. complete the replacement candidate and merge with a head match"
since="$(complete_candidate "$pr")"; expect_gate "$pr" "$new" "$since" success
state="$(merge_state "$pr")"
case "$state" in CLEAN|UNSTABLE) ;; *) fail "expected mergeable before merge, got $state";; esac
if wrong="$(gh pr merge "$pr" -R "$REPO" --squash --match-head-commit "$zero" 2>&1)"; then fail "merge with a wrong head succeeded"; fi
case "$wrong" in *"Head branch was modified"*) echo "wrong head rejected as expected";; *) fail "wrong-head merge failed for another reason: $wrong";; esac
# GitHub can return a transient 502 / merge lock; retry and confirm the merged state rather than trust one call.
for attempt in 1 2 3 4 5; do
  gh pr merge "$pr" -R "$REPO" --squash --match-head-commit "$new" --delete-branch && break
  [ "$(gh pr view "$pr" -R "$REPO" --json state --jq .state)" = MERGED ] && break
  echo "merge attempt $attempt failed; retrying"; sleep 20
done
[ "$(gh pr view "$pr" -R "$REPO" --json state --jq .state)" = MERGED ] || fail "PR #$pr not merged (left open for inspection)"
echo; echo "OK: core gate behaviour verified on PR #$pr"
