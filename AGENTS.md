# Project Overview

This project is a self-hosted Slack-like chat system.

Initial usage will be small, but the architecture must support future use by several dozen users without fundamental redesign.

The system will support:

- Desktop: Windows and macOS
- iOS
- Android

The main priorities are:

1. Reliable message storage
2. Reliable real-time synchronization
3. Reliable push notifications
4. Long-term searchable message history
5. Japanese and English full-text search
6. File attachments
7. Simple Slack-like user experience
8. Easy backup and restore
9. Future support for AI search / RAG
10. Maintainable architecture without unnecessary complexity

Do not optimize the architecture only for two users.

At the same time, do not introduce large-scale infrastructure such as Kubernetes, Kafka, RabbitMQ, or microservices unless clearly necessary.

The target scale is several dozen users.

---

# Repository Structure

Use a monorepo structure.

Preferred structure:

```text
/
├── AGENTS.md
├── README.md
├── docs/
│   ├── ARCHITECTURE.md
│   ├── DATA_MODEL.md
│   ├── SYNC_PROTOCOL.md
│   ├── PUSH_NOTIFICATIONS.md
│   ├── SECURITY.md
│   ├── THREADS.md
│   ├── WORKSPACES.md
│   └── IMPLEMENTATION_PLAN.md
│
├── server/
│
├── apps/
│   ├── desktop/
│   ├── ios/
│   ├── android/
│   └── shared/        # data the clients and the server share (emoji, error texts, unread-rule vectors) + generators
│
├── infra/
│
└── openapi/
```

Do not create unnecessary directories until they are needed.

---

# Backend

Use:

- Python
- FastAPI
- PostgreSQL
- PGroonga for Japanese and English full-text search
- versitygw (S3-compatible object storage over a plain directory) for attachment storage
- WebSocket for real-time communication

The backend is the source of truth.

Use Docker Compose for local and production-like deployment.

A reverse proxy such as Caddy may be used.

Do not introduce Redis initially unless there is a clear technical need.

However, real-time event distribution should be abstracted behind an EventBus interface so that an in-memory implementation can later be replaced with Redis or another implementation if horizontal scaling becomes necessary.

Example:

```text
EventBus
├── InMemoryEventBus
└── RedisEventBus   # future
```

Initial deployment should work with:

- one FastAPI application
- one PostgreSQL instance
- one versitygw instance (S3-compatible object storage)

---

# Clients

## Desktop

Use:

- Tauri
- React
- TypeScript

Support:

- Windows
- macOS

Use native desktop notifications where practical.

The UI should be simple and Slack-like.

Typical layout:

```text
Left:
- channels
- direct messages

Center:
- messages
- message composer

Right:
- thread panel when necessary
```

---

## iOS

Use:

- Swift
- SwiftUI
- Swift Concurrency

Prefer Apple standard frameworks.

Use UIKit only when SwiftUI is insufficient.

Use Keychain for authentication secrets.

Use APNs for remote push notifications.

The app will initially be installed directly onto registered devices using Xcode rather than distributed through the App Store.

Do not make assumptions that require App Store distribution.

---

## Android

Use:

- Kotlin
- Jetpack Compose
- Kotlin Coroutines / Flow

Use Firebase Cloud Messaging for push notifications.

Prefer Android standard and Jetpack APIs.

Avoid unnecessary third-party dependencies.

---

# Core Entities

Design the system around at least the following entities:

- User
- Channel
- ChannelMember
- Message
- MessageReaction
- ReadState
- Device
- Session
- NotificationPreference
- OutboxEvent
- Attachment

Do not encode assumptions that there are only two users.

---

# Channels

Support these channel types:

- public
- private
- dm
- group_dm

Direct messages should generally be represented as channels with membership rather than implemented as an entirely separate messaging system.

Channel membership must be represented independently.

Example:

```text
Channel

ChannelMember
- channel_id
- user_id
- role
- joined_at
```

---

# Roles

Initial system roles:

- admin
- member

Initial channel roles:

- owner
- member

Do not implement complex RBAC initially.

The model should allow additional roles to be added later if necessary.

---

# Messaging

Messages must be reliably stored.

Each message should have at least:

- server-generated ID
- client-generated idempotency key
- channel ID
- sender ID
- channel sequence number
- body
- created_at
- edited_at
- deleted_at

The client-generated idempotency key must prevent duplicate messages when a request is retried.

Message ordering must not depend only on client timestamps.

Use a server-side sequence or equivalent ordering mechanism.

---

# Synchronization

The server is always the source of truth.

WebSocket provides real-time events but is not the only synchronization mechanism.

Clients must be able to recover after:

- temporary network loss
- application suspension
- WebSocket disconnect
- device reboot
- missed push notification

Clients should keep a synchronization cursor or sequence position.

After reconnection, clients must request missing data from the server.

Do not assume WebSocket events are never lost.

---

# Read State

Do not create one database row for every user-message read combination.

Track read position per user and channel.

For example:

```text
ReadState
- user_id
- channel_id
- last_read_sequence
- updated_at
```

Unread counts can be derived from the channel sequence.

Read state must synchronize across devices.

---

# Push Notifications

Push notifications are not a message synchronization mechanism.

Push notifications only indicate that new data may exist.

After receiving a push notification, the client should synchronize with the server.

The system must remain correct even if push notifications are:

- delayed
- duplicated
- reordered
- dropped

---

# Devices

A user may have multiple devices.

Store devices independently.

At minimum:

```text
Device
- id
- user_id
- platform
- push_provider
- push_token
- device_name
- app_version
- last_seen_at
- enabled
- created_at
- updated_at
```

Possible platforms:

- ios
- android
- desktop

Possible push providers:

- apns
- fcm
- none

Push tokens may change and must be updatable.

Invalid push tokens must be removable.

---

# APNs

Use APNs for iOS.

Prefer token-based APNs authentication using a .p8 key.

Never commit any of the following:

- APNs private key
- API keys
- passwords
- access tokens
- secrets

Configuration such as:

- Team ID
- Key ID
- Bundle ID
- secret locations

must come from environment variables or secret files.

---

# FCM

Use Firebase Cloud Messaging for Android.

FCM tokens may change.

When a token changes, update it on the server.

Do not assume one user has only one FCM token.

---

# Reliable Notification Processing

Use the Transactional Outbox pattern.

When creating a message, within the same PostgreSQL transaction:

1. insert the message
2. insert an OutboxEvent

Then commit.

A background worker processes OutboxEvent records and sends notifications.

Processing must be idempotent.

A server crash after message commit must not silently lose the notification event.

Do not introduce Kafka or RabbitMQ only for this purpose.

PostgreSQL is sufficient initially.

---

# Authentication

There is no public user registration in the initial version.

Administrators create users.

Use secure password hashing such as Argon2id.

Use:

- short-lived access tokens
- renewable refresh tokens

Refresh tokens must be revocable.

Mobile applications must store authentication secrets securely.

iOS should use Keychain.

Android should use appropriate secure storage.

Never store plaintext passwords.

---

# Search

Messages will contain both Japanese and English.

Use PostgreSQL with PGroonga for full-text search.

Search should eventually support:

- message body
- author
- channel
- date range

Initial implementation does not need embeddings or an LLM.

However, avoid architecture that would make future semantic search or RAG difficult.

Future AI capabilities may include:

- semantic search
- conversation summaries
- decision extraction
- task extraction
- question answering over past discussions

These features are explicitly out of scope for the first implementation.

---

# Attachments

Use versitygw as S3-compatible object storage.

Note: MinIO was the original choice, but its community edition was discontinued
(repository archived in April 2026, official images removed). versitygw serves the
S3 API on top of a plain directory. The application talks to it only through the
S3 API behind a `BlobStore` abstraction, so any S3-compatible store can replace it later.

Do not store large files directly inside PostgreSQL.

Validate:

- file size
- MIME type
- authenticated access

Attachment metadata belongs in PostgreSQL.

The object itself belongs in versitygw (object storage).

---

# API

Use OpenAPI.

The same API specification should be used by:

- desktop
- iOS
- Android

Do not independently invent different API behaviors per client.

Prefer cursor-based pagination over offset pagination for message history.

API changes that affect clients must update the API specification.

---

# Error Handling

Do not silently ignore errors.

Return structured API errors.

Clients must distinguish at least:

- authentication errors
- permission errors
- validation errors
- temporary server errors
- network errors

Network retry logic must not create duplicate messages.

---

# Security

TLS is required in production.

Do not commit secrets.

Validate all user input on the server.

Do not trust client-provided:

- user IDs
- timestamps
- roles
- permissions

Authorization checks must happen on the server.

Validate attachment type and size.

Prevent unauthorized users from accessing private channels and attachments.

---

# Scalability Target

Design for:

- several dozen users
- hundreds of simultaneous WebSocket connections
- hundreds of thousands to several million messages
- long-term message retention

This does not require microservices.

Do not prematurely introduce:

- Kubernetes
- Kafka
- RabbitMQ
- Elasticsearch
- distributed databases
- service mesh

Prefer a modular monolith.

---

# Engineering Principles

Prefer simple and explicit architecture.

Avoid speculative abstractions.

However, define clean boundaries where future replacement is reasonably expected.

Examples:

```text
PushProvider
├── APNsPushProvider
└── FCMPushProvider
```

```text
EventBus
├── InMemoryEventBus
└── RedisEventBus  # possible future implementation
```

Do not add dependencies merely because they are popular.

Prefer standard platform APIs.

Do not perform large rewrites when a small change is sufficient.

Do not silently change architectural decisions documented in `/docs`.

If a documented architecture decision appears wrong, explain the problem and update the documentation together with the implementation.

---

# AI Development Rules

Before changing significant architecture:

1. inspect the existing repository
2. read AGENTS.md
3. read relevant files in `/docs`
4. understand the existing implementation
5. preserve compatible behavior where possible

Do not invent API behavior when the specification already exists.

Do not claim something works without testing it where testing is possible.

After backend changes:

- run tests
- run type checks if configured
- run lint if configured

After desktop changes:

- run TypeScript checks
- run tests
- verify the Tauri build when appropriate

After iOS changes:

- build the Xcode project when possible
- fix build errors before considering the task complete

After Android changes:

- run the appropriate Gradle build or checks
- fix compilation errors before considering the task complete

Do not leave known build failures behind unless clearly documented.

---

# Implementation Strategy

Work in small milestones.

Do not attempt to implement the complete Slack-like system in one task.

Preferred milestone sequence:

## Milestone 1

Backend foundation:

- PostgreSQL
- authentication
- users
- channels
- channel membership
- basic message creation
- message retrieval

Completion condition:

A test client can log in, post a message, store it in PostgreSQL, and retrieve it.

## Milestone 2

Reliable synchronization:

- channel sequence
- idempotency
- WebSocket
- reconnect synchronization

## Milestone 3

Desktop client:

- login
- channel list
- message list
- send message
- real-time updates

## Milestone 4

iOS client:

- login
- channel list
- messages
- send message
- real-time synchronization

## Milestone 5

APNs:

- device registration
- push token registration
- push delivery
- notification handling
- synchronization after notification

## Milestone 6

Android client:

- login
- channel list
- messages
- send message
- synchronization

## Milestone 7

FCM:

- device registration
- token handling
- push delivery

## Milestone 8

Messaging features:

- threads
- reactions
- mentions
- edit
- delete
- unread state

## Milestone 9

Attachments and search:

- versitygw (S3-compatible object storage)
- attachments
- PGroonga
- search UI

## Milestone 10

Operational reliability:

- backup
- restore
- security review
- logging
- deployment documentation

Do not start a later milestone until the current milestone is reasonably functional.

---

# Initial Development Rule

When first entering this repository, do not immediately implement large amounts of code.

First inspect the repository and create or review:

- docs/ARCHITECTURE.md
- docs/DATA_MODEL.md
- docs/SYNC_PROTOCOL.md
- docs/PUSH_NOTIFICATIONS.md
- docs/SECURITY.md
- docs/IMPLEMENTATION_PLAN.md

Identify architecture problems before implementation.

The highest priority is not feature count.

The highest priority is:

**a simple, reliable, maintainable chat system that can grow from a few users to several dozen users without fundamental redesign.**

---

# Practical notes for agents (2026-09-28)

What the sections above do not spell out, learned while building the project.

### Working alongside another agent

- Another agent may be working on `main` in parallel. Work on your own branch (or git worktree), keep commits small,
  and say in each commit message what changed and how it was checked.
- Do not push tags: a tag push deploys production. Do not touch production servers or their secrets.
- Never commit secrets: `infra/.env`, `infra/secrets/`, APNs `.p8` keys, Firebase service-account JSON, tokens.

### Rules learned the hard way

- **API changes**: when the server's API changes, regenerate `openapi/` (`cd server && uv run python -m app.cli
  export-openapi`) and the desktop types (`cd apps/desktop && npm run gen:api`) **in the same commit**. CI diffs both.
- **Error codes**: add the text to `apps/shared/errors.json`, then run `python3 apps/shared/gen_errors.py` (it writes the
  tables of the three clients; a server test checks every code has a text).
- **Unread and read rules** are shared by the server and the three clients: `docs/SYNC_PROTOCOL.md` §10 and the vectors
  in `apps/shared/unread-rules.json`. Change them together, never in one client alone.
- **Android**: never bump the Room database version (`fallbackToDestructiveMigration` would delete unsent messages).
  New fields go inside the JSON the tables already store.
- **iOS**: a new wire field needs its CodingKeys and any hand-written decoder updated, and must decode when missing
  (older servers, rows saved before). Leave `CFBundleVersion` in `apps/ios/project.yml` alone unless asked (one person
  bumps it per TestFlight upload).
- **Delicate code** (verify on a simulator or emulator, unit tests alone do not catch regressions here): the iOS
  conversation screen (`apps/ios/ChikuwaChat/UI/ChannelView.swift`, `ThreadView.swift`, `KeyboardBehavior.swift`: keyboard,
  scrolling and the §10.1 read anchors), and the sync engines and stores of the three clients.
- Do not pipe a checker's output into `head` or similar when its exit code matters.

### Checks before a commit

- Server (needs the local PostgreSQL of `infra/`'s docker compose):
  `cd server && uv run ruff format --check . && uv run ruff check . && uv run mypy && DEBUG=false uv run pytest -q`
- Desktop / web: `cd apps/desktop && npx tsc --noEmit -p . && npx vitest run && npm run build`
- iOS: `cd apps/ios && xcodegen generate && xcodebuild -project ChikuwaChat.xcodeproj -scheme ChikuwaChat
  -destination "platform=iOS Simulator,name=iPhone 17 Pro" test`
- Android (with `ANDROID_HOME` set): `cd apps/android && ./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug`
