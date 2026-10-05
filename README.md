# Taylis

[日本語](README.ja.md)

Taylis is a self-hosted, Slack-like team chat for small organisations such as research labs: one server you run
yourself, and native clients for Windows, macOS, iOS and Android plus a browser client.

(Formerly "ChikuwaChat"; internal identifiers such as bundle IDs, package names and the `chikuwachat://` URL scheme
keep the old name.)

> **No support guarantee.** Taylis is developed for the author's own use and published as-is. Issues and pull
> requests are welcome, but there is no promise of support, fixes, or a roadmap. See [CONTRIBUTING.md](CONTRIBUTING.md).

<!-- Screenshots: docs/images/ (not yet published) -->

## Features

- Public and private channels, direct messages and group DMs
- Threads, reactions, mentions, editing and deletion, unread state synchronised across devices
- Reliable delivery: server-side ordering, idempotent sends, catch-up after reconnects (WebSocket + REST,
  [docs/SYNC_PROTOCOL.md](docs/SYNC_PROTOCOL.md))
- Push notifications through APNs (iOS) and FCM (Android), sent from a transactional outbox
- Japanese and English full-text search (PostgreSQL + PGroonga)
- File attachments in S3-compatible object storage (versitygw by default)
- Canvas documents, calendar with recurring events and iCal, tasks, workflows, custom emoji
- Optional sign-in with Google (SSO), invitations, guest accounts
- Several workspaces (servers) in one client
- Importers for Mattermost and Slack exports
- Optional AI bot (answers mentions, private summaries, questions over past messages; [docs/AI.md](docs/AI.md))
- Backup and restore scripts, automatic deployment from a release tag

## Architecture

A modular monolith: **FastAPI** (Python) + **PostgreSQL** with **PGroonga** + **versitygw** (S3-compatible object
storage), deployed with Docker Compose behind Caddy (or an existing reverse proxy). No Redis, Kafka or Kubernetes;
the real-time event bus is an interface so it can be replaced if the server ever needs to scale out.
Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
server/         FastAPI server (modular monolith)
apps/desktop/   Desktop client (Tauri 2 + React + TypeScript, Windows / macOS); the same bundle is served as the
                browser client (infra/web.Dockerfile)
apps/ios/       iOS client (Swift / SwiftUI)
apps/android/   Android client (Kotlin / Jetpack Compose)
apps/shared/    Data shared by the clients and the server (emoji table, error texts, test vectors) and generators
infra/          Docker Compose, Caddy, deployment and operations
openapi/        OpenAPI and WebSocket event schemas generated from the code
docs/           Design documents (mostly in Japanese)
```

## Self-hosting quick start

You need a Linux server (2 vCPU / 4 GB RAM or more) with Docker Engine and the compose plugin, and a DNS name pointing
at it with ports 80 and 443 open.

```sh
git clone https://github.com/kanotown/chikuwachat.git /srv/chikuwachat
cd /srv/chikuwachat/infra
cp .env.example .env && chmod 600 .env     # fill in SECRET_KEY, POSTGRES_PASSWORD, S3_SECRET_KEY, CHAT_DOMAIN
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile proxy up -d --build
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec app python -m app.cli create-admin --username admin
```

Then open `https://<CHAT_DOMAIN>/` in a browser, or enter that URL in a desktop or mobile client. Backups, restores,
push notification setup (APNs / FCM), running behind an existing reverse proxy, automatic deployment and imports are
described in [infra/README.md](infra/README.md).

## Clients

| Client | Stack | Notes |
| --- | --- | --- |
| Browser | React (served by the server) | `https://<CHAT_DOMAIN>/` |
| Desktop | Tauri 2 + React | Windows and macOS; in-app updates from the official releases |
| iOS | SwiftUI | Push via APNs; build with Xcode ([docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)) |
| Android | Jetpack Compose | Push via FCM; build with Gradle |

Every client talks to the server through the same API ([openapi/openapi.json](openapi/openapi.json)).

## Development

- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): toolchain, check commands, building forks
- [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md): milestones; open items in [docs/BACKLOG.md](docs/BACKLOG.md)
- [CLAUDE.md](CLAUDE.md) / [AGENTS.md](AGENTS.md): the project's engineering principles

| Design document | Topic |
| --- | --- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Overall structure, modules, process model, error classes, design decisions |
| [DATA_MODEL.md](docs/DATA_MODEL.md) | Tables, IDs and sequences, invariants |
| [SYNC_PROTOCOL.md](docs/SYNC_PROTOCOL.md) | REST + WebSocket synchronisation, reconnects, idempotency, read state |
| [PUSH_NOTIFICATIONS.md](docs/PUSH_NOTIFICATIONS.md) | APNs / FCM, handling duplicated, dropped or delayed pushes |
| [SECURITY.md](docs/SECURITY.md) | Authentication, authorisation, attachments, deployment |
| [WORKSPACES.md](docs/WORKSPACES.md) | Several workspaces (servers) in one client |

**What operators can see**: private channels and DMs cannot be read in the apps by admins who are not members, but
anyone with access to the server, the database or the backups can technically read every message. Tell your users,
and consider who should hold the admin and server roles ([docs/LAB.md](docs/LAB.md) J).

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

The source code is licensed under the [Apache License 2.0](LICENSE). Bundled third-party data is listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The name "Taylis" and the squirrel icon / logo are **not** covered by the Apache License: forks must use another name
and icon. See [TRADEMARKS.md](TRADEMARKS.md) and [NOTICE](NOTICE).
