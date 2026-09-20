#!/usr/bin/env bash
# Hermes script-mode cron job: runs the nightly watchlist ingest.
#
# Installed by scripts/hermes-setup.sh install-cron into ~/.hermes/scripts/,
# with __PROJECT_DIR__ replaced by this repo's absolute path at install time
# -- once this file lives under ~/.hermes it has no other way to find the
# repo (same reason com.pharmallm.mcp.plist.template bakes in __PROJECT_DIR__).
#
# Hermes runs this job with --no-agent (see hermes/cron/jobs.json and
# scripts/hermes-setup.sh's install-cron): whatever this script prints to
# stdout is what --deliver/--failure-deliver actually send, and empty stdout
# is silent. So this script prints nothing on success and one short summary
# on failure, and exits non-zero exactly when the ingest run itself failed --
# that, combined with --deliver local --failure-deliver telegram, is what
# gives us "only speak up when something is wrong".
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

OUTPUT="$(npx tsx scripts/watchlist.ts ingest 2>&1)"
STATUS=$?

if [ "$STATUS" -ne 0 ]; then
  echo "watchlist ingest failed (exit $STATUS):"
  echo "$OUTPUT" | tail -20
fi

exit "$STATUS"
