#!/usr/bin/env bash
# The demo server (fictional data, app.cli seed-demo) as a second Taylis next to a production one on the same
# host, behind the host's nginx (infra/demo/DEPLOY_VPS.md). Its own compose project, volumes and localhost port,
# so it never touches the production containers or data.
#
# Usage (from anywhere; works on the infra/ next to this file):
#   demo-vps.sh up <tag>   start or upgrade to the release images <tag> (e.g. the production's infra/.release)
#   demo-vps.sh seed       write the demo lab once (prints the generated passwords, keeps them in secrets/)
#   demo-vps.sh reset      delete everything and seed again, then restart the app (for a nightly cron)
#   demo-vps.sh status | logs | down
# Settings: infra/.env (from infra/demo/demo.env.example). REGISTRY (default ghcr.io/kanotown) and
# DEMO_PROJECT (default taylis-demo) may be set in the environment.
set -euo pipefail

INFRA="$(cd "$(dirname "$0")/.." && pwd)"
cd "$INFRA"
PROJECT="${DEMO_PROJECT:-taylis-demo}"
REGISTRY="${REGISTRY:-ghcr.io/kanotown}"
PASSWORD_FILE=secrets/demo_review_password
ACCOUNTS_FILE=secrets/demo-accounts.txt

log() { echo "[$(date -u +%FT%TZ)] $*"; }
die() { log "$*" >&2; exit 1; }

[ -f .env ] || die "infra/.env is missing: cp demo/demo.env.example .env and fill it in (DEPLOY_VPS.md)"
grep -q '^WORKSPACE_NAME=Taylis デモ研究室$' .env \
  || die "infra/.env must say WORKSPACE_NAME=Taylis デモ研究室 (seed-demo --reset refuses any other workspace)"

COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.yml -f docker-compose.prod.yml
  -f docker-compose.release.yml -f docker-compose.behind-proxy.yml --profile proxy)

use_tag() {
  export CHIKUWA_SERVER_IMAGE="$REGISTRY/chikuwachat-server:$1"
  export CHIKUWA_WEB_IMAGE="$REGISTRY/chikuwachat-web:$1"
}

current_tag() {
  [ -f .release ] || die "no infra/.release yet: run demo-vps.sh up <tag> first"
  cat .release
}

# Bind-mounted files compose expects: missing ones would become empty root-owned directories. Empty files
# mean "not configured" (no push, no AI). The emoji preset folder stays empty: no preset art in the demo.
prepare() {
  install -d -m 700 secrets
  local name
  for name in apns_key.p8 fcm_service_account.json google_client_secret anthropic_api_key openai_api_key; do
    [ -e "secrets/$name" ] || install -m 644 /dev/null "secrets/$name"
  done
  [ -d emoji-presets ] || install -d -m 755 emoji-presets
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

# seed-demo inside the app container; the review password goes in on stdin (never on a command line).
seed() {
  [ -s "$PASSWORD_FILE" ] || die "$PASSWORD_FILE is missing or empty (DEPLOY_VPS.md)"
  local out status=0
  out="$("${COMPOSE[@]}" exec -T app python -m app.cli seed-demo "$@" --review-password-file /dev/stdin \
    < "$PASSWORD_FILE" 2>&1)" || status=$?
  if [ "$status" -ne 0 ]; then
    printf '%s\n' "$out" | tail -20 >&2
    die "seed-demo failed"
  fi
  # A new seed made new passwords for the fictional cast (tanaka is the administrator): keep the latest.
  if printf '%s\n' "$out" | grep -q '^passwords'; then
    (umask 077 && printf '%s\n' "$out" | grep -v '^{' > "$ACCOUNTS_FILE")
  fi
  printf '%s\n' "$out" | grep -E '^(seeded|the demo lab)' || true
}

command="${1:-}"
case "$command" in
  up)
    tag="${2:?usage: demo-vps.sh up <tag>}"
    prepare
    use_tag "$tag"
    "${COMPOSE[@]}" pull app caddy converter \
      || log "pull failed: using the images already on this host (docker login ghcr.io if they are missing)"
    "${COMPOSE[@]}" up -d --remove-orphans
    ready || die "the demo app did not become ready: demo-vps.sh logs"
    printf '%s\n' "$tag" > .release
    log "demo is running $tag"
    ;;
  seed)
    use_tag "$(current_tag)"
    seed
    log "accounts: $INFRA/$ACCOUNTS_FILE (review: the password in $PASSWORD_FILE)"
    ;;
  reset)
    use_tag "$(current_tag)"
    seed --reset
    # Sessions, WebSocket connections and in-memory state of the old data go away with the restart.
    "${COMPOSE[@]}" restart app
    ready || die "the demo app did not become ready after the reset"
    log "demo reset"
    ;;
  status)
    use_tag "$(current_tag)"
    "${COMPOSE[@]}" ps
    ;;
  logs)
    use_tag "$(current_tag)"
    "${COMPOSE[@]}" logs --tail 100 app
    ;;
  down)
    use_tag "$(current_tag)"
    "${COMPOSE[@]}" down
    ;;
  *)
    sed -n '2,12p' "$0" >&2
    exit 2
    ;;
esac
