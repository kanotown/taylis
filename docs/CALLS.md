# CALLS：アプリ内の音声・ビデオ通話（LiveKit、M130〜、設計）

会話（チャンネル・DM・グループ DM）に付いた「通話」を、自前の LiveKit（SFU、Apache-2.0）でアプリの中で行う。
Slack のハドルと同じ形：会話で誰かが通話を始め、メンバーは出入りでき、会話とサイドバーに「通話中（n）」が出る。

**状態：M130（サーバと手元の infra・M117 の廃止）は実装済み（2026-10-07）。M131〜M136 は設計**。利用者の決定（2026-10-07）：
アプリ内の通話は LiveKit で作る。会議リンクの通話（M117）は要らないので **LiveKit の通話で置き換えて廃止する**（§11）。
M117 の設計は履歴として末尾の付録 A に残す。M130 で確かめたこと・設計からの違い・端末向けの API の要点は §13。

M117 のコードと他の文書にある「CALLS.md §n」（M117 の時点の節）は、付録 A の「A.n」を指す（M130〜M135 で M117 のコードを
消すときに直す）。

この文書で確かめられていない LiveKit の細部は「**要確認**」と書く（LiveKit の公開の文書 `docs.livekit.io` と
`config-sample.yaml` を 2026-10-07 に読んだ範囲）。M130 で手元の LiveKit（`livekit/livekit-server:v1.13.8`、dev モード）を
動かして確かめたものは「（M130 で確認）」と書き直した（§13.1）。残りは M131 で VPS の上で確かめる。

## 1. 範囲

| 項目 | v1 | 後で（理由） |
| --- | --- | --- |
| 音声の通話 | ○ DM・グループ DM・公開 / 非公開チャンネル。会話ごとに同時に 1 つ | — |
| ビデオ | ○ 3 端末（カメラは参加してから自分で入れる。既定はオフ） | — |
| 画面共有 | ○ Desktop / Web だけ | iOS は ReplayKit の Broadcast Upload Extension（別ターゲット・別プロセス・メモリ 50 MB の上限）、Android は MediaProjection と `mediaProjection` 型のフォアグラウンドサービスが要る。見るのは v1 から 3 端末ともできる |
| 「通話中（n）」の表示 | ○ 会話の見出し・サイドバー・DM の一覧 | — |
| 着信 | v1 は「ふつうのプッシュ」+ アプリを開いていればアプリ内のバナー（§4.4） | CallKit / ConnectionService の全画面の着信（§1.1） |
| スレッドの中の通話 | × | 要望が出たら |
| 電話網（PSTN・SIP） | × | 研究室の用途に無い |
| 録音・録画・文字起こし | × | 同意・保存・容量の設計が別に要る（LiveKit Egress を足すことになる） |
| 通話の中のチャット | × | 会話そのものがチャット。データチャネルは使わない |
| E2EE | × | §7.3 |
| ゲスト（`role = guest`）の参加 | ○ メンバーの会話だけ（投稿と同じ規則） | — |
| 会議リンク（M117） | **廃止**（§11） | — |

### 1.1 全画面の着信を後にする理由

- iOS で「電話のような着信」を出すには PushKit の VoIP プッシュと CallKit が要る。iOS 13 からは、VoIP プッシュを受けたら
  **必ず** すぐ CallKit に着信を報告しなければならず、報告しないとアプリが強制終了され、繰り返すと VoIP プッシュが
  届かなくなる。つまり「誰かが通話を始めた」を全部 VoIP で送ることはできず、DM の 1:1 だけ鳴らす・グループは鳴らさない・
  出たらすぐ CallKit と LiveKit の音声セッションをつなぐ、といった別の設計が要る。APNs の VoIP トピック（`<bundle>.voip`）も
  別に扱う。
- Android の全画面の通知（`USE_FULL_SCREEN_INTENT`）は Android 14 から通話・目覚ましのアプリだけに許され、Google Play の
  申告が要る。ConnectionService / `androidx.core.telecom` を使う。
- どちらも v1 の「通話ができる」には要らず、ストアの審査の論点を増やす。v1 はふつうのプッシュで足りる（研究室では
  多くの通話がその場の「今いい？」）。
- そのため `voip` のバックグラウンドモードは v1 では宣言しない（CallKit なしで宣言すると審査で問われる）。

## 2. 構成

```
                          ┌──────────── 1 台の VPS（compose の 1 プロジェクト）──────────────┐
端末 ─https/wss─▶ nginx ─▶ Caddy ─▶ app（FastAPI）──RoomService（HTTP、内部網）──▶ livekit:7880 │
 │                  │                   ▲                                           │       │
 │                  │                   └──── webhook（HTTP、内部網、署名つき）──────┘       │
 │                  └─wss livekit.<domain>──▶ 127.0.0.1:7880（シグナリング）               │
 └──── メディア：UDP 7882（ICE、1 ポート）／TCP 7881（ICE/TCP）／TURN 3478/udp・5349/tcp ───┘
```

- **LiveKit server** はアプリの compose に 1 コンテナで足す（イメージ `livekit/livekit-server`、版を固定）。TURN は LiveKit に
  組み込みのものを使う（coturn を別に立てない）。Redis は使わない（LiveKit は 1 ノードなら Redis なしで動く。複数ノードに
  なったら要る）。
- **認可はアプリのサーバに置く**。端末は LiveKit の API キーを知らない。アプリが会話のメンバーか・アーカイブ・ブロック・
  ワークスペースの設定を確かめてから、その通話の部屋だけに入れる短い **アクセストークン**（JWT）を渡す（§7.1）。
- **部屋の作成・終了はアプリが持つ**：通話を始めるとアプリが `calls` の行を作り、LiveKit の RoomService で部屋を作る。
  端末に `roomCreate` の権限は渡さない。
- **参加者の出入りは LiveKit の webhook** でアプリに届き、`call_participants` を更新して「通話中（n）」を配る。webhook が
  欠けても正しくなるよう、通話がある間は RoomService で突き合わせる（§3.3）。
- アプリと LiveKit の間（RoomService・webhook）は compose の内部網だけを通す（`http://livekit:7880`・`http://app:8000`）。
  公開の Caddy は webhook のパスを外に出さない（§7.4）。
- **サーバのライブラリ**：Python の `livekit-api` は使わない（aiohttp・protobuf を連れてくる）。必要なのは 3 つだけで、
  今の依存で書ける：トークンの発行（`pyjwt`、HS256）、webhook の検証（`pyjwt` + SHA-256）、RoomService（Twirp の JSON を
  `httpx` で POST）。`LiveKitGateway` の Protocol（実装：`HttpLiveKitGateway` と試験用の `FakeLiveKitGateway`）に閉じ込め、
  ほかのモジュールは LiveKit を直接呼ばない（PushProvider と同じ考え）。
- EventBus・outbox・同期の仕組みは今のまま。通話の状態の変化は seq を使わないイベント（§5.3）、通話の始まりと終わりは
  メッセージ（seq あり）で残る。

### 2.1 部屋の一生

| 段階 | 起きること |
| --- | --- |
| 始める | `POST /channels/{id}/huddle`（§5.2）。その会話に進行中の通話が無ければ、1 つのトランザクションで `calls` の行と通話のメッセージ（`message.created`、プッシュ、§6）を書き、**コミットの前に** RoomService `CreateRoom`（`empty_timeout`・`departure_timeout`・`max_participants`）。LiveKit に届かなければロールバックして `503 calls_unavailable`（何も投稿されず、誰にも通知が行かない。M130 の実装。コミットが後で失敗したときに残る空の部屋は `empty_timeout` で LiveKit が消す）。進行中の通話があれば新しく作らずそれに参加する |
| 参加 | トークンを渡す（始めた人にも）。端末が LiveKit につながると webhook `participant_joined` → `call_participants` に行 → `call.updated` |
| 退出 | 端末が切る・アプリを閉じる → `participant_left` → 行に `left_at` → `call.updated` |
| 終わる | 最後の人が出て `departure_timeout`（20 秒）経つと LiveKit が部屋を閉じる → `room_finished` → `calls.ended_at` → 通話のメッセージを更新（`message.updated` の `change: "call"`、「通話 · 12 分 · 参加者 4 人」）と `call.ended` |
| 誰も来ない | 始めたのに誰もつながらない（アプリが落ちた等）：`empty_timeout`（2 分）で LiveKit が閉じる。webhook が来なくても §3.3 の突き合わせで終える |
| 会話のアーカイブ・メンバーから外す・アカウントの無効化 | アプリが RoomService で `DeleteRoom`（アーカイブ）・`RemoveParticipant`（外された人）を呼ぶ |

- 会話ごとに進行中の通話は 1 つ（`calls (channel_id) WHERE ended_at IS NULL` の一意索引で競合も防ぐ）。
- **部屋の名前 = 通話の id**（UUIDv4、122 ビットの乱数）。推測できないが、守りはトークン（部屋の名前を知っても入れない）。
- **identity = ユーザーの id**。同じ人が 2 台目で入ると、LiveKit は同じ identity の古い接続を切る（`DUPLICATE_IDENTITY`）。
  これを「通話を別の端末へ移す」として使う（2 台で同時に入ると音が回り込むため、1 人 1 接続の方がよい）。古い端末は
  「別の端末で通話に参加しました」を出す。
- 1 つの通話の上限は 50 人（環境変数 `LIVEKIT_MAX_PARTICIPANTS`、LiveKit の `max_participants` にも渡す）。超えると `409 call_full`。

## 3. サーバ

### 3.1 データ（移行は M130）

```text
calls
- id                  uuid PK（= LiveKit の部屋の名前）
- channel_id          FK channels
- message_id          FK messages UNIQUE（通話のメッセージ）
- started_by          FK users
- started_at          timestamptz（サーバの時刻）
- ended_at            timestamptz NULL
- end_reason          text NULL  -- 'empty' | 'reconciled' | 'archived' | 'admin'
- peak_participants   int  -- 同時に居た人数の最大
- participant_count   int  -- 1 回でも入った人（人の数、重複なし）
- UNIQUE INDEX (channel_id) WHERE ended_at IS NULL

call_participants
- id            uuid PK
- call_id       FK calls
- user_id       FK users
- livekit_sid   text UNIQUE（LiveKit の参加者の sid。webhook の重複・順序の入れ替わりを吸収する鍵）
- joined_at     timestamptz
- left_at       timestamptz NULL
- INDEX (call_id) WHERE left_at IS NULL

messages
- call_id       uuid NULL FK calls（LiveKit の通話のメッセージ）
- call_url      text NULL（M117 の会議リンク。履歴として残す、§11）

workspace_settings
- in_app_calls_enabled  bool NOT NULL DEFAULT true（管理者のスイッチ。サーバに LiveKit が設定されていなければ効かない）
- meeting_base_url      text NULL（M117。M130 で NULL にし、読まない。列は 1 リリース後の移行で消す）
```

- 1 つの接続 = 1 行（同じ人が出入りすれば行が増える）。「今いる人」= `left_at IS NULL` の行の `user_id`（重複を除く）。
- 保存期間はメッセージと同じ（消さない）。誰がいつ通話に居たかは会話のメンバーには見えてよい情報（Slack と同じ）。

### 3.2 webhook

- LiveKit の `webhook.urls` に `http://app:8000/api/v1/livekit/webhook`、`webhook.api_key` にアプリと同じキー。
- **検証**（M130 で確認）：`Authorization` ヘッダにそのまま JWT が入る（`Bearer` は付かない）。HS256、API シークレットで署名、
  `iss` = API キー、`nbf`・`iat`・`exp`（**5 分**。LiveKit の `protocol/webhook/url_notifier.go` の `SetValidFor(5 * time.Minute)`）、
  クレーム `sha256` = 本文の SHA-256 の **標準の base64**（パディングあり、`base64.StdEncoding`）。`Content-Type` は
  `application/webhook+json`、`User-Agent: LiveKit`。本文は protobuf の JSON（**camelCase**：`joinedAt`・`numParticipants`、
  int64 は文字列 `"1791329539"`）。アプリはこれを確かめ、合わなければ `401`（ログに残す。本文は処理しない）。期限の検査には
  60 秒の余裕を見る。本物の LiveKit が送った 4 つ（`room_started`・`participant_joined`・`participant_left`・`room_finished`）を
  `server/tests/fixtures/livekit_webhooks.json` に記録し、試験はそれを検証する。
- 再送の重複・5 分以内の再生（replay）は、処理が冪等なので害が無い（`livekit_sid` で 1 行、終わった通話・知らない部屋は捨てる）。
- 扱うイベント：`participant_joined`・`participant_left`・`room_finished`（`room_started` は使わない。部屋はアプリが作る）。
  `track_published` などは捨てる（v1 は「カメラを入れている人」をサーバで持たない）。
- 知らない部屋（ほかのサーバの部屋、終わった通話）は `200` で捨てる。重複・順序の入れ替わりは `livekit_sid` で吸収
  （先に `left` が来たら、参加者の情報の `joined_at` で行を作って閉じる）。処理は冪等。
- LiveKit の webhook は URL ごとの待ち行列（既定 100 件、あふれたら **捨てる**）と 10 の worker で送り、失敗は
  go-retryablehttp で再送する（LiveKit は回数を設定していないので retryablehttp の既定。`url_notifier.go` を 2026-10-07 に
  読んだ範囲。retryablehttp の既定の値（4 回・1〜30 秒）は読んでいない）。欠けは §3.3 で直す。
- `room_started` と `track_published` などは捨てる（M130 の実装は `participant_joined`・`participant_left`・`room_finished` だけ）。

### 3.3 突き合わせ（webhook が欠けたとき）

- アプリの中の定期の作業（今の outbox の worker と同じプロセス）：進行中の通話があるときだけ 60 秒ごと、と起動したとき。
  `ListRooms` と各部屋の `ListParticipants` を取り、`call_participants` と `calls` を正す：
  - LiveKit に居てアプリに無い人 → 行を作る。アプリで開いたままで LiveKit に居ない人 → `left_at` を入れる。
  - 部屋が無い・2 分以上誰も居ない → 通話を終える（`end_reason = 'reconciled'`、部屋が残っていれば `DeleteRoom`）。
- LiveKit に届かない（落ちている・再起動中）ときは何も終えない（誤って終えない）。5 分続けば警告のログ。
- 変化があれば webhook のときと同じイベントを出す。

### 3.4 設定（環境変数、infra/.env）

| 変数 | 例 | 意味 |
| --- | --- | --- |
| `LIVEKIT_URL` | `wss://livekit.chat.example.com` | 端末がつなぐ URL（トークンと一緒に返す） |
| `LIVEKIT_API_URL` | `http://livekit:7880` | アプリから RoomService |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET_FILE` | `taylis` / `/run/secrets/livekit_api_secret` | キーとシークレット（シークレットはファイル。リポジトリに入れない。本番（`ENVIRONMENT=production`）では 32 バイト未満なら通話はオフになり、ログに出る） |
| `LIVEKIT_API_SECRET` | `secret` | 手元の開発だけ（LiveKit の dev モードの決まったシークレット）。ファイルがあればファイルが優先 |
| `LIVEKIT_RECONCILE_INTERVAL_SECONDS` | `60` | §3.3 の突き合わせの間隔 |
| `LIVEKIT_MAX_PARTICIPANTS` | `50` | 1 通話の上限 |
| `LIVEKIT_TOKEN_TTL_SECONDS` | `600` | トークンの期限 |

4 つ（URL・API の URL・キー・シークレット）がそろったときだけ通話が使える（`in_app_calls_enabled` の実効値、§5.1）。

## 4. 端末

### 4.1 SDK と依存

| 端末 | SDK | ライセンス | 大きさ（目安、**要実測**） | 注意 |
| --- | --- | --- | --- | --- |
| Desktop / Web | `livekit-client`（npm） | Apache-2.0 | 圧縮前で数百 KB の JS。通話の画面を開いたときだけ読み込む（動的 import） | ブラウザ（WKWebView・WebView2）の WebRTC を使うのでネイティブの追加は無い |
| iOS | LiveKit Swift SDK（SPM） | Apache-2.0（中の WebRTC は BSD-3） | WebRTC のバイナリでアプリが 10〜20 MB 程度増える | bitcode は Xcode 14 で廃止済みで関係ない。依存（swift-protobuf など）を M134 で一覧にする |
| Android | LiveKit Android SDK（`io.livekit:livekit-android`） | Apache-2.0（WebRTC は BSD-3） | ネイティブの WebRTC が ABI ごとに 10 MB 前後。AAB なので端末の ABI の分だけ届く | R8（§4.5）。依存（protobuf-javalite など）を `./gradlew :app:dependencies` で確かめる |

**依存を足す理由**（CLAUDE.md「不要な第三者の依存を避ける」）：WebRTC の SFU とのやり取り（シグナリング・ICE・
simulcast・帯域の調整・再接続）は自分で書くものではない。iOS / Android の標準 API に WebRTC は無い。3 つとも LiveKit の
公式で、サーバと同じプロトコルの版を追う。`THIRD_PARTY_NOTICES.md` に足す。

### 4.2 権限

| 端末 | 要るもの |
| --- | --- |
| iOS | `NSMicrophoneUsageDescription`（新しく。3 言語、InfoPlist.xcstrings）、`NSCameraUsageDescription`（今は写真の添付の文。「通話と写真」に直す）、`UIBackgroundModes` = `audio`（通話中に画面を消しても・ほかのアプリへ移っても音を続ける。`voip` は宣言しない、§1.1）。`PrivacyInfo.xcprivacy` の収集データに「音声・映像」は入れない（サーバに保存しない。中継だけ。M103 の表を見直す） |
| Android | `RECORD_AUDIO`・`CAMERA`（実行時。通話に入るとき・カメラを入れるときに聞く）、`MODIFY_AUDIO_SETTINGS`、`BLUETOOTH_CONNECT`（Android 12+、ヘッドセット）、`FOREGROUND_SERVICE`・`FOREGROUND_SERVICE_MICROPHONE`・`FOREGROUND_SERVICE_CAMERA`。通話中はフォアグラウンドサービス（`foregroundServiceType="microphone\|camera"`）と常駐の通知（「通話中 · #研究室 · 退出」）。Android 14+ では型ごとの権限が要り、マイク・カメラの型は **アプリが前面にあるときにしか始められない**（通話に入る操作のときに始める。後ろからは始めない） |
| macOS（Tauri） | バンドルの `Info.plist` に `NSMicrophoneUsageDescription`・`NSCameraUsageDescription`。署名（今は ad-hoc の `signingIdentity: "-"`）で hardened runtime を使うなら entitlements に `com.apple.security.device.audio-input`・`com.apple.security.device.camera`。画面共有は「画面収録」の許可（システム設定）を利用者が与える。WKWebView の `getUserMedia` は、アプリがマイク・カメラの権限を持てば使える。wry は v0.35.1 で macOS 14 以降の画面共有の許可のダイアログを直している。Tauri の今の版（2.11 系）で `getUserMedia`・`getDisplayMedia` が動くか、許可のプロンプトが毎回出ないか（wry の権限ハンドラ）は **M132 の最初に試して確かめる**（動かなければ画面共有は Desktop では Web に回す） |
| Windows（WebView2） | WebView2 は既定で許可のプロンプトを出す（サイトごと）。Tauri の権限ハンドラで自分のオリジンだけを許すか、プロンプトのままにするかを M132 で決める。OS の「マイクへのアクセス」がオフなら案内を出す |
| Web | https が要る（本番は https）。Caddy の CSP の `connect-src` に `LIVEKIT_URL` のホスト（`wss:` と `https:`）を足す（今は `'self'` だけ）。Tauri の CSP は `wss:`・`https:` を既に許している |

### 4.3 画面

- **Desktop / Web**：
  - 会話の見出しに「🎧 通話」（進行中なら「参加（n）」と居る人のアバター）。サイドバーの行に 🎧 と人数。
  - 参加すると、メッセージの上に **通話のペイン**（タイル：アバター / 映像、話している人の枠を光らせる）。サイドバーの下に
    **通話のバー**（会話の名前・経過時間・ミュート・カメラ・画面共有・退出・⚙ で入力 / 出力 / カメラの選択）。別の会話へ
    移ってもバーは残り、ペインは開いた会話でだけ出す（Slack のハドルと同じ）。画面共有は大きく、ほかは小さいタイル。
  - タイルが多いとき（10 人超）は話している人と画面共有を優先し、ほかはアバターの列。
  - 入るときはマイクはオン・カメラはオフ。8 人以上が居る通話にはマイクをオフで入る。
- **iOS / Android**：会話の見出しの 🎧。参加すると **全画面の通話の画面**（タイル・ミュート・カメラ・スピーカー切替・
  退出）。下へ払うと小さく畳み、アプリのどこでも画面の上に **細いバー**（「通話中 · #研究室 · 00:12 · 🎙」、タップで戻る）。
  - 音の出口：iOS は `AVAudioSession` の `.playAndRecord` + `.voiceChat`（ビデオのときは `.videoChat`）、既定はビデオなら
    スピーカー・音声だけなら受話口、Bluetooth を許す。出口の選択は `AVRoutePickerView`。Android は `AudioManager` の
    通信モード（`setCommunicationDevice`、Android 12+）でスピーカー / 受話口 / Bluetooth を選ぶ。LiveKit の SDK の音の
    扱いに任せられる所は任せる（要確認：iOS の SDK が AVAudioSession を自分で設定するか）。
  - バックグラウンド：iOS は `audio` のバックグラウンドモードで続く（カメラは iOS がバックグラウンドで止める。戻ったら
    再開）。Android はフォアグラウンドサービスで続く。アプリを強制終了したら退出（webhook で反映）。
- **通話のカード**（メッセージ）：進行中は「🎧 〇〇 さんが通話を始めました · 参加者のアバター · [参加]」、終わったら
  「🎧 通話 · 12 分 · 参加者 4 人」（参加ボタンなし）。カードの数字はメッセージの `call` から（§5.4）。
- 用語：「通話」はそのまま（glossary.json）。ボタンは「通話を始める」「参加」「退出」。

### 4.4 着信（v1）

- **プッシュ**：通話のメッセージの `message.created` からいつものプッシュ（対象はメッセージと同じ規則、§6）。タップで
  会話を開く（自動では入らない。会話の「参加」で入る）。
- **アプリ内のバナー**：アプリを開いている人には `call.started` で、DM・グループ DM だけ「〇〇 さんが通話を始めました
  [参加] [×]」を 30 秒出す（チャンネルは見出しとサイドバーの表示だけ。Slack のハドルと同じく鳴らさない）。音は短い
  通知音を 1 回（鳴り続けない）。ミュートした会話・おやすみ中（DND）・ブロックした人が始めた通話では出さない。

### 4.5 Android の R8

リリースは R8（2026-10-06 から `isMinifyEnabled = true`）。WebRTC は JNI からクラス名で Java を呼ぶので、`org.webrtc.**`
と LiveKit の JNI・protobuf のクラスを残す規則が要る。LiveKit Android SDK が consumer の ProGuard 規則を同梱しているか
は **要確認**（同梱なら追加なし。無ければ `proguard-rules.pro` に `-keep class org.webrtc.** { *; }` と LiveKit の README の
規則）。完了条件に「**リリースビルド**で 2 台が通話できる」を入れる（デバッグでは R8 の抜けが見えない）。

### 4.6 古い端末で通話しないこと

`in_app_calls_enabled` を知らない端末（M130 より前）は 🎧 を出さない。§11.3 も見ること。

## 5. API・イベント

### 5.1 設定

- bootstrap の `workspace_settings` と `workspace.settings_updated` の `settings`：
  - `in_app_calls`：`{ enabled: bool, video: bool, screen_share: bool }`。`enabled` = 管理者のスイッチ **かつ** サーバに LiveKit が
    設定されている。`video` / `screen_share` は v1 では `enabled` と同じ（後で管理者が切れるように形だけ分ける）。
  - `calls_enabled`：**M117 の古い端末向けに、いつも `false`**（§11）。`meeting_base_url`：いつも `null`。
- `PATCH /admin/workspace-settings {in_app_calls_enabled}`（管理者だけ、監査 `workspace.settings_updated`）。オフにしても
  進行中の通話は切らない（新しく始められないだけ）。`meeting_base_url` を送ってきたら `409 meeting_links_retired`（古い
  Desktop の管理画面。黙って捨てない）。

### 5.2 エンドポイント（`/api/v1`）

| メソッドとパス | 本文 → 応答 | 説明 |
| --- | --- | --- |
| `POST /channels/{id}/huddle` | `{client_msg_id}` → `201 {call, message, join}` / `200`（再送、または進行中の通話に参加） | 始める（無ければ）か参加する。`join = {url, token, expires_at}` |
| `POST /calls/{id}/join` | — → `200 {call, join}` | 参加・つなぎ直し（トークンの取り直し）。終わった通話は `409 call_ended` |
| `POST /calls/{id}/leave` | — → `204` | 退出（LiveKit から切ったうえでの念押し。`RemoveParticipant` を呼び、行を閉じる。webhook が後から来ても冪等） |
| `GET /calls/{id}` | → `200 {call}` | 通話（居る人を含む）。メンバーだけ |
| `GET /calls?active=true` | → `200 {calls: [...]}` | 自分がメンバーの会話の進行中の通話（つなぎ直したときの読み直し） |
| `POST /livekit/webhook` | LiveKit のイベント → `200` | §3.2。Caddy は外から通さない |
| `POST /channels/{id}/calls` | M117 | **廃止**：いつも `409 calls_disabled`（§11） |

- パスを `…/calls` から変えるのは、M117 の古い端末が同じパスに `{client_msg_id}` を送り、返事の `url` をブラウザで開くため
  （同じパスで LiveKit の答えを返すと、古い端末が `wss://` の URL を開こうとする）。
- **始められる・入れる人**：その会話にトップレベルのメッセージを投稿できる人（メンバー、アナウンスのチャンネルは
  オーナーと管理者が始め、参加はメンバー全員）。1:1 の DM で、どちらかがもう一方をブロックしていれば `403 dm_unavailable`
  （§7.2）。アーカイブは `409 channel_archived`、オフは `409 calls_disabled`、LiveKit に届かないと `503 calls_unavailable`。
- **冪等**：`client_msg_id` は通話のメッセージの冪等キー。同じキーの再送は同じ通話とメッセージを返す（トークンは新しく）。
  進行中の通話がある会話に別のキーで送ると、新しいメッセージを作らずその通話に参加する（`200`、`message` はその通話の
  メッセージ）。
- `CallOut`：`{ id, channel_id, message_id, started_by, started_at, ended_at, participants: [{user_id, joined_at}],
  participant_count, peak_participants }`。
- レート：始める 10 回 / 分・人、参加 30 回 / 分・人（`429 rate_limited`）。
- 新しいエラーコード（apps/shared/errors.json、3 言語）：`call_not_found`（404）・`call_ended`（409）・`call_full`（409）・
  `calls_unavailable`（503）・`meeting_links_retired`（409）。`calls_disabled` は残す。`meeting_url_invalid` は古い端末の
  ために表に残し、サーバは出さなくなる。

### 5.3 WebSocket のイベント（seq なし）

| type | audience | data |
| --- | --- | --- |
| `call.started` | channel | `{ call }`（始めた人だけが居る） |
| `call.updated` | channel | `{ call }`（参加・退出のたび。端末は id で差し替える） |
| `call.ended` | channel | `{ call }`（`ended_at` あり） |

- seq を使わないので欠けてよい：つなぎ直したら `GET /calls?active=true` で差し替える。bootstrap にも `active_calls` を入れる。
- 通話の始まりと終わりの **記録** はメッセージ（`message.created` と `message.updated` の `change: "call"`）で seq を持つ。
- ws-events.json に足す。

### 5.4 メッセージ

- 通話のメッセージは `type = "user"`、送った人は始めた人、本文は `🎧 通話を始めました` + 改行 + `<PUBLIC_BASE_URL>/call/<id>`
  （ワークスペースの言語。古い端末・検索・通知の 1 行のため）。
- `MessageOut.call` は M117 の形 `{url, started_by}` を保ったまま広げる：
  `{ kind: "livekit", url: "<PUBLIC_BASE_URL>/call/<id>", started_by, call_id, started_at, ended_at, duration_seconds, participant_count }`。
  M117 のメッセージは `{ kind: "link", url: "<会議の URL>", started_by }`。古い端末は知らない項目を読み飛ばす（3 端末とも
  M117 の時点で余分な項目を許す作り。**M130 の試験で古い版の解読を確かめる**）。
- 通話が終わったら `ended_at`・`duration_seconds`・`participant_count` を入れて `message.updated`（`change: "call"`、seq を 1 つ）。
- `<PUBLIC_BASE_URL>/call/<id>` は Web クライアントのページ（ログインの後もこのパスを保ち、その通話の会話を開いて参加の
  確認を出す）。古い端末の「参加する」・本文のリンクはこれを外のブラウザで開くので、古い端末の人もブラウザで入れる。
  `PUBLIC_BASE_URL` が無いサーバでは本文に URL を付けず、`call.url` はパスだけの `/call/<id>`（**null にしない**：出してある
  Android 1.0.2 は null の `url` を読めずメッセージを落とす。§13.2）。

## 6. 通知

| 場面 | 文（ja / en / zh-Hans。`server/app/i18n/messages.json`） | 対象 |
| --- | --- | --- |
| 通話が始まった | `🎧 〇〇 さんが通話を始めました` / `🎧 〇〇 started a call` / `🎧 〇〇 发起了通话`（M117 の `push.call.started` を、絵文字だけ 📞 → 🎧 に） | ふつうのメッセージと同じ（DM・グループ DM は届き、チャンネルはその人の通知の設定。ブロックした人が始めたものは出さない） |
| 参加・退出・終わり | プッシュしない | — |

- 始めた人の他の端末には送らない（今の規則どおり）。プッシュは起床のヒントで、端末は同期してから会話を見せる（D11）。
- アイコン付きの通知（PUSH_NOTIFICATIONS.md §16）はそのまま使える。

## 7. セキュリティ・プライバシー

### 7.1 トークン

- HS256 の JWT、`iss` = API キー、`sub` = identity（ユーザーの id）、`name` = 表示名、`exp` = 10 分、`nbf`、
  `video = { room: <call id>, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false,
  canPublishSources: ["microphone", "camera", "screen_share", "screen_share_audio"], canUpdateOwnMetadata: false }`。
  `roomCreate`・`roomAdmin`・`roomList`・`recorder`・`hidden` は付けない。`metadata` は `{ "avatar_version": n }` だけ。
- `canPublishSources` は設定から作る（`video` がオフなら `microphone` だけ、`screen_share` がオフなら画面共有を外す。iOS /
  Android は v1 では画面共有を外す）。
- 期限はつなぐときにだけ要る。LiveKit はつながっている間に新しいトークンを端末へ配り、短い切断のつなぎ直しはそれで足りる
  （要確認：LiveKit の token refresh の挙動）。長い切断の後は `POST /calls/{id}/join` で取り直す。
- トークンはログに出さない。応答は `Cache-Control: no-store`。

### 7.2 誰が入れるか

- メンバーだけ（公開チャンネルでも、入っていなければ `403 not_a_member`）。ゲストは入っている会話だけ。ボットは入れない。
- 会話から外された・無効化された人は、アプリが `RemoveParticipant` で切る（その時点のトークンでは入り直せない：部屋への
  再参加はトークンの期限の内なら可能なので、`join` を拒むだけでなく切ることで防ぐ。残る隙は最長 10 分のトークンの期限）。
- **ブロック**（MODERATION.md §4）：
  - 1:1 の DM：どちらかがブロックしていれば始めることも入ることもできない（`403 dm_unavailable`。投稿より強い。声は
    「折りたたむ」ことができないため）。
  - グループ DM・チャンネル：拒まない（投稿と同じく、ほかの人との会話を壊さない）。ブロックした人の通話の開始は
    プッシュもバナーも出さない。通話の中で相手の声は聞こえる（受け入れる差。端末は相手のタイルに「ブロック中」の印を
    付け、その人の音声を自分だけミュートできるボタンを出す）。
- 管理者の特権は無い（管理者でもメンバーでない会話の通話には入れない。メッセージを読む規則と同じ）。

### 7.3 E2EE をしない理由（v1）

- メディアは端末と LiveKit の間で DTLS-SRTP で暗号化される。LiveKit は自前のサーバで、メッセージ（E2EE でない、
  ARCHITECTURE.md §1 の非目標）と同じ信頼の境界に入る。
- LiveKit の E2EE（Insertable Streams）は鍵の配り方・端末の対応（WKWebView・WebView2・Safari の差）・CPU の負担を足す。
  研究室の規模で得るものが少ない。将来は「鍵をアプリが配る」形で足せる（部屋ごとの鍵を `join` の応答に載せる）。

### 7.4 そのほか

- **API のシークレット**：`infra/secrets/livekit_api_secret`（32 バイト以上の乱数、ファイル 600）。LiveKit の設定には
  `keys` に同じものを環境変数で渡す。リポジトリに入れない。
- **webhook**：署名で守る（§3.2）。さらに Caddy で `/api/v1/livekit/*` を外から `404` にし、compose の内部網からだけ届く
  ようにする。
- **TURN の資格情報**：LiveKit の組み込み TURN は、つないだ端末に部屋ごとの一時的な資格情報を渡す（要確認）。固定の
  TURN のパスワードは作らない。外の誰でも使える TURN（オープンリレー）にしない。
- **ポート 7880**（シグナリングと RoomService）はホストの `127.0.0.1` にだけ出す。外から RoomService を叩けない。
- **監査ログ**：設定の変更（`workspace.settings_updated`）。通話そのものは `calls` / `call_participants` が記録（監査ログには
  入れない。メッセージと同じ扱い）。管理者が通話を終わらせる操作は v1 には無い。
- 録音しない。LiveKit のログに残るのは identity（ユーザーの id）・部屋の名前・IP。ログの保存は今の compose の既定（json-file）。

## 8. ネットワークと infra

### 8.1 LiveKit が使うポート（LiveKit の文書「Ports and firewall」2026-10-07）

| 用途 | 既定 | この設計 | 外に開けるか |
| --- | --- | --- | --- |
| シグナリング（WebSocket）と API | 7880/tcp | `127.0.0.1:7880`、nginx が `livekit.<domain>` の 443 から渡す | 開けない |
| ICE/TCP（UDP が通らない網の逃げ道） | 7881/tcp | 7881/tcp | 開ける |
| ICE/UDP | 50000–60000/udp（参加者 1 人に 2 つ）か、1 ポートにまとめる `rtc.udp_port`（例 7882） | **7882/udp の 1 ポート** | 開ける |
| TURN/UDP（STUN も） | 3478/udp | 3478/udp | 開ける |
| TURN/TLS | 5349/tcp（LiveKit の文書：ロードバランサが無ければ 443 に置くべき） | **5349/tcp**（443 は nginx が持つ） | 開ける |
| TURN のリレー | `relay_range_start/end`（1.13.8 の起動ログでは 30000–40000） | 組み込み TURN と SFU は同じコンテナの中で話すので外には要らない見込み（**要確認**：リレーは SFU の公開の候補（`NODE_IP`:7882）へ送るので、Docker のヘアピン NAT を通る。M131 で TURN だけの経路（`iceTransportPolicy: relay`）を試す） | 開けない |

- **1 ポートの UDP（7882）を選ぶ理由**：ファイアウォールの穴が 1 つで済み、Docker のブリッジ網のポートの割り当てでも
  そのまま動く（1 万ポートの範囲をブリッジで出すのは重く、LiveKit は範囲を使うならホスト網を勧める）。30 人規模なら
  1 ポートで足りる。
- **シグナリングは専用のホスト名**（`livekit.<domain>`）にする。LiveKit の SDK は URL の後ろに `/rtc` などを足してつなぐ
  ので、`chat.example.com/livekit/` のようなパスの下に置くと書き換えが要り、壊れやすい（パスの下で動くかは要確認で、
  試さない）。
- **TURN/TLS を 443 にできない問題**：共用の VPS では nginx が 443 を持つ（D22）。443 で TURN/TLS も受けるには nginx の
  `stream` モジュールの SNI の振り分け（`ssl_preread`）で、今の全サイトの `listen 443` を内側のポートに移す必要がある。
  20 ほどのほかのサイトに手を入れるので **v1 ではやらない**。5349/tcp に置く。
  - 大学の網は 443 以外の外向きを閉じていることがある。そのときは ICE/UDP・ICE/TCP 7881・TURN 3478・5349 のどれも通らず、
    通話はつながらない（チャットは 443 なので使える）。**M131 で研究室の網・学内の Wi-Fi・携帯の回線から実測する**。
  - 通らなかったときの選択肢（どれも利用者の判断）：（1）VPS に 2 つ目の IP アドレスを足し、その 443 を LiveKit の TURN/TLS に
    渡す（VPS の契約で追加の IP が取れるかは要確認）、（2）nginx の `stream` の SNI 振り分け（全サイトの設定が変わる）、
    （3）443 の空いた小さな VPS（2 vCPU / 2〜4 GB）を LiveKit 専用にする（いちばん素直）。
- **TURN の証明書**：TURN/TLS は `livekit.<domain>` の証明書をそのまま使う（ポートが違うのでシグナリングと同じ名前でよい。
  LiveKit の生成ツールが TURN に別の名前を使うのは、443 で SNI を振り分けるため）。nginx の certbot が取った証明書を
  読み取り専用でコンテナに入れ、更新の後に LiveKit を再起動する（その証明書だけの `renew_hook`。LiveKit が証明書を
  読み直すかは要確認）。

### 8.2 LiveKit の設定（M130：`infra/livekit.yaml`）

設計の下書き（下）から変えた点：テンプレートにせず、サーバごとの値は環境変数で渡す（LiveKit は設定ファイルの中の `${…}` を
展開しないが、全ての項目を環境変数でも受ける）。`docker-compose.livekit.yml` が `infra/.env` から `NODE_IP`（=
`LIVEKIT_NODE_IP`）・`LIVEKIT_TURN_DOMAIN`（= `LIVEKIT_DOMAIN`）・`LIVEKIT_TURN_CERT_FILE` / `LIVEKIT_TURN_KEY_FILE`
（certbot の `/etc/letsencrypt/live/<domain>/`）・`LIVEKIT_WEBHOOK_API_KEY`（= `LIVEKIT_API_KEY`）を渡す。キーとシークレットは
`LIVEKIT_KEYS`（`secrets/livekit.env`、deploy.sh が作る、権限 600）。**LiveKit は他人が読める鍵ファイル（`key_file`）を
起動の時に拒む**（「key file others permissions must be set to 0」、M130 で確認）ため、アプリと同じファイルは使えない。
帯域のために `rtc.congestion_control`（`enabled`・`allow_pause`）と `rtc.allow_tcp_fallback` を明示した（§8.4）。
この設定で 1.13.8 が起動し、TURN（3478/udp・5349/tcp）を開くことを手元で確かめた（自己署名の証明書）。

下書き（設計の時点）：

```yaml
port: 7880
rtc:
  tcp_port: 7881
  udp_port: 7882
  use_external_ip: false
  node_ip: ${LIVEKIT_NODE_IP}        # the VPS's public IPv4 (explicit: STUN discovery is one more thing to fail)
turn:
  enabled: true
  domain: ${LIVEKIT_DOMAIN}          # livekit.chat.example.com
  udp_port: 3478
  tls_port: 5349
  cert_file: /certs/fullchain.pem
  key_file: /certs/privkey.pem
room:
  empty_timeout: 120
  departure_timeout: 20
  max_participants: 50
webhook:
  api_key: ${LIVEKIT_API_KEY}
  urls: [http://app:8000/api/v1/livekit/webhook]
logging:
  level: info
# keys come from the LIVEKIT_KEYS environment variable ("<key>: <secret>"), never from this file
```

### 8.3 サーバごとの推奨

| 環境 | 推奨 |
| --- | --- |
| **（a）本番（共用の研究室の VPS、nginx が 80/443、D22）** | compose に `docker-compose.livekit.yml`（新規）を `EXTRA_COMPOSE_FILES` で足す：ブリッジ網、`127.0.0.1:7880`、`7881/tcp`・`7882/udp`・`3478/udp`・`5349/tcp`。nginx に `livekit.<domain>` のサイト（`infra/nginx-livekit.conf.example`、WebSocket の Upgrade と長い timeout、certbot で 443）。DNS の A レコード。ファイアウォールに 4 つ。**どれも共用のサーバの変更なので利用者の了承の後**。メモリに余裕の少ないサーバだが、LiveKit は数百 MB（§8.5） |
| **（b）taylis の VPS（12 GB、nginx が 80/443）** | （a）と同じ構成。**最初にここで試す**（M131）：本番より余裕があり、CI の runner と同じ所で試せる |
| **（c）デモ（taylis の VPS の 2 つ目の compose）** | v1 では **通話はオフ**（LiveKit を置かない。`in_app_calls.enabled = false` で 🎧 が出ない）。ストアの審査で通話を見せる必要が出たら、デモ用の LiveKit を別のポート（7891/tcp・7892/udp・3479/udp・5350/tcp）と別の名前（`livekit-demo.<domain>`）で足す（ポートは同じホストの 2 つの LiveKit で共有できない） |
| **（d）手元の開発** | `docker compose --profile calls up`：`livekit/livekit-server --dev`（キー `devkey` / シークレット `secret`、手元専用）、`7880`・`7881`・`7882/udp` を出す。**dev モードの LiveKit は 127.0.0.1 でしか待たない**ので `--bind 0.0.0.0` を付ける（付けないとアプリのコンテナから RoomService に届かない。M130 で確認）。`LIVEKIT_NODE_IP` は既定 `127.0.0.1`、実機（同じ Wi-Fi）で試すときは Mac の LAN の IP。TURN なし。`LIVEKIT_URL=ws://<その IP>:7880`（iOS は `NSAllowsLocalNetworking` が既にある。Android の開発ビルドは平文の手元の通信を許しているかを確かめる）。Web は `localhost` なら `getUserMedia` が使える |

### 8.4 帯域（目安。**M131 で実測して直す**）

LiveKit は SFU で、映像を変換しない。各人は自分の 1 本（simulcast なら 3 層）を上げ、見るものを下ろす。サーバの外向きは
「下ろす量の合計」。

| 流れ | 1 人の上り | 1 人の下り（相手 1 人あたり） |
| --- | --- | --- |
| 音声（Opus、話している間。無音は DTX でほぼ 0） | 約 30〜50 kbps | 約 30〜50 kbps |
| 720p のカメラ（simulcast 3 層：720p 約 1.7 Mbps + 360p 約 0.5 + 180p 約 0.15） | 約 2.5 Mbps | 大きく見る：約 1.7 Mbps、格子の小さいタイル：約 0.15〜0.5 Mbps（adaptiveStream で表示の大きさに合わせる） |
| 画面共有（1080p、動きが少ない） | 約 1〜2.5 Mbps | 同じ |

| 場面 | サーバの入り | サーバの出（合計） |
| --- | --- | --- |
| 1:1 のビデオ | 約 5 Mbps | 約 4 Mbps |
| 5 人・全員カメラ（小さいタイル） | 約 12 Mbps | 約 5〜10 Mbps |
| 研究室の会議 30 人・カメラ 4 人・画面共有 1・話す人 2〜3 | 約 12 Mbps | 約 30 人 × 2〜4 Mbps = **60〜120 Mbps** |
| 同じ会議を音声と画面共有だけ | 約 3 Mbps | 約 30 人 × 2 Mbps = 約 60 Mbps |

- VPS の回線（共有の 100 Mbps〜1 Gbps など）と、ほかの 20 のサイトとの取り合い、月の転送量の上限の有無は **要確認**
  （契約のプラン）。30 人の会議 1 時間で外向き 30〜50 GB。
- 研究室の会議は「カメラは話す人だけ」を既定の案内にする。帯域が足りなければ、画面共有の解像度・カメラの上限（720p → 540p）
  をサーバの設定ではなく端末の公開の設定で下げる。

### 8.5 CPU・メモリ

- 30 人までの SFU は軽い（転送だけ）。目安は 1〜2 vCPU の一部と RAM 200〜500 MB（**目安。M131 で 30 人の負荷を `lk load-test`
  で測る**）。組み込み TURN を通る人が多いと CPU が増える（TLS の暗号化）。
- compose で `mem_limit: 1g`・`cpus: 2` を付け、ほかのサイトを巻き込まない。

### 8.6 利用者がすること（本番・taylis の VPS ごと）

M131（taylis の VPS、162.43.29.120）で行う。DNS（1）は済んでいる（`livekit.kano-lab.com` → 162.43.29.120、利用者 2026-10-07）。
ほかの手順は M131 の作業者が利用者と一緒に行う（共用のサーバの変更は利用者の了承済み、§12）。`<domain>` は `kano-lab.com`、
`/srv/taylis` は infra の置き場所に読み替える（taylis の VPS では `/srv/chikuwachat`）。

0. **配布の仕組み**（M131 で足した）：リリースは `docker-compose.livekit.yml` と `livekit.yaml` も送る。受け取る側の `/usr/local/bin/chikuwa-deploy`（`infra/deploy-ssh.sh`）は、この 2 つを「あれば受け取る」ので、M131 より前の版のままのサーバ（本番）はそのままでよい。LiveKit を置くサーバでは `sudo install -m 755 infra/deploy-ssh.sh /usr/local/bin/chikuwa-deploy` で入れ替える。

1. **DNS**：`dig +short livekit.kano-lab.com` が `162.43.29.120` を返すこと。
2. **ポートが空いているか**：`sudo ss -lntupH | grep -E ':(7880|7881|7882|3478|5349)\b'` が何も出さないこと（出たら、その
   ポートを使っているほかのサイトを利用者と確かめる）。
3. **ファイアウォール**：VPS の管理画面のパケットフィルタ（あれば）と OS の両方で `7881/tcp`・`7882/udp`・`3478/udp`・
   `5349/tcp` を受け入れる。ufw なら `sudo ufw allow 7881/tcp && sudo ufw allow 7882/udp && sudo ufw allow 3478/udp && sudo ufw allow 5349/tcp`。
   7880 は開けない（127.0.0.1 だけ）。
4. **UDP の受信バッファ**：LiveKit は起動の時に「UDP receive buffer is too small for a production set-up（425984、勧めは
   5000000）」と警告する（M130 で確認）。`echo 'net.core.rmem_max=5000000' | sudo tee /etc/sysctl.d/90-livekit.conf && sudo sysctl --system`
   （`net.core.wmem_max` も同じ値にしてよい）。ほかのサイトへの害は無い（上限を上げるだけ）。
5. **nginx と証明書**：`infra/nginx-livekit.conf.example` の `livekit.example.com` を `livekit.kano-lab.com` にして
   `/etc/nginx/sites-available/taylis-livekit` に置き、`ln -s` → `sudo nginx -t && sudo systemctl reload nginx` →
   `sudo certbot --nginx -d livekit.kano-lab.com --redirect`。
6. **証明書の更新の後に LiveKit を再起動**：`/etc/letsencrypt/renewal/livekit.kano-lab.com.conf` の `[renewalparams]` に
   `renew_hook = cd /srv/taylis/infra && docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.release.yml -f docker-compose.behind-proxy.yml -f docker-compose.livekit.yml --profile proxy restart livekit`
   を 1 行足す（この証明書だけ。ほかのサイトの更新では動かない）。`sudo certbot renew --dry-run --cert-name livekit.kano-lab.com` で確かめる。
7. **シークレットと設定**：`openssl rand -base64 48 | tr -d '\n' > /srv/taylis/infra/secrets/livekit_api_secret && chmod 644 /srv/taylis/infra/secrets/livekit_api_secret`。
   `infra/.env` に `LIVEKIT_URL=wss://livekit.kano-lab.com`・`LIVEKIT_API_KEY=taylis`・`LIVEKIT_NODE_IP=162.43.29.120`・
   `LIVEKIT_DOMAIN=livekit.kano-lab.com`、`deploy.conf` の `EXTRA_COMPOSE_FILES` に `docker-compose.livekit.yml` を足す。
   次のデプロイで deploy.sh が `secrets/livekit.env` を作り、LiveKit が起動する。
8. **回線と転送量**（§8.4・§8.7）：VPS の契約の管理画面で、回線の速さ（共有か・上限）と月の転送量の上限の有無を見る。
9. **つながるかを試す**：M131 の手順（研究室の有線・学内 Wi-Fi・携帯の回線・自宅、§8.7）。

### 8.7 帯域とつながりやすさ（利用者の決定 2026-10-07：「できるだけ多くの場面に対応する」）

できるだけ多くの網・回線でつながり、細い回線でも話せるようにする。サーバと端末で次を全部使う：

| 手段 | どこで | 効くこと |
| --- | --- | --- |
| UDP 1 ポート（7882）→ ICE/TCP（7881）→ TURN/UDP（3478）→ TURN/TLS（5349） | サーバ（M130 の設定）と SDK の既定 | UDP が閉じた網でも TCP・TLS でつながる。`rtc.allow_tcp_fallback`：UDP が不安定な端末は TCP に移る |
| simulcast（3 層） | 端末の公開（M133〜M135 で有効にする。SDK の既定はオン） | 受け手ごとに 180p / 360p / 720p を選べる |
| adaptiveStream | 端末の購読（M133〜M135） | 画面のタイルの大きさに合った層だけを受ける。見えないタイルは止める |
| dynacast | 端末の公開（M133〜M135） | 誰も見ていない層は上げない（上りの節約） |
| 混雑の制御（`congestion_control`、`allow_pause`） | サーバ（M130 の設定） | 受け手の下りを推定し、層を下げ、足りなければ映像を止めて音声を残す |
| 音声だけに落とす | 端末（M132〜M135）：接続の質（`ConnectionQuality.Poor`）が続いたら「映像を止めますか」を出し、受ける映像を止める。8 人以上の通話はマイクをオフで入る（§4.3） | 細い回線・携帯で話を続けられる |
| 443 しか通らない網 | §8.1 の選択肢。利用者の決定：**（3）LiveKit 専用の小さな VPS（443 が空いている）**（M131 の実測で 443 以外が閉じた網が見つかったとき） | TURN/TLS を 443 に置ける |

**利用者が VPS で確かめること**（M131 で作業者と一緒に）：

1. 回線：契約の管理画面で回線の速さと月の転送量の上限。目安は §8.4（30 人の会議で外向き 60〜120 Mbps、1 時間 30〜50 GB）。
2. 実際の外向きの速さ：3 の `lk load-test` の間に `vnstat -l` で外向きの Mbps を見る（回線の上限に近ければ、ほかのサイトにも
   響く。そのときは「カメラは話す人だけ」の案内と、端末の公開の上限（720p → 540p）で下げる）。
3. LiveKit の負荷：`lk load-test`（M131、§9）で 30 人の CPU・メモリ・外向きの帯域を `docker stats` と `vnstat -l`（無ければ
   `sudo apt install vnstat`）で記録し、§8.4・§8.5 を直す。
4. どの経路でつながったか：LiveKit のログ（`docker compose ... logs livekit | grep -i candidate`）か、端末の `getStats` の
   `candidateType`（host / srflx / relay）と `protocol`（udp / tcp）を、研究室・学内 Wi-Fi・携帯・自宅で記録する。

## 9. 試験

- **サーバ（pytest、`FakeLiveKitGateway`）**：トークンのクレーム（部屋・identity・期限・`canPublishSources` の設定ごとの差・
  `roomCreate` が無い）、メンバー・ゲスト・アーカイブ・アナウンス・ブロックの 1:1 DM・上限・冪等（再送・進行中への参加・
  一意索引の競合）、webhook の署名（正しい・本文の改ざん・期限切れ・別のキー）、重複・順序の入れ替わり・知らない部屋、
  突き合わせ（webhook なしで入った人・消えた部屋・LiveKit に届かないときは終えない）、終わりのメッセージの更新と seq、
  イベントの audience、M117 の廃止（`calls_enabled = false`、`POST /channels/{id}/calls` が 409、`meeting_base_url` の PATCH が
  409、M117 のメッセージの `call.kind = "link"`）。webhook の署名の試験データは、本物の LiveKit（手元の `--dev`）が送ったものを
  1 つ記録して固定する（自分で作った署名だけで試すと、方式の取り違えに気付かない）。
- **手元の LiveKit**：`docker compose --profile calls` の上で、`lk`（LiveKit の CLI）で参加者を出し入れし、webhook → 表示を
  確かめる。`lk load-test` で 30 人。
- **端末**：Desktop は Vitest で通話の状態（イベントの差し替え・バーの表示・権限が無いとき）。iOS / Android は通話の状態の
  ロジックを単体の試験（SDK はプロトコルの裏に置いて偽物に替える）。実機：Mac アプリ・Windows アプリ・ブラウザ・iPhone・
  Android（`ChikuwaChat_Pixel_9` の AVD はカメラ・マイクが偽物なので、音の確認は実機）で 3〜5 人の通話。iOS は画面を消して
  1 分、Android はホームに出て 1 分、音が続くこと。
- **網**：M131 の手順（研究室の有線・学内 Wi-Fi・携帯の回線・自宅）。どの経路（UDP / TCP / TURN）でつながったかを LiveKit の
  ログか端末の `getStats` で記録する。

## 10. マイルストーン

番号は **M130 から**（M120〜M129 は並行して設計しているほかの機能（Wiki）のために空けておく）。

| # | 名前 | 完了条件 |
| --- | --- | --- |
| M130 | サーバと手元の infra・M117 の廃止（**済み 2026-10-07**、§13） | `calls`・`call_participants`・`messages.call_id`・`in_app_calls_enabled` の移行。`LiveKitGateway`、トークン、webhook、突き合わせ、§5 の API とイベント、通話のメッセージとプッシュ。M117 の廃止（§11）。`docker-compose.yml` の `calls` プロファイル、`docker-compose.livekit.yml`、`livekit.yaml.template`、`nginx-livekit.conf.example`、infra/README.md。pytest・mypy・ruff が通り、手元の LiveKit と `lk` で、参加・退出・終わりが API とイベントに出る。M117 の古い 3 端末（Desktop 0.1.39・Android 1.0.2・iOS build 105）を手元のサーバにつなぎ、📞 が消えて落ちないこと |
| M131 | taylis の VPS での試し・網の実測 | 利用者の了承の後に（b）を設定（§8.6）。`lk` でトークンを作り、LiveKit の公開の試験ページ（LiveKit Meet の「カスタム」）から研究室・学内 Wi-Fi・携帯の回線でつながる経路を記録。`lk load-test` で 30 人の CPU・メモリ・帯域を記録して §8.4・§8.5 を直す。443 以外が閉じた網があれば §8.1 の選択肢を利用者に示す |
| M132 | Desktop / Web の音声 | Tauri（macOS・Windows）とブラウザで `getUserMedia` を確かめる（§4.2）。🎧・通話のバー・ペイン・入出力の選択・話している表示・「通話中（n）」・カード・DM のバナー・`/call/<id>` のページ・管理の設定（「アプリ内通話」のスイッチ。会議サービスの欄を消す）。Mac・Windows・ブラウザの 3 人で 10 分話せ、表示が合う。tsc・Vitest・`tauri build` |
| M133 | Desktop / Web のビデオと画面共有 | カメラ（simulcast・adaptiveStream・dynacast）、画面共有（macOS の画面収録の許可・Windows）、タイルの並べ方。3 人がカメラ・1 人が画面共有で 10 分 |
| M134 | iOS の音声とビデオ | LiveKit Swift SDK、全画面の通話・畳んだバー、音の出口、`audio` のバックグラウンド、権限の文（3 言語）、`PrivacyInfo` の見直し。実機で Desktop と 1:1・3 人、画面を消して音が続く。xcodebuild |
| M135 | Android の音声とビデオ | LiveKit Android SDK、フォアグラウンドサービス（microphone / camera）、権限、Bluetooth、R8 の規則。**リリースビルド**の実機で Desktop・iOS と 3 人。`./gradlew build` |
| M136 | 本番への展開 | 利用者の了承の後に（a）を設定。研究室の会議（20〜30 人）で 1 回使い、帯域・CPU を記録。`meeting_base_url` の列を消す移行（古い端末が `calls_enabled` を読み続けるので、項目は返し続ける）。website の利用者・管理者向けの説明 |
| 後で | 全画面の着信（CallKit・ConnectionService）、iOS / Android の画面共有、録音、通話の中の挙手・リアクション、管理者が通話を終わらせる | — |

M130 で M117 を止めると、M132 まで通話が無い期間ができる。利用者の決定（会議リンクは要らない）により受け入れる。

## 11. M117（会議リンク）の廃止

### 11.1 サーバ（M130）

| もの | どうするか |
| --- | --- |
| `workspace_settings.calls_enabled`（bootstrap・`workspace.settings_updated`） | **意味を変えず、いつも `false`**。M117 の端末にとっては「📞 を出すか」で、出させたくないため。新しい端末は読まない（`in_app_calls` を読む）。項目は消さない（古い端末は無いときも `false` と読むが、Desktop の管理画面は項目の有無で欄を出し分けるため、残す方が挙動が読みやすい） |
| `workspace_settings.meeting_base_url` | 応答ではいつも `null`。移行で値を `NULL` に。列は M136 で消す |
| `PATCH /admin/workspace-settings {meeting_base_url}` | `409 meeting_links_retired`（黙って捨てない） |
| `POST /channels/{id}/calls` | いつも `409 calls_disabled`（古い端末は 📞 を隠す）。OpenAPI では deprecated。古い端末が無くなったら消す |
| `messages.call_url`・M117 のメッセージ | 残す。`MessageOut.call = {kind: "link", url, started_by}`。古い端末はこれまでどおりカードと「参加する」 |
| プッシュの文 `push.call.started` | LiveKit の通話の開始に使い続ける（絵文字だけ 🎧） |
| エラーコード `meeting_url_invalid` | サーバは出さない。errors.json には古い端末のために残す |

### 11.2 新しい端末（M132〜M135）

- 📞 と会議サービスの設定の欄を消し、🎧（§4.3）にする。
- `message.call.kind == "link"`（または `kind` が無く `url` がある）のメッセージは「過去の通話（会議リンク）」のカード：
  「📞 〇〇 さんが通話を始めました」と「リンクを開く」（外のブラウザ）。参加者・時間は出さない。

### 11.3 出してある古い端末（Desktop 0.1.39・Android 1.0.2・iOS build 105）

| 場面 | 古い端末の動き（3 端末のコードで確かめた：`calls_enabled === true` のときだけ 📞、`409 calls_disabled` で隠す） |
| --- | --- |
| 会話を開く | `calls_enabled = false` なので 📞 を出さない |
| 手元に古い設定が残っていて 📞 を押した | `POST /channels/{id}/calls` → `409 calls_disabled` → 「このワークスペースでは通話がオフになっています」を出して 📞 を隠す（3 端末とも実装済み） |
| M117 のメッセージ | 今までどおりのカード（`call.url` を外で開く） |
| LiveKit の通話のメッセージ | `call.url`（`/call/<id>` の Web のページ）があるので M117 のカードが出る（追加の項目は 3 端末とも読み飛ばす、M130 で 3 端末の出した版のコードで確認）。`PUBLIC_BASE_URL` のあるサーバでは「参加する」で外のブラウザが開き、Web クライアントで参加できる（M132 から。それまでは Web のページは会話を開くだけ）。パスだけの URL（`PUBLIC_BASE_URL` の無いサーバ）は開けない：iOS はボタンを出さず、Android は「開けません」を出し、Tauri の Desktop は何もしない（どれも落ちない）。本文は「🎧 通話を始めました」なので、Desktop・iOS は本文もカードの下に出す（見た目だけ） |
| Desktop の管理画面（0.1.39） | 「通話の会議サービス」の欄は出る（`calls_enabled` の項目があるため）が、オフの表示。保存すると `409 meeting_links_retired`（一般のエラーの文）。Desktop は自動更新があるので短い間 |
| `call.started` などの新しいイベント | 知らない種類のイベントは捨てる（3 端末とも既存の作り。M130 の試験で古い版を手元のサーバにつないで確かめる） |

## 12. 利用者の決定（2026-10-07）

設計の時点の「未決の点」に利用者が答えた。

1. **ホスト名**：`livekit.kano-lab.com`。A レコード → 162.43.29.120（taylis の VPS）を利用者が作った（済み）。本番のホスト名は M136 で決める。
2. **どのサーバに置くか**：まず taylis の VPS（M131）。本番（共用の VPS）は後で（M136）。デモのサーバは通話をオフ（LiveKit を置かない）。
3. **共用の VPS の変更**：ポートを開ける・nginx にサイトを 1 つ・certbot の `renew_hook` を 1 つ足すことを了承。作業は M131（§8.6）。
4. **大学の網（443 以外が閉じている場合）**：この文書の勧め（§8.1 の（3）、LiveKit 専用の小さな VPS）。M131 の実測で必要になったとき。
5. **帯域**：できるだけ多くの場面に対応する（simulcast・adaptiveStream・dynacast・音声だけへの切り替え・TURN/TLS。§8.7）。
   VPS で確かめることは §8.6・§8.7 に手順を書いた。
6. **上限人数**：1 通話 50 人。
7. **画面共有**：v1 は Desktop / Web だけ（見るのは全端末）。
8. **着信**：v1 はふつうのプッシュ + アプリ内のバナー（DM・グループ DM）。全画面の着信は後で。
9. **ブロック**：1:1 の DM はどちらかがブロックしていれば通話できない。グループ・チャンネルでは拒まない（§7.2）。
10. **M117 の空白**：M130 で M117 を止め、M132 まで通話が無い期間ができてよい。

## 13. M130 の実装（2026-10-07）

### 13.1 手元の LiveKit で確かめたこと

`livekit/livekit-server:v1.13.8`（dev モード）と `lk`（livekit-cli 2.18.8）・LiveKit の Python SDK（使い捨ての環境。プロジェクトの
依存には入れない）で確かめた。

- webhook の形と署名（§3.2）。記録は `server/tests/fixtures/livekit_webhooks.json`。
- RoomService（Twirp の JSON、`/twirp/livekit.RoomService/<Method>`、`Authorization: Bearer <JWT>`）：要求は proto の名前
  （`empty_timeout` など snake_case）で受け、答えも snake_case（webhook の camelCase と違う）。`CreateRoom` は `roomCreate`、
  `ListRooms` は `roomList`（無いと `401 unauthenticated`）、`ListParticipants`・`RemoveParticipant` は `roomAdmin` + `room`、
  `DeleteRoom` は `roomCreate`。知らない部屋の `DeleteRoom` と居ない人の `RemoveParticipant` は `404 not_found`（アプリは
  「もう無い」として扱う）。知らない部屋の `ListParticipants` は `200` で空。
- 部屋を閉じる時間：最後の人が出てから `departure_timeout`（20 秒）で `room_finished`（`roomEndReason: ROOM_END_IDLE_TIMEOUT`）。
- 端から端まで（compose の `calls` プロファイル + アプリ）：始める（201、`call.started`、メッセージ `kind: livekit`）→ 本物の
  クライアントがアプリのトークンでつながる → webhook で参加者が出る（0.5 秒以内）→ 2 人目（iOS の端末のセッション）の
  トークンに画面共有が無く、画面共有の音声の公開は LiveKit に拒まれる → 退出・`leave` → 20 秒後に終わり、メッセージが
  `message.updated`（`change: "call"`）で「30 秒・2 人」になる → `join` は `409 call_ended`、M117 の `POST /channels/{id}/calls`
  は `409 calls_disabled`。
- 突き合わせ：webhook の行を消しても 1 周（試験では 15 秒）で戻る。チャンネルをアーカイブすると、outbox の起床でその場で
  `DeleteRoom` と `end_reason = 'archived'`、つないでいた端末は LiveKit から切られる。
- 本番の設定（`infra/livekit.yaml` + 環境変数）で 1.13.8 が起動し、TURN を開く（自己署名の証明書）。

### 13.2 設計からの違い

| 項目 | 設計 | 実装 | 理由 |
| --- | --- | --- | --- |
| `CreateRoom` の時 | コミットの後 | コミットの前（§2.1） | LiveKit に届かないとき、投稿・プッシュを出さずに `503` を返せる |
| `call.url`（`PUBLIC_BASE_URL` が無いサーバ） | `null` | `/call/<id>`（パスだけ）。本文には URL を付けない | **出してある Android 1.0.2 は `call.url` が null だとメッセージを読めず、ページごと同期に失敗する**（`url: String`）。iOS は `call` を捨てるだけ、Desktop は落ちない。パスなら 3 端末とも落ちない（「参加する」は開けない） |
| `infra/livekit.yaml.template` | テンプレート | `infra/livekit.yaml`（固定）+ 環境変数 | §8.2 |
| LiveKit のシークレット | 環境変数で渡す | `secrets/livekit.env`（deploy.sh が作る、600）の `LIVEKIT_KEYS` | §8.2 |
| `POST /livekit/webhook` | §5.2 の表 | OpenAPI に出さない（端末の API ではない） | — |
| 外された人・無効化・アーカイブ・ブロックで切る | アプリが `RemoveParticipant` / `DeleteRoom` | 突き合わせの作業がする。`channel.archived`・`channel.member_removed`・`user.deactivated`・`block.updated` の outbox で起こされ、その場で動く（待っても 60 秒） | channels モジュールが calls に依存しない。1 か所で全部の規則を当てる |
| 1:1 の DM でブロックが後からできた | — | その通話を（突き合わせで）2 人とも切る | 声は折りたためない（§7.2） |
| ボット | 入れない | `403 forbidden` | 新しいコードを足さない |
| 管理者のスイッチをオフにした後の `join` | — | 進行中の通話には入れる（新しく始めるのは `409 calls_disabled`） | §5.1「進行中の通話は切らない」 |
| 終わった通話の `huddle` の再送 | — | `409 call_ended`（新しい鍵なら新しい通話） | — |
| `GET /calls/{id}` でメンバーでない | — | `403 not_a_member`（無い id は `404 call_not_found`） | チャンネルと同じ |
| `in_app_calls_enabled` の監査 | — | ほかの設定と同じ `workspace.settings_updated` | — |

### 13.3 端末（M132〜M135）が使う API

- **設定**：bootstrap と `workspace.settings_updated` の `workspace_settings.in_app_calls = {enabled, video, screen_share}`。
  `enabled` が false なら 🎧 を出さない（M130 より前のサーバは項目が無い → false と読む）。`calls_enabled` / `meeting_base_url` は
  読まない（いつも false / null）。管理画面は `in_app_calls_enabled`（`PATCH /admin/workspace-settings`）。
- **始める・入る**：`POST /channels/{id}/huddle {client_msg_id}` → `201`（始めた）/ `200`（再送・進行中に参加）
  `{call: CallOut, message: MessageOut, join: {url, token, expires_at}}`。失敗の再送は同じ `client_msg_id`。
  `join.url` と `join.token` で LiveKit の SDK の `room.connect(url, token)`。identity = 自分のユーザー id、部屋の名前 = `call.id`。
- **つなぎ直し**：`POST /calls/{id}/join` → `{call, join}`（トークンは 10 分。つないでいる間は LiveKit が更新するので、長い切断の
  後だけ取り直す）。
- **出る**：SDK で切ってから `POST /calls/{id}/leave`（204、冪等）。
- **状態**：`GET /calls/{id}` → `{call}`、`GET /calls?active=true` → `{calls}`（自分がメンバーの会話の進行中の通話）。
  bootstrap の `active_calls`。イベント `call.started` / `call.updated` / `call.ended`（`{call}`、seq なし、会話のメンバーへ）：
  id で差し替える。つなぎ直したら `GET /calls?active=true` で全部差し替える。
- `CallOut = {id, channel_id, message_id, started_by, started_at, ended_at, participants: [{user_id, joined_at}], participant_count, peak_participants}`。
  `participants` は今いる人（1 人 1 件、入った順）。
- **カード**：`message.call = {kind: "livekit", url, started_by, call_id, started_at, ended_at, duration_seconds, participant_count}`。
  `ended_at` が null の間は「参加」、終わったら「🎧 通話 · n 分 · 参加者 m 人」。`kind` が `"link"`（または無い）なら M117 の
  過去のカード（§11.2）。本文は `🎧 通話を始めました` + 改行 + URL（カードがあれば出さない）。
- **エラー**：`403 not_a_member` / `posting_restricted`（アナウンスのチャンネルで始める）/ `dm_unavailable` / `forbidden`、
  `404 call_not_found`、`409 calls_disabled` / `channel_archived` / `call_full`（`details.max`）/ `call_ended` /
  `idempotency_conflict`、`429 rate_limited`（始める 10 回・参加 30 回 / 分）、`503 calls_unavailable`。
- **公開できるもの**：トークンの `canPublishSources`。iOS / Android のセッションには画面共有が無い（サーバがセッションの端末の
  `platform` で決める）。
- **Web の CSP**：M132 で Caddy の `connect-src` に `LIVEKIT_URL` のホスト（`wss:`・`https:`）を足す（M130 では足していない）。

## 付録 A：会議リンクの通話（M117、2026-10-06。M130 で廃止）

履歴として M117 の設計をそのまま残す（廃止の手順は §11）。この付録の中の「§3」などは付録の「A.3」などを指す。

会話の中から音声・ビデオの通話を始められるようにする。最初は「会議サービスの部屋のリンクを会話に投稿する」だけの
簡単な形にし、通話そのものはアプリの外（ブラウザ・Jitsi Meet のアプリ）で行う（利用者の決定 2026-10-06）。

### A.1 目的

- DM・グループ DM・チャンネルで、ボタン 1 つで「今から話そう」を始められる。
- 相手には通知が届き、メッセージの「参加する」から同じ部屋に入れる。
- サーバ・3 端末に WebRTC・TURN・メディアサーバを足さない。

### A.2 なぜ会議リンクから始めるか

- アプリの中の通話（WebRTC）には、メディアサーバ（SFU）・TURN・端末ごとの音声の扱い（CallKit・ConnectionService・
  バックグラウンド）が要り、作るのも運用するのも大きい。数十人の研究室では、まず「すぐ話せる」ことが要る。
- 会議サービス（既定は公開の Jitsi、`https://meet.jit.si/`）は無料で、ブラウザでもアプリでも入れる。
- 部屋の名前はサーバが推測できない乱数で作るので、リンクを知っている人だけが入れる（リンクが鍵）。
- メッセージとして残るので、同期・未読・通知・検索・古いクライアントでの表示は今の仕組みのまま動く。

**meet.jit.si の注意**：公開の meet.jit.si では、部屋に最初に入る人（主催者）がサインイン（Google・GitHub など）を
求められる（2023 年からの meet.jit.si の決まり。後から入る人は不要）。気になるなら自前の Jitsi（Docker で立てられる）
などを設定に入れる（§3）。会議サービスは Taylis の外のサービスで、通話の中身はそのサービスを通る。

### A.3 設定（管理者）

`workspace_settings.meeting_base_url`（移行 0091、DATA_MODEL.md workspace_settings、MEMBERSHIP.md §3）。

| 値 | 意味 |
| --- | --- |
| `https://meet.jit.si/`（既定。行が無いときも） | 公開の Jitsi で部屋を作る |
| ほかの `https://…` | そのサービスで部屋を作る（自前の Jitsi など。部屋の名前を後ろに付けて開ける URL） |
| NULL | 通話はオフ。端末は 📞 を出さず、`POST /channels/{id}/calls` は `409 calls_disabled` |

- 変更：`PATCH /admin/workspace-settings {meeting_base_url}`（管理者だけ）。`""` か `null` を送るとオフ、項目を送らなければ
  そのまま。ほかの設定と同じく監査ログ `workspace.settings_updated`（`{meeting_base_url: {from, to}}`）と
  `workspace.settings_updated` イベント（全員）。
- 確かめること（外れたら `422 meeting_url_invalid`、`details.reason`）：`https` だけ（`http` はサーバが DEBUG のときの
  `localhost` / `127.0.0.1` / `::1` だけ。手元で立てた Jitsi の試験用）、ホストがある、ユーザー名・パスワード・`?`・`#` が
  無い、空白・制御文字が無い、ポートが正しい。末尾に「/」が無ければ足す。長さは 200 文字まで（足した後。超えれば 422）。
- 端末が読む所：bootstrap の `workspace_settings` と `workspace.settings_updated` の `settings` に
  `calls_enabled`（bool）と `meeting_base_url`（文字列か null）。管理者の `GET / PATCH /admin/workspace-settings` にも出る。
  端末は URL を自分で組み立てない（部屋はサーバが作る）。`meeting_base_url` は設定画面の表示用。

### A.4 API

`POST /api/v1/channels/{channel_id}/calls`

```json
// 要求
{ "client_msg_id": "<uuid>" }
// 応答 201（作った）/ 200（同じ client_msg_id の再送）
{ "url": "https://meet.jit.si/taylis-k3q7…", "message": { /* MessageOut。message.call = {url, started_by} */ } }
```

- 始められる人：その会話にトップレベルのメッセージを投稿できる人と同じ（メンバー。公開チャンネルでも参加していなければ
  `403 not_a_member`。アナウンスのチャンネルはオーナーと管理者（`403 posting_restricted`）。DM は DM の送信と同じ
  （`403 dm_unavailable`）。DM・グループ DM・公開・非公開チャンネルのどれでも）。スレッドの中では始めない（`parent_id` は無い）。
- `409 channel_archived`：アーカイブされた会話。`409 calls_disabled`：設定がオフ。`404 channel_not_found`。
  `422 validation_error`：`client_msg_id` が無い・UUID でない。`429 rate_limited`：メッセージの投稿と同じ上限を数える。
- 冪等：`client_msg_id` はメッセージの冪等キーそのもの（`messages.client_msg_id`）。同じキーの再送は、その後に会話や設定が
  変わっていても同じメッセージと同じ URL を 200 で返す（メッセージが削除されていても `url` は返し、`message.deleted = true`）。
  ふつうのメッセージに使ったキーを送ると `409 idempotency_conflict`。
- 部屋の名前：`taylis-` + 小文字の base32（`a-z2-7`）24 文字（120 ビットの乱数、`secrets`）。会話や人の id からは作らない。
  通話のたびに新しい部屋になる（同じ会話でも前の部屋は使い回さない）。
- 投稿はふつうのメッセージの経路（seq・outbox の `message.created`・プッシュ・既読を進める・検索）を通る。

### A.5 メッセージの形

- `type = "user"`、送った人は始めた人、`body` は `📞 通話を始めました` + 改行 + URL（ワークスペースの言語の日本語のまま。
  docs/I18N.md §1。M117 より前のクライアントはこの本文を出し、URL は自動でリンクになる）。
- `MessageOut.call`：`{ url, started_by }`（`started_by` = `sender_id`）。通話のメッセージでなければ null。削除すると null
  （本文も空）。`messages.call_url` に保存する（移行 0091）。
- 編集はふつうのメッセージと同じにできる（`call` は残る）。リアクション・スレッド・ピン留めも同じ。
- 未読・メンション・通知キーワード・検索（本文）・DM 一覧のプレビュー（`last_message.excerpt` は本文の 1 行）は
  ふつうのメッセージと同じ。

### A.6 通知

- プッシュの対象はふつうのメッセージと同じ規則（PUSH_NOTIFICATIONS.md §4。DM・グループ DM はいつもどおり届き、チャンネルは
  その人の通知の設定に従う）。
- 本文は本文の抜粋の代わりに「📞 〇〇 さんが通話を始めました」（受け手の言語：en `📞 〇〇 started a call`、
  zh-Hans `📞 〇〇 发起了通话`。`server/app/i18n/messages.json` の `push.call.started`）。題（DM なら相手の名前、
  チャンネルなら `#名前`）は今までどおり。URL は入れない（タップで会話を開き、そこの「参加する」で入る）。
  `PUSH_INCLUDE_CONTENT=false` でも同じ文（本文の中身を含まないため）。
- Desktop / Web のアプリ内の通知（`message.created` から作るもの）も同じ文にする。

### A.7 端末の動き（期待すること）

- **📞 ボタン**：会話の見出し（DM・グループ DM・チャンネル）に置く。`workspace_settings.calls_enabled` が true で、
  その会話に投稿できるとき（アーカイブされていない。アナウンスのチャンネルはオーナーと管理者）だけ。押すと確認
  （「通話を始めますか？メンバーに通知が届き、会議のリンクが投稿されます。」→「通話を始める」/「キャンセル」）。
- 確かめたら `client_msg_id` を作って `POST /channels/{id}/calls`。失敗の再送は同じ `client_msg_id` で（二重に始めない）。
  成功したら返ってきた `url` をアプリの外で開く：Desktop は既定のブラウザ（Tauri の opener）、Web は新しいタブ、
  iOS / Android はシステムのブラウザ（`UIApplication.open` / `Intent.ACTION_VIEW`。Jitsi Meet のアプリが入っていれば
  ユニバーサルリンク / アプリリンクでそちらが開く）。アプリの中の WebView では開かない（カメラ・マイクの許可が要るため）。
  `409 calls_disabled` なら設定を読み直して 📞 を隠す。
- **通話のメッセージ**：`message.call` があれば、本文の代わりに（または本文の上に）通話のカード「📞 〇〇 さんが通話を
  始めました」と「参加する」ボタン（`call.url` を上と同じように外で開く）。時刻はメッセージの時刻。本文の URL は
  繰り返さない（リンクのプレビューも出さない）。通話が終わったかはサーバは知らないので、カードはいつまでも
  「参加する」を出す。
- **通知**：プッシュ / アプリ内の通知をタップすると会話を開く（自動で通話には入らない）。
- 設定：Desktop / Web の管理画面「ワークスペースの設定」に「通話の会議サービス」（URL の欄、空にするとオフ、既定に戻す
  ボタン、meet.jit.si の主催者のサインインの注意書き）。
- 用語：「通話」= Call / 通话（apps/shared/i18n/glossary.json）。
- **Android**（2026-10-06）：📞 は会話の上のバーの検索の左（`ui/Calls.kt` の `Calls.canStart`）。部屋は `Intent.ACTION_VIEW`
  で開く（Custom Tab は使わない）。再送の鍵は答えが分からない失敗（ネットワーク・5xx・429）のときだけ 10 分残す（`CallKeys`）。
  管理画面は無い。
- **iOS（2026-10-06）**：📞 は会話のナビゲーションバーの ⋯ の左（自分だけの DM には出さない。相手がいないため）。確認は
  画面の中央のアラート。`client_msg_id` は会話ごとに投稿できるまで（または断られるまで）持ち、10 分以内の再送は同じ鍵で
  送る（`CallKeys`）。部屋は `UIApplication.open` で開く。カードは本文の代わりに出し、編集で足した文だけを下に出す
  （`CallRules.extraBody`）。アプリ内の通知は iOS ではサーバのプッシュをそのまま出すので、文はサーバの §6 のとおり。
  管理の画面は iOS に無い。

**Desktop / Web の実装（2026-10-06）**：

- 📞 は会話の見出しの右のボタン（スマホの幅でも出す）。`calls_enabled` が true のときだけ（`calls_enabled` を送らない M117 より前の
  サーバでは出さない）。確認のダイアログを開いたときに `client_msg_id` を作り、閉じるまで同じものを使う（失敗して「通話を
  始める」をもう一度押しても同じ id。二重に始めない）。Web では押したときに空のタブを先に開き、URL が返ってきたらそこへ
  移る（リクエストの後で開くタブはブラウザに止められるため。失敗したら閉じる）。`409 calls_disabled` は手元の
  `calls_enabled` を false にして 📞 を隠す。
- 通話のカードは本文の代わりに出す。本文がサーバの決まった文（`📞 通話を始めました` + 改行 + URL）のままなら本文は出さず、
  編集して変えた本文はカードの下に出す。部屋の URL のリンクのプレビューは取らない。削除したメッセージはふつうの削除と同じ。
- アプリ内の通知（`message.created` から作るもの）は「📞 〇〇 さんが通話を始めました」。チャンネルでも「〇〇: 」を前に付けない。
- 管理 → 設定「通話の会議サービス」：URL の欄と「保存」（Enter でも）、既定でないときは「既定（meet.jit.si）に戻す」。空で
  保存するとオフ。`422 meeting_url_invalid` は `details.reason`（`scheme`・`host`・`query`・`credentials`・`characters`・
  `malformed`・`length`）を言葉にして欄の下に出す。meet.jit.si のときは主催者のサインインの注意書きを出す。

### A.8 今後（今はやらない）

- **アプリの中の通話**：LiveKit（自前の SFU）などで、会話の中で通話する。その時は `message.call` に `provider` などを
  足し、会議リンクの通話はそのまま読めるようにする。
- **着信の画面**：iOS の CallKit・Android の ConnectionService / 全画面の通知での「着信」（VoIP プッシュが要る）。
- 通話の終わり・参加者の表示（会議サービスからの webhook が要る）。
- 予定（カレンダー）に会議のリンクを付ける。
