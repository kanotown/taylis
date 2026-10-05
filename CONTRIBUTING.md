# Contributing

Thank you for your interest in Taylis.

- **Issues and pull requests are welcome**, but Taylis is maintained in the author's spare time for their own use.
  There is no promise that issues will be answered, that pull requests will be reviewed or merged, or of any support.
- For anything larger than a small fix, please open an issue first to ask whether the change fits the project. The
  architecture and its principles are described in [CLAUDE.md](CLAUDE.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md);
  changes that add heavy infrastructure (Redis, message brokers, Kubernetes, ...) are unlikely to be accepted.
- Security problems: do not open an issue; see [SECURITY.md](SECURITY.md).

## License of contributions

Taylis is licensed under the [Apache License 2.0](LICENSE). By submitting a contribution you agree that it is licensed
under the same license (inbound = outbound, as in section 5 of the Apache License), and that you have the right to
submit it. Contributions must not include the Taylis brand assets in modified form or third-party material under an
incompatible license.

## Before opening a pull request

Run the checks for the parts you changed (the commands are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) §4):

- **Server**: `cd server && uv run pytest -q && uv run ruff check . && uv run ruff format --check . && uv run mypy app tests`
  (the tests need PostgreSQL with PGroonga: `docker compose -f infra/docker-compose.yml up -d db`). If the API changed,
  regenerate `openapi/openapi.json` (`uv run python -m app.cli export-openapi`) and the web types
  (`cd apps/desktop && npm run gen:api`).
- **Desktop / web**: `cd apps/desktop && npm run typecheck && npm test && npx vite build`
- **iOS**: build and test the Xcode project (`apps/ios`, generated with XcodeGen).
- **Android**: `apps/android/gradlew -p apps/android :app:testDebugUnitTest :app:lintDebug :app:assembleDebug`
- Changed data in `apps/shared`: run the matching generator and the tests of every client.

Code comments and commit messages are in English. Keep changes small and focused; do not reformat unrelated code.
