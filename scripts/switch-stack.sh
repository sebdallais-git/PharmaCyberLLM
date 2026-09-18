#!/usr/bin/env bash
# Switch PharmaLLM between the Ollama and MLX stacks. Only one stack runs at a time.
# Usage:
#   scripts/switch-stack.sh ollama|mlx|omlx          stop the other stacks, start this one, restart the app
#   scripts/switch-stack.sh ensure-stack ollama|mlx  start a stack and its indexes without starting the app
#   scripts/switch-stack.sh prepare                  download models and create the MLX venv (one-time)
#   scripts/switch-stack.sh status                   show the active stack, ports and index counts
#   scripts/switch-stack.sh token                    create the API token for agents and other machines
#   scripts/switch-stack.sh ollama-ctx               recreate qwen3.8-pharma if its context differs from the Modelfile
#   scripts/switch-stack.sh mcp-token                create the token agents use to reach pharmallm-mcp
#   scripts/switch-stack.sh mcp start|stop|status    control the pharmallm-mcp launchd service

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_PREFIX="switch-stack"
# shellcheck source=lib/services.sh
source "$SCRIPT_DIR/lib/services.sh"

RUN_DIR="${PHARMALLM_RUN_DIR:-$PROJECT_DIR/data/run}"
TOKEN_FILE="$RUN_DIR/api-token"
MCP_TOKEN_FILE="$RUN_DIR/mcp-token"
MCP_LABEL="com.pharmallm.mcp"
MCP_PLIST="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}/$MCP_LABEL.plist"
MCP_PORT="3200"
LOG_DIR="$PROJECT_DIR/data/logs"
MLX_VENV="$PROJECT_DIR/python/mlx-venv"
MLX_PYTHON="${MLX_PYTHON:-python3}"
HF_CACHE="${HF_HOME:-$HOME/.cache/huggingface}/hub"
OLLAMA_MANIFESTS="${OLLAMA_MODELS:-$HOME/.ollama/models}/manifests/registry.ollama.ai/library"

APP_PORT="3000"
APP_HTTPS_PORT="3443"
OLLAMA_PORT="11434"
MLX_CHAT_PORT="8080"
MLX_EMBED_PORT="8081"

OLLAMA_BASE_MODEL="qwen3.8:27b-q4_K_M"
OLLAMA_CHAT_MODEL="qwen3.8-pharma"
OLLAMA_EMBED_MODEL="qwen3-embedding:0.6b-q8_0"
MLX_CHAT_MODEL="mlx-community/Qwen3.8-27B-4bit"
MLX_EMBED_MODEL="mlx-community/Qwen3-Embedding-0.6B-8bit"
OLLAMA_MODELFILE="$PROJECT_DIR/ollama/qwen3.8-pharma.Modelfile"
# Caps how much memory mlx_lm.server spends on cached prompts (several 64k agent prompts would otherwise pile up)
MLX_PROMPT_CACHE_BYTES="${MLX_PROMPT_CACHE_BYTES:-8589934592}"

OMLX_VENV="$PROJECT_DIR/python/omlx-venv"
OMLX_PORT="8090"
# Pinned to the commit verified in docs/superpowers/plans/2026-09-18-omlx-stack-verification.md
OMLX_VERSION="cbc1a80"
OMLX_REPO="https://github.com/jundot/omlx"
# Caps the oMLX paged SSD prefix cache (unbounded, it reached 4.3 GB in two short sessions)
OMLX_CACHE_MAX_GB="${OMLX_CACHE_MAX_GB:-20}"

mkdir -p "$RUN_DIR" "$LOG_DIR"

active_stack() {
  cat "$RUN_DIR/active-stack" 2>/dev/null || echo "ollama"
}

validate_stack() {
  case "$1" in
    ollama|mlx|omlx) ;;
    *) log "Unknown stack '$1' (expected ollama, mlx or omlx)"; exit 1 ;;
  esac
}

# --- Model availability (checked on disk, so no server needs to run) ---------

ollama_manifest() {
  local name="${1%%:*}" tag="${1#*:}"
  [ "$name" = "$1" ] && tag="latest"
  echo "$OLLAMA_MANIFESTS/$name/$tag"
}

hf_snapshot_present() {
  local dir="$HF_CACHE/models--${1//\//--}/snapshots"
  [ -d "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]
}

models_ready() {
  case "$1" in
    ollama)
      [ -f "$(ollama_manifest "$OLLAMA_CHAT_MODEL")" ] && [ -f "$(ollama_manifest "$OLLAMA_EMBED_MODEL")" ]
      ;;
    mlx)
      [ -x "$MLX_VENV/bin/mlx_lm.server" ] && hf_snapshot_present "$MLX_CHAT_MODEL" && hf_snapshot_present "$MLX_EMBED_MODEL"
      ;;
    omlx)
      [ -x "$OMLX_VENV/bin/omlx" ] && hf_snapshot_present "$MLX_CHAT_MODEL" && hf_snapshot_present "$MLX_EMBED_MODEL"
      ;;
  esac
}

# --- Stack processes -----------------------------------------------------------

stop_ollama() {
  brew services stop ollama >/dev/null 2>&1 || true
  # launchd restarts a killed Ollama, so only a closed port proves it is down
  wait_port_closed "$OLLAMA_PORT" 30 || { log "Ollama is still listening on :$OLLAMA_PORT"; return 1; }
}

start_ollama() {
  port_open "$OLLAMA_PORT" || brew services start ollama >/dev/null
  wait_http "http://localhost:$OLLAMA_PORT/v1/models" 60 || { log "Ollama did not become ready"; return 1; }
}

modelfile_num_ctx() {
  awk '$1 == "PARAMETER" && $2 == "num_ctx" { print $3 }' "$OLLAMA_MODELFILE"
}

ollama_model_num_ctx() {
  ollama show "$OLLAMA_CHAT_MODEL" --parameters 2>/dev/null | awk '$1 == "num_ctx" { print $2 }'
}

# Recreate qwen3.8-pharma when its context differs from the Modelfile (reuses the pulled weights, no download)
ensure_ollama_ctx() {
  local wanted current
  wanted="$(modelfile_num_ctx)"
  current="$(ollama_model_num_ctx || true)"
  if [ "$current" = "$wanted" ]; then
    log "$OLLAMA_CHAT_MODEL context is $wanted"
    return 0
  fi
  log "Recreating $OLLAMA_CHAT_MODEL with context $wanted (was ${current:-unknown})"
  ollama create "$OLLAMA_CHAT_MODEL" -f "$OLLAMA_MODELFILE" >/dev/null
}

stop_pidfile() {
  local name="$1" port="$2" ignore_foreign="${3:-}"
  stop_pidfile_process "$RUN_DIR/$name.pid"
  # Also covers a project server started by hand; another program on the port makes this fail
  # unless ignore-foreign is set (MLX ports may be shared with an unrelated program).
  stop_port "$port" 20 "$ignore_foreign" || { log "Port $port ($name) is still in use"; return 1; }
}

stop_mlx() {
  local chat_rc=0 embed_rc=0
  # Run both stops even if one fails, so a stuck chat port doesn't leave the embed server up.
  stop_pidfile mlx-chat "$MLX_CHAT_PORT" ignore-foreign || chat_rc=$?
  stop_pidfile mlx-embed "$MLX_EMBED_PORT" ignore-foreign || embed_rc=$?
  [ "$chat_rc" -eq 0 ] && [ "$embed_rc" -eq 0 ]
}

start_mlx() {
  if port_open "$MLX_CHAT_PORT"; then
    project_listener_open "$MLX_CHAT_PORT" \
      || { log "Port $MLX_CHAT_PORT is used by another program — cannot start MLX"; return 1; }
  else
    nohup "$MLX_VENV/bin/mlx_lm.server" --model "$MLX_CHAT_MODEL" --host 127.0.0.1 --port "$MLX_CHAT_PORT" \
      --prompt-cache-bytes "$MLX_PROMPT_CACHE_BYTES" \
      >"$LOG_DIR/mlx-chat.log" 2>&1 &
    echo $! >"$RUN_DIR/mlx-chat.pid"
  fi
  if port_open "$MLX_EMBED_PORT"; then
    project_listener_open "$MLX_EMBED_PORT" \
      || { log "Port $MLX_EMBED_PORT is used by another program — cannot start MLX"; return 1; }
  else
    nohup "$MLX_VENV/bin/python" "$PROJECT_DIR/python/mlx-embed-server.py" \
      --model "$MLX_EMBED_MODEL" --host 127.0.0.1 --port "$MLX_EMBED_PORT" \
      >"$LOG_DIR/mlx-embed.log" 2>&1 &
    echo $! >"$RUN_DIR/mlx-embed.pid"
  fi
  wait_http "http://localhost:$MLX_CHAT_PORT/v1/models" 180 || { log "mlx_lm.server did not become ready"; return 1; }
  wait_http "http://localhost:$MLX_EMBED_PORT/v1/models" 180 || { log "MLX embedding server did not become ready"; return 1; }
}

stop_omlx() {
  stop_pidfile omlx "$OMLX_PORT" ignore-foreign
}

start_omlx() {
  if port_open "$OMLX_PORT"; then
    project_listener_open "$OMLX_PORT" \
      || { log "Port $OMLX_PORT is used by another program — cannot start oMLX"; return 1; }
  else
    nohup "$OMLX_VENV/bin/omlx" serve --host 127.0.0.1 --port "$OMLX_PORT" \
      --model-dir "$HF_CACHE" --paged-ssd-cache-max-size "${OMLX_CACHE_MAX_GB}GB" \
      >"$LOG_DIR/omlx.log" 2>&1 &
    echo $! >"$RUN_DIR/omlx.pid"
  fi
  wait_http "http://localhost:$OMLX_PORT/v1/models" 180 || { log "oMLX did not become ready"; return 1; }
}

start_stack() {
  case "$1" in
    mlx) start_mlx ;;
    omlx) start_omlx ;;
    *) start_ollama && ensure_ollama_ctx ;;
  esac
}

stop_stack() {
  case "$1" in
    mlx) stop_mlx ;;
    omlx) stop_omlx ;;
    *) stop_ollama ;;
  esac
}

# Load both models into memory so the first real request doesn't pay for it
warm_up() {
  local chat_url embed_url chat_model embed_model extra
  if [ "$1" = "mlx" ]; then
    chat_url="http://localhost:$MLX_CHAT_PORT"
    embed_url="http://localhost:$MLX_EMBED_PORT"
    chat_model="$MLX_CHAT_MODEL"
    embed_model="$MLX_EMBED_MODEL"
    extra='"chat_template_kwargs":{"enable_thinking":false}'
  elif [ "$1" = "omlx" ]; then
    chat_url="http://localhost:$OMLX_PORT"
    embed_url="$chat_url"
    chat_model="mlx-community--Qwen3.8-27B-4bit"
    embed_model="mlx-community--Qwen3-Embedding-0.6B-8bit"
    extra='"chat_template_kwargs":{"enable_thinking":false}'
  else
    chat_url="http://localhost:$OLLAMA_PORT"
    embed_url="$chat_url"
    chat_model="$OLLAMA_CHAT_MODEL"
    embed_model="$OLLAMA_EMBED_MODEL"
    extra='"reasoning_effort":"none"'
  fi

  log "Warming up $1..."
  curl -sf -m 600 "$chat_url/v1/chat/completions" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$chat_model\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with OK\"}],\"max_tokens\":5,$extra}" \
    >/dev/null || { log "Chat warm-up failed"; return 1; }
  curl -sf -m 120 "$embed_url/v1/embeddings" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$embed_model\",\"input\":\"warm-up\"}" \
    >/dev/null || { log "Embedding warm-up failed"; return 1; }
}

ensure_index() {
  local rc=0
  (cd "$PROJECT_DIR" && LLM_PROVIDER="$1" npx tsx scripts/reindex-stack.ts --check) || rc=$?
  case "$rc" in
    0)
      log "Indexes for $1 are ready"
      ;;
    2)
      log "Building indexes for $1 (re-embeds the whole knowledge base, see $LOG_DIR/reindex-$1.log)..."
      local reindex_rc=0
      (cd "$PROJECT_DIR" && LLM_PROVIDER="$1" npx tsx scripts/reindex-stack.ts) >"$LOG_DIR/reindex-$1.log" 2>&1 \
        || reindex_rc=$?
      case "$reindex_rc" in
        0) ;;
        3) log "Indexes for $1 built with skipped raw documents — see $LOG_DIR/reindex-$1.log" ;;
        *) log "Reindex failed"; tail -n 15 "$LOG_DIR/reindex-$1.log"; return 1 ;;
      esac
      tail -n 1 "$LOG_DIR/reindex-$1.log"
      ;;
    *)
      log "Index check failed (exit $rc)"
      return 1
      ;;
  esac
}

# --- PharmaLLM app --------------------------------------------------------------

stop_app() {
  local pid
  stop_pidfile_process "$RUN_DIR/app.pid"
  # Also stop an app started another way (npm run dev, manual tsx); tsx watch would respawn its child.
  # Other projects run the same command, so only this project's copy is stopped.
  for pid in $(pgrep -f "tsx watch src/server.ts" 2>/dev/null || true); do
    if is_project_pid "$pid"; then kill -TERM "$pid" 2>/dev/null || true; fi
  done
  if ! stop_port "$APP_PORT" 20 || ! stop_port "$APP_HTTPS_PORT" 20; then
    log "App ports are still in use"
    return 1
  fi
}

# API token for agents and other machines (readable only by you)
ensure_token() {
  if [ -s "$TOKEN_FILE" ]; then
    log "API token already exists at $TOKEN_FILE"
  else
    (umask 077 && openssl rand -hex 32 >"$TOKEN_FILE")
    log "Created API token at $TOKEN_FILE"
  fi
  chmod 600 "$TOKEN_FILE"
  log "Restart the app to enforce it: scripts/switch-stack.sh $(active_stack)"
  log "Use it in a shell with: export PHARMALLM_API_TOKEN=\"\$(cat $TOKEN_FILE)\""
}

api_token() {
  if [ -s "$TOKEN_FILE" ]; then
    cat "$TOKEN_FILE"
  fi
}

# Token agents send to pharmallm-mcp (readable only by you); run-mcp.sh passes it to the service
ensure_mcp_token() {
  if [ -s "$MCP_TOKEN_FILE" ]; then
    log "MCP token already exists at $MCP_TOKEN_FILE"
  else
    (umask 077 && openssl rand -hex 32 >"$MCP_TOKEN_FILE")
    log "Created MCP token at $MCP_TOKEN_FILE"
  fi
  chmod 600 "$MCP_TOKEN_FILE"
}

# pharmallm-mcp runs under launchd (installed by scripts/hermes-setup.sh install-services); stack switches leave it running
mcp_service() {
  local domain
  domain="gui/$(id -u)"
  case "${1:-}" in
    start)
      [ -f "$MCP_PLIST" ] || { log "No $MCP_PLIST — run: scripts/hermes-setup.sh install-services"; exit 1; }
      launchctl bootstrap "$domain" "$MCP_PLIST" 2>/dev/null || launchctl kickstart -k "$domain/$MCP_LABEL"
      wait_http "http://127.0.0.1:$MCP_PORT/healthz" 30 \
        || { log "pharmallm-mcp did not answer on :$MCP_PORT (see $LOG_DIR/mcp.log)"; exit 1; }
      log "pharmallm-mcp is up on :$MCP_PORT"
      ;;
    stop)
      launchctl bootout "$domain/$MCP_LABEL" 2>/dev/null || true
      log "pharmallm-mcp stopped"
      ;;
    status)
      if launchctl print "$domain/$MCP_LABEL" >/dev/null 2>&1; then log "  mcp service loaded"; else log "  mcp service not loaded"; fi
      if curl -sf -m 3 "http://127.0.0.1:$MCP_PORT/healthz"; then echo; else log "  mcp (:$MCP_PORT) down"; fi
      ;;
    *)
      log "Usage: scripts/switch-stack.sh mcp start|stop|status"
      exit 1
      ;;
  esac
}

start_app() {
  cd "$PROJECT_DIR"
  LLM_PROVIDER="$1" CHROMADB_URL="$CHROMA_URL" PHARMALLM_API_TOKEN="$(api_token)" \
    nohup npx tsx src/server.ts >"$LOG_DIR/app.log" 2>&1 &
  echo $! >"$RUN_DIR/app.pid"

  local waited=0 status=""
  while [ "$waited" -lt 180 ]; do
    status="$(curl -sf -m 5 "http://localhost:$APP_PORT/api/health" 2>/dev/null \
      | python3 -c 'import sys, json; print(json.load(sys.stdin)["status"])' 2>/dev/null || true)"
    case "$status" in
      healthy) log "PharmaLLM is up on the $1 stack"; return 0 ;;
      degraded) log "PharmaLLM is up on the $1 stack (degraded: a supporting service is down)"; return 0 ;;
    esac
    sleep 2
    waited=$((waited + 2))
  done
  log "PharmaLLM did not become healthy (last status: ${status:-no response})"
  return 1
}

show_logs() {
  local file
  for file in "$LOG_DIR/mlx-chat.log" "$LOG_DIR/mlx-embed.log" "$LOG_DIR/app.log"; do
    [ -f "$file" ] || continue
    log "--- last lines of $(basename "$file") ---"
    tail -n 15 "$file"
  done
}

# Stop every stack except the target: with three stacks "the other one" is no longer a single value
stop_other_stacks() {
  local target="$1" other rc=0
  for other in ollama mlx omlx; do
    [ "$other" = "$target" ] && continue
    case "$other" in
      ollama) stop_ollama || rc=$? ;;
      mlx) stop_mlx || rc=$? ;;
      omlx) stop_omlx || rc=$? ;;
    esac
  done
  return "$rc"
}

# --- Commands ---------------------------------------------------------------------

switch_to() {
  local target="$1" previous
  previous="$(active_stack)"
  validate_stack "$target"
  models_ready "$target" || { log "Models for $target are missing. Run: scripts/switch-stack.sh prepare"; exit 1; }
  ensure_chromadb

  log "Switching: $previous -> $target"
  stop_app
  stop_other_stacks "$target"

  if start_stack "$target" && warm_up "$target" && ensure_index "$target" && start_app "$target"; then
    echo "$target" >"$RUN_DIR/active-stack"
    log "Active stack: $target"
    return 0
  fi

  show_logs
  if [ "$previous" != "$target" ]; then
    log "Rolling back to $previous..."
    stop_app || true
    if ! stop_stack "$target"; then
      log "Could not stop $target; not starting $previous to avoid running both stacks"
      exit 1
    fi
    if start_stack "$previous" && warm_up "$previous" && start_app "$previous"; then
      log "Rolled back to $previous"
    else
      log "Rollback to $previous failed too; see $LOG_DIR"
    fi
  fi
  exit 1
}

ensure_stack() {
  local target="$1"
  validate_stack "$target"
  models_ready "$target" || { log "Models for $target are missing. Run: scripts/switch-stack.sh prepare"; exit 1; }
  stop_other_stacks "$target"
  if ! { start_stack "$target" && warm_up "$target" && ensure_index "$target"; }; then
    show_logs
    exit 1
  fi
  echo "$target" >"$RUN_DIR/active-stack"
}

prepare() {
  local previous
  previous="$(active_stack)"
  log "Preparing both stacks (about 33 GB of downloads on the first run)"
  stop_app

  # Ollama models: pulling needs the Ollama service, so MLX must be down first
  stop_mlx
  start_ollama
  ollama pull "$OLLAMA_BASE_MODEL"
  ollama pull "$OLLAMA_EMBED_MODEL"
  ollama create "$OLLAMA_CHAT_MODEL" -f "$OLLAMA_MODELFILE"

  # MLX models: files only, no server is started here
  [ -x "$MLX_VENV/bin/python" ] || "$MLX_PYTHON" -m venv "$MLX_VENV"
  "$MLX_VENV/bin/pip" install -q -r "$PROJECT_DIR/python/mlx-requirements.txt"
  "$MLX_VENV/bin/python" -c "from huggingface_hub import snapshot_download as d; d('$MLX_CHAT_MODEL'); d('$MLX_EMBED_MODEL')"

  # oMLX venv: pinned, models come from the same Hugging Face cache
  if [ ! -x "$OMLX_VENV/bin/omlx" ]; then
    log "Installing oMLX $OMLX_VERSION into $OMLX_VENV"
    rm -rf "$PROJECT_DIR/python/omlx-src"
    git clone "$OMLX_REPO" "$PROJECT_DIR/python/omlx-src"
    (cd "$PROJECT_DIR/python/omlx-src" && git checkout -q "$OMLX_VERSION")
    "$MLX_PYTHON" -m venv "$OMLX_VENV"
    "$OMLX_VENV/bin/pip" install -q -e "$PROJECT_DIR/python/omlx-src"
  fi

  log "Models ready. Restoring the $previous stack..."
  switch_to "$previous"
}

status() {
  log "Active stack: $(active_stack)"
  local entry name port stack
  for entry in "app:$APP_PORT" "ollama:$OLLAMA_PORT" "mlx-chat:$MLX_CHAT_PORT" "mlx-embed:$MLX_EMBED_PORT" "omlx:$OMLX_PORT" "chromadb:$CHROMA_PORT"; do
    name="${entry%%:*}"
    port="${entry#*:}"
    if port_open "$port"; then log "  $name (:$port) up"; else log "  $name (:$port) down"; fi
  done
  [ -d "$HOME/.omlx" ] && log "  omlx SSD cache: $(du -sh "$HOME/.omlx" 2>/dev/null | cut -f1)"
  local parallel
  parallel="$(launchctl getenv OLLAMA_NUM_PARALLEL 2>/dev/null || true)"
  log "  OLLAMA_NUM_PARALLEL: ${parallel:-not set in launchd (keep it at 1: each parallel slot allocates its own 64k context)}"
  if port_open "$OLLAMA_PORT"; then ollama ps || true; fi
  if curl -sf "${CHROMA_URL}/api/v2/heartbeat" >/dev/null 2>&1; then
    for stack in ollama mlx; do
      (cd "$PROJECT_DIR" && LLM_PROVIDER="$stack" npx tsx scripts/reindex-stack.ts --status) || true
    done
  fi
}

case "${1:-}" in
  ollama|mlx|omlx) switch_to "$1" ;;
  ensure-stack) ensure_stack "${2:-}" ;;
  prepare) prepare ;;
  status) status ;;
  token) ensure_token ;;
  ollama-ctx) ensure_ollama_ctx ;;
  mcp-token) ensure_mcp_token ;;
  mcp) mcp_service "${2:-}" ;;
  *) sed -n '2,11p' "$0"; exit 1 ;;
esac
