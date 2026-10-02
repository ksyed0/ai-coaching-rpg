#!/usr/bin/env bash
# One-command local start.
#   ./run.sh         run the server in Docker on port 8080
#   ./run.sh --dev   run the server with tsx watch, no Docker (needs Node >= 22 and pnpm)
#   ./run.sh --help  show this help
set -euo pipefail
cd "$(dirname "$0")"

usage() {
  cat <<'USAGE'
usage: ./run.sh [--dev | --help]

  (no flag)  build and run the server in Docker (docker compose), port 8080
  --dev      run the server directly with tsx watch (needs Node >= 22 and pnpm)
  --help     show this help

Environment: HOST_PORT changes the host-side port for the Docker start (default 8080).
Settings come from .env (created from .env.example on first run).
USAGE
}

die() { echo "error: $*" >&2; exit 1; }

mode="docker"
case "${1:-}" in
  "") ;;
  --dev) mode="dev" ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; die "unknown argument: $1" ;;
esac
[ "$#" -le 1 ] || { usage >&2; die "too many arguments"; }

if [ ! -f .env ]; then
  cp .env.example .env
  echo "created .env from .env.example (MODEL_PROVIDER=mock)"
fi

if [ "$mode" = "dev" ]; then
  command -v node >/dev/null 2>&1 || die "node is not installed; install Node 22 or newer"
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$node_major" -ge 22 ] || die "Node 22 or newer is required (found $(node -v))"
  command -v pnpm >/dev/null 2>&1 || die "pnpm is not installed; run: npm install -g pnpm@9"
  pnpm install
  exec pnpm dev:runtime
fi

command -v docker >/dev/null 2>&1 || die "docker is not installed; install Docker, or use ./run.sh --dev"
docker compose version >/dev/null 2>&1 || die "'docker compose' is not available; install Docker Compose v2, or use ./run.sh --dev"
mkdir -p data
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
export HOST_UID HOST_GID
exec docker compose -f deploy/compose/docker-compose.yml up --build
