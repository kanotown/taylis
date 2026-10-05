# apps/ios

iOS クライアント。Swift / SwiftUI / Swift Concurrency。Apple 標準フレームワークのみで、第三者依存はない
(SQLite は SQLite3 の C API を薄くラップ、資格情報は Keychain、WebSocket は `URLSessionWebSocketTask`)。

## 開発

```
brew install xcodegen            # プロジェクト生成ツール (開発時のみ)
xcodegen generate                # project.yml から ChikuwaChat.xcodeproj を生成 (生成物はコミット済み)
open ChikuwaChat.xcodeproj       # Xcode で開き、Team を選んで実機にインストール (App Store は使わない)

# テスト (シミュレータ)。テストは日本語の文言で比べるので、テストの言語を日本語にする
xcodebuild -project ChikuwaChat.xcodeproj -scheme ChikuwaChat \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO -testLanguage ja -testRegion JP test
```

## 表示言語 (日本語 / English / 简体中文)

- 文言は `ChikuwaChat/Resources/Localizable.xcstrings` (String Catalog、ソース言語は日本語、キー = 日本語の文)。
  Info.plist の文言は `InfoPlist.xcstrings`。英語・簡体字中国語の訳語は `apps/shared/i18n/glossary.json` に合わせる。
- SwiftUI の `Text("…")` / `Button("…")` などはそのまま訳される。それ以外で組み立てる文は `tr("…")` を使う
  (`String(localized:)` は起動時の言語のままで、アプリ内の切り替えに追従しない)。データの日本語 (コマンド名 `/日程`、
  解析する語など) には同じ行に `// i18n-ignore` を付ける。
- アプリ内の切り替え (自分 → 表示 → 言語) は `App/AppLanguage.swift` の `UILanguage`。サーバの `UserMe.locale`
  と同期し、すべてのリクエストに `Accept-Language` を付ける。
- 確認: `python3 scripts/i18n_check.py leftovers` (カタログ外の日本語の文字列。ビルドの .stringsdata と照合)、
  `python3 scripts/i18n_check.py sync` (抽出したキーをカタログへ追加)、`python3 scripts/i18n_check.py missing`
  (訳のないキー。`LocalizationTests` も同じことを確かめる)。

実サーバに対するエンジンの検証: `TEST_RUNNER_LIVE_URL=http://127.0.0.1:8000 TEST_RUNNER_LIVE_PASS=... xcodebuild ... -only-testing:ChikuwaChatTests/LiveBackendTests test`
(`dtuser1` / `dtuser2` を CLI で作っておく。シミュレータはホストの `127.0.0.1` に到達できる)。

実機で開発サーバに接続するときは、サーバ URL に Mac の LAN アドレス (例: `http://192.168.x.x:8000`) を指定する。
`Info.plist` の ATS はローカル / HTTP を許可している (本番は Caddy の TLS 経由)。

## 構成

```
ChikuwaChat/
  App/        ChikuwaChatApp (入口、scenePhase で復帰時に再接続)、AppController (ワークスペース、セッション復元、ログイン、強制パスワード変更、エンジン)、
              Workspaces (M16c: 登録済みサーバの一覧と移行、URL の正規化、通知の振り分け、アプリアイコンのバッジ)
  Api/        ApiClient (bearer 認証、token_expired で 1 回だけ refresh、エラー分類)、Models (OpenAPI のモデル)、JSON (コーダと JSONValue)
  Sync/       SyncEngine (SYNC_PROTOCOL.md §5/§7/§8/§9)、Store (表示の唯一のソース、SQLite へ write-through)、Frames、WebSocketTransport、
              CanvasSave (キャンバスの保存ループ、CANVAS.md §4.4) と CanvasHub (一覧・canvas.* イベント・保存待ち、M45)
  Platform/   Keychain、SQLiteStore (SQLite3 ラッパと永続化)
  UI/         LoginView (最初のログイン / ワークスペースの追加 / 再ログイン)、ChangePasswordView、MainView (NavigationSplitView)、ChannelListView、
              ChannelView、MessageBodyView、Sheets、WorkspaceViews (切り替えシート、タイル)、YouView + YouRules (M40: 「自分」タブと設定の画面、表示のテーマ)、Search + SearchView (M16b: 候補、絞り込み、結果)
ChikuwaChatTests/
  FakeServer (プロトコルの模擬サーバ)、SyncEngineTests、ContractTests (server/tests/contract/*.json をバンドルして実行)、
  ApiClientTests (URLProtocol スタブ)、BodyTokenizerTests、LiveBackendTests (LIVE_URL 指定時のみ)
project.yml   xcodegen の定義 (deployment target iOS 17、Swift 5 言語モード、Team ID は自動署名用)
```

## 同期の要点

Desktop と同じアルゴリズム (`server/tests/contract_client.py` が仕様): WS → hello → bootstrap → catch_up、
チャンネルごとの `syncedSeq` と連番検証、欠落時は差分 API、5000 件超の遅れは最新ページの読み直し、
`client_msg_id` 付きの楽観的送信と再送キュー (一時的な失敗は 2〜30 秒のバックオフで再開、4xx は「送信に失敗」として残す)。
タイムラインは最新ページから連続して読んだ範囲 (`oldestLoadedSeq` 以降) だけを並べる (§7.3)。
表示範囲による既読は、未読の行がすべてその範囲に入り (古い側は `covers`、新しい側は `syncedSeq >= lastSeq`)、最初の未読行が
画面に出てから送る (§10.1、`ReadGate` / `ReadAnchor`)。届かない間は上端のバナー (「未読 N 件 · 10:23 以降」、「最初の未読へ」、
「既読にする」) を出す。最初の未読行への位置合わせ (開いた時、「最初の未読へ」) は、スクロールが着地して行が画面に出るまで既読を
判定しない。見ていない間に最初の未読行が画面の上へ流れた (最下部追従、差分の取り込み) ときや、既読位置が下がったときは起点を
取り直す。スレッドは返信の全件取得後だけ既読にする (§10.2)。「ここから未読にする」で位置を前へ進めるのも範囲が揃っている時だけ。
自分の投稿で既読位置を進めるのは、この端末からのトップレベル投稿の POST 応答だけ (自分の `message.created` では動かさない、§10.1 11.)。
その応答でも、再送で既に保存済みだった投稿 (`created` false) は保留を解くだけで位置を動かさず、自分の投稿より後の他人の行は未読のまま
数え直す (未読 0 にすると、次の表示で見ていない行を飛び越える)。シート (スレッド、チャンネル情報、メッセージのメニュー、検索など) に
覆われている間の行は見ていないものとして既読にしない (`CoverProbe`)。
最後のフレームから 60 秒で切断扱い、close 4001 は access token を更新して再接続 (§5.3)。バックグラウンドで iOS がソケットを止めた後は、
フォアグラウンド復帰 (`scenePhase == .active`) で再接続と catch_up を行う。プッシュ通知は M5 で追加する。
ローカルストアはサーバ URL とユーザー名のハッシュ名のファイルで、サインアウトで削除する (§11)。

## ワークスペース (M16c, docs/WORKSPACES.md)

登録したサーバの一覧は UserDefaults の `chikuwa.workspaces` (JSON) と `chikuwa.workspace.active`。旧版の `chikuwa.server` /
`chikuwa.username` は初回起動時に 1 件のワークスペースへ移行し (文字列はそのまま。Keychain とローカルストアの名前に使うため)、
以後はアクティブなワークスペースの値を映す。接続するのはアクティブな 1 つだけで、ほかは `GET /sync/summary` (復帰時と
切り替えシートを開いた時) とプッシュでバッジを知る。API クライアントはワークスペースごとに 1 つ (refresh を直列にするため)。
通知のタップは `workspace_id` → チャンネルを持つローカルストア → アクティブの順で振り分ける。

