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
