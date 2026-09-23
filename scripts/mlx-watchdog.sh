#!/usr/bin/env bash
# Restart the active MLX-family chat server when it stops generating.
#
# MLX can wedge without dying: on 2026-09-22 it sat at 0% CPU with port 8080
# open, served /v1/models normally, and timed out a 5-token generation at 90s.
# Nothing noticed -- the app's health check probed /v1/models, the process was
# alive, the port answered, so every signal said healthy while chat was dead.
# It had OOMed once beforehand ([metal::malloc] Resource limit exceeded).
#
# So this checks the only thing that matters: can it produce a token.
#
# Covers mlx, omlx and splash -- the three stacks that run a local chat server
# on their own port (8080, 8090, 8000 respectively; see scripts/switch-stack.sh,
# which defines the same ports). Ollama is excluded on purpose: it is a long-
# running system service with its own restart story, not a per-project process
# this watchdog owns.
#
# Run by launchd every WATCHDOG_INTERVAL seconds. Deliberately NOT a KeepAlive
# job -- the failure is a live process that stops working, which KeepAlive
# cannot see.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
STATE_DIR="${PHARMALLM_RUN_DIR:-$PROJECT_DIR/data/run}"
STRIKES_FILE="$STATE_DIR/mlx-watchdog.strikes"
LOG="$PROJECT_DIR/data/logs/mlx-watchdog.log"

# Generous: a busy server (the watchlist tagger saturates it for ~20s an item)
# must not be mistaken for a wedged one.
PROBE_TIMEOUT="${WATCHDOG_PROBE_TIMEOUT:-90}"
# Two consecutive failures before acting, so one slow moment never restarts a
# server that is merely busy.
MAX_STRIKES="${WATCHDOG_MAX_STRIKES:-2}"

mkdir -p "$STATE_DIR" "$(dirname "$LOG")"
log() { printf "%s %s\n" "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG"; }

# Only restart the stacks this watchdog can actually probe. Each one gets its
# own port, matching scripts/switch-stack.sh -- probing the wrong port would
# report "healthy" for a server this watchdog never contacted, which is worse
# than not watching it at all.
stack="$(cat "$STATE_DIR/active-stack" 2>/dev/null || echo ollama)"
case "$stack" in
  mlx) port="${MLX_CHAT_PORT:-8080}" ;;
  omlx) port="${OMLX_PORT:-8090}" ;;
  splash) port="${SPLASH_PORT:-8000}" ;;
  *) exit 0 ;;
esac

CHAT_URL="${WATCHDOG_CHAT_URL:-http://localhost:$port}"

# The watchlist tagger saturates the same single chat server for ~20s an item,
# so a probe issued mid-ingest queues behind the backlog and can exceed even a
# 90s timeout. Two of those would have this watchdog restart the stack
# underneath the ingest and destroy the run it was meant to protect. A
# saturated server is busy, not wedged.
if pgrep -f "watchlist.ts ingest" >/dev/null 2>&1; then
  exit 0
fi

code="$(curl -s -o /dev/null -w '%{http_code}' -m "$PROBE_TIMEOUT" \
  -X POST "$CHAT_URL/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}' 2>/dev/null)"

if [ "$code" = "200" ]; then
  [ -s "$STRIKES_FILE" ] && log "recovered after $(cat "$STRIKES_FILE") strike(s)"
  : >"$STRIKES_FILE"
  exit 0
fi

strikes=$(( $(cat "$STRIKES_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$strikes" >"$STRIKES_FILE"
log "$stack generation probe failed (HTTP ${code:-000}), strike $strikes/$MAX_STRIKES"

if [ "$strikes" -lt "$MAX_STRIKES" ]; then
  exit 0
fi

log "restarting the $stack stack"
pid="$(lsof -ti ":$port" 2>/dev/null | head -1)"
if [ -n "$pid" ]; then
  kill -TERM "$pid" 2>/dev/null
  for _ in $(seq 1 15); do lsof -ti ":$port" >/dev/null 2>&1 || break; sleep 1; done
  # A wedged process often ignores SIGTERM, which is what wedged means.
  lsof -ti ":$port" >/dev/null 2>&1 && kill -9 "$pid" 2>/dev/null
fi

if "$SCRIPT_DIR/switch-stack.sh" ensure-stack "$stack" >>"$LOG" 2>&1; then
  log "$stack restarted"
  : >"$STRIKES_FILE"
else
  log "restart FAILED — needs a human"
fi
