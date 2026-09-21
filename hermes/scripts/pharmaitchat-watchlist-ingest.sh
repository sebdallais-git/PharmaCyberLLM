#!/usr/bin/env bash
# Hermes script-mode cron job: runs the nightly watchlist ingest.
#
# Installed by scripts/hermes-setup.sh install-cron into ~/.hermes/scripts/,
# with __PROJECT_DIR__ replaced by this repo's absolute path at install time
# -- once this file lives under ~/.hermes it has no other way to find the
# repo (same reason com.pharmaitchat.mcp.plist.template bakes in __PROJECT_DIR__).
#
# Hermes runs this job with --no-agent (see hermes/cron/jobs.json and
# scripts/hermes-setup.sh's install-cron): whatever this script prints to
# stdout is what --deliver/--failure-deliver actually send, and empty stdout
# is silent. So this script prints nothing on success and one short summary
# on failure, and exits non-zero exactly when the ingest run itself failed --
# that, combined with --deliver local --failure-deliver telegram, is what
# gives us "only speak up when something is wrong". The run's full output is
# kept in data/logs/watchlist-ingest-<date>.log either way.
#
# `set -e` is deliberately NOT used: the ingest's non-zero exit is data this
# script has to report, not a reason to die before reporting it.
set -uo pipefail

PROJECT_DIR="__PROJECT_DIR__"
cd "$PROJECT_DIR" || { echo "watchlist ingest: cannot cd to $PROJECT_DIR"; exit 1; }

# Same stack-resolution order scripts/watchlist.ts's own resolveStackName
# uses (LLM_PROVIDER if set, else data/run/active-stack, else the client's
# own "ollama" default) -- the ingest CLI already does this internally, but
# setting it here too keeps this wrapper correct on its own terms, not only
# by relying on the CLI never changing that behaviour.
if [ -z "${LLM_PROVIDER:-}" ] && [ -s "$PROJECT_DIR/data/run/active-stack" ]; then
  LLM_PROVIDER="$(cat "$PROJECT_DIR/data/run/active-stack")"
  export LLM_PROVIDER
fi

# I6: keep the run's own log. stdout has to stay empty on success (that
# silence is what makes --no-agent report only failures), but the per-feed
# lines, the anomalies and the stack name are the only record of what the
# night actually did -- and on a SUCCESSFUL run nothing else keeps them.
# `tee` writes them to a dated file while the command substitution keeps them
# off the real stdout. One file per day, never rotated here: the ingest runs
# once a night and the files are a few kilobytes.
LOG_DIR="$PROJECT_DIR/data/logs"
LOG_FILE="$LOG_DIR/watchlist-ingest-$(date +%F).log"
mkdir -p "$LOG_DIR" || { echo "watchlist ingest: cannot create $LOG_DIR"; exit 1; }
printf '=== %s watchlist ingest ===\n' "$(date +%FT%T%z)" >>"$LOG_FILE"

# `set -o pipefail` (above) is what makes this $? the ingest's exit status
# rather than tee's -- appending to the log must never turn a failed run into
# a successful one, or a successful one into a failure.
OUTPUT="$(npx tsx scripts/watchlist.ts ingest 2>&1 | tee -a "$LOG_FILE")"
STATUS=$?

if [ "$STATUS" -ne 0 ]; then
  echo "watchlist ingest failed (exit $STATUS):"
  echo "$OUTPUT" | tail -20
fi

exit "$STATUS"
