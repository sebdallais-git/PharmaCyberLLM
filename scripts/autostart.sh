#!/usr/bin/env bash
# One switch for "does this machine bring PharmaITChat back up by itself?".
#
#   scripts/autostart.sh on       install and start everything, and at every login
#   scripts/autostart.sh off      stop everything and do not start at login
#   scripts/autostart.sh status   what is installed and what is running
#
# Four launchd jobs cover the whole stack:
#   com.pharmaitchat.stack    ChromaDB + the active LLM stack + the app
#   com.pharmaitchat.mcp      the MCP server the agent tools reach
#   com.pharmaitchat.n8n      the knowledge-gap auto-fill workflow
#   ai.hermes.gateway         the Hermes gateway behind Telegram
#
# Docker is deliberately not managed here: Neo4j and SearXNG are containers with
# restart policy unless-stopped, so they come back when Docker Desktop does.
# `on` reports if Docker Desktop is not set to start at login, because nothing
# this script does can fix that.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEMPLATE_DIR="$PROJECT_DIR/hermes"
LAUNCH_AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LAUNCHCTL_BIN="${LAUNCHCTL_BIN:-launchctl}"
DOMAIN="gui/$(id -u)"

# Rendered from a template here; the gateway's plist is written by hermes itself.
OWN_LABELS=(com.pharmaitchat.stack com.pharmaitchat.mcp com.pharmaitchat.n8n)
ALL_LABELS=("${OWN_LABELS[@]}" ai.hermes.gateway)

log() { printf "[autostart] %s\n" "$*"; }

node_bin() { echo "${NODE_BIN:-$(command -v node || echo /usr/local/bin/node)}"; }

render() {
  local label="$1" template="$TEMPLATE_DIR/$label.plist.template" out="$LAUNCH_AGENTS_DIR/$label.plist"
  [ -f "$template" ] || { log "no template for $label — skipping"; return 1; }
  sed -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" \
      -e "s|__NODE_BIN__|$(node_bin)|g" \
      -e "s|__MCP_HOST__|${MCP_HOST:-127.0.0.1}|g" \
      -e "s|__N8N_PORT__|${N8N_PORT:-5678}|g" \
      -e "s|__PATH__|$(dirname "$(node_bin)"):/usr/bin:/bin:/usr/sbin:/sbin|g" \
      "$template" >"$out"
}

# launchd answers "Input/output error" on a bootstrap issued right after a
# bootout. Every caller in this repo retries for that reason.
bootstrap_with_retry() {
  local label="$1" plist="$LAUNCH_AGENTS_DIR/$1.plist" attempt
  [ -f "$plist" ] || { log "$label: no plist at $plist"; return 1; }
  for attempt in 1 2 3 4 5; do
    if "$LAUNCHCTL_BIN" bootstrap "$DOMAIN" "$plist" >/dev/null 2>&1; then
      log "$label: started"
      return 0
    fi
    sleep 2
  done
  log "$label: bootstrap failed after 5 attempts"
  return 1
}

state_of() {
  "$LAUNCHCTL_BIN" print "$DOMAIN/$1" 2>/dev/null | awk '/state = /{print $3; exit}'
}

cmd_on() {
  mkdir -p "$LAUNCH_AGENTS_DIR" "$PROJECT_DIR/data/logs"
  local label rc=0
  for label in "${OWN_LABELS[@]}"; do render "$label" || rc=1; done
  # The gateway's plist is hermes' own; install it if it is missing.
  if [ ! -f "$LAUNCH_AGENTS_DIR/ai.hermes.gateway.plist" ] && [ -x "$HOME/.hermes/hermes-agent/venv/bin/python" ]; then
    "$HOME/.hermes/hermes-agent/venv/bin/python" -m hermes_cli.main gateway install --force --start-on-login >/dev/null 2>&1 || true
  fi
  for label in "${ALL_LABELS[@]}"; do
    "$LAUNCHCTL_BIN" bootout "$DOMAIN/$label" >/dev/null 2>&1 || true
    "$LAUNCHCTL_BIN" enable "$DOMAIN/$label" >/dev/null 2>&1 || true
    bootstrap_with_retry "$label" || rc=1
  done
  log "autostart is ON — these come back at login and restart on crash"
  if ! docker info >/dev/null 2>&1; then
    log "NOTE: Docker Desktop is not running. Neo4j and SearXNG only return if it starts at login (Settings > General)."
  fi
  return "$rc"
}

cmd_off() {
  local label
  for label in "${ALL_LABELS[@]}"; do
    "$LAUNCHCTL_BIN" bootout "$DOMAIN/$label" >/dev/null 2>&1 || true
    # disable survives a bootstrap, so a stray `launchctl load` cannot quietly
    # switch autostart back on.
    "$LAUNCHCTL_BIN" disable "$DOMAIN/$label" >/dev/null 2>&1 || true
    log "$label: stopped and disabled"
  done
  log "autostart is OFF — nothing starts at login. Bring the stack up by hand with scripts/start-services.sh"
}

cmd_status() {
  local label state
  for label in "${ALL_LABELS[@]}"; do
    state="$(state_of "$label")"
    printf "  %-26s %s\n" "$label" "${state:-not loaded}"
  done
  printf "  %-26s %s\n" "docker (neo4j, searxng)" "$(docker info >/dev/null 2>&1 && echo running || echo 'not running')"
}

case "${1:-status}" in
  on) cmd_on ;;
  off) cmd_off ;;
  status) cmd_status ;;
  *) echo "usage: $0 on|off|status" >&2; exit 2 ;;
esac
