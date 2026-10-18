#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
command="${1:-start}"
if (( $# > 1 )) || [[ ! "$command" =~ ^(start|stop|restart|status|logs|update)$ ]]; then
  echo 'Usage: ./start.sh [start|stop|restart|status|logs|update]' >&2; exit 1
fi
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  echo 'Install Docker Engine/Desktop with Docker Compose, then run ./start.sh again.' >&2; exit 1
fi
if [[ ! -f .env ]]; then
  echo 'Missing root .env. Copy .env.example to .env and fill in your secrets and Discord IDs.' >&2; exit 1
fi
DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then
  if ! command -v sudo >/dev/null; then echo 'Docker is unavailable. Start Docker and check your permissions.' >&2; exit 1; fi
  DOCKER=(sudo docker)
  "${DOCKER[@]}" info >/dev/null
fi
COMPOSE=("${DOCKER[@]}" compose --ansi never --progress plain)
"${COMPOSE[@]}" config --quiet
case "$command" in
  stop) "${COMPOSE[@]}" stop ;;
  status) "${COMPOSE[@]}" ps --all ;;
  logs) "${COMPOSE[@]}" logs --tail=100 --follow ;;
  *)
    trap 'echo "Startup failed. Check root .env, then run: ./start.sh status and ./start.sh logs" >&2' ERR
    if [[ "$command" == restart ]]; then "${COMPOSE[@]}" stop; fi
    "${COMPOSE[@]}" up --build --detach --wait --wait-timeout 300
    "${COMPOSE[@]}" ps --all
    "${COMPOSE[@]}" exec -T --interactive=false web node -e 'console.log("Dashboard: " + process.env.APP_BASE_URL)'
    ;;
esac
