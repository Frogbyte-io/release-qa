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
expect_gate() { # pr sha since expected
  local out; out="$("$here/wait-gate.sh" "$1" "$2" "$3")"; echo "$out"
  case "$out" in *"completed $4"*) ;; *) echo "FAIL: expected $4"; exit 1;; esac
}
merge_state() { gh api graphql -f query="{repository(owner:\"${REPO%/*}\",name:\"${REPO#*/}\"){pullRequest(number:$1){mergeStateStatus}}}" --jq .data.repository.pullRequest.mergeStateStatus; }
complete_candidate() { # pr  -> prepares a candidate, submits both results, refreshes; prints since-timestamp
  "$here/prepare-candidate.sh" "$1" >/dev/null 2>&1
  "$here/submit-report.sh" "$1" windows/persistence passed >/dev/null
  "$here/submit-report.sh" "$1" windows/device-feel passed >/dev/null
  "$here/refresh.sh" "$1"
}

cd "$sandbox"
git fetch -q origin && git switch -q -c "$branch" origin/main
echo "itest $(date -u +%s)" > VERSION && git add VERSION && git commit -qm "chore: release itest"
git push -q -u origin "$branch" 2>&1 | grep -v '^remote:' || true
pr="$(gh pr create -R "$REPO" --base main --head "$branch" --title "itest $branch" --body "integration test" | sed 's|.*/||')"
head="$(pr_head "$pr")"; echo "PR #$pr head $head"

step "1. no candidate: gate must block"
expect_gate "$pr" "$head" "" failure

step "2. complete results: gate must pass and PR be mergeable (CLEAN, or UNSTABLE while non-required bot checks are pending)"
since="$(complete_candidate "$pr")"; expect_gate "$pr" "$head" "$since" success
sleep 5; case "$(merge_state "$pr")" in CLEAN|UNSTABLE) ;; *) echo "FAIL: expected mergeable (CLEAN/UNSTABLE), got $(merge_state "$pr")"; exit 1;; esac

step "3. new commit: new head must be blocked"
echo "late" >> VERSION && git commit -qam "fix: late change" && git push -q origin "$branch" 2>&1 | grep -v '^remote:' || true
new="$(git rev-parse HEAD)"
for _ in $(seq 1 30); do [ "$(pr_head "$pr")" = "$new" ] && break; sleep 2; done # the API lags a push by a few seconds
expect_gate "$pr" "$new" "" failure

step "4. complete again, then replace the candidate: PR must be BLOCKED before the new candidate exists"
since="$(complete_candidate "$pr")"; expect_gate "$pr" "$new" "$since" success
"$here/prepare-candidate.sh" "$pr" >/dev/null 2>&1
[ "$(merge_state "$pr")" = BLOCKED ] || { echo "FAIL: replacement left PR mergeable"; exit 1; }

step "5. complete the replacement candidate and merge with a head match"
since="$(complete_candidate "$pr")"; expect_gate "$pr" "$new" "$since" success; sleep 5
if gh pr merge "$pr" -R "$REPO" --squash --match-head-commit "$zero" >/dev/null 2>&1; then echo "FAIL: wrong head merged"; exit 1; fi
gh pr merge "$pr" -R "$REPO" --squash --match-head-commit "$new" --delete-branch
[ "$(gh pr view "$pr" -R "$REPO" --json state --jq .state)" = MERGED ] || { echo "FAIL: not merged"; exit 1; }
echo; echo "OK: core gate behaviour verified on PR #$pr"
