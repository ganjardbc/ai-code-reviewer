#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# deploy.sh — Docker Compose deployment for AI Code Reviewer
# Usage: ./deploy.sh [options]
# ──────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="${PROJECT_NAME:-ai-code-review}"
# Respect a caller-provided COMPOSE_FILE; otherwise the devbox overlay is
# added below only when its external network exists.
COMPOSE_FILE_FROM_ENV="${COMPOSE_FILE:-}"
ENV_FILE="${ENV_FILE:-.env}"
NETWORK_NAME="${NETWORK_NAME:-devbox_devnet}"

# ── Colors ────────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
  CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; CYAN=''; BOLD=''; NC=''
fi

ok()   { echo -e "${GREEN}✓${NC} $1"; }
info() { echo -e "${CYAN}→${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
err()  { echo -e "${RED}✗${NC} $1"; }

# ── Cleanup trap ──────────────────────────────────────────────────────────────
cleanup() {
  local rc=$?
  if [ $rc -ne 0 ] && [ $rc -ne 130 ]; then
    echo ""
    err "Deploy failed (exit code $rc). See above for details."
  fi
  exit $rc
}
trap cleanup EXIT

# ── Help ──────────────────────────────────────────────────────────────────────
usage() {
  cat <<EOF
${BOLD}Usage:${NC} $0 [options]

Deploy AI Code Reviewer with Docker Compose.

${BOLD}Options:${NC}
  -b, --build         Rebuild images (no cache) before deploying
  -f, --fast          Incremental rebuild + rolling restart (skip health wait)
  -c, --check         Only verify current deployment health, don't deploy
  -s, --service SRV   Deploy only specific services (comma-separated: api,worker)
                      Default: api,worker (redis skipped unless explicit)
  -e, --env-file PATH Path to .env file (default: .env)
  -n, --no-cache      Force --no-cache in docker build
  -h, --help          Show this help and exit

${BOLD}Examples:${NC}
  $0                    # Quick restart (no rebuild)
  $0 -b                 # Full rebuild + deploy
  $0 -f                 # Incremental build + fast restart
  $0 -c                 # Check health only
  $0 -s api             # Deploy api only
  $0 -s worker,redis    # Deploy worker + redis
EOF
  exit 0
}

# ── Parse args ────────────────────────────────────────────────────────────────
DO_BUILD=false
NO_CACHE=false
FAST=false
CHECK_ONLY=false
SERVICES="api worker"
CUSTOM_SERVICES=false
ENV_PATH="${SCRIPT_DIR}/${ENV_FILE}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)    usage ;;
    -b|--build)   DO_BUILD=true; NO_CACHE=true; shift ;;
    -f|--fast)    FAST=true; shift ;;
    -c|--check)   CHECK_ONLY=true; shift ;;
    -n|--no-cache) NO_CACHE=true; shift ;;
    -s|--service)
      shift
      if [ -z "${1:-}" ]; then err "--service requires a value"; exit 1; fi
      SERVICES="$1"
      CUSTOM_SERVICES=true
      shift
      ;;
    -e|--env-file)
      shift
      if [ -z "${1:-}" ]; then err "--env-file requires a path"; exit 1; fi
      ENV_PATH="$1"
      shift
      ;;
    *) err "Unknown option: $1"; echo "Try $0 --help"; exit 1 ;;
  esac
done

cd "$SCRIPT_DIR"

# ── Preflight checks ──────────────────────────────────────────────────────────
info "Preflight checks..."

if ! command -v docker &>/dev/null; then
  err "docker is not installed"; exit 1
fi
ok "docker found"

if ! docker compose version &>/dev/null; then
  err "docker compose plugin not found"; exit 1
fi
ok "docker compose found"

if [ "$CUSTOM_SERVICES" = false ]; then
  # Default: deploy api + worker, skip redis
  info "Default services: api, worker (redis left untouched)"
fi

if [ ! -f "$ENV_PATH" ]; then
  err ".env file not found at $ENV_PATH (copy .env.example to .env first)"
  exit 1
fi
ok ".env file: $ENV_PATH"

# Export env so docker compose picks it up (in addition to --env-file)
set -a
source "$ENV_PATH"
set +a

# Attach the devbox overlay only when its external network exists — compose
# refuses to start if a declared external network is missing.
if [ -n "$COMPOSE_FILE_FROM_ENV" ]; then
  export COMPOSE_FILE="$COMPOSE_FILE_FROM_ENV"
  ok "Using COMPOSE_FILE=$COMPOSE_FILE"
elif docker network inspect "$NETWORK_NAME" &>/dev/null; then
  export COMPOSE_FILE="docker-compose.yml:docker-compose.devbox.yml"
  ok "External network '$NETWORK_NAME' exists — attaching api/worker to it"
else
  export COMPOSE_FILE="docker-compose.yml"
  warn "External network '$NETWORK_NAME' not found — deploying on the default compose network only."
  warn "For Nginx Proxy Manager integration: docker network create $NETWORK_NAME, then redeploy."
fi

# ── Check-only mode ──────────────────────────────────────────────────────────
if [ "$CHECK_ONLY" = true ]; then
  echo ""
  info "=== Health Check ==="
  docker compose --env-file "$ENV_PATH" ps
  echo ""
  # Try API health endpoint
  local_health="http://localhost:${PORT:-3000}/health"
  if curl -sf "$local_health" >/dev/null 2>&1; then
    health=$(curl -sf "$local_health")
    ok "API health endpoint: $health"
  else
    warn "API health endpoint not reachable (expected if containers aren't running)"
  fi
  exit 0
fi

# ── Build ─────────────────────────────────────────────────────────────────────
BUILD_ARGS=()
if [ "$DO_BUILD" = true ]; then
  info "Building images (no cache)..."
  docker compose build --no-cache 2>&1 | sed 's/^/  /'
  ok "Build complete"
elif [ "$FAST" = true ]; then
  info "Building images (incremental)..."
  docker compose build 2>&1 | sed 's/^/  /'
  ok "Build complete"
fi

# ── Deploy ────────────────────────────────────────────────────────────────────
echo ""
info "Deploying services: ${CYAN}${SERVICES}${NC}"

DEPLOY_ARGS=(-d)
if [ "$CUSTOM_SERVICES" = false ]; then
  # Default deploy for api+worker: --no-deps avoids restarting redis unnecessarily
  DEPLOY_ARGS=(-d --no-deps)
fi
# In fast mode, also skip healthcheck wait
if [ "$FAST" = true ]; then
  DEPLOY_ARGS+=("--wait" "--wait-timeout" "30" "--remove-orphans")
else
  DEPLOY_ARGS+=("--remove-orphans")
fi

# shellcheck disable=SC2086
if ! docker compose --env-file "$ENV_PATH" up ${DEPLOY_ARGS[*]} $SERVICES 2>&1; then
  err "docker compose up failed"
  exit 1
fi
ok "Containers recreated"

# ── Health verification ───────────────────────────────────────────────────────
if [ "$FAST" = true ]; then
  # fast mode uses `--wait` flag — docker compose handles healthcheck natively
  info "Fast mode — up (docker compose --wait handled health checks)"
elif [ "$CUSTOM_SERVICES" = true ] || [ "$SERVICES" = "redis" ]; then
  info "Custom service selection — no health polling (verify with './deploy.sh -c')"
else
  echo ""
  info "Waiting for containers to become healthy (timeout: 60s)..."

  ALL_SERVICES="$SERVICES"
  TIMEOUT=60
  INTERVAL=5
  ELAPSED=0

  while [ $ELAPSED -lt $TIMEOUT ]; do
    ALL_HEALTHY=true
    for svc in $ALL_SERVICES; do
      # Skip services that don't have a healthcheck defined
      if ! docker compose --env-file "$ENV_PATH" config --services 2>/dev/null | grep -qxF "$svc"; then
        continue
      fi
      if [ "$svc" = "redis" ]; then continue; fi
      state=$(docker compose --env-file "$ENV_PATH" ps --status healthy --format '{{.Name}}' "$svc" 2>/dev/null | head -1)
      if [ -z "$state" ]; then
        ALL_HEALTHY=false
        break
      fi
    done
    if [ "$ALL_HEALTHY" = true ]; then
      ok "All requested services are healthy"
      break
    fi
    sleep "$INTERVAL"
    ELAPSED=$((ELAPSED + INTERVAL))
  done

  if [ $ELAPSED -ge $TIMEOUT ]; then
    # Check what statuses we actually got
    echo ""
    docker compose --env-file "$ENV_PATH" ps 2>&1 | sed 's/^/  /'
    echo ""
    warn "Health wait timed out — some services may not have healthchecks"
  fi
fi

# ── Summary ────────────────────────────────────────────────────────────────────
echo ""
info "=== Deployment Summary ==="
docker compose --env-file "$ENV_PATH" ps

# Attempt health check if API is running
if [[ ",$SERVICES," =~ ",api," ]] || [ "$CUSTOM_SERVICES" = false ]; then
  # Check health only if the container exists and is running
  api_state=$(docker compose --env-file "$ENV_PATH" ps --status running --format '{{.Name}}' api 2>/dev/null | head -1)
  if [ -n "$api_state" ]; then
    echo ""
    local_health="http://localhost:${PORT:-3000}/health"
    if curl -sf "$local_health" >/dev/null 2>&1; then
      health=$(curl -sf "$local_health")
      ok "API health: $health"
    else
      warn "API health endpoint not reachable yet — may still be starting"
    fi
  fi
fi

echo ""
ok "Deploy complete!"
