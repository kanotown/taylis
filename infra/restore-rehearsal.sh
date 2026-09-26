#!/usr/bin/env bash
# Restore rehearsal (IMPLEMENTATION_PLAN.md M10): take a backup of the running stack, restore it into a
# throw-away compose project (no host ports), compare row counts, verify attachments, tear it down.
# Usage: infra/restore-rehearsal.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
PROJECT="chikuwa-rehearsal"
COMPOSE=(docker compose -f "$HERE/docker-compose.yml" -f "$HERE/docker-compose.prod.yml" -p "$PROJECT")
# shellcheck disable=SC1091
set -a; . "$HERE/.env"; set +a
DBUSER="${POSTGRES_USER:-chikuwa}"; DBNAME="${POSTGRES_DB:-chikuwa}"
COUNT_SQL="SELECT (SELECT count(*) FROM users) || ' users, ' || (SELECT count(*) FROM messages) || ' messages, ' || (SELECT count(*) FROM attachments) || ' attachments'"

cleanup() { "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

"$HERE/backup.sh" "$WORK/backups"
BACKUP="$(ls -1d "$WORK"/backups/*/ | head -n 1)"
EXPECTED="$(docker compose -f "$HERE/docker-compose.yml" exec -T db psql -U "$DBUSER" -d "$DBNAME" -tA -c "$COUNT_SQL")"

CHIKUWA_PROD=1 "$HERE/restore.sh" "$BACKUP" "$PROJECT"
ACTUAL="$("${COMPOSE[@]}" exec -T db psql -U "$DBUSER" -d "$DBNAME" -tA -c "$COUNT_SQL")"
echo "source:   $EXPECTED"
echo "restored: $ACTUAL"
[ "$EXPECTED" = "$ACTUAL" ] || { echo "REHEARSAL FAILED: counts differ"; exit 1; }
echo "REHEARSAL OK"
