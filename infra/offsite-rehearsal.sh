#!/usr/bin/env bash
# Restore rehearsal from the off-server repository (docs/DRIVE.md §16.2, M164), on ANOTHER machine than the
# server: restore a restic snapshot, put it into a throw-away compose project (no host ports), compare the counts
# with the ones the backup recorded, check every attachment's bytes and the drive's counters, tear it down.
# Usage: infra/offsite-rehearsal.sh [SNAPSHOT]   (default latest)
#   needs infra/offsite.conf (or the same environment) and infra/.env (any passwords: the stack is thrown away);
#   REHEARSAL_DIR  where the snapshot is restored (default: a new directory under the system's temp directory;
#                  it needs the size of one backup, and the project's volume needs as much again)
#   REHEARSAL_PROJECT  the compose project (default taylis-offsite-rehearsal); KEEP=1 leaves it running
# Nextcloud is switched off only after this has succeeded once from the repository (infra/README.md).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SNAPSHOT="${1:-latest}"
PROJECT="${REHEARSAL_PROJECT:-taylis-offsite-rehearsal}"
WORK="${REHEARSAL_DIR:-$(mktemp -d)}"
COMPOSE=(docker compose -f "$HERE/docker-compose.yml" -f "$HERE/docker-compose.prod.yml" -p "$PROJECT")
# shellcheck disable=SC1091
set -a; . "$HERE/.env"; set +a
DBUSER="${POSTGRES_USER:-chikuwa}"; DBNAME="${POSTGRES_DB:-chikuwa}"
log() { echo "[$(date -u +%FT%TZ)] $*"; }

cleanup() {
  if [ "${KEEP:-0}" != "1" ]; then
    "${COMPOSE[@]}" down -v --remove-orphans --rmi local >/dev/null 2>&1 || true
    rm -rf "$WORK/restore"
  fi
}
trap cleanup EXIT

started=$(date +%s)
"$HERE/offsite-backup.sh" restore "$SNAPSHOT" "$WORK/restore"
restored=$(date +%s)
BACKUP="$WORK/restore/backup"
CHIKUWA_PROD=1 "$HERE/restore.sh" "$BACKUP" "$PROJECT"
loaded=$(date +%s)

COUNT_SQL="SELECT 'users', count(*) FROM users UNION ALL SELECT 'messages', count(*) FROM messages
  UNION ALL SELECT 'attachments', count(*) FROM attachments UNION ALL SELECT 'drive_items', count(*) FROM drive_items
  UNION ALL SELECT 'drive_files', count(*) FROM drive_items WHERE kind = 'file'
  UNION ALL SELECT 'drive_bytes', coalesce(sum(used_bytes), 0) FROM drive_locations"
ACTUAL="$("${COMPOSE[@]}" exec -T db psql -U "$DBUSER" -d "$DBNAME" -tA -F ' ' -c "$COUNT_SQL")"
echo "recorded by the backup:"; sed 's/^/  /' "$BACKUP/counts.txt"
echo "restored:";               printf '%s\n' "$ACTUAL" | sed 's/^/  /'
"${COMPOSE[@]}" exec -T app python -m app.cli drive-usage --verify
objects="$(wc -l < "$BACKUP/objects.sha256" | tr -d ' ')"
bytes="$(du -sk "$BACKUP/objects" | cut -f1)"
log "restic restore $((restored - started)) s, restore.sh $((loaded - restored)) s, $objects objects, ${bytes} KiB"
if [ "$(cat "$BACKUP/counts.txt")" != "$ACTUAL" ]; then
  echo "REHEARSAL: the counts differ (expected only for rows written between the dump and its counts)" >&2
  exit 1
fi
echo "REHEARSAL OK"
