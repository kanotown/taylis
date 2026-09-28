# AGENTS.md

For coding agents other than Claude Code (Codex and others). The project instructions are in
[CLAUDE.md](CLAUDE.md): read it first, everything in it applies to you too. The design documents are in `docs/`
(ARCHITECTURE, DATA_MODEL, SYNC_PROTOCOL, SECURITY, IMPLEMENTATION_PLAN).

## Working alongside another agent

- Another agent may be working on `main` in parallel. Work on your own branch (or git worktree), keep commits small,
  and say in each commit message what changed and how it was checked.
- Do not push tags: a tag push deploys production. Do not touch production servers or their secrets.
- Never commit secrets: `infra/.env`, `infra/secrets/`, APNs `.p8` keys, Firebase service-account JSON, tokens.

## Rules learned the hard way

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

## Checks before a commit

- Server (needs the local PostgreSQL of `infra/`'s docker compose):
  `cd server && uv run ruff format --check . && uv run ruff check . && uv run mypy && DEBUG=false uv run pytest -q`
- Desktop / web: `cd apps/desktop && npx tsc --noEmit -p . && npx vitest run && npm run build`
- iOS: `cd apps/ios && xcodegen generate && xcodebuild -project ChikuwaChat.xcodeproj -scheme ChikuwaChat
  -destination "platform=iOS Simulator,name=iPhone 17 Pro" test`
- Android (with `ANDROID_HOME` set): `cd apps/android && ./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug`
