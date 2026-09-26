# apps/android

Android クライアント。M6 で作成し、M7 で FCM を追加する。

スタック (CLAUDE.md): Kotlin / Jetpack Compose / Coroutines + Flow。Jetpack 標準 API を優先する。
ローカルストアは Room、トークンは Android Keystore の鍵で暗号化して DataStore に保存。
WebSocket は OkHttp (Jetpack に WS クライアントが無いため、唯一許容する第三者依存)。
FCM は data-only メッセージを受けてアプリが通知を組み立てる。

責務: [docs/SYNC_PROTOCOL.md](../../docs/SYNC_PROTOCOL.md) のクライアント側手順と、
[docs/PUSH_NOTIFICATIONS.md](../../docs/PUSH_NOTIFICATIONS.md) §3 / §9 の端末登録・通知の扱い。
