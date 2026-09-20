#!/usr/bin/env bash
# usage: wait-gate.sh <pr> [sha] [since-iso]
# Prints the newest release-qa check conclusion for the head (or sha) once completed and started at/after since.
. "$(dirname "$0")/lib.sh"
n="$1"; sha="${2:-$(pr_head "$n")}"; since="${3:-1970-01-01T00:00:00Z}"
for _ in $(seq 1 60); do
  out="$(gh api "repos/$REPO/commits/$sha/check-runs?check_name=release-qa" --jq "[.check_runs[]|select(.started_at>=\"$since\")|{s:.status,c:.conclusion,id:.id,start:.started_at}]|sort_by(.start)|last // empty|\"\(.s) \(.c) run=\(.id)\"")"
  case "$out" in completed*) echo "$sha: $out"; exit 0;; esac
  sleep 4
done
echo "$sha: timed out (last: ${out:-none})"; exit 1
