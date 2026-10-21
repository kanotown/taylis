#!/usr/bin/env bash
# Off-server backups with restic (docs/DRIVE.md §16.2, M164; infra/README.md 「サーバの外へのバックアップ」).
# The newest complete backup that backup.sh made (db.dump, objects/, checksums, counts.txt) goes to a
# restic repository on another machine (SFTP over SSH) or on a mounted disk / NAS path: encrypted,
# deduplicated, incremental. restic runs in its official image (pinned), so the server needs nothing new.
#
# Usage: infra/offsite-backup.sh COMMAND
#   init                  create the repository (once)
#   backup [DIR]          back up DIR (default: the newest complete backup under OFFSITE_BACKUP_ROOT),
#                         then apply the retention (restic forget, without prune)
#   maintain              forget + prune, then restic check reading OFFSITE_CHECK_SUBSET of the data (weekly)
#   check [SUBSET]        restic check (SUBSET like 5% or 1/10 reads that part of the data; "all" reads all)
#   snapshots             list the snapshots
#   restore SNAPSHOT DIR  restore a snapshot ("latest" or an id) into DIR: DIR/backup is a backup directory
#                         for restore.sh, DIR/secrets the .env and secrets/ when they were included
#
# Settings: environment variables, or infra/offsite.conf (not in git; see offsite.conf.example):
#   RESTIC_REPOSITORY      sftp:USER@HOST:/path  or  /mnt/nas/taylis-restic (an absolute local path)
#   RESTIC_PASSWORD_FILE   the repository's password, a file on this machine (keep a copy OFF the server:
#                          without it the repository cannot be read). Never put it in the repository.
#   OFFSITE_BACKUP_ROOT    where backup.sh writes (default /srv/backups)
#   OFFSITE_SSH_KEY        SFTP: the private key (default /root/.ssh/taylis_offsite)
#   OFFSITE_SSH_KNOWN_HOSTS SFTP: a known_hosts with the target's key (default /root/.ssh/known_hosts)
#   OFFSITE_SSH_PORT       SFTP: the port (default 22)
#   OFFSITE_KEEP_DAILY / _WEEKLY / _MONTHLY   retention (default 14 / 8 / 12)
#   OFFSITE_INCLUDE_SECRETS 1: also infra/.env and infra/secrets/ (encrypted in the repository; default 0)
#   OFFSITE_CHECK_SUBSET   what maintain reads back (default 5%)
#   OFFSITE_HOST           the snapshots' host name (default taylis; keep it when the server moves)
#   OFFSITE_CACHE_VOLUME   the Docker volume of restic's cache (default taylis-restic-cache)
#   RESTIC_IMAGE           default restic/restic:0.17.3
# Cron example (root, after the nightly backup.sh at 03:30):
#   30 4 * * *  /srv/chikuwachat/infra/offsite-backup.sh backup   >> /var/log/chikuwachat-offsite.log 2>&1
#   30 5 * * 0  /srv/chikuwachat/infra/offsite-backup.sh maintain >> /var/log/chikuwachat-offsite.log 2>&1
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$HERE/offsite.conf" ]; then
  # shellcheck disable=SC1091
  set -a; . "$HERE/offsite.conf"; set +a
fi
: "${RESTIC_REPOSITORY:?set RESTIC_REPOSITORY (infra/offsite.conf)}"
: "${RESTIC_PASSWORD_FILE:?set RESTIC_PASSWORD_FILE (infra/offsite.conf)}"
BACKUP_ROOT="${OFFSITE_BACKUP_ROOT:-/srv/backups}"
IMAGE="${RESTIC_IMAGE:-restic/restic:0.17.3}"
HOST_TAG="${OFFSITE_HOST:-taylis}"
CACHE="${OFFSITE_CACHE_VOLUME:-taylis-restic-cache}"
log() { echo "[$(date -u +%FT%TZ)] $*"; }
[ -r "$RESTIC_PASSWORD_FILE" ] || { log "cannot read RESTIC_PASSWORD_FILE $RESTIC_PASSWORD_FILE" >&2; exit 1; }

# docker run arguments shared by every command: the password, the cache, the repository's way in.
RUN=(docker run --rm -i --hostname "$HOST_TAG"
     -v "$(cd "$(dirname "$RESTIC_PASSWORD_FILE")" && pwd)/$(basename "$RESTIC_PASSWORD_FILE"):/run/restic-password:ro"
     -e RESTIC_PASSWORD_FILE=/run/restic-password -e RESTIC_REPOSITORY="$RESTIC_REPOSITORY"
     -v "$CACHE:/root/.cache/restic")
REPO_OPTS=()
case "$RESTIC_REPOSITORY" in
  sftp:*)
    KEY="${OFFSITE_SSH_KEY:-/root/.ssh/taylis_offsite}"
    KNOWN="${OFFSITE_SSH_KNOWN_HOSTS:-/root/.ssh/known_hosts}"
    [ -r "$KEY" ] || { log "cannot read OFFSITE_SSH_KEY $KEY" >&2; exit 1; }
    [ -r "$KNOWN" ] || { log "cannot read OFFSITE_SSH_KNOWN_HOSTS $KNOWN" >&2; exit 1; }
    RUN+=(-v "$KEY:/run/ssh/key:ro" -v "$KNOWN:/run/ssh/known_hosts:ro")
    REPO_OPTS=(-o "sftp.args=-i /run/ssh/key -p ${OFFSITE_SSH_PORT:-22} -o UserKnownHostsFile=/run/ssh/known_hosts -o StrictHostKeyChecking=yes -o BatchMode=yes -o ServerAliveInterval=30")
    ;;
  /*)
    [ -d "$RESTIC_REPOSITORY" ] || mkdir -p "$RESTIC_REPOSITORY"
    RUN+=(-v "$RESTIC_REPOSITORY:$RESTIC_REPOSITORY")
    ;;
  *)
    log "RESTIC_REPOSITORY must be sftp:USER@HOST:/path or an absolute path (a mounted disk or NAS)" >&2
    exit 1
    ;;
esac
restic() { "${RUN[@]}" "$IMAGE" "${REPO_OPTS[@]+"${REPO_OPTS[@]}"}" "$@"; }

newest_backup() {
  local sums
  sums="$(ls -1 "$BACKUP_ROOT"/*/SHA256SUMS 2>/dev/null | sort | tail -n 1 || true)"
  [ -n "$sums" ] || { log "no complete backup under $BACKUP_ROOT (run backup.sh first)" >&2; exit 1; }
  dirname "$sums"
}

shacheck() { if command -v sha256sum >/dev/null 2>&1; then sha256sum -c --quiet "$@"; else shasum -a 256 -c -q "$@"; fi; }

retention() {
  restic forget --host "$HOST_TAG" --tag taylis --group-by host \
    --keep-daily "${OFFSITE_KEEP_DAILY:-14}" --keep-weekly "${OFFSITE_KEEP_WEEKLY:-8}" \
    --keep-monthly "${OFFSITE_KEEP_MONTHLY:-12}" "$@"
}

command="${1:-}"
shift || true
case "$command" in
  init)
    restic init
    ;;
  backup)
    SRC="${1:-$(newest_backup)}"
    SRC="$(cd "$SRC" && pwd)"
    ( cd "$SRC" && shacheck SHA256SUMS ) || { log "$SRC does not match its SHA256SUMS: not sent" >&2; exit 1; }
    log "off-server backup of $SRC -> $RESTIC_REPOSITORY"
    # Always the same paths (/backup, /secrets) and host, so restic finds the previous snapshot and reads
    # only what changed: an unchanged object is a hard link with a new ctime and the same size and mtime.
    MOUNTS=(-v "$SRC:/backup:ro")
    PATHS=(/backup)
    if [ "${OFFSITE_INCLUDE_SECRETS:-0}" = "1" ]; then
      [ -f "$HERE/.env" ] && MOUNTS+=(-v "$HERE/.env:/secrets/infra.env:ro") && PATHS+=(/secrets/infra.env)
      [ -d "$HERE/secrets" ] && MOUNTS+=(-v "$HERE/secrets:/secrets/secrets:ro") && PATHS+=(/secrets/secrets)
    fi
    RUN+=("${MOUNTS[@]}")
    restic backup --host "$HOST_TAG" --tag taylis --tag "backup-$(basename "$SRC")" \
      --ignore-ctime --ignore-inode --exclude /backup/.objects-work "${PATHS[@]}"
    retention
    log "off-server backup done"
    ;;
  maintain)
    retention --prune
    restic check --read-data-subset "${OFFSITE_CHECK_SUBSET:-5%}"
    ;;
  check)
    subset="${1:-}"
    if [ "$subset" = "all" ]; then restic check --read-data
    elif [ -n "$subset" ]; then restic check --read-data-subset "$subset"
    else restic check
    fi
    ;;
  snapshots)
    restic snapshots --host "$HOST_TAG"
    ;;
  restore)
    SNAPSHOT="${1:?snapshot (latest or an id)}"
    TARGET="${2:?target directory (new or empty)}"
    mkdir -p "$TARGET"
    TARGET="$(cd "$TARGET" && pwd)"
    [ -z "$(ls -A "$TARGET")" ] || { log "$TARGET is not empty" >&2; exit 1; }
    RUN+=(-v "$TARGET:/restore")
    restic restore "$SNAPSHOT" --host "$HOST_TAG" --target /restore
    ( cd "$TARGET/backup" && shacheck SHA256SUMS && cd objects && shacheck ../objects.sha256 )
    log "restored into $TARGET: every checksum matches"
    log "next: CHIKUWA_PROD=1 infra/restore.sh $TARGET/backup <compose project>  (or infra/offsite-rehearsal.sh)"
    [ -d "$TARGET/secrets" ] && log "the .env and secrets/ of the server are in $TARGET/secrets (mode them 600)"
    ;;
  *)
    sed -n '2,32p' "$0" >&2
    exit 2
    ;;
esac
