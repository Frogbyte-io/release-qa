#!/usr/bin/env bash
# usage: prepare-candidate.sh <pr>
# Replaces the active candidate. Readiness is made BLOCKING first: the old candidate is
# withdrawn, the evaluator is refreshed, and only after a *failing* evaluation lands is the new
# candidate selected. This closes the window where an old green check covers a new candidate.
. "$(dirname "$0")/lib.sh"
here="$(cd "$(dirname "$0")" && pwd)"
n="$1"; rid="$(draft_id "$n")"; head="$(pr_head "$n")"
for aid in $(asset_ids "$rid" '^candidate[.]json$'); do delete_asset "$aid"; done
since="$("$here/refresh.sh" "$n")"
blocked="$("$here/wait-gate.sh" "$n" "$head" "$since")"
echo "$blocked" >&2
case "$blocked" in
  *"completed failure"*) ;;
  *) echo "refusing to select a new candidate: expected a completed failing evaluation, got: $blocked" >&2; exit 1;;
esac
base="$(gh api "repos/$REPO/branches/$(gh api "repos/$REPO/pulls/$n" --jq .base.ref)" --jq .commit.sha)"
cid="cand-$(uid)"
upload_json "$rid" candidate.json "$(json schemaVersion=1 id="$cid" sourceSha="$head" baseSha="$base")" >/dev/null
echo "$cid"
