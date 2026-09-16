#!/usr/bin/env bash
# Shared helpers for start-services.sh and switch-stack.sh. Source this file; don't execute it.

PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
CHROMA_PORT="${CHROMADB_PORT:-8100}"
CHROMA_URL="http://localhost:${CHROMA_PORT}"
CHROMA_BIN="$PROJECT_DIR/python/venv/bin/chroma"
CHROMA_DATA="$PROJECT_DIR/.chromadb-data"

log() {
  printf '[%s] %s\n' "${LOG_PREFIX:-services}" "$*"
}

# Poll a URL until it answers with 2xx, or give up after SECONDS
wait_http() {
  local url="$1" timeout="$2" waited=0
  until curl -sf -m 2 "$url" >/dev/null 2>&1; do
    [ "$waited" -ge "$timeout" ] && return 1
    sleep 1
    waited=$((waited + 1))
  done
}

port_open() {
  nc -z localhost "$1" >/dev/null 2>&1
}

wait_port_closed() {
  local port="$1" timeout="$2" waited=0
  while port_open "$port"; do
    [ "$waited" -ge "$timeout" ] && return 1
    sleep 1
    waited=$((waited + 1))
  done
}

# True when PID is a live process whose command line contains this project's path.
# Other projects run dev servers with the same commands and ports, so this is the only safe kill check.
is_project_pid() {
  local pid="${1:-}" cmd
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  cmd="$(ps -ww -p "$pid" -o command= 2>/dev/null)" || return 1
  [[ "$cmd" == *"$PROJECT_DIR/"* ]]
}

# PIDs listening on a TCP port, one per line (empty when nothing listens)
port_listeners() {
  lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
}

# Send SIGNAL to the project's listeners on PORT. Returns 1, without signaling anything,
# when a listener belongs to another program.
signal_port() {
  local port="$1" signal="$2" pid pids foreign=0
  pids="$(port_listeners "$port")"
  for pid in $pids; do
    if ! is_project_pid "$pid"; then
      log "Port $port is used by another program (pid $pid: $(ps -ww -p "$pid" -o command= 2>/dev/null || echo unknown)) — not stopping it"
      foreign=1
    fi
  done
  [ "$foreign" -eq 0 ] || return 1
  for pid in $pids; do
    kill -"$signal" "$pid" 2>/dev/null || true
  done
}

# Free PORT: TERM the project's listeners, wait up to TIMEOUT seconds, then KILL them.
# Fails when the port is held by another program or stays in use.
stop_port() {
  local port="$1" timeout="$2"
  port_open "$port" || return 0
  signal_port "$port" TERM || return 1
  wait_port_closed "$port" "$timeout" && return 0
  signal_port "$port" KILL || return 1
  wait_port_closed "$port" 5
}

# TERM the process recorded in PIDFILE (and its direct children) if it belongs to the project,
# then remove the file. A stale file (dead PID or a PID reused by another program) is just removed.
stop_pidfile_process() {
  local pidfile="$1" pid child
  [ -f "$pidfile" ] || return 0
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    # npx parents don't carry the project path, but their tsx/node children do
    for child in $(pgrep -P "$pid" 2>/dev/null || true); do
      if is_project_pid "$child"; then kill -TERM "$child" 2>/dev/null || true; fi
    done
    if is_project_pid "$pid"; then kill -TERM "$pid" 2>/dev/null || true; fi
  fi
  rm -f "$pidfile"
}

ensure_chromadb() {
  if curl -sf "${CHROMA_URL}/api/v2/heartbeat" >/dev/null 2>&1; then
    log "ChromaDB already running on port ${CHROMA_PORT}"
    return 0
  fi

  if [ ! -f "$CHROMA_BIN" ]; then
    log "ChromaDB not installed. Setting up Python venv..."
    python3 -m venv "$PROJECT_DIR/python/venv"
    "$PROJECT_DIR/python/venv/bin/pip" install -q chromadb
  fi

  log "Starting ChromaDB on port ${CHROMA_PORT}..."
  mkdir -p "$CHROMA_DATA"
  nohup "$CHROMA_BIN" run --port "$CHROMA_PORT" --path "$CHROMA_DATA" >/dev/null 2>&1 &
  wait_http "${CHROMA_URL}/api/v2/heartbeat" 30 || { log "ChromaDB failed to start within 30s"; return 1; }
  log "ChromaDB ready"
}
