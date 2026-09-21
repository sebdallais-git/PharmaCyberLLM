#!/usr/bin/env bash
# launchd entry point for pharmaitchat-n8n: runs the n8n instance that hosts the
# knowledge-gap auto-fill workflow.
#
# n8n owns the FILLING half of the gap loop -- generate search queries, search
# SearXNG, fetch and clean pages, extract, filter for relevance, then ingest.
# Hermes owns the CHECKING half: the pharmaitchat-gap-resolution cron re-asks
# each gap and marks it resolved. Neither replaces the other, and the app's Gap
# Detector calls this webhook the moment a gap is found, which is why it runs as
# a service rather than on a schedule.
#
# Holds no secrets: n8n reads its own credentials from ~/.n8n.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

export N8N_PORT="${N8N_PORT:-5678}"
# Bound to loopback on purpose: the only caller is the app's Gap Detector on
# this machine, and n8n's editor has no auth in this deployment.
export N8N_LISTEN_ADDRESS="${N8N_LISTEN_ADDRESS:-127.0.0.1}"
export N8N_USER_FOLDER="${N8N_USER_FOLDER:-$HOME}"
# Suppress the permissions warning launchd's umask would otherwise trigger.
export N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS="${N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS:-false}"
export N8N_DIAGNOSTICS_ENABLED="${N8N_DIAGNOSTICS_ENABLED:-false}"

if [ -n "${N8N_BIN:-}" ] && [ -x "$N8N_BIN" ]; then
  exec "$N8N_BIN" start
fi

# npx resolves the cached copy under ~/.npm/_npx; --yes stops it prompting when
# launchd gives it no tty.
cd "$PROJECT_DIR"
exec npx --yes n8n start
