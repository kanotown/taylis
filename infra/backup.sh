#!/usr/bin/env bash
# Daily backup (ARCHITECTURE.md §8): PostgreSQL dump first, then the object store directory
# (incremental: unchanged files are hard links into the previous backup).
# Usage: infra/backup.sh [backup-root]   (default: infra/backups/<UTC timestamp>)
# Cron example: 30 3 * * * /srv/chikuwachat/infra/backup.sh /srv/backups >> /var/log/chikuwachat-backup.log 2>&1
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${1:-$HERE/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
COMPOSE=(docker compose -f "$HERE/docker-compose.yml")
[ -f "$HERE/docker-compose.prod.yml" ] && [ "${CHIKUWA_PROD:-0}" = "1" ] && COMPOSE+=(-f "$HERE/docker-compose.prod.yml")
# shellcheck disable=SC1091
set -a; . "$HERE/.env"; set +a

mkdir -p "$ROOT"
# One backup at a time (the nightly cron and a deploy can overlap): a second run waits for the first.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$ROOT/.backup.lock"
  flock -w 1800 9 || { echo "[$(date -u +%FT%TZ)] another backup is still running" >&2; exit 1; }
fi
# This run's own directory, created exclusively: an existing one (same second, clock set back) is never
# reused, so the clean-up below can only ever remove what this run started.
DEST="$ROOT/$STAMP"
n=1
until mkdir "$DEST" 2>/dev/null; do
  n=$((n + 1))
  [ "$n" -le 50 ] || { echo "[$(date -u +%FT%TZ)] cannot create a new backup directory under $ROOT" >&2; exit 1; }
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$n"
  DEST="$ROOT/$STAMP"
done
# The objects of a backup are written by the object store's container as root, so only a container can
# remove them (the deploy user cannot): every removal of a backup directory goes through this.
remove_backup() {
  "${COMPOSE[@]}" run --rm --no-deps -T -v "$ROOT:/backups" --entrypoint rm objectstore -rf "/backups/$1" </dev/null
}
# A failed run leaves nothing behind: a partial directory would count as one of the 14 kept below.
# Once the backup is complete (COMPLETE=1) nothing that follows may remove it.
COMPLETE=0
discard_partial() {
  local status=$?
  [ "$status" -eq 0 ] || [ "$COMPLETE" = "1" ] && return 0
  [ -f "$DEST/SHA256SUMS" ] && return 0  # complete after all: keep it
  remove_backup "$STAMP" || rm -rf "$DEST" || true
  echo "[$(date -u +%FT%TZ)] backup failed, nothing kept" >&2
}
trap discard_partial EXIT
echo "[$(date -u +%FT%TZ)] backup -> $DEST"

# 1. PostgreSQL: custom format (compressed, restorable table by table with pg_restore).
"${COMPOSE[@]}" exec -T db pg_dump -U "${POSTGRES_USER:-chikuwa}" -Fc "${POSTGRES_DB:-chikuwa}" > "$DEST/db.dump"

# 2. Object store: the posix backend keeps objects as plain files under /data. Each backup holds
#    them as a directory; a file unchanged since the previous backup is a hard link to its copy
#    there, so 14 daily backups of 7 GB of attachments take about 7 GB plus each day's new files.
#    objects.sha256 lists every file (restore.sh checks it). Needs $ROOT on one filesystem.
# The newest COMPLETE backup (it has SHA256SUMS): a half-written or half-removed one is no base to link to.
PREV="$(ls -1 "$ROOT"/*/SHA256SUMS 2>/dev/null | sort | tail -n 1 || true)"
[ -n "$PREV" ] && PREV="$(dirname "$PREV")/objects"
PREV_STAMP=""
[ -n "$PREV" ] && PREV_STAMP="$(basename "$(dirname "$PREV")")"
"${COMPOSE[@]}" run --rm --no-deps -T -v "$ROOT:/backups" -e "STAMP=$STAMP" -e "PREV_STAMP=$PREV_STAMP" \
  --entrypoint sh objectstore -c '
set -eu
out="/backups/$STAMP/objects"
prev="/backups/$PREV_STAMP/objects"
mkdir -p "$out"
cd /data
find . -type d | while IFS= read -r d; do mkdir -p "$out/$d"; done
find . -type f | while IFS= read -r f; do
  if [ -n "$PREV_STAMP" ] && [ -f "$prev/$f" ] &&
     [ "$(stat -c %s:%Y "$f")" = "$(stat -c %s:%Y "$prev/$f")" ]; then
    ln "$prev/$f" "$out/$f" && echo linked
  else
    cp -p "$f" "$out/$f" && echo copied
  fi
done | sort | uniq -c
cd "$out" && find . -type f -exec sha256sum {} + > "/backups/$STAMP/objects.sha256"'

# 3. Manifest (sizes + checksums). Secrets (.env, infra/secrets) are backed up by another route.
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
( cd "$DEST" && sha db.dump objects.sha256 > SHA256SUMS && ls -l )
echo "[$(date -u +%FT%TZ)] done"
COMPLETE=1

# Keep the newest 14 backups (portable: no GNU head -n -N). A removal that fails is reported, not fatal:
# the backup above is complete either way, and a deploy must not stop on housekeeping.
ls -1d "$ROOT"/*/ 2>/dev/null | sort -r | tail -n +15 | while read -r old; do
  remove_backup "$(basename "$old")" || echo "[$(date -u +%FT%TZ)] could not remove old backup $old" >&2
done
