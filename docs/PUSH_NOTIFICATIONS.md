# PUSH_NOTIFICATIONS

iOS (APNs) と Android (FCM) へのプッシュ通知の設計。Desktop はプッシュを使わず、WS 経由のイベントから
アプリ自身が OS ネイティブ通知を出す (`devices.push_provider = 'none'`)。

## 1. 方針

- **プッシュは「新しいデータがあるかもしれない」という合図であって、同期の手段ではない。**
  欠落・遅延・重複・順序の入れ替わりを前提にする。ユーザーに見せる内容の真実は同期プロトコル
  (SYNC_PROTOCOL.md) で取得する。プッシュが 1 つも届かなくてもシステムは正しく動く。
- 送信の計画は Transactional Outbox の永続ハンドラで行い、送信状態は `push_deliveries` テーブルで管理する
  (at-least-once)。重複は端末側の collapse で無害化する。
- プロバイダ (APNs / FCM) の違いは `PushProvider` の実装に閉じ込める。

```
PushProvider
├── APNsPushProvider
├── FCMPushProvider
├── LogPushProvider    # 開発用 (設定が無い時の既定)
└── FakePushProvider   # テスト用
```

## 2. 構成と流れ

```
message.created (outbox)
   |
   v
OutboxRelay --> PushPlanner.handle(event, session)       [Relay の処理トランザクション内]
                  - 受信者を決める (§4)
                  - 受信者の有効な devices (push_token あり) ごとに push_deliveries を INSERT
                    (UNIQUE (event_id, device_id) で再処理時も 1 行)
   |
   v
PushSender (asyncio ループ。1 秒ごと、または Planner からの起床で)
   - SELECT pending AND next_attempt_at <= now() FOR UPDATE SKIP LOCKED LIMIT 50
   - 行ごとにリース (attempts += 1, next_attempt_at = now() + 60s) して COMMIT   ← ネットワーク I/O 中に行ロックを持たない
   - 送信直前の再判定: expires_at 超過 → skipped / 既読済み (last_read_seq >= message_seq) → skipped
   - provider.send(device, payload) を並列 10 まで
   - 結果で status を更新 (sent / pending+backoff / failed / トークン無効化)
   |
   v
APNs (HTTP/2, .p8 トークン認証)   FCM HTTP v1 (サービスアカウントの OAuth2)
```

メッセージのコミット後にサーバが落ちても outbox 行は残るので、通知イベントは失われない。
送信中にプロセスが落ちた場合、リース期限後に同じ行が再送される。端末側は `collapse_key` で
同一通知に畳むので二重表示にならない。

## 3. 端末とトークンの登録

端末 (`devices`) はログイン時にサーバが作る (DATA_MODEL.md `devices`)。プッシュトークンは後から登録する。

```
PUT /api/v1/devices/current
{ "push_provider": "apns", "push_token": "<hex>", "push_environment": "sandbox", "app_version": "1.0.0", "device_name": "iPhone" }
```

- 対象は現在のセッションに紐付く端末。`push_provider` / `push_token` / `push_environment` / `app_version` /
  `device_name` を更新する。
- 同じ `(push_provider, push_token)` が別の行にあれば、その行のトークンを NULL にしてから付け替える
  (端末を別ユーザーが使い始めた、または再ログインで新しい端末行ができた場合)。
- **ログアウト / セッション失効時に `enabled = false` にする** (ログアウト後の端末に通知を送らない)。
- クライアントはアプリ起動ごと、およびトークン更新 (APNs の `didRegisterForRemoteNotificationsWithDeviceToken`、
  FCM の `onNewToken`) のたびに登録し直す。トークンは変わるものとして扱う。
- 複数のワークスペース (サーバー) にサインインしている場合、同じトークンを各サーバーに登録する。
  トークンが変わったら全ワークスペースに登録し直す (WORKSPACES.md §8)。
- プロバイダから「無効なトークン」が返ったら `push_token = NULL`、`push_token_invalid_reason` を記録する。
  端末行自体は有効のまま。再登録で復活する。
- 1 ユーザーが複数端末・複数トークンを持つ前提。

### iOS の配布形態と APNs 環境

iOS アプリは App Store ではなく Xcode から登録済み実機に直接インストールする (CLAUDE.md)。
この場合の APNs 環境は **sandbox** (development 用プロビジョニングプロファイル) になる。
端末ごとに `push_environment` を持ち、`APNsPushProvider` はその値でホスト
(`api.sandbox.push.apple.com` / `api.push.apple.com`) を切り替える。サーバ側の固定設定にしない。
Ad Hoc / TestFlight / App Store に切り替えた端末は `production` として登録し直す。
プッシュには有料の Apple Developer Program と Push Notifications capability が必要。

## 4. 通知対象の判定 (PushPlanner)

対象イベントは `message.created` のみ (v1)。受信者は次の順で絞り込む。通知設定は
`notification_preferences` (行が無ければチャンネル種別の既定: DM は `all`、チャンネルは `mentions`)。

| 条件 | 判定 | 実装時期 |
| --- | --- | --- |
| 送信者本人 | 除外 | M5 |
| `type = system` のメッセージ | 除外 | M5 |
| `level = none`、または `muted_until > now()` | 除外 | M5 |
| 本文に本人の `notify_keywords` のどれかが含まれる (大文字小文字を区別しない部分一致、送信者自身は除く、M12g) | `messages.keyword_user_ids` に入り、`level = mentions` でも通知され、未読の mention_count と `GET /mentions` にも数えられる。この列はクライアントに送らない (他のメンバーに本人のキーワードが分かってしまうため。M16a)。PushPlanner は行から読む | M12g / M16a |
| `reminder.updated` (status=fired、M12e) | 本人の端末へ `kind = reminder` (タイトル「リマインダー」、本文はメモ + 設定時の本文、`channel_id` / `message_id` で該当メッセージを開く)。DND 中は出さない | M12e |
| 本人の `dnd_until > now()`、または quiet hours の時間帯 (本人のタイムゾーン、`users.quiet_hours_*`) | 除外 (M12c 「通知を一時停止」。バッジは次のプッシュ / 起動時に追いつく) | M12c |
| `level = all` (DM / グループ DM の既定) | 対象 | M5 |
| `level = mentions` (チャンネルの既定) | `mentioned_user_ids` か `keyword_user_ids` に含まれる、または `mention_all` の時だけ対象 | M8a (実装済み) |
| スレッド返信 | 上記に加え、スレッドのフォロワー (`thread_follows.following`: 親の投稿者、返信者、スレッド内でメンションされた人。手動で外した人は含まない) を対象 (level が `none` でなければ) | M8c → M11a (実装済み。`message.created` の `parent_thread.participant_ids` から判定、THREADS.md §4) |
| 既に既読 (`last_read_seq >= message.seq`) | 除外 | M8b (実装済み。送信直前にも再判定し `skipped / already_read`) |
| 別端末でアクティブ (§4.1) | 除外 | M5 |
| `push_token` を持つ有効な端末が無い | 除外 (Desktop のみのユーザー) | M5 |

### 4.1 アクティブ判定

WS の `ping` フレームに `{ "active": true|false }` を持たせ、クライアントはウィンドウがフォーカスされている /
アプリがフォアグラウンドの時に `true` を送る。Hub は user ごとに「最後に active だった時刻」を
メモリに持ち、**60 秒以内なら「ユーザーは今画面を見ている」と見なしてプッシュを出さない**
(Slack の「デスクトップで操作中はモバイルに通知しない」に相当)。

この状態はプロセスローカル (ARCHITECTURE.md §7)。Redis 導入時に外出しする。

### 4.2 バッジ (iOS)

`badge` = 受信者の「DM の未読数 + チャンネルのメンション数」の合計を計画時に数える (M8b で実装。受信者ごとに payload を作る)。
近似値でよい。アプリは起動時に bootstrap の値でバッジを上書きする。
複数のワークスペースを使う端末では各サーバーが自分の分だけの値を付けるので、アプリは全ワークスペースの
合計で上書きする (WORKSPACES.md §6)。

## 5. ペイロード

`push_deliveries.payload` に格納する共通形式。プロバイダ実装がそれぞれの形式に変換する。

```json
{
  "kind": "message",
  "workspace_id": "…",                 // 送ったデプロイ (WORKSPACES.md §3.3)。タップをワークスペースに振り分ける
  "channel_id": "…", "message_id": "…", "seq": 1533,
  "title": "#general",                 // DM なら相手の表示名
  "subtitle": "Alice",                 // チャンネルの場合の送信者。DM では省略
  "body": "本文の先頭 200 文字",         // PUSH_INCLUDE_CONTENT=false なら "新しいメッセージ"。重要度 (M15e) があれば先頭に "[重要] " / "[緊急] "
  "badge": 3,
  "collapse_key": "<channel_id>",
  "sent_at": "2026-09-25T13:00:00Z"
}
```

| 項目 | APNs | FCM (Android) |
| --- | --- | --- |
| 種別 | `apns-push-type: alert`、`apns-priority: 10`、`apns-topic: <bundle id>` | data-only メッセージ、`android.priority: HIGH` |
| 表示 | `aps.alert = {title, subtitle, body}`、`aps.sound = default`、`aps.badge`、`aps.thread-id = channel_id` | アプリが `onMessageReceived` で通知を組み立てる。`tag = channel_id` |
| 畳み込み | `apns-collapse-id = channel_id` | `android.collapse_key = channel_id` |
| 有効期限 | `apns-expiration = expires_at (unix)` | `android.ttl = 残り秒数` |
| データ | `aps` の外に上記 JSON をそのまま | `data` に文字列化して格納 |

Android を data-only にする理由: 通知の見た目・グルーピングをアプリで制御し、受信時に軽い同期を
走らせるため。iOS は APNs を直接使い、Firebase SDK に依存しない。

サイレントプッシュ (`kind = silent`、既読同期による通知消去など) は
APNs `content-available: 1` / `apns-push-type: background` / priority 5、FCM data-only / priority NORMAL。
v1 では使わない (§12)。

## 6. 送信・再試行

| 項目 | 値 |
| --- | --- |
| 有効期限 | 計画時刻 + 10 分 (`PUSH_ALERT_TTL_SECONDS`)。過ぎたら `skipped`。10 分後に届く通知は役に立たない |
| 再試行間隔 | 30 秒 → 2 分 → 10 分 (有効期限に収まる範囲で)。それ以上は `failed` |
| 同時送信数 | 10 |
| 送信前の再判定 | 既読済みならスキップ。端末が無効 / トークン無しならスキップ |

## 7. 重複・欠落・遅延への対応

| 問題 | 起こる場面 | 対策 |
| --- | --- | --- |
| 同じ通知が 2 回計画される | Relay が outbox を再処理 | `UNIQUE (event_id, device_id)` で 1 行に |
| 同じ通知が 2 回送られる | Sender が送信後・状態更新前に落ちる | `collapse_key` (チャンネル単位) で端末側が 1 つに畳む |
| 通知が届かない | プロバイダ側の破棄、端末オフライン、トークン失効 | アプリ起動 / 復帰時に必ず同期する。未読はサーバに残っているので失われない。失効トークンは NULL にして再登録を待つ |
| 遅れて届く | 端末のスリープ、プロバイダの遅延 | `expires_at` で古いものは送らない。既読済みなら送らない。届いた通知のタップ時は必ず最新を同期してから表示する |
| 順序が入れ替わる | プロバイダは順序を保証しない | 通知の順序に意味を持たせない。畳み込みで最新だけ見せる |
| 別端末で既に読んだ | Desktop で読んでいる間にモバイルに来る | 計画時と送信直前の既読チェック。アクティブ判定 (§4.1)。届いてしまった分の消去はサイレントプッシュで将来対応 (§12) |
| プロセス障害で送信が止まる | app プロセスの再起動 | `push_deliveries` は永続。再起動後に pending から再開 |

## 8. プロバイダ抽象

```python
class PushProvider(Protocol):
    provider: Literal["apns", "fcm"]

    async def send(self, device: Device, notification: PushPayload) -> PushResult: ...

@dataclass
class PushResult:
    outcome: Literal["sent", "retry", "invalid_token", "failed"]
    detail: str | None = None
    retry_after: timedelta | None = None
```

| 実装 | 用途 |
| --- | --- |
| `APNsPushProvider` | HTTP/2 + JWT (ES256, `.p8` キー)。`httpx` の HTTP/2 で直接叩く。端末の `push_environment` で sandbox / production のホストを切り替える。M5 |
| `FCMPushProvider` | FCM HTTP v1。サービスアカウント鍵 (JSON) から JWT bearer grant で OAuth2 アクセストークンを取得する (PyJWT の RS256。`google-auth` は不要)。data-only メッセージ、`android.priority` HIGH / NORMAL、`ttl`、`collapse_key`。M7 |
| `LogPushProvider` | 開発用。ログに出すだけ。設定が無い時の既定 |
| `FakePushProvider` | テスト用。呼び出しを記録する |

### プロバイダ応答の対応表

| プロバイダ応答 | outcome |
| --- | --- |
| APNs 200 | `sent` |
| APNs 400 `BadDeviceToken` / 410 `Unregistered` | `invalid_token` → `push_token = NULL` |
| APNs 403 (認証トークン不正) | `retry` (Provider が JWT を再生成) + エラーログ (設定ミスの可能性) |
| APNs 429 / 5xx | `retry` |
| APNs 413 (payload 大きすぎ) | `failed` (実装バグ) |
| FCM 200 | `sent` |
| FCM 404 `UNREGISTERED` / 400 `INVALID_ARGUMENT` (token) | `invalid_token` |
| FCM 401 / 403 | `retry` + エラーログ |
| FCM 429 `QUOTA_EXCEEDED` / 500 / 503 | `retry` (`Retry-After` を尊重) |

Provider の選択は起動時に設定から決め、`notifications` モジュール内のレジストリ
(`push_provider → PushProvider`) に登録する。設定が無いプロバイダは `LogPushProvider` になる。

## 9. クライアント側の挙動

| 場面 | iOS | Android |
| --- | --- | --- |
| 通知受信 (バックグラウンド) | OS が表示。`thread-id` でチャンネルごとにグループ化 | `onMessageReceived` で通知を表示 (`tag = channel_id`、チャンネルの通知チャネル)。可能なら軽い同期 (WorkManager) |
| 通知受信 (フォアグラウンド) | 開いている会話の通知は表示しない (WS で受信済み)。同じワークスペースの他の会話と、他のワークスペースの通知は表示する (WORKSPACES.md §7) | アクティブなワークスペースのプッシュは表示しない (WS から自前で通知を出すため)。他のワークスペースの通知は表示する |
| 通知タップ | `workspace_id` のワークスペースに切り替え、該当チャンネルを開き、通常の起動同期 (WS → bootstrap → catch_up) の後に表示 | 同左 |
| アプリ起動 / 復帰 | トークン登録 (§3)、バッジを bootstrap の値で更新、当該チャンネルの通知を消去 | 同左 |
| ログアウト | 何もしなくてよい (サーバがセッション失効時に端末を無効化) | 同左 |

## 10. 設定

```
PUSH_APNS_ENABLED=false
PUSH_APNS_KEY_PATH=/run/secrets/apns_key.p8     # 秘密鍵はコミットしない
PUSH_APNS_KEY_ID=
PUSH_APNS_TEAM_ID=
PUSH_APNS_BUNDLE_ID=
PUSH_FCM_ENABLED=false
PUSH_FCM_SERVICE_ACCOUNT_PATH=/run/secrets/fcm_service_account.json
PUSH_INCLUDE_CONTENT=true          # false で本文をプッシュに含めない
PUSH_ALERT_TTL_SECONDS=600
PUSH_ACTIVE_WINDOW_SECONDS=60
```

Team ID、Key ID、Bundle ID、鍵の場所はすべて環境変数または秘密ファイルから読む。

## 11. テストと運用

- `PushPlanner` の判定はユニットテスト (ルール表 §4 を 1 行 1 ケースで)。
- `PushSender` は `FakePushProvider` で at-least-once とリース、backoff、トークン無効化を検証。
- 実機確認: `uv run python -m app.cli push-test --user <username>` でテスト通知を送る。
- iOS は Apple Developer Program と実機が必要 (シミュレータは APNs を受け取れない)。
  Android は Google Play services 入りのエミュレータで確認できる。
- 監視: `push_deliveries` の `failed` 件数と `attempts` の分布をログに出す。

## 12. 将来の拡張 (今はやらない)

- 既読同期による通知の消去: `read.updated` からサイレントプッシュを計画し、端末側で当該チャンネルの
  通知を消す。`push_deliveries.kind = silent` の置き場所だけ用意してある。
- 通知の詳細設定 UI (quiet hours、キーワード通知)。判定ルール (§4) と `notification_preferences` の列追加で済む。
- Desktop への Web Push: Web クライアントを作る時に検討。

## 13. 実装メモ (M5)

- サーバ: `app/modules/notifications/` (planner / sender / providers / service / router)。Planner は `OutboxRelay` の
  永続ハンドラとして `main.py` で注入され、Sender は lifespan の背景タスク。設定は `PUSH_*`。
- `push-test` CLI: `uv run python -m app.cli push-test --user <username>` (compose では `docker compose exec app python -m app.cli push-test --user <username>`)。
- iOS: `AppDelegate` がトークンを受け取り `PushCenter` が `PUT /devices/current` で登録する。`aps-environment` は
  `ChikuwaChat.entitlements` で development (= sandbox)。埋め込みプロビジョニングプロファイルから環境を判定する。
- M8 で追加するもの: メンション時の通知 (`level = mentions`)、既読チェック、バッジの正確な数。

## 14. 実装メモ (M7)

- サーバ: `FCMPushProvider` (`providers.py`)。`build_providers` は `PUSH_FCM_ENABLED=true` のとき
  `PUSH_FCM_SERVICE_ACCOUNT_PATH` の JSON から生成する。アクセストークンは有効期限の 60 秒前に更新、
  401 / 403 ではトークンを捨てて `retry` (設定ミスをエラーログ)。`Retry-After` を尊重する。
  応答の対応表 (§8) を `tests/test_fcm_provider.py` で固定している。
- Android: `ChikuwaMessagingService` (`onNewToken` → `PushCenter.tokenReceived`、`onMessageReceived` →
  `AppController.handlePush`)。`PushCenter` はセッション開始時と復帰時にトークンを取得し、変わったときと
  新しいセッションのときだけ `PUT /devices/current` (`push_provider = fcm`) を送る。
  data-only メッセージはフォアグラウンドかつ WS 接続中なら表示しない (WS で届く)。それ以外は
  `Notifier` がチャンネルごとの通知 (id = channel_id) を出し、タップで該当チャンネルを開く。
  `google-services.json` が無いビルドでは Firebase が初期化されず、登録は静かにスキップされる。
- 未確認: 実際の Firebase プロジェクトでの受信 (infra/README.md の手順でユーザー側が設定する)。
