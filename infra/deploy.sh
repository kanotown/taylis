#!/usr/bin/env bash
# One release on the production server (infra/README.md 「自動デプロイ」), started by deploy-ssh.sh:
#   1. log in to the registry with the workflow's short-lived token (stdin), pull the app + caddy images
#   2. back up PostgreSQL and the object store (the app applies migrations when it starts)
#   3. start the new images and wait for /readyz ("status": "ok": database reachable, schema at head)
#   4. if it does not become ready, start the previous release's images again and fail
# Usage: deploy.sh <tag>        stdin: registry user, then token (one per line)
# The registry and the backup directory come from deploy.conf, which only the administrator writes.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TAG="${1:?usage: deploy.sh <tag>}"
cd "$HERE"

log() { echo "[$(date -u +%FT%TZ)] $*"; }
die() { log "$*" >&2; exit 1; }

[ -f .env ] || die "infra/.env is missing: create it once by hand (infra/README.md)"
[ -f deploy.conf ] || die "infra/deploy.conf is missing: create it once by hand (deploy.conf.example)"
# shellcheck disable=SC1091
. ./deploy.conf
: "${REGISTRY:?set REGISTRY in infra/deploy.conf, e.g. ghcr.io/<owner>}"
BACKUP_ROOT="${BACKUP_ROOT:-$HERE/backups}"

# Optional secret files (the AI keys, docs/AI.md): compose bind-mounts each one, and a missing file would
# make Docker create an empty root-owned directory in its place, which then stands in the way of the key.
# An empty file means "not configured" to the app; the administrator writes the key into it later.
# Mode 644: the app in the container runs as uid 10001 and must read it; secrets/ itself is 700 (deploy only),
# so nobody else on the host can reach the file.
for optional in anthropic_api_key openai_api_key; do
  if [ ! -e "secrets/$optional" ]; then
    install -m 644 /dev/null "secrets/$optional"
  elif [ -f "secrets/$optional" ] && [ ! -L "secrets/$optional" ]; then
    chmod 644 "secrets/$optional" 2>/dev/null || log "cannot make secrets/$optional readable (mode 644): fix it by hand"
  else
    log "secrets/$optional is not a regular file (a directory left by Docker?): remove it and write the key into a file"
  fi
done

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.release.yml)
# Files for this server only, e.g. docker-compose.behind-proxy.yml when nginx already owns ports 80 and 443.
for extra in ${EXTRA_COMPOSE_FILES:-}; do
  [ -f "$extra" ] || die "EXTRA_COMPOSE_FILES in deploy.conf names $extra, which is not in infra/"
  COMPOSE+=(-f "$extra")
done
COMPOSE+=(--profile proxy)
use_release() {
  export CHIKUWA_SERVER_IMAGE="$REGISTRY/chikuwachat-server:$1"
  export CHIKUWA_WEB_IMAGE="$REGISTRY/chikuwachat-web:$1"
}

ready() {
  local _
  for _ in $(seq 1 90); do
    if "${COMPOSE[@]}" exec -T app python -c \
      'import json, sys, urllib.request; sys.exit(0 if json.load(urllib.request.urlopen("http://127.0.0.1:8000/readyz", timeout=3)).get("status") == "ok" else 1)' \
      >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# Only the images of the current and the previous release stay on disk.
prune() {
  local keep=("$TAG" "${1:-}") repo tag
  for repo in "$REGISTRY/chikuwachat-server" "$REGISTRY/chikuwachat-web"; do
    docker images "$repo" --format '{{.Tag}}' | while read -r tag; do
      [[ " ${keep[*]} " == *" $tag "* ]] || docker rmi "$repo:$tag" >/dev/null 2>&1 || true
    done
  done
}

previous="$(cat .release 2>/dev/null || true)"

# The token is only valid while the workflow runs; it never stays in ~/.docker/config.json.
read -r registry_user
read -r registry_token
printf '%s' "$registry_token" | docker login "${REGISTRY%%/*}" -u "$registry_user" --password-stdin >/dev/null
unset registry_token
trap 'docker logout "${REGISTRY%%/*}" >/dev/null 2>&1 || true' EXIT

use_release "$TAG"
log "pull $TAG"
"${COMPOSE[@]}" pull app caddy

if [ -n "$("${COMPOSE[@]}" ps -q db 2>/dev/null)" ]; then
  log "backup before $TAG (migrations run when the app starts)"
  CHIKUWA_PROD=1 ./backup.sh "$BACKUP_ROOT"
else
  log "first start: no database to back up yet"
fi

log "start $TAG (previous: ${previous:-none})"
"${COMPOSE[@]}" up -d --remove-orphans

if ready && [ -n "$("${COMPOSE[@]}" ps -q --status running caddy)" ]; then
  if [ -n "$previous" ] && [ "$previous" != "$TAG" ]; then printf '%s\n' "$previous" > .release.previous; fi
  printf '%s\n' "$TAG" > .release
  prune "$(cat .release.previous 2>/dev/null || true)"
  log "released $TAG"
  exit 0
fi

log "$TAG did not become ready; last app log lines:"
"${COMPOSE[@]}" logs --no-color --tail 60 app >&2 || true
if [ -n "$previous" ] && [ "$previous" != "$TAG" ]; then
  log "rolling back to $previous. A migration $TAG applied stays in the database: if $previous cannot run on it,"
  log "restore the backup taken above (CHIKUWA_PROD=1 infra/restore.sh $BACKUP_ROOT/<time>)"
  use_release "$previous"
  "${COMPOSE[@]}" up -d app caddy
  if ready; then log "$previous is serving again"; else log "$previous did not become ready either"; fi
fi
exit 1
