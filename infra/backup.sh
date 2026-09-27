#!/usr/bin/env bash
# Daily backup (ARCHITECTURE.md §8): PostgreSQL dump first, then the object store directory.
# Usage: infra/backup.sh [backup-root]   (default: infra/backups/<UTC timestamp>)
# Cron example: 30 3 * * * /srv/chikuwachat/infra/backup.sh /srv/backups >> /var/log/chikuwachat-backup.log 2>&1
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${1:-$HERE/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$ROOT/$STAMP"
COMPOSE=(docker compose -f "$HERE/docker-compose.yml")
[ -f "$HERE/docker-compose.prod.yml" ] && [ "${CHIKUWA_PROD:-0}" = "1" ] && COMPOSE+=(-f "$HERE/docker-compose.prod.yml")
# shellcheck disable=SC1091
set -a; . "$HERE/.env"; set +a

mkdir -p "$DEST"
# A failed run leaves nothing behind: a partial directory would count as one of the 14 kept below.
discard_partial() {
  local status=$?
  [ "$status" -eq 0 ] || { rm -rf "$DEST"; echo "[$(date -u +%FT%TZ)] backup failed, nothing kept" >&2; }
}
trap discard_partial EXIT
echo "[$(date -u +%FT%TZ)] backup -> $DEST"

# 1. PostgreSQL: custom format (compressed, restorable table by table with pg_restore).
"${COMPOSE[@]}" exec -T db pg_dump -U "${POSTGRES_USER:-chikuwa}" -Fc "${POSTGRES_DB:-chikuwa}" > "$DEST/db.dump"

# 2. Object store: the posix backend keeps objects as plain files under /data; tar the volume.
"${COMPOSE[@]}" run --rm --no-deps -T -v "$DEST:/backup" --entrypoint sh objectstore \
  -c 'cd /data && tar czf /backup/objects.tgz .'

# 3. Manifest (sizes + checksums). Secrets (.env, infra/secrets) are backed up by another route.
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
( cd "$DEST" && sha db.dump objects.tgz > SHA256SUMS && ls -l )
echo "[$(date -u +%FT%TZ)] done"

# Keep the newest 14 backups (portable: no GNU head -n -N).
ls -1d "$ROOT"/*/ 2>/dev/null | sort -r | tail -n +15 | while read -r old; do rm -rf "$old"; done
