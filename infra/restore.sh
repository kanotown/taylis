#!/usr/bin/env bash
# Restore a backup made by backup.sh into the compose stack (ARCHITECTURE.md §8):
#   DB restore -> bucket restore -> app start -> verify-attachments.
# Usage: infra/restore.sh <backup dir> [compose project name]
# DANGER: replaces the database and the object store of the target project.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:?backup directory}"
PROJECT="${2:-}"
COMPOSE=(docker compose -f "$HERE/docker-compose.yml")
[ -n "$PROJECT" ] && COMPOSE+=(-p "$PROJECT")
[ "${CHIKUWA_PROD:-0}" = "1" ] && COMPOSE+=(-f "$HERE/docker-compose.prod.yml")
# shellcheck disable=SC1091
set -a; . "$HERE/.env"; set +a
DBUSER="${POSTGRES_USER:-chikuwa}"; DBNAME="${POSTGRES_DB:-chikuwa}"

shacheck() { if command -v sha256sum >/dev/null 2>&1; then sha256sum -c "$@"; else shasum -a 256 -c "$@"; fi; }
( cd "$SRC" && shacheck SHA256SUMS )

echo "== stopping app, starting db + objectstore"
"${COMPOSE[@]}" stop app 2>/dev/null || true
"${COMPOSE[@]}" up -d db objectstore
for _ in $(seq 1 30); do
  "${COMPOSE[@]}" exec -T db pg_isready -U "$DBUSER" -d postgres >/dev/null 2>&1 && break
  sleep 2
done

echo "== database"
"${COMPOSE[@]}" exec -T db psql -U "$DBUSER" -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DBNAME' AND pid <> pg_backend_pid();" \
  -c "DROP DATABASE IF EXISTS \"$DBNAME\";" -c "CREATE DATABASE \"$DBNAME\";" >/dev/null
"${COMPOSE[@]}" exec -T db pg_restore -U "$DBUSER" -d "$DBNAME" --no-owner --no-privileges < "$SRC/db.dump"

echo "== object store"
"${COMPOSE[@]}" run --rm --no-deps -T -v "$SRC:/backup:ro" --entrypoint sh objectstore \
  -c 'rm -rf /data/* && cd /data && tar xzf /backup/objects.tgz'

echo "== app"
"${COMPOSE[@]}" up -d --build app
for _ in $(seq 1 60); do
  "${COMPOSE[@]}" exec -T app python -c "import urllib.request,sys; r=urllib.request.urlopen('http://127.0.0.1:8000/readyz'); sys.exit(0 if b'\"status\":\"ok\"' in r.read() else 1)" >/dev/null 2>&1 && break
  sleep 2
done
"${COMPOSE[@]}" exec -T app python -m app.cli verify-attachments
echo "== restore complete"
