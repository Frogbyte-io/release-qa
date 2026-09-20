#!/usr/bin/env bash
# usage: refresh.sh <pr>   Non-mutating evaluator refresh: changes a marker in the PR body (fires pull_request:edited).
. "$(dirname "$0")/lib.sh"
n="$1"
body="$(gh api "repos/$REPO/pulls/$n" --jq .body)"
stamp="$(date -u +%Y%m%dT%H%M%S%N)"
new="$(printf '%s' "$body" | node -e "
let s=require('fs').readFileSync(0,'utf8');const m='<!-- qa:refresh='+process.argv[1]+' -->';
s=/<!-- qa:refresh=[^>]*-->/.test(s)?s.replace(/<!-- qa:refresh=[^>]*-->/,m):s+'\n'+m;process.stdout.write(s)" "$stamp")"
gh api "repos/$REPO/pulls/$n" -X PATCH -f body="$new" --jq .updated_at
