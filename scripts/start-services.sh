#!/usr/bin/env bash
# Start ChromaDB + PharmaLLM dev server
# Usage: ./scripts/start-services.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CHROMA_PORT="${CHROMADB_PORT:-8100}"
CHROMA_URL="http://localhost:${CHROMA_PORT}"
CHROMA_BIN="$PROJECT_DIR/python/venv/bin/chroma"
CHROMA_DATA="$PROJECT_DIR/.chromadb-data"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

cleanup() {
  echo ""
  echo -e "${YELLOW}Shutting down services...${NC}"
  # Kill all child processes
  kill 0 2>/dev/null
  exit 0
}
trap cleanup SIGINT SIGTERM

# --- ChromaDB ---

# Check if Python venv exists
if [ ! -f "$CHROMA_BIN" ]; then
  echo -e "${YELLOW}ChromaDB not installed. Setting up Python venv...${NC}"
  python3 -m venv "$PROJECT_DIR/python/venv"
  "$PROJECT_DIR/python/venv/bin/pip" install -q chromadb
fi

# Check if ChromaDB is already running
if curl -sf "${CHROMA_URL}/api/v2/heartbeat" > /dev/null 2>&1; then
  echo -e "${GREEN}ChromaDB already running on port ${CHROMA_PORT}${NC}"
else
  echo -e "${YELLOW}Starting ChromaDB on port ${CHROMA_PORT}...${NC}"
  mkdir -p "$CHROMA_DATA"
  "$CHROMA_BIN" run --port "$CHROMA_PORT" --path "$CHROMA_DATA" > /dev/null 2>&1 &
  CHROMA_PID=$!

  # Wait for ChromaDB to become healthy
  MAX_WAIT=30
  WAITED=0
  while ! curl -sf "${CHROMA_URL}/api/v2/heartbeat" > /dev/null 2>&1; do
    if [ $WAITED -ge $MAX_WAIT ]; then
      echo -e "${RED}ChromaDB failed to start within ${MAX_WAIT}s${NC}"
      kill $CHROMA_PID 2>/dev/null
      exit 1
    fi
    sleep 1
    WAITED=$((WAITED + 1))
  done
  echo -e "${GREEN}ChromaDB ready (pid ${CHROMA_PID})${NC}"
fi

# --- PharmaLLM ---

echo -e "${YELLOW}Starting PharmaLLM dev server...${NC}"
cd "$PROJECT_DIR"
export CHROMADB_URL="$CHROMA_URL"
npx tsx watch src/server.ts &

# Wait for all background processes
wait
