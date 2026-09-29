# ChikuwaChat

セルフホスト型の Slack ライクなチャットシステム。FastAPI + PostgreSQL (PGroonga) + versitygw (S3 互換オブジェクトストレージ) の
modular monolith をサーバとし、Desktop (Windows / macOS)、iOS、Android のクライアントを持つ。

開発方針は [CLAUDE.md](CLAUDE.md)。進捗は [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) の
マイルストーン表を参照 (M0〜M27 まで実装済み、2026-09-29 時点)。

## 構成

```
server/         FastAPI サーバ (modular monolith)
apps/desktop/   Desktop クライアント (Tauri 2 + React + TypeScript + Tailwind CSS + Radix UI + Lucide、Windows / macOS)。
                同じバンドルをブラウザ向けにも配信する (infra/web.Dockerfile、M12j)
apps/ios/       iOS クライアント (Swift / SwiftUI)
apps/android/   Android クライアント (Kotlin / Jetpack Compose)
apps/shared/    3 端末とサーバが共有するデータ (絵文字表、エラー文言、未読の規則の検証ベクトル) と生成スクリプト
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
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | マイルストーン表 (M0〜M27) とバックログ |
| [docs/THREADS.md](docs/THREADS.md) | フォロー中スレッド一覧の設計 (M11a で実装) |
| [docs/WORKSPACES.md](docs/WORKSPACES.md) | 複数ワークスペース (サーバ) の切り替え (M16c) |
