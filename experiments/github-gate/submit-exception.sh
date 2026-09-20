#!/usr/bin/env bash
# usage: submit-exception.sh <pr> <requirement> <reason> [claimed-actor]
# The evaluator authorizes by the verified uploader of the asset, never by the claimed actor.
. "$(dirname "$0")/lib.sh"
n="$1"; req="$2"; reason="$3"; claimed="${4:-$(gh api user --jq .login)}"; rid="$(draft_id "$n")"
cid="$(current_candidate_id "$rid")"
upload_json "$rid" "exception-$(uid).json" \
  "$(json schemaVersion:=1 "candidateId=$cid" "requirements[]=$req" reason="$reason" actor="$claimed")" >/dev/null
echo "exception for $req on $cid"
