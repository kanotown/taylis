#!/usr/bin/env bash
# One-time setup of a fresh Debian (12 / 13) or Ubuntu VPS, e.g. Xserver VPS, for automatic deployment
# (infra/README.md 「自動デプロイ」). Run as root; it never overwrites an existing .env or deploy.conf.
#
#   scp infra/vps-bootstrap.sh infra/deploy-ssh.sh infra/.env.example infra/deploy.conf.example \
#       chikuwa-deploy.pub root@<VPS>:/tmp/
#   ssh root@<VPS>
#   bash /tmp/vps-bootstrap.sh --domain chat.example.com --workspace-name "チーム名" \
#       --registry ghcr.io/<owner> --deploy-key-file /tmp/chikuwa-deploy.pub [--behind-proxy]
#
# What it does: Docker Engine + compose plugin (unless already there), a swap file on small machines, the
# `deploy` user (docker group), /srv/chikuwachat/infra and /srv/backups, the forced command
# /usr/local/bin/chikuwa-deploy with the deploy key, infra/.env with fresh random secrets, infra/deploy.conf and
# the daily backup. The firewall is left to the provider's packet filter (Xserver VPS: SSH 22, Web 80 / 443,
# UDP 443), so a typo here cannot lock you out of SSH.
# --behind-proxy: the server already runs nginx on 80 / 443 (other sites); Caddy then listens on 127.0.0.1:18080
# only (docker-compose.behind-proxy.yml) and nginx is set up by hand (nginx-site.conf.example).
set -euo pipefail

DOMAIN="" WORKSPACE_NAME="" REGISTRY="" DEPLOY_KEY="" BEHIND_PROXY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --workspace-name) WORKSPACE_NAME="$2"; shift 2 ;;
    --registry) REGISTRY="$2"; shift 2 ;;
    --deploy-key) DEPLOY_KEY="$2"; shift 2 ;;
    --deploy-key-file) DEPLOY_KEY="$(head -n 1 "$2")"; shift 2 ;;
    --behind-proxy) BEHIND_PROXY=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$DOMAIN" ] && [ -n "$REGISTRY" ] && [ -n "$DEPLOY_KEY" ] \
  || { echo "usage: vps-bootstrap.sh --domain <host> --registry ghcr.io/<owner> --deploy-key-file <file.pub> [--workspace-name <name>] [--behind-proxy]" >&2; exit 2; }
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "not a host name: $DOMAIN" >&2; exit 2; }
# The name goes into .env in double quotes (backup.sh and restore.sh source that file with bash).
[[ "$WORKSPACE_NAME" != *[\"\\\$\`]* ]] || { echo "the workspace name cannot contain \" \\ \$ or a backquote" >&2; exit 2; }
[[ "$REGISTRY" =~ ^ghcr\.io/[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || { echo "registry must look like ghcr.io/<owner in lower case>" >&2; exit 2; }
[[ "$DEPLOY_KEY" =~ ^ssh-(ed25519|rsa)\ [A-Za-z0-9+/=]+(\ .*)?$ ]] || { echo "--deploy-key must be one public key line" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
command -v apt-get >/dev/null || { echo "this script expects Debian or Ubuntu" >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
for f in deploy-ssh.sh .env.example deploy.conf.example; do
  [ -f "$HERE/$f" ] || { echo "copy $f next to this script first" >&2; exit 1; }
done
APP=/srv/chikuwachat
INFRA=$APP/infra
BACKUPS=/srv/backups
step() { echo; echo "== $*"; }

step "packages (a minimal Debian image may lack cron or openssl)"
# Only what is missing: a server that already runs other services keeps its package versions.
export DEBIAN_FRONTEND=noninteractive
missing=()
for cmd in curl openssl cron; do command -v "$cmd" >/dev/null || missing+=("$cmd"); done
[ -f /etc/ssl/certs/ca-certificates.crt ] || missing+=(ca-certificates)
if [ ${#missing[@]} -gt 0 ]; then
  apt-get update -q
  apt-get install -y -q "${missing[@]}"
else
  echo "all present"
fi
systemctl enable --now cron >/dev/null

step "Docker Engine + compose plugin"
if ! docker compose version >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  # shellcheck disable=SC1091
  . /etc/os-release
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker >/dev/null
docker compose version

step "Swap (only on machines under 3.5 GB without any)"
mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
if [ "$mem_kb" -lt 3600000 ] && [ -z "$(swapon --show --noheadings)" ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "2 GB swap added"
else
  echo "not needed"
fi

step "deploy user and directories"
# No password: the account is reached only with the deploy key (and `su` / sudo from root).
id deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash deploy
usermod -aG docker deploy
install -d -o deploy -g deploy -m 755 "$APP" "$INFRA" "$INFRA/emoji-presets"
install -d -o deploy -g deploy -m 700 "$INFRA/secrets"
install -d -o deploy -g deploy -m 750 "$BACKUPS"

step "forced command and the deploy key"
install -m 755 "$HERE/deploy-ssh.sh" /usr/local/bin/chikuwa-deploy
install -d -o deploy -g deploy -m 700 /home/deploy/.ssh
line="command=\"/usr/local/bin/chikuwa-deploy\",restrict $DEPLOY_KEY"
touch /home/deploy/.ssh/authorized_keys
grep -qxF "$line" /home/deploy/.ssh/authorized_keys || echo "$line" >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys

step "infra/.env"
if [ -f "$INFRA/.env" ]; then
  echo "kept the existing infra/.env"
else
  secret() { openssl rand -hex 32; }
  install -o deploy -g deploy -m 600 "$HERE/.env.example" "$INFRA/.env"
  # The value is escaped for sed (& \ | would otherwise mean something to it).
  set_env() { sed -i "s|^$1=.*|$1=$(printf '%s' "$2" | sed -e 's/[\\&|]/\\&/g')|" "$INFRA/.env"; }
  set_env ENVIRONMENT production
  set_env SECRET_KEY "$(secret)"
  set_env POSTGRES_PASSWORD "$(secret)"
  set_env S3_SECRET_KEY "$(secret)"
  set_env CHAT_DOMAIN "$DOMAIN"
  set_env WORKSPACE_NAME "\"$WORKSPACE_NAME\""
  echo "written with fresh random secrets (they exist only on this server: keep a copy with your backups)"
fi

step "infra/deploy.conf"
if [ -f "$INFRA/deploy.conf" ]; then
  echo "kept the existing infra/deploy.conf"
else
  install -o deploy -g deploy -m 644 "$HERE/deploy.conf.example" "$INFRA/deploy.conf"
  sed -i -e "s|^REGISTRY=.*|REGISTRY=$REGISTRY|" -e "s|^BACKUP_ROOT=.*|BACKUP_ROOT=$BACKUPS|" "$INFRA/deploy.conf"
  if [ "$BEHIND_PROXY" = 1 ]; then
    sed -i "s|^# *EXTRA_COMPOSE_FILES=.*|EXTRA_COMPOSE_FILES=docker-compose.behind-proxy.yml|" "$INFRA/deploy.conf"
  fi
fi
grep -q '^EXTRA_COMPOSE_FILES=.*behind-proxy' "$INFRA/deploy.conf" && BEHIND_PROXY=1

step "daily backup at 03:30 (starts working after the first release put backup.sh in place)"
touch /var/log/chikuwachat-backup.log && chown deploy:deploy /var/log/chikuwachat-backup.log
cat > /etc/cron.d/chikuwachat-backup <<CRON
30 3 * * * deploy [ -x $INFRA/backup.sh ] && CHIKUWA_PROD=1 $INFRA/backup.sh $BACKUPS >> /var/log/chikuwachat-backup.log 2>&1
CRON
chmod 644 /etc/cron.d/chikuwachat-backup

address="$(hostname -I | awk '{print $1}')"
hostkey="$(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
if [ "$BEHIND_PROXY" = 1 ]; then
  web="nginx: the site from infra/nginx-site.conf.example for $DOMAIN (→ 127.0.0.1:18080), nginx -t, reload,
   then certbot --nginx -d $DOMAIN --redirect  (infra/README.md 「既存の nginx の後ろで動かす」)"
else
  web="Packet filter: allow TCP 22 (SSH), TCP 80 / 443 (Web), UDP 443 (HTTP/3)"
fi
cat <<DONE

== done. Next (infra/README.md 「自動デプロイ」):
1. DNS: an A record  $DOMAIN  →  $address
2. $web
3. GitHub → Settings → Environments → production → Secrets:
     DEPLOY_HOST         $DOMAIN   (or $address)
     DEPLOY_USER         deploy
     DEPLOY_KNOWN_HOSTS  $DOMAIN $hostkey
                         (with the IP as DEPLOY_HOST:  $address $hostkey)
     DEPLOY_SSH_KEY      the private half of the deploy key
   Host key fingerprint to compare: $(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub)
4. APNs / FCM keys (optional): copy them into $INFRA/secrets/ and set PUSH_* in $INFRA/.env
5. Push a tag (git tag v0.1.0 && git push origin v0.1.0), then create the first administrator (README).
DONE
