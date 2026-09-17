#!/usr/bin/env bash
# Set up Hermes Agent for PharmaLLM: config, secrets, launchd services and scheduled jobs.
# Usage:
#   scripts/hermes-setup.sh check             read-only status (prints variable names, never values)
#   scripts/hermes-setup.sh install-config    copy config.yaml and SOUL.md into ~/.hermes and fill ~/.hermes/.env
#   scripts/hermes-setup.sh install-services  install the pharmallm-mcp launch agent and the Hermes gateway service
#   scripts/hermes-setup.sh install-cron      create or update the scheduled jobs from hermes/cron/jobs.json
#   scripts/hermes-setup.sh all               install-config, install-services, install-cron
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEMPLATE_DIR="$PROJECT_DIR/hermes"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
ENV_FILE="$HERMES_HOME/.env"
RUN_DIR="${PHARMALLM_RUN_DIR:-$PROJECT_DIR/data/run}"
LAUNCH_AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
HERMES_BIN="${HERMES_BIN:-hermes}"
LAUNCHCTL_BIN="${LAUNCHCTL_BIN:-launchctl}"
MCP_HEALTH_URL="${MCP_HEALTH_URL:-http://127.0.0.1:3200/healthz}"
MCP_LABEL="com.pharmallm.mcp"
ENV_KEYS=(PHARMALLM_URL PHARMALLM_MCP_URL SEARXNG_URL PHARMALLM_API_TOKEN PHARMALLM_MCP_TOKEN
  TELEGRAM_BOT_TOKEN TELEGRAM_ALLOWED_USERS TELEGRAM_HOME_CHANNEL)

log() {
  printf '[hermes-setup] %s\n' "$*"
}

require_hermes() {
  command -v "$HERMES_BIN" >/dev/null 2>&1 || { log "hermes is not installed — see hermes/README.md"; exit 1; }
}

# Prints one .env value (for internal use only; callers never echo it)
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  python3 - "$ENV_FILE" "$1" <<'PY'
import sys
path, key = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as handle:
    for line in handle:
        name, sep, value = line.rstrip("\n").partition("=")
        if sep and name.strip() == key:
            print(value.strip().strip('"').strip("'"))
            break
PY
}

# Writes KEY=value into .env (mode 600); the value travels through the environment, not argv
env_set() {
  ENV_VALUE="$2" python3 - "$ENV_FILE" "$1" <<'PY'
import os, sys
path, key = sys.argv[1], sys.argv[2]
value = os.environ["ENV_VALUE"]
lines = []
if os.path.exists(path):
    with open(path, encoding="utf-8") as handle:
        lines = handle.read().splitlines()
out, written = [], False
for line in lines:
    name, sep, _ = line.partition("=")
    if sep and name.strip() == key:
        if not written:
            out.append(f"{key}={value}")
            written = True
        continue
    out.append(line)
if not written:
    out.append(f"{key}={value}")
# Write a private temp file next to .env and rename it over: an interruption never truncates the secrets
directory = os.path.dirname(path) or "."
tmp_path = os.path.join(directory, f".env.tmp-{os.getpid()}")
fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write("\n".join(out) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp_path, path)
except BaseException:
    if os.path.exists(tmp_path):
        os.unlink(tmp_path)
    raise
os.chmod(path, 0o600)
PY
}

# Value precedence: token file, current environment, existing .env, default, hidden prompt on a terminal
fill_env() {
  local key="$1" default="$2" file="${3:-}" value=""
  if [ -n "$file" ] && [ -s "$file" ]; then
    value="$(tr -d '[:space:]' <"$file")"
  elif [ -n "${!key:-}" ]; then
    value="${!key}"
  else
    value="$(env_get "$key")"
  fi
  if [ -z "$value" ] && [ -n "$default" ]; then value="$default"; fi
  if [ -z "$value" ] && [ -t 0 ]; then
    read -rs -p "$key: " value
    echo >&2
  fi
  if [ -z "$value" ]; then
    local hint=""
    case "$key" in
      PHARMALLM_API_TOKEN) hint=" — generate it with: scripts/switch-stack.sh token" ;;
      PHARMALLM_MCP_TOKEN) hint=" — generate it with: scripts/switch-stack.sh mcp-token" ;;
    esac
    log "Missing $key: add it to $ENV_FILE (chmod 600) and re-run, see hermes/README.md$hint"
    return 1
  fi
  env_set "$key" "$value"
  log "  $key set"
}

install_file() {
  local src="$1" dest="$2"
  if [ -f "$dest" ] && ! cmp -s "$src" "$dest"; then
    cp -p "$dest" "$dest.bak-$(date +%Y%m%d%H%M%S)"
    log "Backed up the previous $(basename "$dest")"
  fi
  cp "$src" "$dest"
}

install_config() {
  mkdir -p "$HERMES_HOME"
  (umask 077 && touch "$ENV_FILE")
  chmod 600 "$ENV_FILE"
  install_file "$TEMPLATE_DIR/config.template.yaml" "$HERMES_HOME/config.yaml"
  install_file "$TEMPLATE_DIR/SOUL.md" "$HERMES_HOME/SOUL.md"
  fill_env PHARMALLM_URL "http://localhost:3000"
  fill_env PHARMALLM_MCP_URL "http://127.0.0.1:3200/mcp"
  fill_env SEARXNG_URL "http://localhost:8888"
  fill_env PHARMALLM_API_TOKEN "" "$RUN_DIR/api-token"
  fill_env PHARMALLM_MCP_TOKEN "" "$RUN_DIR/mcp-token"
  fill_env TELEGRAM_BOT_TOKEN ""
  fill_env TELEGRAM_ALLOWED_USERS ""
  # A single chat id, not the whole allow-list: scheduled jobs are delivered to one channel
  fill_env TELEGRAM_HOME_CHANNEL "$(env_get TELEGRAM_ALLOWED_USERS | cut -d, -f1 | tr -d '[:space:]')"
  log "Config installed in $HERMES_HOME"
}

install_services() {
  require_hermes
  [ -s "$RUN_DIR/mcp-token" ] || { log "No MCP token — run: scripts/switch-stack.sh mcp-token"; exit 1; }
  local node_bin plist domain
  node_bin="${NODE_BIN:-$(command -v node || true)}"
  [ -n "$node_bin" ] || { log "node not found on PATH (set NODE_BIN)"; exit 1; }
  mkdir -p "$LAUNCH_AGENTS_DIR" "$PROJECT_DIR/data/logs"
  plist="$LAUNCH_AGENTS_DIR/$MCP_LABEL.plist"
  sed -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" \
      -e "s|__NODE_BIN__|$node_bin|g" \
      -e "s|__PATH__|$(dirname "$node_bin"):/usr/bin:/bin:/usr/sbin:/sbin|g" \
      "$TEMPLATE_DIR/com.pharmallm.mcp.plist.template" >"$plist"
  domain="gui/$(id -u)"
  "$LAUNCHCTL_BIN" bootout "$domain/$MCP_LABEL" >/dev/null 2>&1 || true
  # launchd can still be tearing the old job down and answers "Input/output error"; give it a few tries
  local attempt
  for attempt in 1 2 3 4 5; do
    if "$LAUNCHCTL_BIN" bootstrap "$domain" "$plist"; then break; fi
    if [ "$attempt" -eq 5 ]; then log "launchctl bootstrap failed 5 times for $MCP_LABEL"; exit 1; fi
    sleep 1
  done
  log "Installed and started $MCP_LABEL"
  "$HERMES_BIN" gateway install --force --start-now --start-on-login
  log "Installed the Hermes gateway service"
}

install_cron() {
  require_hermes
  HERMES_BIN="$HERMES_BIN" python3 - "$TEMPLATE_DIR/cron/jobs.json" "$HERMES_HOME/cron/jobs.json" <<'PY'
import json, os, subprocess, sys

definitions_path, store_path = sys.argv[1], sys.argv[2]
hermes = os.environ["HERMES_BIN"]
with open(definitions_path, encoding="utf-8") as handle:
    definitions = json.load(handle)

# Hermes' own job store is read only to find existing job ids by name; all changes go through the CLI
existing = {}
if os.path.exists(store_path):
    with open(store_path, encoding="utf-8") as handle:
        data = json.load(handle)
    jobs = data.get("jobs", []) if isinstance(data, dict) else data
    if isinstance(jobs, dict):
        jobs = list(jobs.values())
    for job in jobs if isinstance(jobs, list) else []:
        if isinstance(job, dict) and job.get("name") and job.get("id"):
            existing[job["name"]] = job["id"]

for job in definitions:
    name, schedule, prompt, deliver = job["name"], job["schedule"], job["prompt"], job["deliver"]
    if name in existing:
        command = [hermes, "cron", "edit", existing[name], "--schedule", schedule, "--prompt", prompt, "--deliver", deliver]
        action = "Updated"
    else:
        command = [hermes, "cron", "create", schedule, prompt, "--name", name, "--deliver", deliver]
        action = "Created"
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
    print(f"[hermes-setup] {action} cron job {name}")
PY
}

check() {
  local problems=0 key perms
  if command -v "$HERMES_BIN" >/dev/null 2>&1; then
    log "hermes: installed"
  else
    log "hermes: not installed"
    problems=1
  fi
  for key in config.yaml SOUL.md .env; do
    if [ -f "$HERMES_HOME/$key" ]; then log "$key: present"; else log "$key: missing"; problems=1; fi
  done
  if [ -f "$ENV_FILE" ]; then
    perms="$(stat -f %Lp "$ENV_FILE")"
    log ".env permissions: $perms"
    [ "$perms" = "600" ] || problems=1
  fi
  for key in "${ENV_KEYS[@]}"; do
    if [ -n "$(env_get "$key")" ]; then log "  $key: set"; else log "  $key: missing"; problems=1; fi
  done
  # `hermes gateway install` loads its label in user/$UID while our agent lives in gui/$UID: probe both
  for key in "$MCP_LABEL" ai.hermes.gateway; do
    if "$LAUNCHCTL_BIN" print "gui/$(id -u)/$key" >/dev/null 2>&1 || "$LAUNCHCTL_BIN" print "user/$(id -u)/$key" >/dev/null 2>&1; then
      log "service $key: loaded"
    else
      log "service $key: not loaded"
      problems=1
    fi
  done
  if curl -sf -m 3 "$MCP_HEALTH_URL" >/dev/null 2>&1; then log "pharmallm-mcp: healthy"; else log "pharmallm-mcp: not answering"; problems=1; fi
  return "$problems"
}

case "${1:-}" in
  check) check ;;
  install-config) install_config ;;
  install-services) install_services ;;
  install-cron) install_cron ;;
  # Separate statements, not &&: set -e is ignored inside && lists, which would hide a failed install_config
  all)
    install_config
    install_services
    install_cron
    ;;
  *) sed -n '2,8p' "$0"; exit 1 ;;
esac
