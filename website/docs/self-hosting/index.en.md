---
title: Self-hosting
description: Run your own Taylis server
---

# Self-hosting

A Taylis server runs on one Linux machine with Docker Compose. It does not use Redis, Kafka or Kubernetes. The same
setup is designed for several dozen users and millions of messages.

## Requirements { #requirements }

| What | Details |
| --- | --- |
| Server | Linux (tested on Debian 12 / 13), 2 vCPU / 4 GB RAM recommended (add swap on 2 GB) |
| Software | Docker Engine with the compose plugin |
| Domain name | A DNS name pointing at the server (for example `chat.example.com`) |
| Ports | TCP 80 and 443 (also used to obtain the certificate); UDP 443 for HTTP/3 |
| Disk | Room for attachments (several GB if you import a large workspace) and backups |

Push notifications additionally need an Apple Developer Program membership (iOS) and a Firebase project (Android).

## Components

```text
users ──https──▶ Caddy (TLS, serves the browser client) ──▶ app (FastAPI, WebSocket)
                                                           ├─▶ db (PostgreSQL 17 + PGroonga)
                                                           ├─▶ objectstore (versitygw: S3-compatible, attachments)
                                                           └─▶ converter (Gotenberg: Office document previews)
```

**All state lives in two places: the PostgreSQL volume and the versitygw data directory.** Backups copy exactly these
two (`infra/backup.sh`, `infra/restore.sh`).

## Next steps

1. [Quick start](quickstart.md): start the server and create the first administrator.
2. The full operations guide (in Japanese) is
   [infra/README.md](https://github.com/kanotown/taylis/blob/main/infra/README.md): backups and restores, push
   notifications (APNs / FCM), running behind an existing reverse proxy, automatic deployment from release tags,
   document previews and imports from Slack and Mattermost. Every setting is listed in
   [infra/.env.example](https://github.com/kanotown/taylis/blob/main/infra/.env.example).

!!! warning "What operators can see"
    Admins who are not members cannot read private channels and DMs in the apps. However, anyone with access to the
    server, the database or the backups can read every message. Tell your users, and decide who will be an admin and
    who will run the server.
