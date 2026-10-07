#!/usr/bin/env bash
# The only commands the release workflow's SSH key may run on the production server (infra/README.md
# 「自動デプロイ」). It lives outside infra/ and belongs to root, so no release can change it:
#   sudo install -m 755 infra/deploy-ssh.sh /usr/local/bin/chikuwa-deploy
#   ~deploy/.ssh/authorized_keys:  command="/usr/local/bin/chikuwa-deploy",restrict ssh-ed25519 AAAA… chikuwa-deploy
# Commands:
#   upload <tag>   stdin: tar.gz of the release's infra files; they replace those in infra/ (a copy stays in
#                  infra/releases/<tag>/). deploy.conf, .env and secrets/ are never touched.
#   deploy <tag>   stdin: registry user and token (one per line); runs infra/deploy.sh <tag>
set -euo pipefail

INFRA="${CHIKUWA_INFRA:-/srv/chikuwachat/infra}"
TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
FILES=(docker-compose.yml docker-compose.prod.yml docker-compose.release.yml docker-compose.behind-proxy.yml Caddyfile
       backup.sh restore.sh deploy.sh)
# In-app calls (docs/CALLS.md §8.6, M131): taken when the archive has them. Releases before M131 do not, and servers
# with an older copy of this script ignore them, so the workflow and the servers need not change at the same time.
OPTIONAL_FILES=(docker-compose.livekit.yml livekit.yaml)

read -r -a argv <<< "${SSH_ORIGINAL_COMMAND:-}"
if [ "${#argv[@]}" -ne 2 ] || ! [[ "${argv[1]}" =~ $TAG_RE ]]; then
  echo "allowed: upload <tag> | deploy <tag>   (tag like v1.2.3)" >&2
  exit 2
fi
tag="${argv[1]}"

case "${argv[0]}" in
  upload)
    stage="$(mktemp -d)"
    trap 'rm -rf "$stage"' EXIT
    archive="$stage/release.tar.gz"
    cat > "$archive"
    # Only these member names are extracted: nothing else in the archive can land anywhere.
    names=("${FILES[@]}")
    listed="$(tar -tzf "$archive")"
    for name in "${OPTIONAL_FILES[@]}"; do
      if grep -qxF "$name" <<< "$listed"; then names+=("$name"); fi
    done
    tar -xzf "$archive" -C "$stage" --no-same-owner --no-same-permissions "${names[@]}"
    mkdir -p "$INFRA/releases/$tag"
    for name in "${names[@]}"; do
      mode=644
      [[ "$name" == *.sh ]] && mode=755
      install -m "$mode" "$stage/$name" "$INFRA/releases/$tag/$name"
      install -m "$mode" "$stage/$name" "$INFRA/$name"
    done
    echo "uploaded $tag"
    ;;
  deploy)
    exec "$INFRA/deploy.sh" "$tag"
    ;;
  *)
    echo "allowed: upload <tag> | deploy <tag>" >&2
    exit 2
    ;;
esac
