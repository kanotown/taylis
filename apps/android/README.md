# apps/android

Android クライアント (M6)。Kotlin / Jetpack Compose / Coroutines + Flow。
Jetpack 標準 API を優先し、第三者依存は WebSocket クライアントの OkHttp のみ (CLAUDE.md "Android")。

## 構成

| ディレクトリ | 内容 |
| --- | --- |
| `app/src/main/java/jp/chikuwachat/android/api/` | `ApiClient` (OkHttp、Bearer 認証、`token_expired` 時の単一飛行リフレッシュ)、`Models` (OpenAPI と同じ snake_case ⇄ camelCase) |
| `.../sync/` | `SyncEngine` (SYNC_PROTOCOL.md §5–§9 のクライアント側手順)、`Store` (UI の唯一の真実、書き込みは `Persistence` に write-through)、`Frames` (WS フレーム)、`OkHttpWsTransport` |
| `.../platform/` | `RoomPersistence` (Room。JSON blob 行、単一スレッドで順序保証)、`SecretStore` (Android Keystore の AES-GCM 鍵で暗号化したリフレッシュトークンを DataStore に保存)、`Notifier` (DM のローカル通知) |
| `.../ui/` | Compose 画面: ログイン、初回パスワード変更、チャンネル一覧、タイムライン + コンポーザ、ダイアログ (DM / チャンネル作成 / メンバー追加 / 公開チャンネル参加)、本文トークナイザ |
| `.../app/AppController.kt` | ログイン・セッション復元・エンジンのライフサイクル (メインスレッドで動作、I/O は `ApiClient` 内で `Dispatchers.IO`) |
| `app/src/test/` | JVM テスト: `FakeServer` (プロトコルのインプロセス模型)、`SyncEngineTest`、`ContractTest` (`server/tests/contract/*.json` を実行)、`ApiClientTest`、`BodyTokenizerTest`、`LiveBackendTest` (`LIVE_URL` 指定時のみ) |

同期エンジンの状態変更はすべて 1 本のワークキュー (コルーチン) で直列に処理する。
WS フレームは bootstrap ステップの後ろに並ぶので、接続直後に届いたイベントは自然にバッファされる (§7.2)。
デスクトップ / iOS と同じ contract fixture を JUnit で回す。

## 必要なもの

- JDK 17 以上 (開発機は 21)
- Android SDK: `platforms;android-37.0`、`build-tools;37.0.0` (`sdkmanager --install ...`)
- Gradle は同梱の wrapper (`./gradlew`) が取得する。AGP 9.x の built-in Kotlin を使うので `kotlin-android` プラグインは適用しない。

SDK の場所は `local.properties` (`sdk.dir=...`、git 管理外) か環境変数 `ANDROID_HOME` で指定する。

## ビルド・テスト

```sh
cd apps/android
./gradlew :app:testDebugUnitTest      # JVM テスト (同期エンジン、契約 fixture、API クライアント)
./gradlew :app:lintDebug              # Android Lint
./gradlew :app:assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
```

バックエンドに対する疎通テスト (`infra/` の compose を起動し、ユーザーを 2 人用意しておく):

```sh
LIVE_URL=http://127.0.0.1:8000 LIVE_USER=alice LIVE_PASSWORD=... LIVE_PEER=bob LIVE_PEER_PASSWORD=... \
  ./gradlew :app:testDebugUnitTest --tests '*LiveBackendTest*' --rerun
```

## エミュレータで動かす

```sh
emulator -avd Pixel_9 &
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n jp.chikuwachat.android/.MainActivity
```

ログイン画面のサーバ URL 既定値は `http://10.0.2.2:8000` (エミュレータから見たホスト機)。
実機では Mac の LAN アドレス (`http://192.168.x.x:8000`) を入れる。
平文 HTTP は開発用に `usesCleartextTraffic` で許可している (iOS の ATS 設定と同じ)。本番は Caddy で TLS 終端する (SECURITY.md)。

## 通知

M6 では DM を受信したときにアプリ内 (WS 経由) でローカル通知を出す。バックグラウンドでソケットが
切れているときの通知は M7 の FCM で追加する (PUSH_NOTIFICATIONS.md §3 / §9)。
Android 13 以降は起動時に通知権限を求める。
