# ChikuwaChat

セルフホスト型の Slack ライクなチャットシステム。FastAPI + PostgreSQL (PGroonga) + versitygw (S3 互換オブジェクトストレージ) の
modular monolith をサーバとし、Desktop (Windows / macOS)、iOS、Android のクライアントを持つ。

開発方針は [CLAUDE.md](CLAUDE.md)。現在の状態: **設計段階 (M0 完了)**。実装は未着手。

## 構成

```
server/         FastAPI サーバ (modular monolith)
apps/desktop/   Desktop クライアント (Tauri 2 + React + TypeScript)
apps/ios/       iOS クライアント (Swift / SwiftUI)
apps/android/   Android クライアント (Kotlin / Jetpack Compose)
infra/          Docker Compose、Caddy、運用手順
openapi/        コードから生成した OpenAPI と WS イベントスキーマ
docs/           設計文書
```

## 設計文書

| 文書 | 内容 |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 全体構成、モジュール分割、プロセスモデル、エラー分類、拡張経路、設計判断 |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | テーブル定義、ID と seq の役割、不変条件 |
| [docs/SYNC_PROTOCOL.md](docs/SYNC_PROTOCOL.md) | REST + WebSocket による同期、再接続、冪等性、既読 |
| [docs/PUSH_NOTIFICATIONS.md](docs/PUSH_NOTIFICATIONS.md) | APNs / FCM、重複・欠落・遅延への対応 |
| [docs/SECURITY.md](docs/SECURITY.md) | 認証・認可・添付・デプロイ |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | マイルストーン (M1〜M10) |
