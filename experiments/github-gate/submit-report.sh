#!/usr/bin/env bash
# usage: submit-report.sh <pr> <requirement> <passed|failed|blocked> [candidate-id]
. "$(dirname "$0")/lib.sh"
n="$1"; req="$2"; outcome="$3"
case "$outcome" in passed|failed|blocked) ;; *) echo "outcome must be passed, failed or blocked (got '$outcome')" >&2; exit 2;; esac
rid="$(draft_id "$n")"
cid="${4:-$(current_candidate_id "$rid")}"
actor="$(gh api user --jq .login)"
upload_json "$rid" "report-$(uid).json" \
  "$(json schemaVersion:=1 candidateId="$cid" requirement="$req" outcome="$outcome" actor="$actor")" >/dev/null
echo "submitted $req=$outcome for $cid"
