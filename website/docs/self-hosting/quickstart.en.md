---
title: Quick start
description: Start a Taylis server and create the first administrator
---

# Quick start

From an empty Linux server to logging in with a browser. Check the [requirements](index.md#requirements) first.

## 1. DNS and firewall

- Add an **A record** (and AAAA for IPv6) so that `chat.example.com` points at the server. `dig +short chat.example.com`
  should print the server's address.
- Open TCP 80 and 443 (and UDP 443 for HTTP/3).
- If the domain is on Cloudflare, turn the proxy off (DNS only): Caddy obtains its own certificate and must pass
  WebSockets and large uploads through unchanged.

## 2. Install Docker

Install Docker Engine and the compose plugin following Docker's official instructions. `docker compose version` should
work.

## 3. Get the code and configure it

```sh
git clone https://github.com/kanotown/taylis.git /srv/chikuwachat
cd /srv/chikuwachat/infra
cp .env.example .env && chmod 600 .env
mkdir -p secrets && chmod 700 secrets
```

Edit `.env` and fill in at least:

```ini
ENVIRONMENT=production
WORKSPACE_NAME=Your team
# 32 characters or more, random
SECRET_KEY=
# random values
POSTGRES_PASSWORD=
S3_SECRET_KEY=
CHAT_DOMAIN=chat.example.com
```

Generate random values with:

```sh
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

!!! danger "Never commit `.env` or `secrets/`"
    `.env` holds secrets. Keep a copy somewhere safe, separate from the backups: without it, a restored backup cannot
    be started.

## 4. Start

```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile proxy up -d --build
```

- Only Caddy (80 / 443) is exposed; the database, the app and the object store are not published on the host.
- Database migrations run automatically when the app starts.
- Caddy obtains a TLS certificate automatically (ports 80 / 443 must be open and DNS must point at the server).

Check that it is up:

```sh
curl https://chat.example.com/healthz
```

## 5. Create the first administrator

```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec app \
  python -m app.cli create-admin --username admin
```

A temporary password is printed **once**.

## 6. Log in

- Open `https://chat.example.com/` in a browser and log in as `admin` with the temporary password; you will be asked
  to choose a new one.
- In the desktop and mobile apps, enter `https://chat.example.com` as the server URL on the login screen.

Then create accounts or send invitation links from Settings → 管理 (Admin) in the desktop or browser client.

## What next

- Schedule the daily backup (most important):

    ```sh
    # crontab (root)
    30 3 * * * CHIKUWA_PROD=1 /srv/chikuwachat/infra/backup.sh /srv/backups >> /var/log/chikuwachat-backup.log 2>&1
    ```

- Updating a manual install:

    ```sh
    git pull && docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile proxy up -d --build
    ```

- Push notifications, running behind an existing nginx, automatic deployment from release tags and imports are
  described in [infra/README.md](https://github.com/kanotown/taylis/blob/main/infra/README.md) (Japanese).
