# apps/ios

iOS クライアント。Swift / SwiftUI / Swift Concurrency。Apple 標準フレームワークのみで、第三者依存はない
(SQLite は SQLite3 の C API を薄くラップ、資格情報は Keychain、WebSocket は `URLSessionWebSocketTask`)。

## 開発

```
brew install xcodegen            # プロジェクト生成ツール (開発時のみ)
xcodegen generate                # project.yml から ChikuwaChat.xcodeproj を生成 (生成物はコミット済み)
open ChikuwaChat.xcodeproj       # Xcode で開き、Team を選んで実機にインストール (App Store は使わない)

# テスト (シミュレータ)
xcodebuild -project ChikuwaChat.xcodeproj -scheme ChikuwaChat \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO test
```

実サーバに対するエンジンの検証: `TEST_RUNNER_LIVE_URL=http://127.0.0.1:8000 TEST_RUNNER_LIVE_PASS=... xcodebuild ... -only-testing:ChikuwaChatTests/LiveBackendTests test`
(`dtuser1` / `dtuser2` を CLI で作っておく。シミュレータはホストの `127.0.0.1` に到達できる)。

実機で開発サーバに接続するときは、サーバ URL に Mac の LAN アドレス (例: `http://192.168.x.x:8000`) を指定する。
`Info.plist` の ATS はローカル / HTTP を許可している (本番は Caddy の TLS 経由)。

## 構成

```
ChikuwaChat/
  App/        ChikuwaChatApp (入口、scenePhase で復帰時に再接続)、AppController (セッション復元、ログイン、強制パスワード変更、エンジン)
  Api/        ApiClient (bearer 認証、token_expired で 1 回だけ refresh、エラー分類)、Models (OpenAPI のモデル)、JSON (コーダと JSONValue)
  Sync/       SyncEngine (SYNC_PROTOCOL.md §5/§7/§8/§9)、Store (表示の唯一のソース、SQLite へ write-through)、Frames、WebSocketTransport
  Platform/   Keychain、SQLiteStore (SQLite3 ラッパと永続化)
  UI/         LoginView、ChangePasswordView、MainView (NavigationSplitView)、ChannelListView、ChannelView、MessageBodyView、Sheets
ChikuwaChatTests/
  FakeServer (プロトコルの模擬サーバ)、SyncEngineTests、ContractTests (server/tests/contract/*.json をバンドルして実行)、
  ApiClientTests (URLProtocol スタブ)、BodyTokenizerTests、LiveBackendTests (LIVE_URL 指定時のみ)
project.yml   xcodegen の定義 (deployment target iOS 17、Swift 5 言語モード、Team ID は自動署名用)
```

## 同期の要点

Desktop と同じアルゴリズム (`server/tests/contract_client.py` が仕様): WS → hello → bootstrap → catch_up、
チャンネルごとの `syncedSeq` と連番検証、欠落時は差分 API、5000 件超の遅れは最新ページの読み直し、
`client_msg_id` 付きの楽観的送信と再送キュー。バックグラウンドで iOS がソケットを止めた後は、
フォアグラウンド復帰 (`scenePhase == .active`) で再接続と catch_up を行う。プッシュ通知は M5 で追加する。
