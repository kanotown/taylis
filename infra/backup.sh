#!/usr/bin/env bash
# Daily backup (ARCHITECTURE.md §8): PostgreSQL dump first, then the object store directory
# (incremental: unchanged files are hard links into the previous backup and keep its SHA-256).
# Usage: infra/backup.sh [backup-root]   (default: infra/backups/<UTC timestamp>)
#        infra/backup.sh --objects-step DATA BACKUP [PREV]   (only the object step, on this machine)
# Cron example: 30 3 * * * /srv/chikuwachat/infra/backup.sh /srv/backups >> /var/log/chikuwachat-backup.log 2>&1
# BACKUP_VERIFY=1 hashes every object again (weekly, say) and fails on a linked file that changed.
# Off the server: infra/offsite-backup.sh (restic) copies the newest backup elsewhere (infra/README.md).
set -euo pipefail

# The object store's step (docs/DRIVE.md §16.2, M164). Plain POSIX sh: it runs in the objectstore
# container (BusyBox) as  sh -c "$OBJECTS_STEP" sh DATA BACKUP [PREV], and on Linux and macOS
# through --objects-step (the tests). It is kept in this file because the deploy key's command
# (deploy-ssh.sh) installs only the infra files it lists: a separate script would not reach the
# servers. It copies DATA into BACKUP/objects against the previous complete backup PREV and writes
# BACKUP/objects.sha256 (what restore.sh checks) and BACKUP/objects.list (what the next run
# compares with).
#
# A file is unchanged when its size, modification time (seconds) and inode in DATA are the ones
# PREV/objects.list recorded (versitygw writes a new object to a temporary file and renames it, so
# a replaced object has a new inode even within the same second). An unchanged file becomes a hard
# link to PREV's copy and keeps PREV's SHA-256 line: a night with nothing new reads no object, it
# lists them (one find, stat in batches) and links them (one cp -al). New and changed files are
# copied (cp -p) and hashed. Without PREV/objects.list (a backup made before M164) the list is
# made from PREV/objects without inodes: that one night compares size and time only. PREV and
# BACKUP must be on one file system (hard links); paths must not contain newlines.
IFS= read -r -d '' OBJECTS_STEP <<'STEP' || true
set -eu
DATA="$(cd "${1:?data directory}" && pwd)"
mkdir -p "${2:?backup directory}"
BACKUP="$(cd "$2" && pwd)"
PREV=""
if [ -n "${3:-}" ]; then PREV="$(cd "$3" && pwd)"; fi
OUT="$BACKUP/objects"
WORK="$BACKUP/.objects-work"
LC_ALL=C
export LC_ALL

if stat -c %s / >/dev/null 2>&1; then
  STAT_FORMAT="-c"
  STAT_FIELDS="%s %Y %i %n"
else  # BSD (macOS)
  STAT_FORMAT="-f"
  STAT_FIELDS="%z %m %i %N"
fi
# "size mtime inode ./path" of the files under directory $1, sorted by path.
list_files() {
  ( cd "$1" && find . -type f -print0 > "$WORK/names0" &&
    if [ -s "$WORK/names0" ]; then xargs -0 stat "$STAT_FORMAT" "$STAT_FIELDS" < "$WORK/names0"; fi
  ) | sort -k4
}
# "sha256  ./path" of the paths (one a line, relative to directory $1) in file $2.
hash_files() {
  [ -s "$2" ] || return 0
  tr '\n' '\0' < "$2" > "$WORK/hash0"
  if command -v sha256sum >/dev/null 2>&1; then
    ( cd "$1" && xargs -0 sha256sum < "$WORK/hash0" )
  else
    ( cd "$1" && xargs -0 shasum -a 256 < "$WORK/hash0" )
  fi
}

mkdir -p "$OUT" "$WORK"
[ -z "$(ls -A "$OUT")" ] || { echo "objects: $OUT is not empty" >&2; exit 1; }
if [ -n "$PREV" ] && { [ ! -d "$PREV/objects" ] || [ ! -f "$PREV/objects.sha256" ]; }; then
  echo "objects: $PREV is not a complete backup: copying everything" >&2
  PREV=""
fi

# 1. What DATA has now.
list_files "$DATA" > "$WORK/now.list"
( cd "$DATA" && find . -type d ) | sort > "$WORK/now.dirs"

# 2. Unchanged since PREV (to link, SHA-256 reused) or new / changed (to copy).
: > "$WORK/link"
: > "$WORK/reused.sha256"
: > "$WORK/copy"
if [ -n "$PREV" ]; then
  if [ -f "$PREV/objects.list" ]; then
    cp "$PREV/objects.list" "$WORK/prev.list"
  else
    list_files "$PREV/objects" | awk '{ $3 = "-"; print }' > "$WORK/prev.list"
  fi
  awk -v link="$WORK/link" -v reused="$WORK/reused.sha256" -v copy="$WORK/copy" '
    function path_of(line,   rest) {  # the path after "size mtime inode "
      rest = line
      sub(/^[^ ]+ +[^ ]+ +[^ ]+ +/, "", rest)
      return rest
    }
    FILENAME == ARGV[1] { was[path_of($0)] = $1 " " $2 " " $3; next }
    FILENAME == ARGV[2] { sha[substr($0, 67)] = $0; next }
    {
      p = path_of($0)
      if ((p in was) && (p in sha)) {
        split(was[p], w, " ")
        if (w[1] == $1 && w[2] == $2 && (w[3] == "-" || w[3] == $3)) {
          print p > link
          print sha[p] > reused
          next
        }
      }
      print p > copy
    }' "$WORK/prev.list" "$PREV/objects.sha256" "$WORK/now.list"
fi

# 3. Links: the whole previous tree in one cp -al, then away with what is not unchanged. A file
#    missing from PREV after all (a damaged backup) is copied instead.
if [ -s "$WORK/link" ]; then
  cp -al "$PREV/objects/." "$OUT/"
  sort "$WORK/link" > "$WORK/link.sorted"
  ( cd "$OUT" && find . -type f ) | sort > "$WORK/out.files"
  comm -23 "$WORK/out.files" "$WORK/link.sorted" | tr '\n' '\0' > "$WORK/drop0"
  if [ -s "$WORK/drop0" ]; then ( cd "$OUT" && xargs -0 rm -f < "$WORK/drop0" ); fi
  comm -13 "$WORK/out.files" "$WORK/link.sorted" > "$WORK/missing"
  if [ -s "$WORK/missing" ]; then
    echo "objects: $(wc -l < "$WORK/missing" | tr -d ' ') file(s) missing from $PREV: copied" >&2
    cat "$WORK/missing" >> "$WORK/copy"
    awk 'FILENAME == ARGV[1] { gone[$0] = 1; next } !(substr($0, 67) in gone)' \
      "$WORK/missing" "$WORK/reused.sha256" > "$WORK/reused.kept"
    mv "$WORK/reused.kept" "$WORK/reused.sha256"
    awk 'FILENAME == ARGV[1] { gone[$0] = 1; next } !($0 in gone)' \
      "$WORK/missing" "$WORK/link" > "$WORK/link.kept"
    mv "$WORK/link.kept" "$WORK/link"
  fi
fi

# 4. Folders as DATA has them (empty ones too), none that DATA no longer has.
tr '\n' '\0' < "$WORK/now.dirs" | ( cd "$OUT" && xargs -0 mkdir -p )
( cd "$OUT" && find . -type d ) | sort > "$WORK/out.dirs"
comm -23 "$WORK/out.dirs" "$WORK/now.dirs" | sort -r | while IFS= read -r d; do
  rmdir "$OUT/$d" 2>/dev/null || true
done

# 5. Copies of the new and changed files (one cp -pR for a first backup). A file the object
#    store removed since step 1 is left out; any other failure stops the backup.
: > "$WORK/copied"
if [ -z "$PREV" ]; then
  cp -pR "$DATA/." "$OUT/"
  ( cd "$OUT" && find . -type f ) | sort > "$WORK/copied"
else
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if cp -p "$DATA/$f" "$OUT/$f"; then
      echo "$f" >> "$WORK/copied"
    elif [ -e "$DATA/$f" ]; then
      echo "objects: cannot copy $f" >&2
      exit 1
    fi
  done < "$WORK/copy"
fi

# 6. Checksums: reused for the links, computed for the copies (BACKUP_VERIFY=1: for all).
if [ "${BACKUP_VERIFY:-0}" = "1" ]; then
  ( cd "$OUT" && find . -type f ) > "$WORK/all"
  hash_files "$OUT" "$WORK/all" | sort > "$WORK/all.sha256"
  sort "$WORK/reused.sha256" > "$WORK/reused.sorted"
  comm -23 "$WORK/reused.sorted" "$WORK/all.sha256" > "$WORK/bad"
  if [ -s "$WORK/bad" ]; then
    echo "objects: $(wc -l < "$WORK/bad" | tr -d ' ') linked file(s) differ from their recorded SHA-256:" >&2
    head -n 20 "$WORK/bad" >&2
    exit 1
  fi
  mv "$WORK/all.sha256" "$BACKUP/objects.sha256"
else
  hash_files "$OUT" "$WORK/copied" > "$WORK/copied.sha256"
  sort -k2 "$WORK/reused.sha256" "$WORK/copied.sha256" > "$BACKUP/objects.sha256"
fi
mv "$WORK/now.list" "$BACKUP/objects.list"
linked="$(wc -l < "$WORK/link" | tr -d ' ')"
copied="$(wc -l < "$WORK/copied" | tr -d ' ')"
total="$(wc -l < "$BACKUP/objects.sha256" | tr -d ' ')"
rm -rf "$WORK"
echo "objects: $total file(s), $linked linked to the previous backup, $copied copied"
STEP

if [ "${1:-}" = "--objects-step" ]; then
  shift
  exec sh -c "$OBJECTS_STEP" sh "$@"
fi

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

# 1. PostgreSQL: custom format (compressed, restorable table by table with pg_restore). counts.txt is what a
#    restore elsewhere is compared with (infra/README.md 「サーバの外へのバックアップ」); it is read just after
#    the dump, so it can differ from it by what was written in between.
DBUSER="${POSTGRES_USER:-chikuwa}"; DBNAME="${POSTGRES_DB:-chikuwa}"
"${COMPOSE[@]}" exec -T db pg_dump -U "$DBUSER" -Fc "$DBNAME" > "$DEST/db.dump"
COUNT_SQL="SELECT 'users', count(*) FROM users UNION ALL SELECT 'messages', count(*) FROM messages
  UNION ALL SELECT 'attachments', count(*) FROM attachments UNION ALL SELECT 'drive_items', count(*) FROM drive_items
  UNION ALL SELECT 'drive_files', count(*) FROM drive_items WHERE kind = 'file'
  UNION ALL SELECT 'drive_bytes', coalesce(sum(used_bytes), 0) FROM drive_locations"
"${COMPOSE[@]}" exec -T db psql -U "$DBUSER" -d "$DBNAME" -tA -F ' ' -c "$COUNT_SQL" > "$DEST/counts.txt" 2>/dev/null ||
  echo "counts unavailable" > "$DEST/counts.txt"

# 2. Object store: the posix backend keeps objects as plain files under /data. Each backup holds
#    them as a directory; a file unchanged since the previous backup is a hard link to its copy
#    there (its SHA-256 taken from there too), so 14 daily backups of 100 GB take about 100 GB plus
#    each day's new files and a night without changes only lists and links them (the step above).
# The newest COMPLETE backup (it has SHA256SUMS): a half-written or half-removed one is no base to link to.
PREV="$(ls -1 "$ROOT"/*/SHA256SUMS 2>/dev/null | sort | tail -n 1 || true)"
PREV_STAMP=""
[ -n "$PREV" ] && PREV_STAMP="$(basename "$(dirname "$PREV")")"
"${COMPOSE[@]}" run --rm --no-deps -T -v "$ROOT:/backups" -e "BACKUP_VERIFY=${BACKUP_VERIFY:-0}" \
  --entrypoint sh objectstore -c "$OBJECTS_STEP" sh /data "/backups/$STAMP" ${PREV_STAMP:+"/backups/$PREV_STAMP"} </dev/null

# 3. Manifest (sizes + checksums). Secrets (.env, infra/secrets) are backed up by another route
#    (offsite-backup.sh can take them, encrypted, when OFFSITE_INCLUDE_SECRETS=1).
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
( cd "$DEST" && sha db.dump objects.sha256 > SHA256SUMS && ls -l )
echo "[$(date -u +%FT%TZ)] done"
COMPLETE=1

# Keep the newest 14 backups (portable: no GNU head -n -N). A removal that fails is reported, not fatal:
# the backup above is complete either way, and a deploy must not stop on housekeeping.
ls -1d "$ROOT"/*/ 2>/dev/null | sort -r | tail -n +15 | while read -r old; do
  remove_backup "$(basename "$old")" || echo "[$(date -u +%FT%TZ)] could not remove old backup $old" >&2
done
