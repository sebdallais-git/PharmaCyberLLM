#!/usr/bin/env bash
# (Re)create the local SearXNG container from config/searxng/settings.yml.
#
# The container used to carry its own copy of the settings in an anonymous
# volume, so nothing about it was reproducible. This keeps what it ran with
# (image, name, restart policy, :8888) and mounts the repo's settings read-only.
# Run it again after editing the settings.
#
# The secret key is created once in data/run/searxng-secret (mode 600) and
# reaches the container through the environment only: `-e SEARXNG_SECRET`
# names the variable, so its value never appears in docker's argv.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RUN_DIR="${PHARMALLM_RUN_DIR:-$PROJECT_DIR/data/run}"
SETTINGS="$PROJECT_DIR/config/searxng/settings.yml"
SECRET_FILE="$RUN_DIR/searxng-secret"
SEARXNG_PORT="${SEARXNG_PORT:-8888}"

[ -f "$SETTINGS" ] || { echo "setup-searxng: no settings at $SETTINGS" >&2; exit 1; }

mkdir -p "$RUN_DIR"
if [ ! -s "$SECRET_FILE" ]; then
  (umask 077 && od -An -tx1 -N32 /dev/urandom | tr -d ' \n' >"$SECRET_FILE")
fi
SEARXNG_SECRET="$(tr -d '[:space:]' <"$SECRET_FILE")"
export SEARXNG_SECRET

docker rm -f searxng >/dev/null 2>&1 || true
docker run -d \
  --name searxng \
  --restart unless-stopped \
  -p "$SEARXNG_PORT:8080" \
  -v "$SETTINGS:/etc/searxng/settings.yml:ro" \
  -e SEARXNG_SECRET \
  searxng/searxng >/dev/null

echo "setup-searxng: searxng recreated on :$SEARXNG_PORT with $SETTINGS"
