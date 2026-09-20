#!/usr/bin/env bash
# Shared helpers for the Task 0.2 gate experiments. Requires: gh, node.
set -euo pipefail
REPO="${QA_REPO:-Frogbyte-io/release-qa-gate-sandbox}"
tmpdir="$(mktemp -d)"; trap 'rm -rf "$tmpdir"' EXIT

uid() { node -e "console.log(require('crypto').randomUUID())"; }
pr_head() { gh api "repos/$REPO/pulls/$1" --jq .head.sha; }

# Serialize a record with a real JSON encoder. Arguments: key=string, key:=raw-json (numbers/booleans), key[]=string (array item).
# Nothing is inferred from a value's content, so a reason such as "[urgent]" stays a string.
json() { node -e '
const o={};
for(const a of process.argv.slice(1)){
  let m;
  if((m=a.match(/^([^=:[]+):=(.*)$/s))) o[m[1]]=JSON.parse(m[2]);
  else if((m=a.match(/^([^=:[]+)\[\]=(.*)$/s))) (o[m[1]]??=[]).push(m[2]);
  else if((m=a.match(/^([^=:[]+)=(.*)$/s))) o[m[1]]=m[2];
  else throw new Error("bad json() argument: "+a);
}
process.stdout.write(JSON.stringify(o))' "$@"; }

# Echo the id of the draft release "QA PR #n", creating it when absent. Reads every page of releases.
draft_id() {
  local n="$1" id
  id="$(gh api --paginate "repos/$REPO/releases?per_page=100" --jq ".[]|select(.draft and .name==\"QA PR #$n\")|.id" | sed -n 1p)"
  if [ -z "$id" ]; then
    id="$(gh api "repos/$REPO/releases" -X POST -f tag_name="qa-pr-$n" -f name="QA PR #$n" -F draft=true -f body="QA records for PR #$n" --jq .id)"
  fi
  echo "$id"
}

upload_json() { # release_id asset_name json
  local rid="$1" name="$2" json="$3"
  printf '%s' "$json" > "$tmpdir/$name"
  gh api "https://uploads.github.com/repos/$REPO/releases/$rid/assets?name=$name" \
    -X POST -H "Content-Type: application/json" --input "$tmpdir/$name" --jq .id
}

delete_asset() { gh api "repos/$REPO/releases/assets/$1" -X DELETE; }

asset_ids() { # release_id name_regex
  gh api "repos/$REPO/releases/$1" --jq ".assets[]|select(.name|test(\"$2\"))|.id"
}

current_candidate_id() { # release_id
  local aid; aid="$(asset_ids "$1" '^candidate[.]json$' | sed -n 1p)"
  [ -n "$aid" ] && gh api -H "Accept: application/octet-stream" "repos/$REPO/releases/assets/$aid" --jq .id
}
