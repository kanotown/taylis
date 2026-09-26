# openapi

API 契約。**コードが正** (FastAPI / Pydantic から生成) で、生成物をここにコミットする。
Desktop / iOS / Android は同じ仕様を使い、クライアントごとに API の振る舞いを変えない。

| ファイル | 内容 | 生成 |
| --- | --- | --- |
| `openapi.json` | REST API (M1 から) | `uv run python -m app.cli export-openapi` |
| `ws-events.json` | WebSocket イベントの JSON Schema (M2 から) | 同上 (`--ws-events`) |

- CI で生成結果とコミット済みファイルの差分を検査し、ドリフトを防ぐ。クライアントに影響する変更は
  必ずここに現れる。
- クライアントはここから型を生成する (TypeScript: openapi-typescript、Swift / Kotlin: openapi-generator など。
  M3 / M4 / M6 で決める)。
- イベントの意味論は [docs/SYNC_PROTOCOL.md](../docs/SYNC_PROTOCOL.md) §6 を参照。
