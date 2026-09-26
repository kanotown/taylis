# apps/ios

iOS クライアント。M4 で作成し、M5 で APNs を追加する。

スタック (CLAUDE.md): Swift / SwiftUI / Swift Concurrency。Apple 標準フレームワークを優先し、UIKit は
SwiftUI で足りない場合のみ。ローカルストアは SQLite (GRDB)、WS は `URLSessionWebSocketTask`、
トークンは Keychain。APNs を直接使う (Firebase SDK は使わない)。

配布: Xcode から登録済み実機に直接インストールする。App Store / TestFlight を前提にしない。
したがって APNs は sandbox 環境で、端末登録時に `push_environment = "sandbox"` を送る。

責務: [docs/SYNC_PROTOCOL.md](../../docs/SYNC_PROTOCOL.md) のクライアント側手順と、
[docs/PUSH_NOTIFICATIONS.md](../../docs/PUSH_NOTIFICATIONS.md) §3 / §9 の端末登録・通知の扱い。
