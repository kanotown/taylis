# apps/desktop

Desktop クライアント (Windows / macOS)。M3 で作成する。

スタック (CLAUDE.md): Tauri 2 + React + TypeScript (Vite)。ローカルストアは SQLite (tauri-plugin-sql)。
トークンは OS の資格情報ストア。通知は OS ネイティブ通知 (tauri-plugin-notification)。

レイアウト: 左にチャンネルと DM、中央にメッセージと入力欄、右に必要な時だけスレッドパネル。

責務: [docs/SYNC_PROTOCOL.md](../../docs/SYNC_PROTOCOL.md) のクライアント側手順
(WS → bootstrap → catch_up、ギャップ検知、楽観的送信、既読) の実装。
API の型は `openapi/openapi.json` から生成する。
