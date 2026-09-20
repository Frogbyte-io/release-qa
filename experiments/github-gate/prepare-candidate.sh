#!/usr/bin/env bash
# usage: prepare-candidate.sh <pr>
# Replaces the active candidate. Readiness is made BLOCKING first: the old candidate is
# withdrawn, the evaluator is refreshed, and only after a blocking result lands is the new
# candidate selected. This closes the window where an old green check covers a new candidate.
. "$(dirname "$0")/lib.sh"
n="$1"; rid="$(draft_id "$n")"; head="$(pr_head "$n")"
for aid in $(asset_ids "$rid" '^candidate[.]json$'); do delete_asset "$aid"; done
since="$("$(dirname "$0")/refresh.sh" "$n")"
"$(dirname "$0")/wait-gate.sh" "$n" "$head" "$since" >&2
base="$(gh api "repos/$REPO/branches/$(gh api "repos/$REPO/pulls/$n" --jq .base.ref)" --jq .commit.sha)"
cid="cand-$(uid)"
upload_json "$rid" candidate.json "{\"schemaVersion\":1,\"id\":\"$cid\",\"sourceSha\":\"$head\",\"baseSha\":\"$base\"}" >/dev/null
echo "$cid"
