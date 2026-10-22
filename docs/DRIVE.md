# DRIVE（ドライブ：研究室の Nextcloud の置き換え）

2026-10-21 の設計。**段階 D1（M160、サーバの土台）・D2（M161、Desktop / Web の画面）・D3（M162、版・コピー・ZIP・容量）・D4（M163、外部共有リンク）を実装（2026-10-21、§20〜§23）**。**段階 D5（M164、Nextcloud の移行とバックアップ）はコードと手順を実装（2026-10-22、§24）**：本番の Nextcloud からの移行の実行は利用者と行う（未実施）。**段階 D6（M165、会話との連携）・D7（M166、スマホ（読むだけ））を実装（2026-10-22、§25・§26）**。マイルストーンは M160〜M166（段階 D1〜D7、§18）。

利用者（研究室の教員）の要望：研究室で自前で動かしている Nextcloud を、Taylis の中の「ドライブ」に置き換えたい。

関連：ARCHITECTURE.md §5（モジュール）・§8（バックアップ）、DATA_MODEL.md「attachments」「outbox_events」「import_refs」
「workspace_settings」、SECURITY.md §3・§4・§5・§8、PREVIEWS.md（文書のプレビュー）、SYNC_PROTOCOL.md §17（ドキュメントの
変更のフィード）、WIKI.md §4（権限と管理者の考え方）、infra/README.md（バックアップと復元）。

画面の名前は「ドライブ」（英語 Drive）、コード上の名前は `drive`（モジュール `app/modules/drive/`、表 `drive_*`、API `/drive/*`）。

## 0. 結論

- **新しいモジュール `drive` を作り、バイト列とその派生物（サムネイル・ポスター・文書のプレビュー）は今の `attachments` の行に
  任せる。** ドライブのファイルの版 1 つ = `attachments` の行 1 つ（新しい列 `drive_item_id`）。プレビューの loop・GC・
  `verify-attachments`・`/attachments/{id}/preview/*` をそのまま使える（§4.1）。
- **場所は 3 種類**：研究室ドライブ（ワークスペースに 1 つ、ゲスト以外の全員）、チャンネルのドライブ（公開・非公開チャンネルの
  メンバー。メンバーシップにそのまま従う）、マイドライブ（本人だけ。管理者も読めない）。DM・グループ DM にはドライブを付けない
  （§3）。v1 は**フォルダごとの共有設定を作らない**：見える人は場所で決まる。限られた人で使うものは非公開チャンネルのドライブに置く。
- **大きなファイルは S3 のマルチパートで分けて送り、途中から再開できる**（16 MiB の塊、1 ファイル既定 5 GB まで、`client_upload_id`
  で冪等）。バイト列は今までどおり app を通る（バケットは非公開、presigned URL は使わない、§6）。
- **ダウンロードは Range に対応し、フォルダは ZIP をその場で流す**（圧縮しない ZIP64、§7）。
- **外部共有リンク**：ファイルかフォルダごと、32 バイトの乱数のトークン（DB には SHA-256 だけ）、期限・パスワード（Argon2id）・
  回数の上限・取り消し、作った人が読めなくなれば止まる、管理者がワークスペース全体で止められる。公開ページは `/s/<token>`、
  `noindex`、共有した部分木の外には決して届かない（§9）。
- **ゴミ箱は 30 日、版は同じ名前の上書きで残す**（既定 10 版・30 日、§10）。容量の上限は場所ごとに任意、使用量は管理者に見える（§11）。
- **会話との連携**：ドライブのファイルをメッセージに「リンク」（読めない人には「表示できないファイル」）か「コピー」（今までの添付）で
  送れる。メッセージの添付をドライブに保存できる（§13）。
- **同期**：`drive.changed {location_id, folder_ids, seq}`（名前を載せない合図）で開いているフォルダを読み直す。v1 の端末は
  ドライブを手元に持たない（オンラインのときだけ、§14）。
- **移行**：`app.cli import-nextcloud`（WebDAV + アプリパスワード、または Nextcloud のデータディレクトリの写し）。フォルダの形と
  更新日時を残し、何度でも実行できる。Nextcloud の共有をどの場所に置くかは対応表（TOML）で人が決める（§15）。
- **バックアップ**：ドライブのバイト列は今のバックアップに入る。**ただし今の `infra/backup.sh` は同じディスクに全体を写し、毎回
  全オブジェクトの SHA-256 を取るので、100 GB では空きと時間が足りなくなる**。サーバの外へのバックアップを必須にし、backup.sh を
  直す（§2・§16）。
- 端末は **Desktop / Web が先**（D2〜D6）。スマホは後で閲覧・ダウンロード・プレビューから（D7）。

## 1. 目標と非目標

### 1.1 今の Nextcloud の使い方（利用者の回答、2026-10-21）と v1 でできること

| Nextcloud での使い方 | v1 でできること |
| --- | --- |
| PC のブラウザからアップロード（手元にはほとんど置かない、同期クライアントは要らない） | Desktop / Web からファイル・複数ファイル・フォルダのアップロード（ドラッグ＆ドロップ、フォルダの選択）。大きなファイルは分けて送り、切れても続きから |
| 研究室のメンバーと共有 | 研究室ドライブ（ゲスト以外の全員）とチャンネルのドライブ（そのメンバー） |
| ときどき学外の人にリンクで共有 | 外部共有リンク（期限・パスワード・回数の上限・取り消し・記録） |
| PDF のプレビュー | 今の PDF のプレビュー（1 ページ目のサムネイルとアプリ内のビューア、PREVIEWS.md） |
| Office は主に見るだけ（OnlyOffice は軽く見る程度） | 今の Office → PDF の変換（converter）でプレビュー。編集はダウンロードして手元のアプリで |
| 合計約 100 GB | 1 ファイル既定 5 GB、場所ごとの容量の上限（任意）、管理者の使用量の画面 |

サーバの前提（2026-10-21）：研究室のサーバのディスク 394 GB、空き 217 GB。今の添付の上限は 1 ファイル 100 MB
（`ATTACHMENT_MAX_BYTES`）、Office のプレビューの入力の上限は 50 MB（`PREVIEW_MAX_INPUT_BYTES`）。

### 1.2 目標

- 研究室の共有ファイルを Taylis だけで置き・探し・見て・渡せる（Nextcloud を止められる）。
- 会話とファイルが行き来できる（会話にドライブのファイルを貼る、会話の添付をドライブに残す）。
- 壊れにくい：アップロードの途中で切れても重複も欠けもない、消しても 30 日は戻せる、上書きしても前の版が残る、バックアップから戻せる。
- 今の作り（モジュール・outbox・BlobStore・プレビュー・監査・速度制限）に乗せ、新しいサービスや依存を足さない。

### 1.3 非目標（v1 では作らない）

| 作らないもの | 理由・代わり |
| --- | --- |
| デスクトップの同期クライアント（フォルダの自動同期） | 利用者が要らないと回答。3 OS で作る費用が大きく、衝突の解決が難しい |
| Office の編集（OnlyOffice / Collabora） | 見るだけで足りると回答。変換のプレビューとダウンロード |
| WebDAV（OS のファイルマネージャからつなぐ） | 後で。認証（アプリパスワード）とロックの実装が要る。§19 Q10 |
| CalDAV | カレンダーは iCal の購読 URL（CALENDAR.md）で足りている |
| フォルダ・ファイルごとの共有設定（特定の人だけに見せる） | v1 は場所で決める（§3.1）。要れば後でドキュメントの権限（WIKI.md §4）と同じ形を足す（§19 Q2） |
| 中身の全文検索（PDF の本文など） | v1 はファイル名だけ。後で版ごとの本文の表を足す（§12） |
| ウイルススキャン | 今の添付と同じギャップ（SECURITY.md §4「未対応」）。要れば ClamAV を周期ジョブに |
| 重複排除（同じ中身を 1 つのオブジェクトにまとめる） | 参照の数え方が要り、壊れたときの影響が大きい。コピーは複製する（§10.3） |
| スマホからのアップロード | D7 の後。まず閲覧・ダウンロード・プレビュー |

## 2. 今の作りとの関係、ぶつかる所

設計の前に確かめた今の作りと、ドライブを入れると変えなければならない所。各段階（§18）で docs と実装を一緒に直す。

| 今の作り | ぶつかる所 | 対応 |
| --- | --- | --- |
| ARCHITECTURE.md §2 の規模「添付ファイル 合計数十 GB」 | ドライブで 100 GB を超え、200 GB 近くになりうる | D1 で §2 を「添付とドライブで 100〜200 GB」に直す。単一プロセス・PostgreSQL・versitygw のままで足りる（行数は数十万、バイト列は通すだけ） |
| `infra/backup.sh`：オブジェクトのディレクトリを**同じディスクの** `/srv/backups` に写す（初回は全体、2 回目からは変わらないファイルを前回へのハードリンク） | 初回で +100 GB。空き 217 GB からドライブ 100 GB と初回のバックアップ 100 GB を引くと残りは約 17 GB で、版・ゴミ箱・PostgreSQL の伸び・マルチパートの一時ファイル（下）を吸えない | サーバの外へのバックアップを必須にする。`BACKUP_ROOT` を別のディスクに置けるようにする（§16） |
| `infra/backup.sh`：毎回 `find … -exec sha256sum` で**全オブジェクト**の SHA-256 を取り、ファイルごとに `stat` を 2 回起動する | 100 GB を毎晩とデプロイのたびに読み直す（数十分。デプロイの前のバックアップが長くなる） | 前回のバックアップから変わっていない（ハードリンクした）ファイルは前回の `objects.sha256` の行を引き継ぎ、写したファイルだけ計算する。ループは 1 回の `find -printf` で比べる（D5） |
| `infra/restore-rehearsal.sh`：稼働中のスタックからバックアップを取り、別の compose に戻す | 同じディスクにもう 1 組（+100 GB 以上）作る | リハーサルはサーバの外（手元の機械・別のディスク）で行う手順を infra/README.md に書く（D5） |
| versitygw（posix）のマルチパート：部品をバケットの中の `.sgwtmp` に置き、完了のときに 1 つのファイルにつなぐ | 完了の間、そのファイルの分だけディスクが一時的に 2 倍になる。5 GB のファイルで +5 GB、つなぐのに数十秒 | **D1 で実物（v1.8.0）で確かめた（§6.6）**：一時の 2 倍は本当（5 GiB で +4.9 GB、完了の間だけ）、つなぐのは手元の SSD で 5 GiB 1.8 秒。完了は app のリクエストの外のタスクで行い（リクエストは 20 秒まで待って 202）、boto3 の読み取りの時間切れを完了の呼び出しだけ 600 秒に延ばした（`DRIVE_COMPLETE_TIMEOUT_SECONDS`） |
| `BlobStore`：`put` / `stream` / `exists` / `delete` / `copy` だけ | マルチパート、範囲を指定した読み出し、大きさの確認が無い | `BlobStore` に `create_multipart` / `upload_part` / `complete_multipart` / `abort_multipart` / `list_multipart_uploads` / `stream(key, start, end)` / `head` を足す。`MemoryBlobStore` にも同じものを足してテストで使う（§6.5） |
| `GET /attachments/{id}/content`：Range に対応していない | 5 GB のダウンロードを途中から再開できない。ブラウザの動画のシークもできない | ドライブのダウンロードは Range に対応する（§7.1）。同じ関数を添付の `/content` にも使う（害は無く、大きな動画のシークが効くようになる） |
| Desktop のダウンロード（`fetchBlob`）：本文を全部メモリに読んでから保存する | 数 GB のファイル・ZIP でメモリが足りない | Desktop は塊ごとにファイルへ書く（fs プラグインの `open` と `write`、今の `fs:scope-download-recursive` の範囲。新しい依存なし）。Web はブラウザ自身のダウンロード（§7.3） |
| Caddy：`/api/*` の本文は 1 MB、`/api/v1/attachments*` は 110 MB。nginx：`client_max_body_size 110m` | 部品の PUT（16 MiB）が 1 MB で断られる | Caddy に `/api/v1/drive/uploads/*/parts/*` の 17 MB の枠を足す。nginx は 110 MB のままでよい（部品は 16 MiB）。公開ページの `/s/*` と `/api/v1/shares/*` の経路も足す（§9.6） |
| アクセスログ（`core/logging.py` の `_SECRET_PATH`） | 共有リンクのトークンが URL のパスに入る | `/s/` と `/api/v1/shares/` を伏せる対象に足す。ホストの nginx のアクセスログにも残るので、`/s/` と `/api/v1/shares/` の `access_log` を伏せる設定例を `nginx-site.conf.example` に足す（§9.5）。**D4 で実装（§23）**：伏せた形式のログ（`map` と `log_format`） |
| `attachments` を読むすべての問い合わせ | ドライブの行（`message_id`・`channel_id` が NULL、`drive_item_id` あり）が混ざる | D1 で attachments を読む所を全部確かめる：GC（pending の 24 時間・deleted）、`verify-attachments`、`GET /files`、メッセージ検索のファイル名の枝、`export-channel`、匿名化、キャンバスとページの整理の周期ジョブ、デモのデータ。`GET /files` と検索は messages と結合するのでドライブの行は出ない（確かめてテストに固定する） |
| プレビューの loop：1 件ずつ、古い順、チャットの添付と共有 | 移行で数千件の Office ファイルが積まれるとチャットのプレビューが何時間も遅れる | 移行のファイルはプレビューを `none` で入れ、`generate-previews --drive` で夜に少しずつ作る（§8・§15） |
| SECURITY.md §4「未対応：ストレージのクォータ」 | ドライブで初めて容量を数える | 場所ごとの上限とワークスペース全体の上限（§11）。チャットの添付は今までどおり数えない |
| ARCHITECTURE.md の設計判断の番号 D1〜D28 | 本書の段階の名前 D1〜D7 と同じ字 | 本書の段階は「段階 D1」のように呼び、マイルストーンは M160〜M166 で書く。設計判断を足すときは D29 |

## 3. 場所（ロケーション）と権限

### 3.1 場所

| 場所 | 数 | 見える人 | 作られる時 |
| --- | --- | --- | --- |
| 研究室ドライブ（`workspace`） | ワークスペースに 1 つ | admin・manager・member（ゲストと bot は除く） | 移行（D1）で作る |
| チャンネルのドライブ（`channel`） | 公開・非公開チャンネルごとに 1 つ | そのチャンネルの今のメンバー（ゲストのメンバーも） | 初めて開いた・書いたとき（§5.1 の `resolve`） |
| マイドライブ（`user`） | 人ごとに 1 つ | 本人だけ（ゲストは持たない） | 初めて開いたとき |

- **DM・グループ DM にはドライブを付けない。** メンバーが固定でオーナーがおらず、「場所」として育てるものではない。DM の
  ファイルは今までどおりの添付。マイドライブのファイルを DM に「コピー」で送れる（§13.1）。
- **フォルダごとの共有設定は v1 に無い。** 見える人は場所で決まる。「教員だけ」「M2 だけ」のファイルは、その人たちの非公開
  チャンネルのドライブに置く（研究室のチャンネルの使い方と同じ考え方で、新しい権限の仕組みを作らずに済む）。特定の 1 人に
  マイドライブのファイルを見せる・ゲストに研究室ドライブの一部を見せるには、後でドキュメントと同じ「受け継ぐ権限」を足す
  （§19 Q2・Q3）。
- **公開チャンネルのドライブもメンバーだけ**（キャンバスと同じ。参加前のプレビュー M27 は当てはめない）。公開チャンネルなら
  参加すればすぐ見える。ファイルは重く、外部リンクの元にもなるので、メッセージより一段狭くする。

### 3.2 操作と権限

○ = できる、— = できない。「書く」はアップロード・フォルダの作成・名前の変更・移動・コピー・ゴミ箱へ・ゴミ箱から戻す・版を戻す。

| 操作 | 研究室ドライブ | チャンネルのドライブ | マイドライブ |
| --- | --- | --- | --- |
| 一覧・ダウンロード・プレビュー・検索 | admin / manager / member | チャンネルのメンバー（ゲストも） | 本人 |
| 書く | 同上 | メンバー。ただし投稿がオーナーだけのチャンネル（`posting_policy = owners`）はオーナーと admin のメンバーだけ、アーカイブしたチャンネルは誰も（読むだけ） | 本人 |
| 完全削除（ゴミ箱から）・古い版の削除 | admin | チャンネルのオーナー | 本人 |
| 外部共有リンクを作る | 書ける人（ゲストを除く）。場所とワークスペースで許されていれば | 同左 | 本人 |
| 自分の作ったリンクの変更・取り消し | 作った人 | 作った人 | 本人 |
| 場所の中のすべてのリンクの一覧・取り消し | admin | チャンネルのオーナー、admin（§3.4） | 本人 |
| 場所の設定（外部リンクを許すか） | admin | チャンネルのオーナー | 本人 |
| 容量の上限 | admin | admin | admin |

- 権限は**毎回のリクエストで**今のロールとメンバーシップから求める（実効の表は作らない。場所が 3 種類で、判定はメンバーの行 1 つで
  済むため）。読めない項目はどの経路でも **404 `drive_item_not_found`**（存在と名前を隠す）。読めるが書けなければ 403
  `drive_read_only`（アーカイブ・投稿の制限）か `guest_restricted`。
- manager は研究室ドライブではメンバーと同じ。ドライブの管理（容量・全体のリンク・引き取り）は admin だけ（新しい権限
  `drive.admin`、`app/core/roles.py`。ROLES.md に足す）。
- ゴミ箱に入れるのは「書く」の一部：研究室ドライブでは誰のファイルでも誰でもゴミ箱に入れられる（Nextcloud の共有フォルダと
  同じ）。消しても 30 日は誰でも戻せ、監査ログに残るので、取り返しのつかない操作（完全削除）だけを絞る。

### 3.3 人とチャンネルの変化

| 変化 | ドライブ | その人の外部リンク | 進行中のアップロード |
| --- | --- | --- | --- |
| チャンネルから抜けた・外された | そのチャンネルのドライブがすぐ見えなくなる（次のリクエストから 404）。置いたファイルは残る（持ち主はチャンネル） | その場所のリンクは止まる（作った人が読める範囲でだけ働く、§9.2） | 完了のときに 404（部品は GC が消す） |
| チャンネルのアーカイブ | 読むだけになる。容量は数えたまま | 止まる（`410 share_link_unavailable`）。アーカイブを戻せばまた働く（§19 Q6） | 完了のときに 403 `drive_read_only` |
| チャンネルの削除 | 今の Taylis にチャンネルの削除は無い（アーカイブだけ）。足すときはドライブの扱いを一緒に決める | — | — |
| 公開 ⇄ 非公開の切り替え | 変わらない（どちらもメンバーだけ） | 変わらない | 変わらない |
| ロールを guest に変えた | 研究室ドライブとマイドライブが見えなくなる（マイドライブは消さない。member に戻せば戻る） | 止まる（ゲストはリンクを持てない） | 完了のときに 403 |
| 無効化（ログインできない） | マイドライブは残す（管理者の引き取り、下） | 止まる | GC が消す |
| 匿名化（アカウントの削除、M104） | マイドライブを完全削除する（ゴミ箱を経ない、周期ジョブ）。共有の場所に置いたファイルは残り、置いた人は「退会したユーザー」 | すべて取り消す | 消す |

- **マイドライブの引き取り**（卒業）：admin は無効化した人のマイドライブを、研究室ドライブの中のフォルダ（既定「引き取り/<表示名>」）
  へ丸ごと移せる（`POST /admin/drive/users/{id}/takeover`）。中身は見ずに移すだけで、監査ログ `drive.takeover` に必ず残る。
  有効な人のマイドライブは引き取れない（本人に移してもらう）。ドキュメントの「引き取り」（WIKI.md §4.3）と同じ考え方。
  ただし卒業生の私物も含みうるので、運用（いつ・誰に知らせて行うか）は §19 Q5。
- **管理者でもマイドライブと、メンバーでない非公開チャンネルのドライブの中身は読めない。** 見えるのは使用量と件数（§11）と、
  リンクの一覧の項目名（§3.4）。

### 3.4 管理者とリンク

- 外部リンクは情報を外へ出す経路なので、admin は**場所を問わずすべての有効なリンク**を一覧し（項目の名前・場所の種類と名前・
  作った人・期限・回数・最後に使われた時刻）、取り消せる（`GET /admin/drive/links`）。項目の名前を出すのは、ドキュメントの管理者の
  一覧が題名を出すのと同じ判断（運用者は技術的にはすべて読める。名前まで隠すと取り消せない）。中身は出さない。

## 4. データモデル

移行は 0118 から（今の最新は 0117）。すべての id は UUIDv7。

### 4.1 バイト列の置き方（`attachments` を使う理由）

- ファイルの版 1 つにつき `attachments` の行 1 つ。`status = 'attached'`、`message_id`・`channel_id`・`canvas_id`・`page_id` は NULL、
  新しい列 `drive_item_id`（`REFERENCES drive_items(id) ON DELETE SET NULL`、部分索引）に項目を入れる。ストレージキーは今までどおり
  `attachments/{attachment_id}`（ファイル名も場所も入れない。名前の変更・移動はメタデータだけで済む）。
- 得るもの：サムネイル（画像）・ポスター（動画）・文書のプレビュー（PREVIEWS.md の loop・claim 番号・再試行）、
  `/attachments/{id}/thumbnail`・`/preview/thumbnail`・`/preview/pdf` の配信、`verify-attachments`、GC によるバイト列の削除、
  `generate-previews`。ドライブ用に作り直さずに済む。
- 読める人の判定は `get_for_access` に足す：`drive_item_id` があれば、`main.py` が注入した `drive.can_read(actor, item_id)` で決める
  （ページの `page_id` と同じ形。注入が無ければ 404 に倒す）。版が古くても判定は項目の権限。
- 版を消す（版の整理・完全削除）ときは、その添付を `deleted` にする（今の GC がバイト列と派生物を消す）。
- 別の表（`drive_blobs`）にしなかった理由：プレビュー・サムネイル・GC・検査をもう 1 組作ることになり、2 つの経路がずれる。代わりに
  attachments を読むすべての問い合わせにドライブの行を入れない条件が要る（§2 の「`attachments` を読むすべての問い合わせ」の行。D1 で全部確かめる）。

### 4.2 表

```sql
CREATE TABLE drive_locations (
  id              uuid PRIMARY KEY,
  kind            varchar(16) NOT NULL,             -- 'workspace' | 'channel' | 'user'
  channel_id      uuid UNIQUE REFERENCES channels(id),
  user_id         uuid UNIQUE REFERENCES users(id),
  root_id         uuid NOT NULL,                    -- drive_items の根のフォルダ（FK は DEFERRABLE、下）
  quota_bytes     bigint,                           -- NULL = 上限なし（§11）
  used_bytes      bigint NOT NULL DEFAULT 0,        -- 今の版 + 古い版 + ゴミ箱（同じトランザクションで増減）
  item_count      integer NOT NULL DEFAULT 0,       -- ファイルとフォルダの数（ゴミ箱を含む）
  external_links  boolean NOT NULL DEFAULT true,    -- この場所で外部リンクを作れるか（既存のリンクも止まる）
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (kind IN ('workspace', 'channel', 'user')),
  CHECK ((kind = 'channel') = (channel_id IS NOT NULL)),
  CHECK ((kind = 'user') = (user_id IS NOT NULL))
);
CREATE UNIQUE INDEX drive_locations_workspace_uniq ON drive_locations ((true)) WHERE kind = 'workspace';

CREATE SEQUENCE drive_change_seq;                   -- 項目のメタデータの変更ごとに 1 つ（§14）

CREATE TABLE drive_items (
  id                  uuid PRIMARY KEY,
  location_id         uuid NOT NULL REFERENCES drive_locations(id),
  parent_id           uuid REFERENCES drive_items(id),        -- NULL は場所の根だけ
  kind                varchar(8) NOT NULL,                    -- 'folder' | 'file'
  name                text NOT NULL,                          -- NFC、1〜255 文字（§4.3）
  name_key            text NOT NULL,                          -- 重複の判定：NFC + casefold
  name_sort           bytea NOT NULL,                         -- core/collation のキーを符号化したもの（日本語の名前順、カーソルに使う）
  current_version_id  uuid,                                   -- file のみ（drive_file_versions、FK は DEFERRABLE INITIALLY DEFERRED）
  size_bytes          bigint,                                 -- file：今の版の大きさ。folder：NULL
  content_type        text,                                   -- file：今の版の sniff した型
  content_modified_at timestamptz,                            -- ファイルの更新日時（移行元の mtime、ブラウザの lastModified。§6.2）
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES users(id),
  updated_at          timestamptz NOT NULL DEFAULT now(),     -- 名前・移動・新しい版
  trashed_at          timestamptz,                            -- ゴミ箱（部分木のすべてに入る）
  trashed_by          uuid REFERENCES users(id),
  trash_root_id       uuid REFERENCES drive_items(id),        -- 一緒にゴミ箱に入ったまとまりの根（根では自分）
  trash_parent_id     uuid,                                   -- まとまりの根だけ：入れた時の親（戻す先）
  change_seq          bigint NOT NULL,                        -- nextval('drive_change_seq')
  CHECK (kind IN ('folder', 'file')),
  CHECK ((kind = 'file') = (current_version_id IS NOT NULL)),
  CHECK (parent_id IS NOT NULL OR kind = 'folder'),
  CHECK ((trashed_at IS NULL) = (trash_root_id IS NULL))
);
-- 同じフォルダに同じ名前（大文字小文字を区別しない）は 1 つ。ゴミ箱の中は数えない
CREATE UNIQUE INDEX drive_items_name_uniq ON drive_items (parent_id, name_key) WHERE trashed_at IS NULL;
-- 一覧（フォルダが先、名前順）とカーソル
CREATE INDEX drive_items_children_idx ON drive_items (parent_id, kind, name_sort, id) WHERE trashed_at IS NULL;
CREATE INDEX drive_items_trash_idx ON drive_items (location_id, trashed_at) WHERE trashed_at IS NOT NULL AND trash_root_id = id;
CREATE INDEX drive_items_change_idx ON drive_items (location_id, change_seq);
CREATE INDEX drive_items_name_pgroonga_idx ON drive_items USING pgroonga (name);  -- §12

CREATE TABLE drive_file_versions (
  id              uuid PRIMARY KEY,
  item_id         uuid NOT NULL REFERENCES drive_items(id) ON DELETE CASCADE,
  number          integer NOT NULL,                 -- 1, 2, 3 …（項目の中で増えるだけ）
  attachment_id   uuid NOT NULL UNIQUE REFERENCES attachments(id),
  size_bytes      bigint NOT NULL,
  sha256          bytea,                            -- 完了の後の処理（§6.4）で入る
  content_modified_at timestamptz,
  uploaded_by     uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  source          varchar(16) NOT NULL DEFAULT 'upload',  -- 'upload' | 'copy' | 'restore' | 'attachment' | 'import'
  processed_at    timestamptz,                      -- 完了の後の処理（SHA-256・サムネイル・ポスター）が済んだ時刻
  UNIQUE (item_id, number)
);

CREATE TABLE drive_uploads (                        -- アップロードのセッション（§6）
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id),
  client_upload_id uuid NOT NULL,                   -- 端末が作る。同じ値の作成は同じセッションを返す
  location_id      uuid NOT NULL REFERENCES drive_locations(id),
  parent_id        uuid NOT NULL REFERENCES drive_items(id),
  relative_dir     text,                            -- フォルダのアップロード：'a/b'（完了のときに作る）
  name             text NOT NULL,
  target_item_id   uuid REFERENCES drive_items(id), -- 「このファイルの新しい版」と明示したとき
  on_conflict      varchar(8) NOT NULL,             -- 'version' | 'rename' | 'fail'
  size_bytes       bigint NOT NULL,
  part_size        integer NOT NULL,                -- 16 MiB（サーバが決める）
  attachment_id    uuid NOT NULL UNIQUE,            -- 予約した id（キー attachments/{id}）
  s3_upload_id     text NOT NULL,
  content_modified_at timestamptz,
  status           varchar(12) NOT NULL DEFAULT 'active',  -- 'active' | 'completing' | 'completed' | 'aborted' | 'expired'
  item_id          uuid,                            -- 完了の結果
  version_id       uuid,
  error            text,
  expires_at       timestamptz NOT NULL,            -- 最後の部品から DRIVE_UPLOAD_TTL_HOURS（既定 24）
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_upload_id)
);
CREATE INDEX drive_uploads_active_idx ON drive_uploads (expires_at) WHERE status IN ('active', 'completing');

CREATE TABLE drive_upload_parts (
  upload_id    uuid NOT NULL REFERENCES drive_uploads(id) ON DELETE CASCADE,
  part_number  integer NOT NULL,                    -- 1 から
  size_bytes   integer NOT NULL,
  sha256       bytea NOT NULL,
  etag         text NOT NULL,                       -- S3 の UploadPart の答え（完了に要る）
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (upload_id, part_number)
);

CREATE TABLE drive_share_links (                    -- 外部共有リンク（§9）
  id              uuid PRIMARY KEY,
  item_id         uuid NOT NULL REFERENCES drive_items(id) ON DELETE CASCADE,
  location_id     uuid NOT NULL REFERENCES drive_locations(id),
  created_by      uuid NOT NULL REFERENCES users(id),
  token_hash      bytea NOT NULL UNIQUE,            -- SHA-256(token)。トークンは作成の応答に 1 回だけ
  password_hash   text,                             -- Argon2id（ログインと同じ設定）。NULL = パスワードなし
  password_version integer NOT NULL DEFAULT 0,      -- パスワードを変えると +1（解錠の cookie を無効にする）
  expires_at      timestamptz,                      -- NULL = 期限なし（ワークスペースで許すときだけ）
  max_downloads   integer,                          -- NULL = 上限なし
  download_count  integer NOT NULL DEFAULT 0,
  note            varchar(80),                      -- 誰向けか（作った人と管理者の一覧に出す）
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES users(id),
  last_used_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX drive_share_links_item_idx ON drive_share_links (item_id) WHERE revoked_at IS NULL;
CREATE INDEX drive_share_links_location_idx ON drive_share_links (location_id) WHERE revoked_at IS NULL;

CREATE TABLE drive_share_events (                   -- 公開側の使われ方（§9.5）。180 日で消す
  id          bigserial PRIMARY KEY,
  link_id     uuid NOT NULL REFERENCES drive_share_links(id) ON DELETE CASCADE,
  item_id     uuid,                                 -- 開いた・落とした項目（部分木の中）
  kind        varchar(16) NOT NULL,                 -- 'open' | 'download' | 'zip' | 'password_failed' | 'refused'
  bytes       bigint,
  ip          inet,
  user_agent  varchar(200),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX drive_share_events_link_idx ON drive_share_events (link_id, created_at);

-- workspace_settings に足す列
ALTER TABLE workspace_settings
  ADD COLUMN drive_external_links_enabled boolean NOT NULL DEFAULT true,   -- 全体のスイッチ（切ると既存のリンクもすべて止まる）
  ADD COLUMN drive_link_max_days integer DEFAULT 90,                       -- リンクの期限の最長。NULL = 期限なしを許す
  ADD COLUMN drive_link_password_required boolean NOT NULL DEFAULT false;  -- パスワードを必須にする

-- attachments に足す列
ALTER TABLE attachments ADD COLUMN drive_item_id uuid REFERENCES drive_items(id) ON DELETE SET NULL;
CREATE INDEX attachments_drive_item_idx ON attachments (drive_item_id) WHERE drive_item_id IS NOT NULL;
```

- `drive_items.current_version_id` と `drive_locations.root_id` は循環するので、外部キーを `DEFERRABLE INITIALLY DEFERRED` にし、
  同じトランザクションで両方の行を入れる（id は app で先に決める）。
- 項目の行は完全削除まで消さない（ゴミ箱は `trashed_at`）。完全削除では版の添付を `deleted` にし、リンクを消し（CASCADE）、行を消す。
  消した項目の id は `drive_tombstones` に残さない（v1 の端末は手元に木を持たないので要らない、§14）。
- `used_bytes` は版の行を足す・消すトランザクションで、場所の行を `FOR UPDATE` で取って増減する（§11）。ずれの検査は
  `app.cli drive-usage --verify`（版の合計と比べる）と `--rebuild`。
- 木の形の変更（作成・名前・移動・ゴミ箱・戻す・コピー）は、親のフォルダの行を `FOR UPDATE` で取って直列化する。移動は元と先の
  親を id の順に取る（デッドロックを避ける）。輪（自分の子孫への移動）の確認は再帰 CTE で先の祖先をたどる（深さの上限 32）。

### 4.3 名前の規則

- 保存の前に NFC に正規化する（macOS のブラウザ・Finder から NFD の濁点が来ても同じ名前として扱う）。前後の空白を除く。
- 断るもの（422 `drive_name_invalid`）：空、255 文字を超える、`/`、NUL と制御文字、`.` と `..`。
- Windows が受け付けない文字（`<>:"\|?*`、末尾の `.` と空白、`CON` などの予約名）は**保存では断らない**（Nextcloud から移す名前を
  そのまま残す）。ZIP とダウンロードのファイル名を作るときに今の規則（PREVIEWS.md §9 の「ファイル名」）で置き換える。
- 同じフォルダに大文字小文字だけ違う名前を置かない（`name_key`）。Windows と macOS で展開したときに衝突しないように。
- 深さは根から 32 段まで（422 `drive_depth_exceeded`）、1 つのフォルダの子は 10,000 まで（409 `drive_folder_full`）。

## 5. API

すべて `/api/v1`、認証は今までどおり（Bearer / Web の cookie）。エラーは `{"error": {"code", "message", "details"}}`。一覧は
カーソル（`cursor` / `next_cursor`、`limit` は既定 100・最大 200）。OpenAPI と `ws-events.json` を再生成し、エラーの文言を
`apps/shared/errors.json` に足す。

### 5.1 場所

| メソッド | パス | 中身 |
| --- | --- | --- |
| GET | `/drive/locations` | `{locations: [DriveLocationOut]}`：研究室ドライブ（ゲスト以外）、マイドライブ（あれば）、自分がメンバーのチャンネルのうちドライブのあるもの |
| POST | `/drive/locations/resolve` | `{kind: "channel", channel_id} \| {kind: "me"}` → `DriveLocationOut`（無ければ作る。冪等、200）。チャンネルのメンバーでなければ 404、DM は 422 `drive_not_available`、ゲストの `me` は 403 `guest_restricted` |
| PATCH | `/drive/locations/{id}` | `{external_links?}`（§3.2 の「場所の設定」の人）。`{quota_bytes?}` は admin だけ（`/admin/drive/locations/{id}`） |

```json
DriveLocationOut = {
  "id": "…", "kind": "channel", "channel_id": "…", "user_id": null,
  "root_id": "…", "name": "#m2-seminar",
  "can_write": true, "can_manage": false, "can_share": true,
  "external_links": true, "quota_bytes": null, "used_bytes": 1234567890, "item_count": 812
}
```

### 5.2 項目

| メソッド | パス | 中身 |
| --- | --- | --- |
| GET | `/drive/folders/{id}/children?sort=name\|modified\|size&order=asc\|desc&cursor=&limit=` | `{folder: ItemOut, path: [Crumb], items: [ItemOut], next_cursor}`。フォルダが先。`path` は根から（場所の名前を含む） |
| GET | `/drive/items/{id}` | `ItemOut` と `path`（パーマリンクのカード・検索の結果から開くため） |
| POST | `/drive/folders` | `{parent_id, name, client_op_id}` または `{parent_id, path: "a/b/c", client_op_id}`（途中も作る、mkdir -p）→ 201 `ItemOut`。同じ `client_op_id` の再送は 200 で同じ行。同じ名前のフォルダがあれば `path` の形はそれを使い、`name` の形は 409 `drive_name_taken`（`details.existing_id`） |
| PATCH | `/drive/items/{id}` | `{name}` → `ItemOut`。409 `drive_name_taken` |
| POST | `/drive/items/move` | `{item_ids: [..≤500], target_folder_id, on_conflict: "fail" \| "rename"}` → `{results: [{id, ok, error?}]}`。場所をまたぐ移動は元と先の両方に書ける人だけ（容量も移る）。409 `drive_cycle` |
| POST | `/drive/items/copy` | `{item_ids, target_folder_id, on_conflict, client_op_id}` → 202 `{job_id}` か 200 `{results}`（§10.3）。**D3**：いつも 200 `{results: [{id, ok, error?, new_id}]}`、上限を超えれば 413（§22.2） |
| POST | `/drive/items/trash` | `{item_ids}` → `{results}`。部分木ごと |
| GET | `/drive/locations/{id}/trash?cursor=` | ゴミ箱のまとまりの根の一覧（入れた人・時刻・中の件数と大きさ） |
| POST | `/drive/items/{id}/restore` | `{on_conflict: "rename" \| "fail"}` → `ItemOut`。元の親がゴミ箱か無ければ場所の根に戻す |
| DELETE | `/drive/items/{id}` | 完全削除（ゴミ箱の中のものだけ、409 `drive_not_in_trash`）。§3.2 の人だけ |
| GET | `/drive/items/{id}/versions` | `{versions: [VersionOut]}`（新しい順） |
| POST | `/drive/items/{id}/versions/{version_id}/restore` | その版を新しい今の版として写す（§10.2）→ `ItemOut` |
| DELETE | `/drive/items/{id}/versions/{version_id}` | 古い版を消す（今の版は 409 `drive_version_current`） |
| GET | `/drive/items/{id}/content?version_id=` | ダウンロード（Range、§7.1） |
| POST | `/drive/zip` | `{item_ids: [..]}` → `{url, expires_in, entries, size_bytes}`（§7.2。**D3** で `zip_bytes`（ZIP の長さ）・`filename` を足した）。`GET /drive/zip/{ticket}` が ZIP を流す |

```json
ItemOut = {
  "id": "…", "location_id": "…", "parent_id": "…", "kind": "file",
  "name": "修論_最終.pdf", "size_bytes": 4823112, "content_type": "application/pdf",
  "content_modified_at": "2026-02-01T09:12:00Z",
  "created_by": "…", "created_at": "…", "updated_by": "…", "updated_at": "…",
  "version_count": 3,
  "file": {                                  // kind = file のときだけ。今の版の添付（AttachmentOut の一部と同じ形）
    "attachment_id": "…", "width": null, "height": null,
    "has_thumbnail": false, "has_poster": false, "duration_ms": null,
    "preview": {"status": "ready", "pages": 12, "width": 800, "height": 1132}
  },
  "link_count": 1                           // 自分に見える有効な外部リンクの数（共有のしるし）
}
```

- サムネイル・ポスター・文書のプレビューは今の `/attachments/{attachment_id}/thumbnail`・`/preview/thumbnail`・`/preview/pdf`
  （§4.1 の判定）。端末の今のビューアがそのまま使える。
- 本文（`/content`）だけはドライブの経路にする：名前が今の項目の名前（アップロードの時の名前ではない）、Range、版の指定のため。

### 5.3 アップロード（§6）

| メソッド | パス | 中身 |
| --- | --- | --- |
| POST | `/drive/uploads` | `{client_upload_id, parent_id, relative_dir?, name, size_bytes, content_modified_ms?, on_conflict, target_item_id?}` → 201 `UploadOut`（同じ `client_upload_id` は 200 で同じセッション）。413 `drive_file_too_large`、409 `drive_quota_exceeded`、409 `drive_name_taken`（`fail` のとき） |
| GET | `/drive/uploads/{id}` | `UploadOut`（受け取った部品の番号） |
| PATCH | `/drive/uploads/{id}` | `{name?, on_conflict?}`（`fail` で 409 になった後に名前・衝突の扱いを変えて完了し直す） |
| GET | `/drive/uploads?status=active` | 自分の進行中のセッション（画面を開き直したときの再開） |
| PUT | `/drive/uploads/{id}/parts/{n}` | 本文は部品のバイト列（`application/octet-stream`）、ヘッダ `X-Content-SHA256`（16 進、必須）→ `{part_number, size_bytes}`。同じ番号の送り直しは置き換え（冪等） |
| POST | `/drive/uploads/{id}/complete` | → 200 `{status: "completed", item: ItemOut, version_id}` か 202 `{status: "completing"}`。冪等 |
| DELETE | `/drive/uploads/{id}` | 取りやめ → 204 |

```json
UploadOut = {
  "id": "…", "status": "active", "part_size": 16777216, "parts_total": 306,
  "received_parts": [1, 2, 3], "size_bytes": 5130000000, "expires_at": "…",
  "item_id": null, "error": null
}
```

### 5.4 外部共有リンク（§9）

| メソッド | パス | 中身 |
| --- | --- | --- |
| POST | `/drive/items/{id}/links` | `{expires_at?, password?, max_downloads?, note?}` → 201 `{link: ShareLinkOut, url}`（`url` はこの応答だけ）。403 `drive_links_disabled` / `guest_restricted`、422 `share_link_expiry_too_long` / `share_link_password_required` |
| GET | `/drive/items/{id}/links` | その項目の有効なリンク（作った人のもの。場所を管理できる人には全部） |
| GET | `/drive/links?mine=1` | 自分が作った有効なリンク（項目と場所の名前つき） |
| PATCH | `/drive/links/{id}` | `{expires_at?, password? (null で外す), max_downloads?, note?}` |
| DELETE | `/drive/links/{id}` | 取り消し → 204 |
| GET | `/drive/links/{id}/events?cursor=` | 使われ方（開いた・落とした時刻・IP の上位を伏せた形・回数） |

```json
ShareLinkOut = {
  "id": "…", "item_id": "…", "item_name": "共同研究_データ", "item_kind": "folder",
  "created_by": "…", "created_at": "…", "expires_at": "…", "has_password": true,
  "max_downloads": 20, "download_count": 3, "note": "〇〇大の△△先生", "last_used_at": "…",
  "state": "active"                       // active | expired | exhausted | revoked | paused（作った人が読めない・場所やワークスペースで止めた）
}
```

公開側（認証なし、§9.3）：

| メソッド | パス | 中身 |
| --- | --- | --- |
| GET | `/shares/{token}` | `{state, kind, name, size_bytes?, expires_at, password_required, root_id}`。知らないトークンは 404 `share_link_not_found`、取り消し・期限切れ・回数切れ・止めたものは 410 `share_link_unavailable` |
| POST | `/shares/{token}/unlock` | `{password}` → 204 と解錠の cookie。401 `share_password_invalid` |
| GET | `/shares/{token}/folders/{id}/children?cursor=` | 部分木の中のフォルダの一覧（名前・大きさ・更新日時・型・プレビューの有無だけ。作った人・更新した人は出さない） |
| GET | `/shares/{token}/items/{id}/content` | ダウンロード（Range） |
| GET | `/shares/{token}/items/{id}/thumbnail`・`/preview/thumbnail`・`/preview/pdf` | 画像のサムネイル・文書の 1 ページ目・全ページの PDF |
| GET | `/shares/{token}/zip?folder_id=` | フォルダの ZIP（§7.2 と同じ上限） |

### 5.5 管理者

| メソッド | パス | 中身 |
| --- | --- | --- |
| GET | `/admin/drive/usage` | 全体と場所ごとの使用量（§11.2） |
| PATCH | `/admin/drive/locations/{id}` | `{quota_bytes}`（監査 `drive.quota_changed`） |
| GET | `/admin/drive/links?cursor=` | すべての有効なリンク（§3.4） |
| DELETE | `/admin/drive/links/{id}` | 取り消し（監査 `drive.link_revoked`、`by_admin: true`） |
| POST | `/admin/drive/users/{id}/takeover` | `{target_folder_name?}` → `{folder: ItemOut}`（§3.3） |
| PATCH | `/admin/workspace-settings` | `drive_external_links_enabled`・`drive_link_max_days`・`drive_link_password_required` を足す（今の監査と `workspace.settings_updated`） |

### 5.6 会話・検索（§12・§13）

| メソッド | パス | 中身 |
| --- | --- | --- |
| GET | `/search/drive?q=&location_id=&cursor=&limit=` | `{items: [ItemOut + path], next_cursor}`（読める場所だけ、ゴミ箱を除く） |
| POST | `/drive/items/{id}/attach-copy` | → 201 `AttachmentOut`（pending。入力欄の添付として送る。100 MB を超えれば 413 `attachment_too_large`） |
| POST | `/drive/save-attachment` | `{attachment_id, folder_id, name?, on_conflict, client_op_id}` → 201 `ItemOut` |
| GET | `/drive/items/{id}/reach?channel_id=` | `{readable: n, unreadable: m}`（その会話のメンバーのうち読める / 読めない人の数。入力欄の注意、§13.1） |

### 5.7 エラーの一覧（`apps/shared/errors.json` に足す）

| HTTP | code | 意味 |
| --- | --- | --- |
| 404 | `drive_item_not_found` | 無い・読めない（区別しない） |
| 403 | `drive_read_only` | アーカイブ・投稿の制限で書けない |
| 403 | `drive_manage_restricted` | 完全削除・場所の設定などの権限が無い |
| 409 | `drive_name_taken` | 同じ名前がある（`details.existing_id`、`details.existing_kind`） |
| 422 | `drive_name_invalid` / `drive_depth_exceeded` | 名前・深さ |
| 409 | `drive_folder_full` / `drive_cycle` / `drive_not_in_trash` / `drive_version_current` | 状態の衝突 |
| 413 | `drive_file_too_large` / `drive_zip_too_large` / `drive_copy_too_large` | 大きさの上限（`details.limit_bytes`） |
| 409 | `drive_quota_exceeded` | 容量の上限（`details.quota_bytes`、`used_bytes`、`location_id`。全体の上限なら `scope: "workspace"`） |
| 410 | `drive_upload_expired` | セッションの期限切れ・取りやめ |
| 409 | `drive_upload_incomplete` | 足りない部品がある（`details.missing: [n]`） |
| 422 | `drive_part_invalid` | 部品の大きさ・SHA-256 が合わない |
| 403 | `drive_links_disabled` | ワークスペース・場所で外部リンクが止まっている |
| 422 | `drive_not_available` | DM・グループ DM |
| 404 / 410 | `share_link_not_found` / `share_link_unavailable` | 公開側（§9.3） |
| 401 | `share_password_required` / `share_password_invalid` | 公開側のパスワード |

## 6. アップロード

### 6.1 流れ

```
端末                                     app                                         versitygw
 POST /drive/uploads ─────────────────▶ 権限・名前・容量（予約）を確かめる
                                         CreateMultipartUpload(attachments/{aid}) ─▶
                                         drive_uploads を INSERT（失敗したら Abort）
 ◀──────────────── 201 {id, part_size, received_parts: []}
 PUT /parts/1 (16 MiB, X-Content-SHA256) ▶ 一時ファイルに流しながら SHA-256 と大きさ
                                         UploadPart(1) ──────────────────────────▶
                                         drive_upload_parts を UPSERT、expires_at を延ばす
 PUT /parts/2 … （同時に 3 本まで）
 （切れた・閉じた）
 GET /drive/uploads/{id} ──────────────▶ received_parts を返す → 足りない番号だけ送る
 POST /complete ───────────────────────▶ 部品が揃っているか → status = completing（コミット）
                                         CompleteMultipartUpload ─────────────────▶（数秒〜数十秒）
                                         先頭 8 KB を Range で読んで型を sniff
                                         1 トランザクション：親を FOR UPDATE、名前の衝突の解決、
                                         attachments・drive_items・drive_file_versions を INSERT、
                                         used_bytes を加える、outbox（drive.changed）、status = completed
 ◀──────────────── 200 {item}
                                         後の処理（§6.4）：SHA-256・サムネイル・ポスター・プレビュー
```

### 6.2 決まりごと

- **大きさ**：1 ファイル `DRIVE_MAX_FILE_BYTES`（既定 5 GB）。0 バイトのファイルも置ける（部品 0 個。S3 には空の put）。
  宣言した `size_bytes` に対し、最後以外の部品はちょうど `part_size`、最後は残り。違えば 422 `drive_part_invalid`。完了の後の
  オブジェクトの大きさも `head` で確かめる。
- **部品の大きさ** 16 MiB（S3 の下限 5 MiB と部品の数の上限 10,000 の間。5 GB で 306 個、10,000 個で 160 GB まで）。app は部品を
  一時ファイルに流してから `upload_part` に渡す（メモリに 2 つ持たない。今の添付の SpooledTemporaryFile と同じ）。
- **冪等**：セッションは `(user_id, client_upload_id)` で 1 つ。部品は番号で置き換え。完了は状態で分ける（`completed` なら同じ結果、
  `completing` なら 202 で端末は 2 秒ごとに `GET /drive/uploads/{id}`）。送り直しで同じファイルが 2 つできることはない。
- **名前の衝突**（完了のとき、親の行のロックの中で決める）：
  - `version`：同じ名前のファイルがあれば新しい版にする（フォルダなら 409 `drive_name_taken`）。
  - `rename`：「名前 (1).pdf」「名前 (2).pdf」…（PREVIEWS.md §9 と同じ付け方）。
  - `fail`：409 `drive_name_taken`（セッションは active のまま、端末が別の名前や `version` で完了し直せる：`PATCH /drive/uploads/{id}`
    で `name` / `on_conflict` を変える）。
  - 端末は送る前に一覧で衝突を見つけ、人に「置き換える（前の版を残す）/ 両方残す / 飛ばす」を聞いて `on_conflict` を決める（§17.3）。
  - `target_item_id` があればその項目の新しい版（名前は項目のまま。項目が動いていても追う）。
- **フォルダのアップロード**：端末は相対パスを `relative_dir` に入れる。途中のフォルダは完了のときに名前で探すか作る（同じ
  トランザクション、`POST /drive/folders` の `path` と同じ関数）。空のフォルダは端末が `POST /drive/folders {path}` で作る。
- **更新日時**：`content_modified_ms`（ブラウザの `File.lastModified`）は表示のための値で、並び順・同期には使わない
  （CLAUDE.md：クライアントの時刻を信用しない）。1980-01-01 から「今 + 1 日」に収め、外れれば NULL。
- **型**：完了のときにオブジェクトの先頭 8 KB を Range で読み、今の添付と同じ `filetype` で sniff する（端末の申告は使わない）。
- **容量**：作成のときに「使用量 + その場所の進行中のセッションの合計 + 今回」が上限を超えれば 409。完了のときに場所の行を
  `FOR UPDATE` で取ってもう一度確かめ、`used_bytes` を加える（§11）。
- **速度制限**（プロセス内の token bucket、SECURITY.md §5 の表に足す）：セッションの作成 ユーザー 600 回 / 分（フォルダの
  アップロードで小さなファイルが数百）、部品 ユーザー 240 回 / 分（16 MiB × 4/秒 ≈ 64 MB/s）、同時に active なセッション 1 人
  1,000 まで（409 `drive_too_many_uploads`）。
- **期限**：最後の部品から 24 時間（`DRIVE_UPLOAD_TTL_HOURS`）で `expired`。周期ジョブが S3 の `AbortMultipartUpload` を呼ぶ。
  1 日 1 回 `ListMultipartUploads`（`attachments/` の前置き）で、行の無い（作成の直後に落ちた）マルチパートも 24 時間後に取りやめる。
  `completing` のまま 10 分を超えた行は周期ジョブが拾う：オブジェクトが期待の大きさであれば行を作って完了させ、無ければ
  `CompleteMultipartUpload` をやり直す（部品は残っている）。

### 6.3 小さなファイル

小さなファイルもセッション → 部品 1 つ → 完了の 3 回で送る（経路を 1 つにする）。フォルダのアップロードで数百のファイルを
送っても、1 回 20 ms 前後なら困らない。測って遅ければ、作成の要求に本文を載せる近道（16 MiB まで）を後で足す。

### 6.4 完了の後の処理（drive の media loop）

完了の応答を速く返すため、次は app の中の 1 本のバックグラウンドループで 1 件ずつ行う（`processed_at IS NULL` の版を
`FOR UPDATE SKIP LOCKED` で取る。プレビューの loop と同じ作り、リースつき）：

1. オブジェクトを流して SHA-256 を取り、`drive_file_versions.sha256` と `attachments.sha256` に入れる。
2. 画像（今の `IMAGE_TYPES`、`DRIVE_IMAGE_THUMB_MAX_BYTES` 既定 100 MB まで）は一時ファイルに落としてサムネイル（今の
   `make_thumbnail`、画素数の上限も同じ）。
3. 動画（`DRIVE_VIDEO_PROBE_MAX_BYTES` 既定 2 GB まで）は一時ファイルに落として今の ffprobe / ffmpeg の手順（SECURITY.md §4「動画」）。
   一時ファイルは終われば消す。大きな動画で一時ディレクトリが溢れないよう、同時に 1 本。
4. 文書は今のプレビューの `queue_on_upload`（`pending` にして preview loop を起こす。上限は §8）。今の版だけ。
5. `processed_at` を入れ、サムネイル・ポスターが増えたら `drive.changed`。

失敗はアップロードを失敗させない（今の添付と同じ：普通のファイルとして残る）。

D1 の実装（§20）：4 の文書のプレビューの予約は、完了のトランザクションで添付の行を作るときに行う（`queue_on_upload`。media loop を
待たずにプレビューの loop が始められる）。media loop のリースは `drive_file_versions.process_next_at`（30 分）と `process_attempts`
（3 回まで）。プレビューの完了は preview loop が `drive.changed` を出す（`main.py` が注入するフック）。

### 6.5 `BlobStore` に足すもの

```python
class BlobStore(Protocol):
    ...
    async def create_multipart(self, key: str, content_type: str) -> str: ...          # upload_id
    async def upload_part(self, key: str, upload_id: str, number: int, data: IO[bytes], size: int) -> str: ...  # etag
    async def complete_multipart(self, key: str, upload_id: str, parts: list[tuple[int, str]]) -> None: ...
    async def abort_multipart(self, key: str, upload_id: str) -> None: ...
    def list_multipart_uploads(self, prefix: str) -> AsyncIterator[tuple[str, str, datetime]]: ...
    def stream(self, key: str, start: int | None = None, end: int | None = None) -> AsyncIterator[bytes]: ...
    async def head(self, key: str) -> int | None: ...                                   # 大きさ、無ければ None
```

`S3BlobStore` は boto3 の同名の呼び出し（スレッドプールで）。完了だけは別の `Config(read_timeout=600)` のクライアントで呼ぶ
（§2）。`MemoryBlobStore` は部品を dict に持ってつなぐ。

### 6.6 versitygw のマルチパートの実測（D1、2026-10-21）

開発用の compose と同じ `versity/versitygw:v1.8.0`（`posix /data`、ext4 の Docker のボリューム、Mac の SSD）に boto3 で 16 MiB の部品を
送って確かめた（`scratchpad` の使い捨てのスクリプト。手順は下の数値を取り直すときのために残す）。

| 確かめたこと | 結果 | 決めたこと |
| --- | --- | --- |
| 部品の置き場所 | バケットの中の `.sgwtmp/multipart/<キーの SHA-256>/<upload id>/<部品の番号>` に 1 部品 1 ファイル | バックアップ（`infra/backup.sh` のオブジェクトのディレクトリの写し）に進行中の部品も入る。期限切れ・孤児の掃除（§6.2）で消す |
| 完了の間のディスク | つなぐ間だけ使用量が増え、終わると戻る：1 GiB で +128 MB（0.4 秒の途中の 1 回の測り）、5 GiB で 37,109 → 42,079 MB（+4.9 GB）→ 37,109 MB | §2 のとおり、空きの見積もりに「最大のファイル 1 つ分」を足す。同時に完了するのは 1 プロセスの中の数本だけ |
| 完了の時間 | 1 GiB 0.4 秒、5 GiB 1.8 秒（約 2.8 GB/秒）。研究室のサーバの遅いディスク・混んでいるときはこの数倍〜数十倍になりうる | 完了の呼び出しだけ read timeout 600 秒（`DRIVE_COMPLETE_TIMEOUT_SECONDS`）、ほかの呼び出しは既定のまま。リクエストは 20 秒（`DRIVE_COMPLETE_WAIT_SECONDS`）待って 202 |
| 部品の送り直し | 同じ番号を別の中身で送ると置き換わり、元の中身で送り直すと元の ETag に戻る | 部品は番号で置き換え（冪等）。ETag は DB の `drive_upload_parts` に持ち、完了ではそれを渡す |
| 完了の送り直し | 完了した後に同じ部品で `CompleteMultipartUpload` を呼んでも成功が返る。`AbortMultipartUpload` は `NoSuchUpload` | app はまず `head` でオブジェクトの大きさを確かめ、揃っていれば完了を呼ばない（ほかの S3 互換のストアでも同じに動く）。取りやめの `NoSuchUpload` は成功として扱う |
| 部品 0 個の完了 | `MalformedXML` | 0 バイトのファイルはマルチパートを作らず空の `put`（`s3_upload_id` は空） |
| 最後以外の部品が 5 MiB 未満 | `EntityTooSmall`（1 部品だけなら 10 バイトでも通る） | 部品は 16 MiB 固定（テストでは `MemoryBlobStore` と小さな `DRIVE_PART_BYTES`）。設定で 5 MiB 未満にしない |
| 取りやめの後の部品 | `NoSuchUpload` | 期限切れ・取りやめのセッションへの部品は app が先に 410 で断る |
| Range・head | `Range: bytes=100-199` に 100 バイトと `Content-Range`、`head` は大きさ | ダウンロードの Range（§7.1）と完了の大きさの確認・型の sniff（先頭 8 KB）に使う |
| 速さ（参考） | boto3 で 5 GiB を 16 MiB × 320 部品 19 秒、読み出し 16 秒。app と Caddy を通した 1 GiB（64 部品）は送り 7 秒・完了 0.6 秒・ダウンロード 3 秒（§20 の compose の通し） | — |


## 7. ダウンロードと ZIP

### 7.1 1 つのファイル

- `GET /drive/items/{id}/content`（と公開側）は `Range: bytes=a-b` に 206 で答える（1 つの範囲だけ。複数の範囲は 200 で全体）。
  `Accept-Ranges: bytes`、`Content-Length`、`ETag`（版の id）、`Last-Modified`。`If-Range` を見る。
- ヘッダは今の添付と同じ：`Content-Disposition: attachment; filename*=UTF-8''<今の名前>`、`X-Content-Type-Options: nosniff`、
  `Cache-Control: private, max-age=3600`（公開側は `no-store`）、`Content-Security-Policy: sandbox`。HTML・SVG・PDF を
  inline で返すことはない（PDF の表示は `/preview/pdf` だけ、PREVIEWS.md §5）。`?inline=1` は画像だけ（今の添付と同じ）。
- 動画の再生（アプリの中のプレーヤー）は Range があるのでシークできる。

### 7.2 フォルダ・複数の ZIP

- `POST /drive/zip {item_ids}` は中身を数えて上限を確かめ、1 回だけ使える 5 分のチケット（32 バイトの乱数、DB ではなくプロセスの
  メモリに SHA-256 で持つ。単一プロセスなので足りる。再起動で消えれば端末は作り直す）を返す。`GET /drive/zip/{ticket}` が流す。
  チケットにするのは、Web がブラウザ自身のダウンロード（`<a href>` への移動）で受け取れるようにするため（`fetch` だと全体が
  メモリに載る）。
- 形：**圧縮しない ZIP（stored）+ ZIP64**。書いたそばから応答に流す（一時ファイルを作らない）。**D3 の実装**：標準の `zipfile` ではなく
  小さな自前の書き手（`drive/zipstream.py`、§22.2）。
  圧縮しないので CPU をほとんど使わず、各ファイルの大きさが分かっているので全体の `Content-Length` を先に出せる（ブラウザに
  進み具合と残り時間が出る）。PDF・画像・Office（中身はもう ZIP）は圧縮しても縮まない。
- 名前は UTF-8 のフラグ付き（Windows 10 以降・macOS で日本語が化けない）、Windows で使えない文字は置き換え（§4.3）、
  同じ名前が重なれば「(1)」。更新日時は `content_modified_at`（無ければ `updated_at`）を拡張タイムスタンプで入れる。空のフォルダも入れる。
- 中身は**チケットを作った時点の**項目の一覧と版で決め、流している間の変更は入れない（途中で消された版は、GC が 24 時間待つので読める）。
  読めない項目・ゴミ箱の項目は入れない。
- 上限：1 つの ZIP に 10,000 件・合計 20 GB（`DRIVE_ZIP_MAX_ENTRIES` / `DRIVE_ZIP_MAX_BYTES`、超えれば 413 `drive_zip_too_large`）。
  同時に流す ZIP は 1 人 2 本、サーバ全体で 4 本（超えれば 429）。
- ZIP は Range に対応しない（途中から再開できない）。大きなフォルダは分けて落とすよう、上限のエラーの文に書く。

### 7.3 端末

- Desktop：1 つのファイルは `/content` を、ZIP はチケットの URL を `fetch` し、本文を塊ごとに保存先のファイルへ書く（fs プラグインの
  `open` / `write`。今の「ダウンロード」フォルダへの保存・名前の付け方・トーストと同じ流れ、PREVIEWS.md §9）。失敗したら
  一時ファイルを消す。新しい依存は足さない。
- Web：`<a href download>` でダウンロードのチケットの URL（1 つのファイルは `POST /drive/items/{id}/download-ticket`、ZIP は §7.2 の
  チケット）。ブラウザのダウンロードが大きなファイルを流し、途中で切れれば（Range があるので）ブラウザの「再開」が効く。
  **D2 で直した**：初めは「cookie で認証されるので 1 つのファイルもそのまま」と書いていたが、Web のアクセストークンはメモリにだけあり
  （cookie は `/auth/refresh` の更新トークンだけ）、`<a href>` は認証されない。チケットの決まりは §21.2。

## 8. プレビュー

| 種類 | 今の仕組み | ドライブでの上限 |
| --- | --- | --- |
| 画像（PNG / JPEG / GIF / WebP） | サムネイル（512 px）、ビューアは本文 | 100 MB・50 Mpx まで（§6.4）。それより大きいものはアイコン |
| 動画 | ポスター・長さ（ffprobe / ffmpeg）、アプリの中のプレーヤー | ポスターは 2 GB まで。再生は大きさによらない（Range） |
| PDF | 1 ページ目の WebP、全ページは PDF.js / PDFKit / PdfRenderer | `PREVIEW_MAX_INPUT_BYTES`（50 MB）まで |
| Office（doc / docx / xls / xlsx / ppt / pptx / odt / ods / odp / rtf） | converter で PDF にしてから同じ | 同じく 50 MB（converter の本文の上限 55 MB に合わせた値） |
| ほか（テキスト・CSV・zip など） | 無し | 無し（v1。テキストのプレビューは後） |

- 上限を超えるファイルは `preview: null`（アイコンと「プレビューできません（大きすぎます）」、ダウンロードはできる）。
- PDF は converter を通らないので、50 MB を PDF だけ上げる設定（`PREVIEW_MAX_PDF_BYTES`）を足す案がある（論文の PDF・スキャンは
  50 MB を超えることがある）。上げると、ビューアは `/preview/pdf` を全部読んでから描くので端末のメモリと時間を食う（Range で
  ページだけ読むのは後）。§19 Q8。
- プレビューを作るのは今の版だけ。古い版は `none`（開けばダウンロード）。
- 移行で入れたファイルは `none` のまま入れ、`generate-previews --drive --limit 200` を夜に回して少しずつ作る（チャットの添付の
  プレビューを待たせない、§2）。

## 9. 外部共有リンク

### 9.1 脅威と守り

| 脅威 | 守り |
| --- | --- |
| トークンの推測・総当たり | 32 バイト（256 ビット）の乱数、base64url 43 文字。知らないトークンは 404、IP ごとの速度制限（§9.4） |
| DB の流出からリンクが使われる | DB には SHA-256 だけ（今の招待・iCal と同じ）。パスワードは Argon2id |
| リンクの転送・メールの漏れ | 既定の期限（7 日、最長はワークスペースの設定 90 日）、パスワード、回数の上限、取り消し、使われ方の記録（作った人が見られる） |
| 共有した部分木の外を読む（id の差し替え、`..`） | 公開側の項目の id は必ず「リンクの項目そのもの、またはその子孫で、ゴミ箱に無い」ことを再帰 CTE で確かめる（祖先をたどって 32 段で止める）。パスは使わず id だけ。外れれば 404。ファイルのリンクはそのファイルの今の版だけ（古い版・兄弟は無い） |
| 作った人が抜けた後もリンクが生き続ける | **リンクは作った人が今その項目を読める間だけ働く**（毎回確かめる。チャンネルを抜けた・ゲストになった・無効化で止まる、§3.3）。状態は `paused`、戻れば働く |
| 研究室のドメインでの悪いファイルの配布（HTML・SVG でのフィッシング・XSS） | 本文は常に `attachment`、`nosniff`、`CSP: sandbox`。inline は生成した画像（WebP / JPEG）と sandbox 付きの PDF のプレビューだけ |
| 検索エンジンへの掲載 | ページの `<meta name="robots" content="noindex, nofollow">`、すべての公開側の応答に `X-Robots-Tag: noindex, nofollow, noarchive`、`/robots.txt` に `Disallow: /s/` |
| Referer でトークンが外へ | `Referrer-Policy: no-referrer`（今の Web と同じ）。公開ページから外へのリンクを置かない |
| 他のサイトへの埋め込み・クリックジャッキング | `frame-ancestors 'none'`、`X-Frame-Options: DENY` |
| 帯域・ディスクの読み出しの浪費 | 回数の上限、リンクごと・IP ごとの速度制限、ZIP の同時の本数 |
| パスワードの総当たり | リンクごと 10 回 / 10 分、IP ごと 20 回 / 分。失敗は `password_failed` として記録し、作った人の画面に出す |
| 管理者が知らないうちに外へ出る | admin の一覧（§3.4）、ワークスペースのスイッチ（切るとすべて止まる。リンクは消さないので戻せば働く）、作成・変更・取り消しは監査ログ |

### 9.2 リンクが働く条件（毎回のリクエストで確かめる）

```
働く = ワークスペースの drive_external_links_enabled
     AND 場所の external_links
     AND revoked_at IS NULL
     AND (expires_at IS NULL OR expires_at > now())
     AND (max_downloads IS NULL OR download_count < max_downloads)   -- 一覧・プレビューは数えない（下）
     AND 項目がゴミ箱に無い
     AND 作った人が有効で、ゲストでなく、今その項目を読める
     AND （チャンネルの場所なら）チャンネルがアーカイブされていない
```

- 働かないとき：知らないトークンは 404 `share_link_not_found`、それ以外はすべて 410 `share_link_unavailable`（理由は出さない。
  トークンを持つ人に「取り消された」と「期限切れ」の違いを見せる必要は無い）。
- **回数**は本文のダウンロード（`/content` の Range なし、または `bytes=0-` で始まるもの）と ZIP 1 本ごとに 1 つ。一覧・サムネイル・
  プレビューは数えない（PDF のプレビューを開くたびに 1 回減ると困るため。プレビューで全ページ読めるのは「見せる」の範囲として
  受け入れる）。`UPDATE … SET download_count = download_count + 1 WHERE … AND download_count < max_downloads RETURNING` で数え、
  同時の要求でも上限を超えない。
- 期限の既定は 7 日（作成の画面で 1 日・7 日・30 日・90 日・日付の指定、`drive_link_max_days` が NULL のときだけ「期限なし」）。

### 9.3 公開ページ

- URL は `https://<domain>/s/<token>`。Caddy は `/s/*` に Web のバンドルの**別の入口**（`share.html`、ログインも同期も持たない小さな
  ページ。Vite の複数の入口）を返す。ページはパスのトークンで公開 API（`/api/v1/shares/<token>/…`）を読む。PDF のビューアは
  アプリと同じ PDF.js（`pdfLoader` の遅延読み込み、今の CSP `'self'` のまま）と同じ `ViewerFrame`。ブラウザ内蔵の PDF ビューアに
  頼らない（`CSP: sandbox` の PDF を Chrome の内蔵ビューアが描かないことがあるのと、アプリと見た目をそろえるため）。
- 見せるもの：項目の名前（フォルダならパンくず。リンクの項目より上は出さない）、一覧（名前・大きさ・更新日時）、ダウンロード、
  「すべてを ZIP で」、画像と PDF / Office のプレビュー、期限（「2026-11-01 まで」）。ワークスペースの名前とアイコン（`GET /server` と同じ）。
  出さないもの：作った人・更新した人の名前、場所の名前、ほかのリンク、版、`note`。
- パスワードのあるリンクは、パスワードの入力だけを見せ、`POST /shares/{token}/unlock` が通れば cookie を渡す：名前
  `taylis_share`、値は `link_id`・`password_version`・期限（12 時間）の HMAC（`SECRET_KEY` から作った鍵）、`HttpOnly`・`Secure`・
  `SameSite=Lax`・`Path=/api/v1/shares/<token>`。パスワードを変えれば（`password_version`）それまでの cookie は効かない。
- JavaScript の無いブラウザには「JavaScript を有効にしてください」と、ファイル 1 つのリンクなら直接のダウンロードのリンク
  （パスワードなしのときだけ）を `<noscript>` で出す。

### 9.4 速度制限

| 対象 | 上限 |
| --- | --- |
| 公開 API（知らないトークンを含む） | IP 120 回 / 分 |
| 知らない・働かないトークン | IP 20 回 / 分（超えれば 429。総当たりを遅くする） |
| 1 つのリンクの本文のダウンロード | リンク 60 回 / 分 |
| パスワード | リンク 10 回 / 10 分、IP 20 回 / 分 |
| リンクの作成 | ユーザー 30 回 / 分 |

単一プロセスのメモリの token bucket（今の `RateLimiter`）。IP は今と同じく Caddy / nginx が置き換えた値（SECURITY.md §6）。

### 9.5 記録

- 監査ログ（`audit_logs`）：`drive.link_created`（項目・場所・期限・パスワードの有無・回数・`note`）、`drive.link_updated`（前後）、
  `drive.link_revoked`（admin による取り消しは `by_admin`）、ワークスペースのスイッチ（今の `workspace.settings` の記録）。
  トークンとパスワードは載せない。
- 使われ方（`drive_share_events`）：開いた・落とした・ZIP・パスワードの失敗・断った（上限）を、IP と User-Agent（200 文字）付きで
  180 日残す（周期ジョブで消す）。作った人と admin が見られる（IP は作った人には上位 2 オクテットだけ）。プライバシーの説明
  （website/docs/privacy.md）に「外部リンクの利用の記録」を足す。
- アクセスログはトークンを伏せる（§2）：`/s/***`、`/api/v1/shares/***/…`。

### 9.6 Caddy と nginx

```caddy
@shareapi path /api/v1/shares/*
handle @shareapi {
	header X-Robots-Tag "noindex, nofollow, noarchive"
	request_body {
		max_size 1MB
	}
	reverse_proxy app:8000
}
@sharepage path /s/*
handle @sharepage {
	root * /srv/web
	header X-Robots-Tag "noindex, nofollow, noarchive"
	header Content-Security-Policy "…今の SPA と同じ…"
	header Referrer-Policy no-referrer
	header X-Frame-Options DENY
	header Cache-Control no-store
	rewrite * /share.html
	file_server
}
@driveparts path_regexp ^/api/v1/drive/uploads/[^/]+/parts/[0-9]+$
handle @driveparts {
	request_body {
		max_size 17MB
	}
	reverse_proxy app:8000
}
```

3 つとも今の `handle /api/*` と SPA の `handle` より前に置く（今の Caddyfile の特定の経路と同じ）。`/robots.txt` を Web のバンドルに置く。nginx（D22 の構成）は `client_max_body_size 110m` のままでよく、`location ~ ^/(s|api/v1/shares)/`
で `access_log off`（またはトークンを伏せた形式）にする例を `nginx-site.conf.example` に足す。

## 10. ゴミ箱・版・コピー

### 10.1 ゴミ箱

- ゴミ箱に入れると部分木のすべてに `trashed_at`・`trash_root_id`（入れた根）が入る。根には `trash_parent_id`。一覧・検索・
  リンク・ZIP から消える。容量は数えたまま（完全に消すまで領域は使う）。
- 戻すのはまとまりごと（根の id で）。元の親が生きていればそこに、親がゴミ箱か無ければ場所の根に。同じ名前があれば `rename`
  （「名前 (復元)」ではなく「名前 (1)」の規則）。ゴミ箱の中で、まとまりの一部だけを戻すことはできない（ドキュメントと同じ）。
- 30 日（`DRIVE_TRASH_DAYS`）で周期ジョブが完全削除する：版の添付を `deleted`、リンクを消し、行を消し、`used_bytes` を引き、
  監査 `drive.purge`（actor なし、場所・名前・件数・大きさ）。手での完全削除も同じ処理（監査 `drive.delete`）。
- 研究室ドライブのゴミ箱は全員に見える（誰が何を消したか分かる）。チャンネルのドライブはメンバーに、マイドライブは本人に。

### 10.2 版

- 同じ名前で上書き（`on_conflict = version` か `target_item_id`）すると、新しい版を足して `current_version_id` を付け替える。
  前の版は残る。
- 残すのは新しい順に `DRIVE_VERSIONS_MAX`（既定 10）版、かつ今の版でないものは `DRIVE_VERSIONS_DAYS`（既定 30 日）まで。
  日数は**次の版に置き換えられた時刻**から数える（D3、§22.2。1 年前に上げて今日上書きしたファイルの前の版も 30 日残る）。
  超えた古い版は周期ジョブが消す（添付を `deleted`、`used_bytes` を引く）。今の版は消さない。
- 版を戻すと、その版のオブジェクトをサーバの中で写して（`BlobStore.copy`、新しい添付）新しい版にする（`source = 'restore'`）。
  1 つの添付を 2 つの版が指すことを作らない（参照の数を持たずに済む。写す分の領域は要る）。
- 版の一覧：番号・時刻・上げた人・大きさ。版ごとにダウンロードできる。プレビューは今の版だけ（§8）。
- 版は Nextcloud から移さない（今の版だけ、§15）。

### 10.3 コピー

- ファイルとフォルダ（深く）を写す。オブジェクトはサーバの中で写す（S3 CopyObject。versitygw の posix では中身の複製なので
  領域はその分増え、容量にも数える）。版は今の版だけ写す。
- 小さな写し（合計 1 GB・500 件まで）はリクエストの中で 200 `{results}`。大きいものは 202 `{job_id}` にして、周期ジョブの仕組みで
  1 件ずつ写し、終われば `drive.changed`（v1 で大きな写しが要るか分からないので、D3 ではまず上限で断り（413 `drive_copy_too_large`、
  1 GB・500 件）、要望が出たら job を足す）。

## 11. 容量と使用量

### 11.1 上限

- 場所ごと：`drive_locations.quota_bytes`（NULL = 上限なし、admin が決める）。数えるのは今の版・古い版・ゴミ箱のすべて。
- ワークスペース全体：`DRIVE_TOTAL_QUOTA_BYTES`（環境変数、既定なし）。**研究室のサーバでは 150 GB 程度に決めることを推める**
  （空き 217 GB からバックアップの一時の領域・マルチパートの 2 倍・PostgreSQL の伸びを残す）。app からはオブジェクトストアの
  ディスクの空きが見えないので、この値が最後の守りになる。§19 Q7。
- マイドライブの既定の上限：`DRIVE_USER_DEFAULT_QUOTA_BYTES`（既定なし。研究室ドライブに置いてほしいなら 10 GB などに）。
- 超えるとアップロード・コピー・版を戻すが 409 `drive_quota_exceeded`。名前の変更・移動（同じ場所の中）・ゴミ箱・削除はいつでもできる
  （減らす操作を止めない）。場所をまたぐ移動は先の上限を確かめる。
- チャットの添付（メッセージ・キャンバス・ページ）は今までどおり上限で数えない（1 ファイル 100 MB と件数の上限だけ）。

### 11.2 使用量の画面（admin）

管理画面の「ドライブ」：

- 全体：ドライブの合計（今の版・古い版・ゴミ箱に分けて）、チャットの添付の合計（`attachments` の `drive_item_id IS NULL` の合計）、
  全体の上限、件数。
- 場所ごとの表：種類・名前（チャンネル名、マイドライブは人の表示名）・使用量・件数・上限（その場で変えられる）・最終更新。
  中身は出さない。
- 人ごと：その人が上げたファイルの合計（共有の場所を含む）。
- ディスクの空きは app には見えないので、画面に「サーバのディスクの空きは `df` で確かめる」と infra/README.md への案内を置く。

使用量は場所の行の `used_bytes` を読むだけ（速い）。ずれれば `app.cli drive-usage --verify / --rebuild`。

## 12. 検索

- ファイル名を PGroonga で探す（`drive_items_name_pgroonga_idx`、今のメッセージ・添付のファイル名と同じトークナイザ）。日本語と
  英語の部分一致。
- `GET /search/drive?q=`：読める場所（研究室ドライブ（ゲスト以外）・マイドライブ・自分がメンバーのチャンネルのドライブ）に絞り、
  ゴミ箱を除く。`location_id` で 1 つの場所に、`kind=folder|file` で種類に絞れる。並びはスコア、同じなら更新の新しい順。結果には
  パス（場所の名前 › フォルダ › …）を付ける。
- `search` モジュールに `drive` の読み取り専用の問い合わせを許す（ARCHITECTURE.md §5 の規約 1 の例外に足す。読める場所の集合は
  `drive` の公開関数で得る）。速度制限は今の検索と同じ枠。
- 全体の検索（⌘K と検索の画面）に「ドライブ」の種類を足す。ドライブの画面の検索欄はその場所の中を探す。
- **後で**：PDF・Office の中身の全文。版ごとの本文の表 `drive_texts (version_id, text, extracted_at)` を足し、プレビューを作る時に
  PDF（変換した PDF も）から文字を取り出して PGroonga で引く。ここに入れた本文は将来の RAG（意味検索）の材料にもなる
  （DATA_MODEL.md §6 の `message_embeddings` と同じ考え方で、`drive_text_embeddings` を足せる）。v1 では表を作らない。

## 13. 会話との連携

### 13.1 ドライブのファイルを会話に送る

2 つの送り方を選べる（入力欄の 📎 →「ドライブから」で選んだあとに、どちらで送るかを出す）：

| 送り方 | 中身 | 読める人 | 向いている時 |
| --- | --- | --- | --- |
| **リンク**（既定） | 本文にパーマリンク `<server>/d/<item_id>` を入れる。端末はカード（名前・大きさ・1 ページ目）を描く | **ドライブの項目を読める人だけ**。メッセージを読めても項目を読めない人には「表示できないファイル」（名前も出さない）。後から名前を変えても、新しい版にしても、カードは今の項目を指す。ゴミ箱・削除で「表示できないファイル」になる | 同じ人たちの中で、最新の版を指したいとき（研究室ドライブのファイルを研究室のチャンネルに） |
| **コピー** | `POST /drive/items/{id}/attach-copy` でサーバの中で写した今までの添付（100 MB まで） | メッセージを読める人（今の添付と同じ） | DM・ゲストのいる会話・ドライブを見られない人に渡すとき、その時点の版を残したいとき |

- リンクのカードは `GET /drive/items/{id}` を読んで描く（404 なら「表示できないファイル」）。**D6 の実装は §25**。ドキュメントの `/p/<id>` と同じ扱いで、
  `pages.py` に `/d/<id>` の案内ページを足し（中身も存在も明かさない）、Caddy では Web のアプリが開く。
- **入力欄の注意**：リンクを入れた会話に項目を読めない人がいれば、送る前に「このチャンネルの 3 人はこのファイルを見られません。
  コピーとして送りますか？」と出す（`GET /drive/items/{id}/reach?channel_id=`。場所がそのチャンネルなら 0、研究室ドライブなら
  ゲストの数、別のチャンネルならそのチャンネルにいない人の数、マイドライブなら自分以外の全員）。
- メッセージのプレビュー（プッシュ・一覧の抜粋）は本文の URL のまま。名前を通知に出さない（読めない人にも届くため）。
- リンクのメッセージを送っても、権限は変わらない（項目を見せるために場所の権限を広げることはしない）。

### 13.2 会話の添付をドライブに保存する

- メッセージの添付のメニュー・ファイルの一覧・ビューアに「ドライブに保存」：保存先のフォルダを選ぶ（既定はそのチャンネルの
  ドライブ、DM ならマイドライブ）。`POST /drive/save-attachment`：添付を読めること（`get_for_access`）と保存先に書けることを確かめ、
  オブジェクトをサーバの中で写して新しい項目にする（`source = 'attachment'`）。元のメッセージが消えても、ドライブの写しは残る。
- 写すので、元のメッセージの添付と独立（保存した後にメッセージを消してもドライブのファイルは残り、ドライブで消してもメッセージは
  変わらない）。

### 13.3 チャンネルの画面

- チャンネルの上のタブ（キャンバス・予定・タスクの並び）に「ドライブ」を足し、そのチャンネルのドライブを同じ画面で開く。
  アーカイブしたチャンネルでは読むだけ。
- チャンネルのドライブにファイルを足したことをチャンネルに投稿するか（「〇〇さんが 3 件のファイルを追加しました」）は §19 Q9。
  v1 の既定は投稿しない（イベントでドライブの画面だけが変わる）。

## 14. 同期

- **ドライブは端末の手元に持たない**（v1。Desktop の SQLite にも入れない）。開いているフォルダの一覧はその都度 API から読み、
  イベントは「読み直せ」の合図だけ。これで、取りこぼし・再接続・権限の変化はすべて「開き直す・読み直す」で済む。
- WS のイベント（outbox から、ほかのイベントと同じ Transactional Outbox。名前を載せない）：

  | type | audience | data | 端末 |
  | --- | --- | --- | --- |
  | `drive.changed` | 研究室ドライブ：`all`（ゲストにも届くが id と番号だけ）／チャンネル：`channel`（今のメンバー）／マイドライブ：`user` | `{location_id, folder_ids: [id], seq}`。`folder_ids` は中身が変わったフォルダ（作成・名前・移動の元と先・ゴミ箱・戻す・新しい版・処理の完了・プレビューの完了） | 開いているフォルダが `folder_ids` にあれば 300 ms まとめて読み直す。ゴミ箱の画面を開いていれば読み直す |
  | `drive.location.updated` | 同上 | `{location: DriveLocationOut}`（外部リンクの可否・上限の変更）。**D3 の実装は `{location_id}` だけ**（§22.2） | 場所の一覧の行を置き換える（D2 からの端末は一覧を読み直す） |
  | `drive.upload.updated` | `user`（上げた本人） | `{upload: UploadOut}`（`completing` の完了・期限切れ） | アップロードの欄を更新（別の端末で始めたアップロードも見える） |

- 再接続のあと：開いているフォルダ・ゴミ箱・場所の一覧を読み直す（イベントは失われうる、SYNC_PROTOCOL.md §1）。`channel.*` の
  メンバーシップの変化と自分のロールの変化（`user.updated`）でも場所の一覧を読み直す。開いていた場所が読めなくなれば（404）
  研究室ドライブの根に戻す。
- `seq` は `drive_change_seq` の値で、同じイベントの重複・入れ違いを端末が捨てるため（古い `seq` は無視）。
- 後で（スマホの D7 以降、オフラインで閲覧したくなったら）：ドキュメントの変更のフィード（SYNC_PROTOCOL.md §17）と同じ形の
  `GET /drive/locations/{id}/changes?since=` と `drive_tombstones` を足せる（`change_seq` と索引はもう持っている）。

## 15. Nextcloud からの移行

### 15.1 コマンド

```sh
# Nextcloud の WebDAV から（アプリパスワードは Nextcloud の「設定 → セキュリティ」で作る。ファイルで渡す）
docker compose ... exec app python -m app.cli import-nextcloud \
  --webdav https://cloud.example.ac.jp/remote.php/dav/files/kano/ \
  --webdav-user kano --webdav-password-file /run/secrets/nextcloud_app_password \
  --map /import/nextcloud-map.toml --actor admin --dry-run

# Nextcloud のデータディレクトリの写しから（data/<user>/files を読む）
docker compose ... exec app python -m app.cli import-nextcloud \
  --data-dir /import/nextcloud-data/kano/files --map /import/nextcloud-map.toml --actor admin
```

- ほかの移行（`import-mattermost` / `import-slack` / `import-notion`）と同じ形：`--actor`（実行する admin。監査ログと、上げた人の既定）、
  `--dry-run`（読むだけで、件数・合計・場所ごとの大きさ・名前の問題・容量の超過を表にする）、何度でも実行できる（`import_refs`）。
- `--list-shares`（WebDAV のときだけ）：Nextcloud の OCS API（`/ocs/v2.php/apps/files_sharing/api/v1/shares`）で今の共有（相手の
  グループ・人、公開リンクの有無と期限）を読み、対応表を書く材料として表に出す。何も書かない。
- `--user NC_USER=USERNAME`（繰り返し可）：Nextcloud の人 → Taylis のアカウント（`content_modified_at` とは別に「上げた人」を残す。
  WebDAV の `oc:owner-id` が読めるとき）。無ければ `--actor`。
- `--no-previews`（既定）：プレビューを `none` で入れる（§8）。終わってから `generate-previews --drive` を回す。
- `--limit-bytes`：1 回の実行で移す量の上限（夜に分けて流すため）。

### 15.2 対応表（TOML、Python の標準の `tomllib` で読む）

```toml
# Nextcloud のフォルダ → Taylis の場所とフォルダ。上から順に、いちばん長く一致した source が勝つ。
# target: "workspace:/パス" | "channel:<チャンネル名>:/パス" | "user:<ユーザー名>:/パス"

[[map]]
source = "/研究室共有"
target = "workspace:/"

[[map]]
source = "/研究室共有/教員"
target = "channel:faculty:/"          # 教員だけの非公開チャンネルのドライブへ

[[map]]
source = "/M2ゼミ"
target = "channel:m2-seminar:/ゼミ資料"

[[map]]
source = "/kano/個人"
target = "user:kano:/"

[[skip]]
source = "/研究室共有/古いバックアップ"  # 移さない
```

- 対応表に無いフォルダは移さず、`--dry-run` と実行の終わりに「対応の無いフォルダ」として大きさつきで出す（黙って捨てない）。
- 先のチャンネルが無ければ止まる（作らない。チャンネルとメンバーは先に Taylis で作る）。先のフォルダは作る。
- 共有の相手（グループ・人）から場所を自動で決めることはしない。Nextcloud の共有は「人ごと・フォルダごと」で、Taylis の「場所」に
  機械的には写らないため、人が対応表で決める（`--list-shares` の表を見ながら）。

### 15.3 移すもの・移さないもの

| 移すもの | 方法 |
| --- | --- |
| フォルダの形・ファイル | そのまま（空のフォルダも） |
| ファイルの更新日時 | WebDAV の `getlastmodified`（データディレクトリなら mtime）を `content_modified_at` へ |
| 名前 | NFC にする。断られる名前（§4.3、`/` は来ない）と大文字小文字だけ違う名前は「名前 (1)」にして表に出す |
| 大きさの上限を超えるファイル | 移さずに表に出す（`DRIVE_MAX_FILE_BYTES` を一時的に上げて流すこともできる） |

| 移さないもの | 理由・代わり |
| --- | --- |
| 版（Nextcloud の versions） | 今の版だけで足りると判断。要れば Nextcloud を読み取り専用でしばらく残す |
| ゴミ箱 | 同上 |
| 共有の設定 | 対応表で場所を決める（§15.2） |
| 公開リンク | トークンは引き継げない。`--list-shares` の表を見て、要るものだけ Taylis で作り直し、相手に新しい URL を送る |
| コメント・タグ・お気に入り | 使っていないと聞いている（§19 Q1 で確かめる） |

### 15.4 冪等と流れ

- `import_refs` に `source = 'nextcloud'`、`kind = 'drive_item'`、`source_id` = 対応表の source を外した Nextcloud のパスの SHA-256（16 進
  64 文字。`source_id` の幅 64 に収める）、`target_id` = `drive_items.id`。**D5 の実装（§24.2）**：`source_id` は「Nextcloud の人・Nextcloud の
  パス全体・規則の target」の SHA-256 にした（同じ相対パスを持つ 2 つの規則がぶつからず、WebDAV とデータディレクトリの写しが同じ鍵になる）。
- もう一度実行すると、既にある項目は大きさと更新日時が同じなら飛ばし、違えば新しい版として足す（Nextcloud を使い続けながら、
  切り替えの日に差分だけ流せる）。Nextcloud で消したファイルは消さない（表に出す）。
- バイト列は WebDAV から読みながら（またはファイルから）16 MiB ずつ S3 のマルチパートへ流す（一時ファイルを作らない。§6 と同じ
  `BlobStore` の関数、同じ版の作成の関数）。ファイルごとにコミットするので、止めても続きから。
- 速さの目安：研究室のサーバの中で 100 GB を流すと、ディスクと versitygw の書き込みで数時間（D5 で実測して infra/README.md に書く）。
  夜に `--limit-bytes` で分けて流せる。WebDAV が学外の機械なら回線の速さで決まる。**D5 の実測（§24.3）**：手元の Mac の Docker の中の
  Nextcloud 31 から WebDAV で約 220 MB/s（100 GB で 8 分ほど）。研究室のサーバのディスク・回線では遅くなるので、リハーサルで測って決める。
- **ディスクに気をつける**：データディレクトリの写しを同じサーバの同じディスクに置くと、移行の間は Nextcloud の 100 GB +
  写し 100 GB + ドライブ 100 GB になる。写しを作らずに WebDAV から流すか、写しを別のディスクに置く（§16）。

## 16. バックアップと復元

### 16.1 今のバックアップとドライブ

- ドライブのバイト列は `attachments/{id}` のオブジェクトなので、**今の `infra/backup.sh` にそのまま入る**（PostgreSQL の `pg_dump` の後に
  オブジェクトのディレクトリを写す順も、`restore.sh` の `verify-attachments` も同じ）。新しい状態の置き場所は増えない。
- 大きさ：ドライブ 100 GB（版・ゴミ箱で 1〜3 割増えうる）。PostgreSQL は項目 10 万件で数十 MB（行と索引）しか増えない。

### 16.2 ぶつかる所と直すこと（§2 の詳しい形）

| 問題 | 直すこと（段階 D5） |
| --- | --- |
| 同じディスクの `/srv/backups` に初回で全体を写す（+100 GB、空きが約 17 GB まで減る） | **サーバの外へのバックアップを必須にする**：`restic`（暗号化・重複排除・増分）で大学の NAS・外付けのディスク・別のサーバへ毎晩。infra/README.md に手順と復元の確かめ方を書く。サーバの中の世代は、`BACKUP_ROOT` を別のディスク（増設）に置くか、置けないならドライブを入れる前に決める（§19 Q7） |
| 毎回すべてのオブジェクトの SHA-256 を取る | ハードリンクにした（変わっていない）ファイルの行は前回の `objects.sha256` から引き継ぎ、写したファイルだけ計算する。ファイルごとの `stat` の起動をやめ、`find -printf '%s:%T@ %p'` を前回の一覧と比べる |
| デプロイの前に毎回バックアップを取る | 上の 2 つで、変わっていない 100 GB はハードリンクと一覧の比較だけになり、数分で済む見込み（D5 で実測） |
| 復元のリハーサルで同じディスクにもう 1 組 | サーバの外（手元の機械、別のディスク）でリハーサルする手順にする |
| 復元にかかる時間 | 100 GB の写しで、ディスクの速さによって 10〜30 分以上。infra/README.md に目安を書く |

**D5 で実装（§24）**：上の表の 1・2・4 行目（`offsite-backup.sh`（restic）、`backup.sh` の SHA-256 の引き継ぎと一覧の比較、
`offsite-rehearsal.sh`）。3 行目は 20,020 ファイル・2 GB で、変わらない夜の写しが 16 秒 → 1 秒になった（§24.3）。5 行目の目安は
infra/README.md「サーバの外へのバックアップ」。

- サーバの中の世代（ハードリンクの増分）は「消した・壊したファイルを昨日に戻す」ためで、ディスクの故障・サーバの喪失には効かない。
  ドライブで研究室のファイルの正本をここに置く以上、**サーバの外の 1 組が無ければ Nextcloud を止めない**ことを切り替えの条件にする（§18 D5）。
- オブジェクトのディレクトリのハードリンクを同じファイルシステムの中で直接作る（写さない）案は、versitygw がオブジェクトを書き換えず
  置き換える（一時ファイル + rename）なら領域をほとんど使わない。ただし Docker のボリュームとバックアップの置き場所が別のマウントだと
  ハードリンクは作れない（EXDEV）ので、置き場所の作りを変える必要がある。D5 で確かめてから決める（採らなくても上の対応で足りる）。
  **D5 の判断（§24.2）**：採らない。上の対応で変わらない夜が数秒になり、置き場所の作りを変える理由が無くなった。

## 17. 画面（Desktop / Web）

### 17.1 置き場所

- 場所のレール（MOBILE_UI.md §18）に「ドライブ」（`apps/shared/nav-items.json` に `drive`。スマホはホームのタイル（D7、§26））。
- ドライブの画面の左（サイドバーの代わりの列）：「研究室ドライブ」「マイドライブ」「チャンネル」（自分がメンバーでドライブのある
  チャンネル。ほかのチャンネルは「チャンネルを選ぶ」から開く）、「共有リンク」（自分が作ったもの）、「ゴミ箱」（今の場所の）。
  場所ごとに使用量（上限があれば棒）を小さく。ゲストには研究室ドライブとマイドライブを出さない。

### 17.2 一覧

- 上：パンくず（場所 › フォルダ › …、押して移る、項目をドロップして移動）、検索欄（この場所の中）、「新規」（フォルダ）、
  「アップロード」（ファイル / フォルダ）、並べ替え（名前・更新日時・大きさ）、リスト / グリッドの切り替え（端末ごとに覚える）。
- リスト：アイコン（種類・画像のサムネイル）、名前、更新日時（`content_modified_at`、無ければ `updated_at`）、更新した人、大きさ、
  共有リンクのしるし。グリッド：サムネイル（画像・文書の 1 ページ目・動画のポスター）と名前。
- 選ぶ：クリック、⌘ / Ctrl + クリック、Shift + クリック、⌘A。キーボード：↑↓、Enter で開く、Space でプレビュー、F2 で名前の変更、
  Delete でゴミ箱へ、⌘C / ⌘V（コピー）、⌘X / ⌘V（移動）。
- 右クリックのメニュー（と行の「…」）：開く・プレビュー、ダウンロード（複数・フォルダは ZIP）、名前を変更、移動、コピー、
  共有リンク、会話に送る、版の履歴、ゴミ箱へ。書けない場所では書く項目を出さない（サーバも断る）。
- 開く：画像・動画・PDF・Office は今のビューア（`ViewerFrame`、← → で同じフォルダの前後のファイル）。ほかはダウンロード。
  **§27 で変えた**：1 回のクリックで開き、PDF はいつもビューア、ほかのファイルは詳細のペイン（ダウンロードはボタンだけ）。
- 右のペイン（任意で開く）：詳細（大きさ・型・更新日時・上げた人・パス・版・リンク）。
- カーソルで 100 件ずつ読み、下までスクロールしたら続きを読む。

### 17.3 アップロードの欄

- OS からのドラッグ＆ドロップ（一覧全体・フォルダの行・パンくず。今の `FileDropZone` の作り。フォルダは
  `DataTransferItem.webkitGetAsEntry()` でたどる）と、「アップロード」のファイルの選択・フォルダの選択（`<input webkitdirectory>`）。
  **Tauri の macOS（WKWebView）と Windows（WebView2）でフォルダのドロップと `webkitdirectory` が動くかを D2 の最初に確かめる**
  （動かなければ dialog プラグインのフォルダの選択から読む）。**D2 の実装（§21）**：アプリの「アップロード」は初めから dialog プラグインで
  選び、パスからディスクを部品ごとに読む（再起動の後も続きから）。ドロップは HTML5 の `webkitGetAsEntry()`（アプリの窓は
  `dragDropEnabled: false`）。Tauri の実機でのドロップは未確認（§21.4）。
- 右下の欄（Google ドライブのような）：ファイルごとの進み具合・速さ・残り、一時停止・再開・取りやめ・失敗のやり直し、全体の件数と
  合計。同時に 3 ファイル、1 ファイルの部品も 3 本まで。
- 再開：アプリ・タブを閉じても、セッションはサーバに 24 時間残る。開き直すと `GET /drive/uploads?status=active` で「続きがあります」と
  出し、同じファイルを選び直せば（名前・大きさ・更新日時が同じなら）送っていない部品だけ送る（ブラウザは閉じたあとファイルを
  読めないため、選び直しが要る）。
- 送る前に一覧で同じ名前を見つけたら、まとめて聞く：「置き換える（前の版を残す）」「両方残す」「飛ばす」と「残りすべてに同じ操作」。

### 17.4 共有リンクの画面

- 項目の「共有リンク」：今のリンクの一覧（期限・パスワード・回数・`note`・最後に使われた時刻・使われ方）と「新しいリンク」。
- 新しいリンク：期限（1 日 / 7 日（既定）/ 30 日 / 90 日 / 日付 / ワークスペースが許せば「なし」）、パスワード（入れると表示の切り替えと
  「作る」ボタン）、回数の上限、誰向けか（`note`）。作ると URL を出し「コピー」。**URL はこの時だけ表示する**（DB にはハッシュだけ）
  ことを画面に書く。もう一度渡すときは新しいリンクを作る（§19 Q4）。
- ワークスペース・場所で止まっていれば「外部リンクは管理者が止めています」とだけ出す。

### 17.5 管理画面

「ドライブ」の節：外部リンクのスイッチ・期限の最長・パスワードの必須、使用量（§11.2）、すべての有効なリンク（§3.4）、引き取り（§3.3）。

### 17.6 スマホ（D7）

- まずは読むだけ：場所・フォルダの一覧、検索、プレビュー（今の PDF / 画像 / 動画のビューア）、ダウンロード・ほかのアプリで開く・
  共有（iOS の共有シート、Android の ACTION_SEND）、会話の `/d/` のカードから開く。
- 後で：写真・ファイルのアップロード（バックグラウンドの転送）、外部リンクの作成。

## 18. 段階（マイルストーン）

段階の名前 D1〜D7 は本書の中だけのもの（ARCHITECTURE.md の設計判断 D1〜D28 とは別）。各段階の終わりに IMPLEMENTATION_PLAN.md §0 の
確認（pytest・mypy・ruff、tsc とテスト、OpenAPI と ws-events.json、移行の downgrade）を行う。

| 段階 | M | 中身 | 完了条件 |
| --- | --- | --- | --- |
| **D1** サーバの土台（**実装 2026-10-21、§20**） | M160 | 移行（表・`attachments.drive_item_id`・研究室ドライブの行）、`drive` モジュール、場所と権限（§3）、フォルダ・名前・移動・ゴミ箱（戻す・完全削除・30 日のジョブ）、マルチパートのアップロード（§6、`BlobStore` の拡張、期限と孤児の掃除、`completing` の回収）、media loop（§6.4）、Range のダウンロード（添付の `/content` にも）、`drive.changed`、`get_for_access` の注入、attachments を読む問い合わせの確認（§2）、Caddy の部品の枠、`drive.admin` の権限、エラーの文言。最初に versitygw のマルチパートの一時の領域と完了の時間を実物で確かめる | pytest：権限の表（3 つの場所 × admin / manager / member / guest / チャンネルのオーナー / 抜けた人 / アーカイブ）を総当たり、アップロードの冪等（同じ `client_upload_id`・部品の送り直し・完了の送り直し・完了の途中で落ちる）、名前の衝突 3 種、輪の移動、ゴミ箱のまとまり、容量の同時の予約。compose の上で 1 GB のファイルを途中で止めて再開し、SHA-256 が合う。ARCHITECTURE.md §2・§5、DATA_MODEL.md、SECURITY.md §4・§5、SYNC_PROTOCOL.md に節を足す |
| **D2** Desktop / Web の画面（**実装 2026-10-21、§21**） | M161 | 場所のレールの「ドライブ」、場所の列、一覧（リスト / グリッド、パンくず、並べ替え、カーソル）、アップロードの欄（ファイル・フォルダ・ドロップ・再開・衝突の質問）、ダウンロード（Desktop は塊ごとに保存、Web はブラウザ）、ビューア、名前・移動・ゴミ箱、ファイル名の検索（`/search/drive` を含む）、チャンネルのタブ | tsc・テスト（アップロードの状態機械、衝突の質問、パンくず）。macOS と Windows のアプリと Web で、フォルダのドロップ・2 GB のファイルの再開・ZIP でない 1 ファイルの 2 GB のダウンロードを手で確かめる |
| **D3** 版・コピー・ZIP・容量（**実装 2026-10-21、§22**） | M162 | 版（上書き・一覧・戻す・消す・整理のジョブ）、コピー（上限つき）、ZIP（§7.2）、場所と全体の上限、管理者の使用量の画面、`drive-usage --verify / --rebuild` | pytest：版の数と日数の整理、ZIP の中身（名前・UTF-8・ZIP64・空のフォルダ・Content-Length が実際の長さと一致）、容量の超過と減らす操作。5,000 ファイル・10 GB のフォルダの ZIP をブラウザで落として展開できる（Windows のエクスプローラーと macOS で） |
| **D4** 外部共有リンク（**実装 2026-10-21、§23**） | M163 | リンクの表と API、公開 API・`share.html`・解錠の cookie、働く条件（§9.2）、速度制限、`drive_share_events` と 180 日の整理、監査、ワークスペースと場所のスイッチ、admin の一覧、Caddy / nginx / ログの伏せ、robots.txt、プライバシーの説明 | pytest：部分木の外の id（兄弟・親・別の場所・ゴミ箱・古い版）がすべて 404、作った人が抜けた・ゲストになった・無効化で止まる、回数の同時の数え方、パスワードの失敗の制限、ヘッダ（noindex・nosniff・sandbox・attachment）。ログインしていないブラウザ（Chrome・Safari・Firefox、スマホ）で、フォルダの一覧・PDF のプレビュー・ZIP を確かめる。SECURITY.md に「外部共有リンク」の節を足し、§12 のようなレビューの一覧で見直す |
| **D5** Nextcloud の移行とバックアップ（**コードと手順は実装 2026-10-22、§24。本番の移行の実行は未実施**） | M164 | `import-nextcloud`（WebDAV・データディレクトリ・対応表・`--list-shares`・`--dry-run`・再実行の差分）、`generate-previews --drive`、backup.sh の SHA-256 の引き継ぎと比較の作り直し、restic でのサーバの外へのバックアップの手順、リハーサルの手順、infra/README.md | pytest：対応表の解決（いちばん長い一致・skip・無い先）、再実行で増えない・変わったファイルが版になる、名前の衝突の表。本番の Nextcloud から `--dry-run` の表を利用者と見て対応表を決める。**サーバの外のバックアップが 1 回取れて、そこから別の機械に戻せることを確かめてから**、本番に移す。移した後に件数と合計の大きさが Nextcloud と合う |
| **D6** 会話との連携（**実装 2026-10-22、§25**） | M165 | `/d/<id>` のパーマリンクとカード（Desktop / Web）、入力欄の「ドライブから」（リンク / コピー）、`reach` の注意、「ドライブに保存」、`pages.py` の案内ページ | pytest：コピーの添付の権限、保存の権限（読めない添付・書けない先）、`reach` の数。Desktop / Web で、ゲストのいるチャンネルに研究室ドライブのリンクを貼ると注意が出て、ゲストには「表示できないファイル」と出る |
| **D7** スマホ（読むだけ）（**実装 2026-10-22、§26**） | M166 | iOS / Android：ドライブのタイル、一覧・検索・プレビュー・ダウンロード・共有、`/d/` のカード | xcodebuild・Gradle のビルドとテスト。実機で PDF・Office のプレビューと大きなファイルのダウンロード |

- Nextcloud を止められるのは D5 の後（D1〜D5 で「置く・見る・渡す・移す・戻す」が揃う）。D6・D7 は止めた後でもよい。
- 見積もりの目安：D1 1.5〜2 週、D2 1.5 週、D3 1 週、D4 1.5 週、D5 1 週（移行の実行を除く）、D6 0.5 週、D7 各 OS 1 週。

## 19. 利用者に確かめること

**2026-10-21 の回答**：サーバの外のバックアップ先はある（Q7。場所と方式は D5 で聞いて設定する）。ほかはすべて下の表の推めのとおりに作る。


| # | 質問 | 推め（決まらなければこれで作る） |
| --- | --- | --- |
| Q1 | Nextcloud で使っているのはファイル・フォルダ・共有・公開リンク・PDF / Office のプレビューだけか（コメント・タグ・お気に入り・グループフォルダ・外部ストレージ・カレンダー / 連絡先は使っていないか） | 使っていない前提で作る（§15.3） |
| Q2 | 研究室ドライブの中に「一部の人だけ」のフォルダは要るか（Nextcloud で人・グループごとに共有を分けていたか） | v1 は非公開チャンネルのドライブで分ける。足りなければ後でドキュメントと同じ受け継ぐ権限をフォルダに足す |
| Q3 | ゲスト（卒業生・学外の共同研究者）に研究室ドライブの一部を見せる必要はあるか | v1 はゲストのいるチャンネルのドライブか外部リンクで渡す。研究室ドライブはゲストに見せない |
| Q4 | 外部リンクの URL を後からもう一度コピーしたいか（Nextcloud ではいつでもコピーできる） | 作った時だけ表示する（DB にはハッシュだけ、指示どおり）。要るなら、トークンを `SECRET_KEY` から作った鍵で暗号化して持ち、作った人にだけ再表示する案に変える（DB と秘密の鍵の両方が漏れたときにリンクが使われる、という引き換え） |
| Q5 | 卒業した人のマイドライブはどうするか（引き取る・本人に移してもらう・一定期間で消す） | 無効化の後も残し、admin が本人に知らせてから研究室ドライブへ引き取る（§3.3）。自動では消さない |
| Q6 | アーカイブしたチャンネルのドライブの外部リンクは止めるか | 止める（戻せば働く） |
| Q7 | サーバの外のバックアップ先はあるか（大学の NAS、外付けディスク、別のサーバ）。サーバの中の世代（`/srv/backups`）は別のディスクに置けるか。全体の上限はいくつにするか | サーバの外を必須にする（無ければ Nextcloud を止めない）。全体の上限 150 GB |
| Q8 | 50 MB を超える PDF（論文・スキャン）のプレビューは要るか | 要るなら PDF だけ 200 MB まで上げる（`PREVIEW_MAX_PDF_BYTES`）。Office は 50 MB のまま |
| Q9 | チャンネルのドライブにファイルを足したら、そのチャンネルに投稿してほしいか | 投稿しない（v1）。要望が出たら、まとめて 1 行（5 分ごと）の投稿を足す |
| Q10 | OS のファイルマネージャ（Finder・エクスプローラー）からつなぎたいか（WebDAV） | v1 は作らない。要れば読むだけの WebDAV から |
| Q11 | 版の数と日数（既定 10 版・30 日）、ゴミ箱の 30 日、1 ファイル 5 GB、リンクの既定の期限 7 日・最長 90 日でよいか | このまま |
| Q12 | 研究室ドライブで、他人のファイルを誰でもゴミ箱に入れられてよいか（Nextcloud の共有フォルダと同じ） | よい（30 日は誰でも戻せ、記録が残る）。困れば「上げた人とチャンネルのオーナー・admin だけ」に絞る |

## 20. 段階 D1 の実装（M160、2026-10-21）

段階 D2 は §21、D3 は §22、D4 は §23、D5 は §24、D6 は §25、D7 は §26。

サーバだけ（画面は D2）。移行 0118、`app/modules/drive/`（`models`・`names`・`access`・`repository`・`service`・`uploads`・`media`・
`housekeeping`・`events`・`router`）、`BlobStore` のマルチパート・範囲の読み出し・`head`、添付の `/content` の Range、
`get_for_access` の注入、`drive.changed` / `drive.upload.updated`、`drive.admin`、Caddy の部品の枠（17 MB）、エラーの文言 22 件
（`apps/shared/errors.json` と 3 つの端末の表）。versitygw の実測は §6.6。

### 20.1 作ったもの

- 場所：`GET /drive/locations`、`POST /drive/locations/resolve`（チャンネル・`me`、冪等）。研究室ドライブは移行が作り、無ければ最初の
  読み出しで作り直す。名前は研究室ドライブ「研究室ドライブ」・マイドライブ「マイドライブ」・チャンネルはチャンネル名（端末は `kind` で
  自分の言語の名前にしてよい）。`can_share` と `link_count` は D4 まで常に false / 0（D4 で実際の値、§23）。
- 項目：`GET /drive/folders/{id}/children`（`sort=name|modified|size`・`order`・カーソル。フォルダが先）、`GET /drive/items/{id}`、
  `POST /drive/folders`（`name` + `client_op_id`、`path` の mkdir -p）、`PATCH /drive/items/{id}`（名前。今の版の添付の `filename` も
  変える：プレビューの PDF の名前のため）、`POST /drive/items/move`、`POST /drive/items/trash`、`GET /drive/locations/{id}/trash`、
  `POST /drive/items/{id}/restore`、`DELETE /drive/items/{id}`、`GET /drive/items/{id}/content?version_id=&inline=`。
- アップロード：§5.3 の 7 つ。管理者：`POST /admin/drive/users/{id}/takeover`。
- 周期ジョブ（`DRIVE_HOUSEKEEPING_INTERVAL_SECONDS`、既定 10 分）：期限切れのセッション、10 分を超えた `completing` の回収、孤児の
  マルチパート（1 日 1 回）、30 日を過ぎたゴミ箱、匿名化した人のマイドライブ、7 日を過ぎた終わったセッション。media loop は完了で起きる。

### 20.2 本書と違うところ（本書の該当の節は直した、または下のとおり読む）

| 本書 | D1 の実装 | 理由 |
| --- | --- | --- |
| §4.2 の表をまとめて作る | 0118 は D1 の表だけ（場所・項目・版・セッション・部品）。`drive_share_links`・`drive_share_events`・`workspace_settings` の 3 列は D4 の移行で足す | 使わない表・列を先に置かない（CLAUDE.md）。D4 で定義どおりに足す |
| §4.2 の列 | 足した：`drive_locations.deleted_at`（匿名化、§3.3 の周期ジョブ）、`drive_items.client_op_id` と部分一意索引（`POST /drive/folders` の冪等）、`drive_file_versions.process_next_at`・`process_attempts`（media loop のリース、§6.4）、索引 `drive_items_parent_idx`（ゴミ箱を含む部分木）。一覧の索引は `kind DESC`（フォルダが先に来る向き） | 本書の動きに要るのに置き場所が無かった |
| §14 の audience（研究室ドライブは `all`、チャンネルは `channel`） | 新しい audience `drive`（`audience_id` = 場所。送る時点でその場所を読める人：研究室ドライブはゲストと bot を除く、チャンネルは今のメンバー、マイドライブは本人） | ゲストに届かず、抜けた人にも届かない。イベントの枠に `channel_id` を載せない（チャンネルの seq と混ざらない） |
| §6.4 の 4（文書のプレビューは media loop が予約） | 完了のトランザクションで予約する | 待つ理由が無い。プレビューの完了は preview loop が `drive.changed` を出す |
| §5.2 `ItemOut` | `trashed_at`・`trashed_by` を足し（ゴミ箱の表示）、`file` に `version_id`。スキーマ名は `Drive*`（`DriveItemOut`・`DriveUploadOut` など。ドキュメントの `Crumb` と OpenAPI で名前がぶつかったため） | — |
| §5.2 `GET /drive/items/{id}` | ゴミ箱の項目も返す（`trashed_at` つき）。一覧・本文・添付の経路（サムネイル・プレビュー）はゴミ箱の項目を 404 にする | ゴミ箱の画面で名前と場所を出すため。中身はゴミ箱から出すまで見せない |
| §5.2 move の `results[].error` | エラーのコードの文字列（`drive_cycle`・`drive_name_taken`・`drive_item_not_found`・`drive_quota_exceeded` など） | — |
| §5.7 のエラー | 足した：`drive_upload_not_found`（404）、`drive_upload_not_active`（409：完了中・完了後の部品・PATCH・取りやめ）、`drive_upload_failed`（完了でオブジェクトが揃わない）、`drive_root_immutable`（409：根の名前・移動・ゴミ箱）、`drive_takeover_active_user`（409）、`drive_too_many_uploads`（§6.2 にあった）、`range_not_satisfiable`（416） | — |
| §6.1 の完了 | 完了のリクエストは `active` → `completing` を確かめてコミットし、つなぐ・置くのはプロセスのタスク（`DriveRuntime`）。リクエストは最大 20 秒待ち、終われば 200、まだなら 202。部品は advisory lock（共有）を持って `UploadPart` し、`completing` への切り替えは同じ鍵を排他で取る（つないでいる間に部品が置き換わらない） | §2 のとおり完了をリクエストの外にした上で、ほとんどのファイルは 1 回の応答で終わる |
| §6.2 `fail` | 作成のときに名前が既にあれば 409。完了のときに（その間に）できていれば 409 で、セッションは `active` のまま `error = drive_name_taken`。完了で起きたほかの失敗（容量・権限・フォルダが消えた）も同じく `error` に残る | — |
| §3.3 の引き取り | ゴミ箱に無い項目だけ移す（ゴミ箱のものはマイドライブに残り、30 日で消える）。先のフォルダの名前が重なれば「(1)」 | ゴミ箱の戻し先（`trash_parent_id`）が場所をまたがない |
| §3.3 の匿名化 | `admin.anonymize_in_tx` が `drive.forget_user_in_tx` を呼び、場所に `deleted_at` を付け、進行中のセッションを期限切れにする。周期ジョブがセッションの後片付けの後に中身と行を消す（監査 `drive.purge`） | §3.3 の「周期ジョブ」の形 |
| §2 の「attachments を読むすべての問い合わせ」 | 確かめた：GC（pending の 24 時間はドライブの行が `attached` なので触らない、`deleted` はバイト列ごと消す）、`verify-attachments`（ドライブの版も確かめる）、`GET /files` とメッセージ検索のファイル名の枝（messages と結合、ドライブの行は出ない）、`export-channel`（メッセージの添付だけ）、匿名化（添付を触らない）、キャンバス・ページの整理（`canvas_id` / `page_id` のある行だけ）、デモのデータ（オブジェクトのキーを全部消す。ドライブの版も消えてよい）。足した条件：動画の backfill（`probe-videos`）と `generate-previews` はドライブの行を取らない（media loop と D5 の `--drive` が受け持つ）。テスト `test_drive_rows_stay_out_of_the_chat` で固定 | — |
| §2 の nginx | 変えない（`client_max_body_size 110m` で 16 MiB の部品が通る） | — |
| §11 の管理者の画面・`PATCH /admin/drive/locations/{id}`・`drive-usage` | D3 のまま（D1 は上限の判定と予約だけ。テストは列を直接書く） | — |

### 20.3 確かめたこと

- pytest：`tests/test_drive.py`（名前・並び、権限の表を 3 つの場所 × admin / manager / member / guest / チャンネルのオーナー / 抜けた人 で
  総当たり、投稿がオーナーだけのチャンネル、アーカイブ、DM、抜けた・ゲストになった人の 404、フォルダ・mkdir -p・深さ・名前の衝突・
  カーソル、輪の移動と場所をまたぐ移動・容量、ゴミ箱のまとまりと戻す・完全削除・30 日のジョブ、イベントの audience、引き取り、
  匿名化）と `tests/test_drive_uploads.py`（同じ `client_upload_id`・部品の送り直しと検査・完了の送り直し、完了の途中で落ちる 2 通り
  （つないだ後・つなぐ途中）と周期ジョブの回収、空のファイル、衝突の 3 種と完了のときの `fail`、フォルダのアップロード・
  `target_item_id`、容量の同時の予約（同時の 2 本のうち 1 本が 409）と完了の再確認と全体の上限、期限切れ・孤児の掃除、Range、
  media loop のサムネイルと SHA-256、チャットの問い合わせに入らないこと）。テストの利用者は各リクエストのセッションで読み直す
  （`drive_helpers.act_as`。本番の認証と同じく、リクエストの中の rollback が利用者を期限切れにするのを見逃さない）。
- compose の通し（使い捨ての compose：PGroonga・versitygw v1.8.0・app のイメージ・この Caddyfile）：1 GiB の乱数のファイルを 16 MiB × 64 で
  Caddy 越しに送り、32 部品で app を再起動して止め、`received_parts` から続きを送り（1 部品は二度送る）、完了・完了の送り直し、全体と
  途中からの 2 つの Range（If-Range）のダウンロードがどちらも元の SHA-256 と一致、media loop の SHA-256 も一致。

## 21. 段階 D2 の実装（M161、2026-10-21）

Desktop / Web の画面と、それに要るサーバの小さな追加。

### 21.1 作ったもの

- **場所のレール**：`apps/shared/nav-items.json` に `drive`（「ドライブ」、`platforms: ["desktop"]`）。既定の並びは「ファイル」の次。
  ほかの場所と同じく `desktop_places` でアイコン列・サイドバー・その他に置け、ドラッグで並べ替え、新しいタブで開ける。iOS / Android の
  カタログにも同じ行を足した（スマホでは描かない。D7 で）。
- **場所の列**（`ui/DriveView.tsx`）：研究室ドライブ・マイドライブ（開いたときに `resolve` で作る。ゲストには出さない）・チャンネル（自分が
  メンバーでドライブのあるもの）・「チャンネルを選ぶ」（まだドライブの無い自分のチャンネルを `resolve`）。場所ごとに使用量、上限があれば棒。
  `drive.changed` のたびに 1 秒まとめて読み直す。
- **一覧**（`ui/DriveBrowser.tsx`）：上の段にパンくず（深いときは途中を「…」のメニューに畳む。項目のドロップで移動）、下の段に
  この場所の検索・新しいフォルダ・アップロード（ファイル / フォルダ）・並べ替え・リスト / グリッド（端末ごとに覚える）・詳細のペイン・ゴミ箱。
  100 件ずつカーソルで読み、下まで見えたら続き。リストは名前・更新日時（`content_modified_at`、無ければ `updated_at`）・更新した人・大きさ、
  見出しを押して並べ替え。選択（クリック・⌘ / Ctrl・Shift）、キー（↑↓・Enter・Space・F2・Delete・⌘A・⌘X → ⌘V で移動）、右クリックと
  行の ⋯（開く / プレビュー・ダウンロード・名前を変更・移動・ゴミ箱へ）。移動はフォルダを選ぶダイアログ（書ける場所をまたいで選べる）。
  ゴミ箱はまとまりごとに「元に戻す」（重なれば「(1)」）と「完全に削除」（§3.2 の人だけ、確認つき）。
- **ビューア**：画像（サムネイルのあるもの）・動画・プレビューのある PDF / Office は今のビューア（`Lightbox`・`VideoViewer`・`PdfViewer`）に
  `AttachmentOut` の形で渡す。ビューアのダウンロードはドライブの経路になる（`driveFileOf`）。← → で同じフォルダの写真と動画を順に。
  Web の動画はチケットの URL を `src` にして Range で流す（全体を Blob にしない）。
- **アップロード**（`drive/uploads.ts`・`platform/driveFiles.ts`・`ui/DriveUploadPanel.tsx`）：§6 のとおり 1 ファイルの部品 3 本・同時に 3 ファイル。
  フォルダは相対パスを `relative_dir` に、空のフォルダは `POST /drive/folders {path}`。一覧へのドロップ・フォルダの行へのドロップ・
  「アップロード」の選択（Web は `<input>` と `webkitdirectory`、アプリは dialog プラグイン）。右下の欄（ダウンロードのトーストはその上に積む）に
  ファイルごとの進み具合・速さ・残り時間、全体、一時停止・再開・取りやめ・やり直し。
- **名前の衝突の質問**：セッションを `fail` で作り、409 `drive_name_taken` で「上書きして版にする（前のものは古い版として残ります）/
  名前を変えて両方残す / スキップ」を 1 件ずつ聞く。「残りすべてに同じ操作」でその回のアップロードの残りに同じ答え。同じ名前がフォルダなら
  版の選択肢を出さない。部品を送っている間に名前が埋まったとき（完了で 409）も同じ質問を出し、`PATCH` で `on_conflict` を変えて完了し直す。
- **再開**：ネットワークの失敗・5xx・429 は「接続を待っています」（2 秒から倍々で 30 秒、ブラウザの `online` と WS の再接続ですぐ）にして、
  `received_parts` から続ける。期限切れのセッションは最初から作り直す。再起動に要るもの（セッションの id・名前・大きさ・更新日時・フォルダ・
  アプリではパス）を localStorage にアカウントごとに残す。アプリはパスからディスクを読み直して自動で続ける（`tauri-plugin-persisted-scope` で
  dialog の許可を再起動の後も保つ）。Web は File をタブの外へ持ち越せないので「続きがあります」と出し、同じファイル（名前・大きさ・更新日時）を
  選び直すと続きから送る。
- **ダウンロード**：アプリは `/content` を `fetch` して塊ごとにファイルへ書く（fs の `open` / `write`、「ダウンロード」へ空いた名前で、
  「保存先を毎回選ぶ」なら保存のダイアログ。失敗したら書きかけを消す。トーストと「開く」「フォルダを開く」は添付と同じ）。Web はチケットの URL を
  `<a download>` で開き、ブラウザ自身のダウンロードに任せる。
- **検索**：場所の中の検索欄（`/search/drive?location_id=`）と、検索の画面の「ドライブ」のタブ（全部の読める場所）。結果はパスつき、
  フォルダと「フォルダで表示」は「ドライブ」で開く。
- **チャンネルのタブ**：公開・非公開チャンネルの見出しのタブ（メッセージ / キャンバス / 予定 / タスク / **ドライブ**）とスマホ幅の
  タブの行に「ドライブ」。DM には出さない。アーカイブしたチャンネルは読むだけ（サーバの `can_write`）。今までの「ファイル」（会話の添付）は
  そのまま残した（ドライブとは別のもの）。
- **同期**：`sync/drive.ts` の `DriveHub` が `drive.changed`（古い `seq` は捨てる）・`drive.upload.updated`・`drive.location.updated`・再接続・
  自分のメンバーシップとロールの変化を「読み直せ」の合図にする。開いているフォルダは 300 ms まとめて読み直し、読めなくなれば場所の根へ、
  根も読めなければ場所の列を読み直して最初の場所へ。

### 21.2 本書と違うところ・足したもの

| 本書 | D2 の実装 | 理由 |
| --- | --- | --- |
| §7.3「Web は cookie で認証されるので `<a href download>`」 | サーバに **ダウンロードのチケット**を足した：`POST /drive/items/{id}/download-ticket?version_id=` → `{url, expires_in}`、`GET /drive/download/{token}`（認証なし）。32 バイトの乱数、プロセスのメモリに SHA-256 だけ、1 人・1 項目・1 版。使われるたびに 5 分延び、発行から 12 時間で必ず終わる。1 人 200 枚まで（古いものから消す）。使うたびに本人が有効で項目を読めることを確かめる（チャンネルを抜けた・無効化・ゴミ箱で 404）。応答は `/content` と同じヘッダで `Cache-Control: private, no-store`。トークンはアクセスログで伏せる | Web のアクセストークンはメモリだけで、cookie は更新トークンだけ（`/auth/refresh` の経路）。§7.2 の ZIP のチケットは「1 回だけ」だが、1 ファイルはブラウザの再開（Range）と動画のシークで同じ URL を何度も使うため、短い期限と毎回の権限の確認にした |
| §5.3 `UploadOut` | `content_modified_at` を足した | 再起動の後に選び直したファイルをセッションと突き合わせる（名前・大きさ・更新日時）ため |
| §5.6 `GET /search/drive` の `{items: [ItemOut + path]}` | `{items: [{item, path, location_kind}], next_cursor}`。カーソルは件数（スコア順なので）、`kind=file\|folder`。語は `pgroonga_query_escape` してから `&@~`（ファイル名を検索の構文として読まない） | パスの根の名前を端末の言語にするため `location_kind` を付けた |
| §17.1「共有リンク」の列 | 出さない（**D4 で足した**：場所の列の「共有リンク」、§23） | D4（外部共有リンク）まで API が無い |
| §17.2 右クリックの「コピー」「共有リンク」「会話に送る」「版の履歴」、複数・フォルダの ZIP | 出さない（複数のファイルのダウンロードは 1 つずつ） | D3・D4・D6 |
| §17.2 ⌘C / ⌘V（コピー） | ⌘X / ⌘V の移動だけ | コピーは D3 |
| §17.3「同時に 3 ファイル、1 ファイルの部品も 3 本」 | そのとおり。Web の部品の進み具合は 16 MiB ごと（`fetch` に送信の進み具合が無い） | — |
| §17.3「送る前に一覧で同じ名前を見つけたら、まとめて聞く」 | 一覧ではなくセッションの作成の 409 で見つけ、1 件ずつ聞く（「残りすべてに同じ操作」でまとめて答える） | 一覧はページで読むので全部を持たない。サーバの答えが正しい |
| §13.3 チャンネルの「ドライブ」のタブ | 足した。「ファイル」のタブ（会話の添付）は残した | 添付とドライブは別のもの（§4.1） |
| §12「全体の検索（⌘K と検索の画面）」 | 検索の画面の「ドライブ」のタブだけ。⌘K（移動）には入れていない | ⌘K は会話とページへの移動で、ファイル名の検索は検索の画面に置いた |
| §14 `drive.location.updated` | 端末は受け取れば場所の一覧を読み直す（サーバはまだ出さない：D3 の上限・D4 の外部リンクの設定で出す） | — |

### 21.3 確かめたこと

- pytest：`tests/test_drive_d2.py`（チケット：期限・延長・上限・ハッシュだけ持つこと、認証なしで全体と Range、別の版、チャンネルから
  外す・ゴミ箱・無効化で 404、ログで伏せる。検索：読める場所だけ（ゲスト・ほかの人のマイドライブ・ゴミ箱は出ない）、場所と種類で絞る、
  カーソル、パス、索引を使うこと。セッションの `content_modified_at`）。サーバの全体・ruff・mypy。
- vitest：`driveUploads.test.ts`（偽のサーバで、部品の切り方、ネットワークが切れて戻る、一時停止と再開、衝突の質問（「残りすべてに」あり・
  なし、フォルダ）、送っている間の衝突、202、失敗とやり直し、期限切れ、取りやめ、ブラウザとアプリの再起動、読めなくなったファイル）、
  `driveListing.test.ts`（パンくず、ページ、選択、ビューア、ダウンロードの経路、塊ごとの書き込みと失敗での削除、フォルダの木、合図）、
  `driveBrowser.test.tsx`（カーソルのページ・並べ替え・消えたフォルダ・ゴミ箱）、i18n（3 言語のキーと引数）、場所のレールとタブの試験。
- 手で（使い捨ての compose：PGroonga・versitygw v1.8.0・この版の app、Vite 1422、ヘッドレスの Chrome を CDP で操作）：
  フォルダ（入れ子・空のフォルダ・写真・PDF）のドロップ、同じフォルダの 2 回目のドロップで衝突の質問 →「上書きして版にする」を残りすべてに、
  2 GiB の乱数のファイルを送っている途中で app を止めて「接続を待っています（21%）」→ 起動で続きから完了、2 GiB の送信の途中でページを
  読み込み直し →「続きがあります（49%）」→ 同じファイルを選び直して 49% から完了、2 GiB のファイルをブラウザのダウンロード（チケット）で
  落として元と SHA-256 が一致（ローカルで 7 秒）、リスト・グリッド・詳細・写真のビューアと ← →・移動のダイアログ・ゴミ箱・チャンネルのタブ・
  検索の画面のタブ。
- **確かめていないこと**：Tauri の macOS / Windows のアプリでの実機の動き（フォルダのドロップ、dialog から選んだファイルの部品ごとの読み出し、
  persisted-scope による再起動の後の自動の再開、ファイルへの塊ごとの書き込み）。`cargo check`（macOS）と権限の設定の検査（tauri-build）は通る。
  WKWebView で、ドロップした File が後から読めなくなる場合（`platform/pickedFiles.ts` の 2026-10-04 の件）は、読めなかったファイルを
  「選び直し」に回すようにしてある。

## 22. 段階 D3 の実装（M162、2026-10-21）

版・コピー・ZIP・容量。サーバ（`drive/versions.py`・`copying.py`・`zips.py`・`zipstream.py`・`usage.py`・`tree.py`）と Desktop / Web の画面。
移行は無い（表と列は D1 のまま足りた）。バックアップの変更（§16 の SHA-256 の引き継ぎ）は §16.2 のとおり段階 D5 で、D3 では行わない。

### 22.1 作ったもの

- **版**（§10.2）：`GET /drive/items/{id}/versions`（新しい順、`keep_versions`・`keep_days` つき）、
  `POST /drive/items/{id}/versions/{vid}/restore`、`DELETE /drive/items/{id}/versions/{vid}`。戻すのは書ける人、消すのは完全削除の人（§3.2）、
  今の版は 409 `drive_version_current`。戻す・消すは監査（`drive.version_restored`・`drive.version_deleted`）。版の整理は周期ジョブ
  （`DRIVE_HOUSEKEEPING_INTERVAL_SECONDS` ごと、200 版ずつのトランザクション、項目 → 場所の順にロック）。
- **戻す**：その版のオブジェクトをサーバの中で写し（`BlobStore.copy`）、サムネイルと**できているプレビュー**（PDF と 1 ページ目の WebP）も
  写す（変換し直さない）。新しい添付と新しい版（`source = 'restore'`、番号は続き）。写すのはトランザクションの外で、その後の
  1 トランザクションで項目・書く権利・容量をもう一度確かめて置く。失敗すれば写したオブジェクトを消す。
- **コピー**（§10.3）：`POST /drive/items/copy` → 200 `{results: [{id, ok, error?, new_id}]}`。ゴミ箱を除く部分木を写し、ファイルは今の版だけ
  （新しい項目の版 1、`source = 'copy'`。オブジェクト・サムネイル・できているプレビューを写す）。読める場所から書ける場所へ（場所をまたいでも）。
  `on_conflict` は `rename`（既定、「名前 (1)」）か `fail`、自分の中へは `drive_cycle`、根は `drive_root_immutable`。上限は
  `DRIVE_COPY_MAX_ITEMS`（500）・`DRIVE_COPY_MAX_BYTES`（1 GB）で、超えればリクエスト全体を 413 `drive_copy_too_large`（job は作らない）。
  容量は写す前に予約込みで一度見て、置くときに項目ごとにもう一度確かめる。`client_op_id` の送り直しは同じコピーを答える。
- **ZIP**（§7.2）：`POST /drive/zip` → `{url, expires_in, entries, size_bytes, zip_bytes, filename}`、`GET /drive/zip/{ticket}`（認証なし、1 回だけ、5 分）。
  中身は深さ優先（各フォルダの中はフォルダが先、名前順）、根を選べばその中身を上に並べる。名前は `names.download_name`（Windows で使えない
  文字を `_`）、同じフォルダの中で大文字小文字を区別せずに重なれば「(1)」。フォルダの項目も入れる（空のフォルダが残る）。日時は DOS の欄を
  頼んだ人のタイムゾーン（`quiet_hours_tz`、無ければ Asia/Tokyo）で、拡張タイムスタンプ（0x5455）を UTC で。始めるときに本人が有効で
  頼んだ項目をまだ読めることを確かめる（読めなければ 404）。同時に 1 人 2 本・全体 4 本（`DRIVE_ZIP_PER_USER`・`DRIVE_ZIP_TOTAL`、超えれば 429、
  チケットは使われずに残る）。トークンはアクセスログで伏せる（`/api/v1/drive/zip/***`）。
- **容量と使用量**（§11）：`GET /admin/drive/usage`（全体：今の版・古い版・ゴミ箱・件数・全体の上限・マイドライブの既定の上限・チャットの添付の
  合計と件数。場所ごと：名前（チャンネル名、マイドライブは人の表示名）・アーカイブ / 無効の印・内訳・件数・上限・効いている上限・最終更新。
  人ごと：上げた版の合計と数）、`PATCH /admin/drive/locations/{id} {quota_bytes}`（監査 `drive.quota_changed`、`drive.location.updated`）、
  `app.cli drive-usage --verify / --rebuild`。コピーと版を戻すも、アップロードと同じく場所と全体の上限を確かめる。
- **画面**：ファイルの右クリックと詳細のペインに「版の履歴」（ダイアログ：版ごとのダウンロード・この版に戻す・削除の確認）、右クリックに
  「コピー」（移動のダイアログのコピーの形。読むだけの場所からも）、⌘C → ⌘V（コピーはクリップボードに残り何度でも貼れる。⌘X は 1 回）、
  フォルダ・複数の選択・詳細のペインの「ZIP でダウンロード」（アプリは塊ごとにファイルへ、Web はブラウザのダウンロード）、
  管理 →「ドライブ」（`drive.admin`）。

### 22.2 本書と違うところ・足したもの

| 本書 | D3 の実装 | 理由 |
| --- | --- | --- |
| §7.2「標準の `zipfile` をスレッドで回し」 | 自前の小さな書き手 `drive/zipstream.py`（stored、UTF-8 のフラグ、CRC はデータ記述子（フラグの bit 3）、ZIP64 は値が 32 ビットに収まらない所だけ：4 GiB 以上のファイル、4 GiB より後ろの項目・中央ディレクトリ） | 名前と大きさだけで全体の長さが決まり、`Content-Length` を最初に正しく出せる。`zipfile` の流す形は ZIP64 を大きさの推測で選び、欄の長さが変わるので先に長さが分からない。小さな ZIP は ZIP64 を使わない（どの展開ソフトでも読める）。読む側は `zipfile`・`unzip`・macOS の `ditto` で確かめた（§22.3） |
| §5.2 copy の 202 `{job_id}` | いつも 200 `{results}`、上限を超えれば 413 | §10.3 のとおり D3 は上限で断る。job は要望が出たら |
| §5.2 copy の `results` | `new_id`（写した先の項目）を足した（`DriveCopyResultsOut`。move の `results` の形は変えない） | 端末が写した項目を開ける・選べるように |
| §5.2 copy の `client_op_id` | 頼んだ項目ごとに `uuid5(client_op_id, 元の id)` を写した先の根の `drive_items.client_op_id` に入れ、送り直しはそれを答える | 新しい表を作らずに冪等にする（D1 の部分一意索引を使う） |
| §7.2 `POST /drive/zip` の応答 | `zip_bytes`（ZIP の長さ）と `filename`（1 つなら「名前.zip」、同じフォルダの複数ならそのフォルダ（根なら場所）の名前、ほかは `drive.zip`）を足した | アプリの進み具合の分母と保存の名前 |
| §10.2 の日数 | 今の版でない版の 30 日は、その版が次の版に置き換えられた時刻から数える | 上げた時刻から数えると、古いファイルを上書きした直後に前の版が消える |
| §10.2「版を戻すと…新しい添付」 | サムネイルと、できているプレビュー（PDF・WebP）も写す。できていなければ今までどおりプレビューを予約 | 戻すたびに Office を変換し直さない。コピーも同じ |
| §14 `drive.location.updated {location: DriveLocationOut}` | `{location_id}` だけ | `DriveLocationOut` は読む人ごとに違う（`can_write` など）。D2 の端末は受け取れば場所の一覧を読み直すので、形を変えても困らない |
| §5.5 `PATCH /admin/drive/locations/{id}` の応答 | 管理の画面の行（`DriveLocationUsageOut`） | 画面の行をそのまま置き換える |
| §11.2「人ごと：上げたファイルの合計」 | 版の `uploaded_by` の合計（今の版・古い版・ゴミ箱を含む。コピーと版を戻すはした人の分） | 場所の使用量と同じ数え方 |
| §17.5 管理画面の「ドライブ」 | 使用量と上限だけ（外部リンクのスイッチ・期限・パスワード、すべてのリンクは D4。**D4 で足した**、§23） | D4 の機能 |
| ワークスペースの設定 | D3 で足すものは無い（全体の上限・マイドライブの既定の上限・版の数と日数・コピーと ZIP の上限は環境変数） | §11.1 のとおり。外部リンクの 3 列は D4 |

足したエラー：`drive_version_current`（409）、`drive_copy_too_large`（413、`details.limit_bytes`・`limit_items`）、`drive_zip_too_large`
（413、`details.limit_bytes`・`limit_entries`）。設定：`DRIVE_VERSIONS_MAX`・`DRIVE_VERSIONS_DAYS`・`DRIVE_COPY_MAX_ITEMS`・`DRIVE_COPY_MAX_BYTES`・
`DRIVE_ZIP_MAX_ENTRIES`・`DRIVE_ZIP_MAX_BYTES`・`DRIVE_ZIP_PER_USER`・`DRIVE_ZIP_TOTAL`。

### 22.3 確かめたこと

- pytest（`tests/test_drive_d3.py`）：ZIP の書き手（`zipfile` で読み戻して CRC・UTF-8 のフラグ・stored・フォルダ・空のファイル・DOS の日時、
  長さが計画と一致、小さな ZIP に ZIP64 が無いこと）、4 GiB + 1 MiB のファイルとその後ろの小さなファイル（疎なファイルに書いて ZIP64 の大きさ・
  位置・終わりの記録を `zipfile` で確かめ、長さが一致）、元の長さが違えば流すのを切ること、チケット（1 回だけ・期限・ハッシュだけ）と同時の本数、
  API の ZIP（フォルダ・選択・Windows で使えない名前・ゴミ箱を入れない・`Content-Length` と実際の長さ・2 回目は 404・上限の 413・429 とチケットが
  残ること・チャンネルを抜けた人は 404）、版（一覧・古い版のダウンロード・戻す・今の版は 409・消すのは管理者だけ・容量の増減・監査）、
  戻すときの場所と全体の上限（写したオブジェクトが残らない）、版の整理（10 版・置き換えから 30 日・今の版は残る）、コピー（フォルダとファイル・
  ゴミ箱を写さない・今の版だけ・`client_op_id` の送り直し・rename / fail・輪・根・マイドライブへ）、コピーの上限と権限（読むだけで写せる・
  アーカイブ先は 403・他人のマイドライブは 404）、**同時の 2 つのコピーで容量に収まるのは 1 つ**（負けた方の写しは消える）、使用量の画面・
  上限の変更（監査・イベント）・上限を下げても減らす操作はできる・`drive-usage` の検査と作り直し。サーバの全体・ruff・mypy。
- vitest：`driveActions.test.ts`（選択のダウンロード、貼り付け、版の操作、上限の欄）、`driveD3.test.tsx`（⌘C / ⌘X → ⌘V、フォルダの ZIP と
  コピーのメニュー、版の履歴の戻す・削除、管理の使用量と上限の保存）。tsc と vitest の全体。
- 手で（使い捨ての compose：PGroonga・versitygw v1.8.0・この版の app、Vite 1422、ヘッドレスの Chrome を CDP で操作）：3 版のファイルの
  版 2 を戻して版 4 になる、フォルダを ⌘C → ⌘V で「ゼミ資料 (1)」、ファイルをマイドライブへコピー、フォルダを Web から ZIP で落として
  macOS の `ditto -x -k` と `unzip` で日本語の名前（全角の空白・括弧・半角カナ・濁点）・入れ子・空のフォルダのまま展開、管理 →「ドライブ」で
  上限 5 GB を付けると場所の列の棒がすぐ変わる、`drive-usage --verify` が 0。ZIP64：4.1 GiB のファイル（部品ごとに中身が違う）と後ろの小さなファイルを
  compose に上げて ZIP（4,399,825,618 バイト、`Content-Length` と一致）、`ditto` と `unzip -t` で展開し SHA-256 が元と一致。5,000 ファイル・
  50 フォルダの ZIP（書き手を直接、日本語の名前）を `ditto` と `unzip` で展開して一致。
- **確かめていないこと**：Windows のエクスプローラーでの展開、10 GB・5,000 ファイルをブラウザで落とすこと（§18 の D3 の完了条件の一部。
  ZIP64 と件数は上のとおり別々に確かめた）、Tauri のアプリでの ZIP の保存（D2 の 1 ファイルの保存と同じ経路）。

## 23. 段階 D4 の実装（M163、2026-10-21）

外部共有リンク。サーバ（移行 0119、`drive/shares.py`（作る側）・`drive/public.py`（公開側）・`drive/share_router.py`）、Desktop / Web の画面、
公開ページ（Web のバンドルの 2 つ目の入口 `share.html`、`src/share/`）、Caddy・nginx の設定例。

### 23.1 作ったもの

- **移行 0119**：`drive_share_links`・`drive_share_events`（§4.2 のとおり。下の違いを除く）、`workspace_settings` の 3 列
  （`drive_external_links_enabled`・`drive_link_max_days`・`drive_link_password_required`）。
- **作る側**（§5.4）：`POST /drive/items/{id}/links`（32 バイトの乱数のトークン、DB には SHA-256 だけ、URL はこの応答だけ。期限の既定 7 日・
  最長はワークスペースの設定、パスワードは Argon2id、回数の上限、`note`）、`GET /drive/items/{id}/links`（リンクと、ダイアログが出せるもの
  `policy`）、`GET /drive/links`（自分のもの）、`PATCH /drive/links/{id}`（作った人）、`DELETE /drive/links/{id}`（作った人・場所を管理する人・
  admin）、`GET /drive/links/{id}/events`（作った人は IP の上位 2 つだけ、admin は全体）、`PATCH /drive/locations/{id} {external_links}`
  （場所を管理する人）。`DriveLocationOut.can_share`、`DriveItemOut.link_count`、`DriveChildrenOut.shared_above`（下）。監査
  `drive.link_created`・`drive.link_updated`・`drive.link_revoked`・`drive.location_links_changed`、ワークスペースのスイッチは
  `workspace.settings_updated`。トークンとパスワードは監査にも載せない。
- **管理者**（§5.5）：`GET /admin/drive/links`（取り消していないすべてのリンク。項目と場所の名前・作った人・期限・回数・最後に使われた時刻・
  状態、中身は出さない）、`DELETE /admin/drive/links/{id}`（`by_admin: true`）、`GET / PATCH /admin/drive/settings`（下の §23.2）。
- **公開側**（§5.4・§9.3、認証なし）：`GET /shares/{token}`、`POST /shares/{token}/unlock`、`GET /shares/{token}/folders/{id}/children`、
  `GET|HEAD /shares/{token}/items/{id}/content`、`/thumbnail`・`/preview/thumbnail`・`/preview/pdf`、`GET /shares/{token}/zip?folder_id=`。
  働く条件（§9.2）は毎回 `shares.link_state` で確かめ、知らないトークンは 404 `share_link_not_found`、ほかはすべて 410
  `share_link_unavailable`（理由は言わない）。部分木の確かめは `public.shared_item`（項目の祖先の鎖を再帰 CTE でたどり、リンクの項目に
  届くこと、その間にゴミ箱の項目が無いこと）。すべての応答（エラーも）に `X-Robots-Tag: noindex, nofollow, noarchive`・
  `Referrer-Policy: no-referrer`・`X-Frame-Options: DENY`・`X-Content-Type-Options: nosniff`・`Cache-Control: no-store` と、
  ルートが付けなければ `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; sandbox`（`ShareHeadersMiddleware`）。
- **回数**：本文（Range なし、`bytes=0-…`）と ZIP 1 本ごとに 1 つ。1 つの条件付き `UPDATE … WHERE download_count < max_downloads RETURNING`
  で数える（同時でも超えない）。一覧・サムネイル・プレビュー・HEAD は数えない。途中から（`bytes=n-`、n > 0）の Range は、同じアドレスが
  そのリンクでその版を 24 時間以内に落としていれば数えない（ブラウザの再開）、そうでなければ数える（§23.2）。
- **速度制限**（§9.4）：公開側の全体 IP 120 / 分、知らない・働かないリンク IP 20 / 分（**引く前に**確かめる：使い切ったアドレスには正しい
  トークンでも 429 を返し、429 がトークンの当否を漏らさない）、本文のダウンロード リンク 60 / 分、パスワード リンク 10 回 / 10 分・
  IP 20 / 分、作成 ユーザー 30 / 分。設定は `DRIVE_SHARE_*`・`DRIVE_LINK_CREATE_RATE_LIMIT_PER_USER`。
- **解錠の cookie**：`taylis_share`、値は `link_id.password_version.期限.HMAC-SHA256`（鍵は `SECRET_KEY` から HMAC で作る）、`HttpOnly`・
  `SameSite=Lax`・`Path=/api/v1/shares/<token>`・12 時間（`DRIVE_SHARE_UNLOCK_HOURS`）、https のときだけ `Secure`（Web のセッションの
  cookie と同じ判定）。パスワードを変えると（外すのも）それまでの cookie は効かない。
- **記録**：`drive_share_events`（`open`・`download`・`zip`・`password_failed`・`refused`、IP と User-Agent 200 文字）。drive の周期ジョブが
  180 日（`DRIVE_SHARE_EVENTS_DAYS`）で消す。アクセスログは `/s/***`・`/api/v1/shares/***/…`（`core/logging.py`）。
- **人の変化**（§3.3）：抜けた・ゲストになった・無効化は止まる（`paused`、戻れば働く）。匿名化はその人のリンクをすべて取り消す
  （`forget_user_in_tx`）。完全削除した項目のリンクと記録は CASCADE で消える。
- **画面**（§17.4・§17.5）：ファイル・フォルダの右クリックと詳細の欄の「共有リンク」（ダイアログ：期限 1 / 7 / 30 / 90 日・日付・「期限なし」
  （許されるときだけ）、パスワード、回数の上限、誰向けか → 作ると URL とコピー、「今だけ表示する」の注意。下にその項目のリンクの一覧：状態・
  期限・回数・最後に使われた時刻・記録・取り消し）。一覧の名前の横のリンクのしるし、外に共有されているフォルダの中の注意の帯、場所の列の
  「共有リンク」（自分が作ったもの）と、場所を管理する人の ⋯ の「この場所で外部共有リンクを許す」。管理 →「ドライブ」の「外部共有リンク」
  （スイッチ・期限の最長・パスワードの必須・すべてのリンクと取り消し）。
- **公開ページ** `/s/<token>`（`share.html`、ログインも同期も持たない入口）：パスワードの入力、ファイルのカード（ダウンロード・プレビュー）、
  フォルダの一覧（リンクのフォルダから下のパンくず、`#f=<id>` で戻るボタンが効く）、「すべてを ZIP でダウンロード」、PDF と Office の
  プレビュー（アプリと同じ PDF.js のビューア。`PdfViewer` は controller の代わりに読み込みの関数を受け取れるようにした）、画像。ダウンロードは
  ふつうのリンク（ブラウザ自身のダウンロード）。作った人・場所・ほかのリンク・版は出さない。`<meta name="robots">`・`<meta name="referrer">`、
  `public/robots.txt`（`Disallow: /s/`・`/api/`）。`vite` と `vite preview` も `/s/*` に share.html を返す（`sharePage` プラグイン）。

### 23.2 本書と違うところ・足したもの

| 本書 | D4 の実装 | 理由 |
| --- | --- | --- |
| §5.5 `PATCH /admin/workspace-settings` に 3 つを足す | `GET / PATCH /admin/drive/settings`（`drive.admin`）。値は `workspace_settings` の列のまま、監査も `workspace.settings_updated` | `/admin/workspace-settings` は運営（channels.manage）も開く経路で、ドライブの管理は admin だけ（§3.2）。管理 →「ドライブ」の画面から使う |
| §5.2 `link_count`「自分に見える有効な外部リンクの数」 | 取り消し・期限切れ・回数切れでないリンクの数を、項目を読めるすべての人に出す（`paused` も数える）。`DriveChildrenOut.shared_above`（開いているフォルダとその上のフォルダのリンクの数）を足し、一覧に「外部に公開されている」帯を出す | ここに置いたものが学外から見えることを、置く人が知っているべき。人ごとに変えると、他人が作ったリンクの下に知らずにファイルを置く |
| §9.2 回数「`bytes=0-` で始まるものだけ数える」 | 途中からの Range も、そのアドレスがそのリンクでその版を 24 時間以内に落としていなければ数える（プロセスのメモリ、SHA-256 のキー） | 本書のままだと `bytes=1-` と `bytes=0-0` の 2 回で上限の付いたファイルを 1 回分で読み切れる |
| §9.2 一覧・プレビューは数えない | そのとおり。ただし回数を使い切ったリンクは一覧・プレビューも含めてすべて 410 | 働く条件（§9.2）に回数が入っている。使い切ったリンクの中身の名前を見せ続ける理由が無い |
| §5.4 `GET /shares/{token}` | `{state, kind, password_required, unlocked, expires_at, downloads_left, root_id, item, workspace_name}`。パスワードのあるリンクは解錠まで `kind`・`item`・`root_id` を null にする | 名前・種類もパスワードの後ろに置く。ページが残りの回数と期限を出す |
| §5.4 `/content` | `HEAD` も受ける（ヘッダだけ、数えない） | ダウンロードマネージャ・ブラウザの確かめで回数が減らないように |
| §5.4 `/zip?folder_id=` | チケットを作らず、cookie（パスワード）とトークンだけで流す。同時の本数はリンクごと 2 本・全体 4 本（D3 の枠を共有） | 公開側は Bearer を持たない。`<a href download>` で直接落とせる |
| §9.3 画像のプレビュー | 回数の上限が無いリンクは元の画像（`?inline=1`、ダウンロードとして数える）、上限のあるリンクはサムネイル（512 px、数えない） | 見るたびに回数が減るのを避けつつ、上限の無いリンクではきれいに見せる |
| §9.3 `<noscript>` で直接のダウンロードのリンク | 「JavaScript を有効にしてください」だけ | ページは静的なファイル（サーバはトークンを見ない）で、リンクの種類やパスワードの有無を知らない |
| §3.2 外部リンクを作る | 場所の根（ドライブのいちばん上のフォルダ）は共有できない（409 `drive_root_immutable`） | 研究室ドライブ全体を 1 本のリンクで外に出せないようにする |
| §9.2 働く条件 | 「項目が作った時の場所にあること」を足した（別の場所へ移されたら `paused`。戻せば働く） | 移った先の場所のスイッチと人がそのリンクを許していない |
| §4.2 `drive_share_links.location_id` | `ON DELETE CASCADE`、`created_by` に索引、`max_downloads > 0` と `download_count >= 0` の CHECK | 匿名化した人のマイドライブを消すとき（§3.3）に残らないように |
| §5.4 `GET /drive/links?mine=1` | `GET /drive/links` はいつも自分のもの（全体は `/admin/drive/links`） | 1 つの経路に 2 つの権限を混ぜない |
| §5.4 `PATCH` | 作った人だけ、その人が今その項目を読めるときだけ。期限・パスワードの必須は作るときと同じ規則 | 読めなくなった人がリンクを延ばせないように |
| §3.2 取り消し | 作った人・場所を管理する人（`can_manage`）・admin。監査に `by_admin`・`by_creator` | §3.2 の表のとおり（場所の中のすべてのリンクの取り消し） |
| 入力の上限 | パスワード 4〜128 文字、`note` 80 文字、回数の上限 1〜100,000、期限の最長の設定 1〜3,650 日（null で期限なしを許す）。期限は最長に 1 時間の余裕（端末の時計のずれ） | — |
| §14 のイベント | リンクの作成・取り消しで項目のフォルダに `drive.changed`（しるしの読み直し）、場所のスイッチで `drive.location.updated`。ワークスペースのスイッチはイベントを出さない（ダイアログを開くたびに `policy` を読む） | — |
| §9.6 Caddy | `/s/*` の CSP は SPA より狭い（`img-src 'self' data: blob:`、`base-uri 'none'`）。`/api/v1/shares/*` のヘッダは app が付ける（Caddy で重ねない） | 公開ページは外の画像を読まない |
| §9.6 nginx の `access_log off` | 伏せた形式のアクセスログ（`map $uri` で `/s/`・`/api/v1/shares/` ほか秘密の入るパスの次の部分を `***`、クエリ文字列を書かない）を `nginx-site.conf.example` に足した | ログを全部止めると運用の手がかりが無くなる |
| §17.1「共有リンク」の列 | 場所の列の下の「共有リンク」がダイアログ（自分が作ったリンク）を開く。場所の設定は場所の行の ⋯ | 一覧の列を増やさない |
| エラー | 足した：`drive_links_disabled`（403）、`share_link_expiry_too_long`・`share_link_password_required`（422）、`share_link_not_found`（404）、`share_link_unavailable`（410）、`share_password_required`・`share_password_invalid`（401） | §5.7 のとおり（作る側の 2 つを足した） |

### 23.3 脅威モデルのチェックリストと試験

§9.1 の表を、実装の守りと、それを固定した試験で見直した（`server/tests/test_drive_d4.py`、画面は `apps/desktop/tests/driveShares.test.tsx`）。

| # | 脅威 | 守り | 試験 |
| --- | --- | --- | --- |
| 1 | トークンの推測・総当たり | 256 ビットの乱数。知らないトークンは 404。IP ごとに知らない・働かないリンク 20 / 分、使い切ったら引く前に 429（正しいトークンでも） | `test_unknown_tokens_are_slowed_down_without_an_oracle`、`test_every_public_request_is_rate_limited_per_address` |
| 2 | DB の流出 | トークンは SHA-256 だけ、パスワードは Argon2id、監査にトークンを載せない | `test_a_link_is_a_random_token_kept_as_its_hash` |
| 3 | 期限切れ・取り消し | 毎回 `expires_at`・`revoked_at` を見る。410（理由は言わない） | `test_expired_revoked_and_unknown_links` |
| 4 | パスワードの誤り・総当たり | Argon2id、リンク 10 回 / 10 分（その後は正しいパスワードも 429）、IP 20 / 分、失敗は `password_failed` に残る | `test_the_password_and_its_unlock_cookie`、`test_passwords_cannot_be_guessed_quickly` |
| 5 | 解錠の cookie の偽造・使い回し | HMAC（`SECRET_KEY` から）、リンクの id とパスワードの版を含む、Path はそのトークン、HttpOnly。パスワードを変えると無効 | `test_the_password_and_its_unlock_cookie` |
| 6 | 作った人が読めなくなった | 毎回、作った人が有効な人（ゲスト・bot でない）でその場所を読めるかを見る：抜けた・ゲストになった・無効化で止まり、戻れば働く | `test_a_link_works_only_while_its_creator_can_read_the_item` |
| 7 | アーカイブしたチャンネル（§19 Q6） | アーカイブの間は止まり、戻せば働く | 同上 |
| 8 | スイッチ（ワークスペース・場所） | 毎回見る。切ると既存のリンクも止まる、作れない（403 `drive_links_disabled`） | 同上、`test_who_may_make_links_and_the_workspace_policy` |
| 9 | 部分木の外の id | 公開側は id だけを受け、祖先の鎖がリンクの項目に届くことを確かめる：親・兄弟・場所の根・別の場所・知らない id・ファイルを一覧として、すべて 404 | `test_only_the_shared_subtree_is_reachable` |
| 10 | 部分木の外へ移された項目 | 移された後は 404、戻せば見える | 同上 |
| 11 | ゴミ箱の項目 | 項目と祖先の鎖にゴミ箱の項目があれば 404。リンクの項目そのものがゴミ箱なら 410 | 同上、`test_a_link_works_only_while_its_creator_can_read_the_item` |
| 12 | 古い版 | 公開側は今の版だけ（`version_id` は受けない） | `test_only_the_shared_subtree_is_reachable` |
| 13 | 回数の上限の同時の要求 | 条件付きの 1 つの `UPDATE` | `test_concurrent_downloads_never_pass_the_limit`（上限 3 に同時に 10 本 → 200 が 3、410 が 7） |
| 14 | Range・HEAD での上限のすり抜け | `bytes=0-` と途中からの初めての Range は数える。HEAD・一覧・サムネイル・プレビューは数えない。416 は数えない | `test_the_download_limit_counts_downloads_only` |
| 15 | 悪いファイル（HTML・SVG）の配布 | 本文は常に `attachment`（画像だけ `?inline=1`）、`nosniff`、`CSP: sandbox`、PDF のプレビューも sandbox | `test_a_file_link_downloads_with_safe_headers` |
| 16 | 検索エンジン・Referer・埋め込み | すべての応答（エラーも）に `X-Robots-Tag`・`no-referrer`・`DENY`・`no-store`。ページの meta、robots.txt、Caddy の `/s/*` のヘッダ | 同上、`driveShares.test.tsx`、compose での確かめ（§23.4） |
| 17 | ログのトークン | app のアクセスログは `***`。Caddy はアクセスログを書かない。nginx は伏せた形式（infra/README.md） | `test_tokens_never_reach_the_logs`、nginx 1.27 での確かめ（§23.4） |
| 18 | ZIP の名前でのパスの乗っ取り | ZIP の名前は項目の名前から `names.download_name` で作る（`/`・`\`・先頭の `.` を置き換え）。`../../etc/passwd`・`..\..\evil.bat` のような名前（移行で入りうる）も 1 つの部分になる | `test_a_folder_link_zips_safely_and_counts_once` |
| 19 | 帯域・ディスクの浪費 | 回数の上限、リンクごとのダウンロード 60 / 分、ZIP の同時の本数（リンク 2・全体 4）、ZIP の上限（10,000 件・20 GB） | `test_every_public_request_is_rate_limited_per_address`、D3 の ZIP の試験 |
| 20 | 管理者が知らないうちに外へ出る | admin の一覧と取り消し、スイッチ、作成・変更・取り消しの監査、一覧のしるしと帯 | `test_admins_see_every_link_and_events_are_kept_180_days`、`test_a_link_is_a_random_token_kept_as_its_hash` |
| 21 | ゲスト・読むだけの人がリンクを作る | ゲストは 403 `guest_restricted`、アーカイブは 403 `drive_read_only`、根は 409 | `test_who_may_make_links_and_the_workspace_policy` |
| 22 | 公開側からの情報の漏れ | 作った人・更新した人・場所・ほかのリンク・版を返さない。パスワードの前は名前も返さない | `test_a_file_link_downloads_with_safe_headers`、`test_the_password_and_its_unlock_cookie`、`driveShares.test.tsx` |
| 23 | 退会・削除 | 匿名化でリンクを取り消す、完全削除でリンクと記録が消える、記録は 180 日 | `test_admins_see_every_link_and_events_are_kept_180_days`、`test_purging_an_item_takes_its_links_and_events` |

**残るリスク（受け入れたもの）**：PDF のプレビューは数えない（PDF はファイルそのものなので、回数の上限のある PDF もプレビューで全ページ
読める。§9.2 のとおり「見せる」の範囲）。回数の再開の判定はプロセスのメモリ（再起動の後の再開は 1 回と数える）。IP は Caddy / nginx が
置き換えた値（SECURITY.md §6）で、大学の NAT の後ろの人は同じアドレスになる。

### 23.4 確かめたこと

- pytest：`tests/test_drive_d4.py`（19 件、上の表と、プロキシが渡した IP でないアドレスを NULL で残すこと）。サーバの全体・ruff・ruff format・mypy。
- vitest：`tests/driveShares.test.tsx`（期限の選択肢と送る値、URL を 1 回だけ出して写す、状態と取り消し、止まっているときの文、一覧のしるし、
  管理のスイッチと一覧、公開ページのパスワード・フォルダ・ファイル・止まったリンク、開発のサーバの書き換え）。tsc と vitest の全体。
  `vite build` に `share.html` と `assets/share-*.js` が入る。エラーの文言の表（`apps/shared/errors.json` から生成）が変わったので、
  Android の `:app:compileDebugKotlin` と iOS の `xcodebuild build`（汎用のシミュレータ）も通した。
- 手で（使い捨ての compose：PGroonga・versitygw v1.8.0・この版の app、Vite 1422、ヘッドレスの Chrome を CDP で操作）：ログインしたプロファイルで
  フォルダ（パスワード・回数 5・誰向け）とファイル（回数 2）のリンクを共有ダイアログから作り、URL のコピーと一覧のしるしを確かめた。
  ログインしていない別のプロファイルで：パスワードの画面（解錠の前に名前が出ない）、誤ったパスワード、フォルダの一覧、PDF のプレビュー
  （PDF.js）、画像（回数の上限があるのでサムネイル）、サブフォルダとパンくず、フォルダの ZIP（ブラウザのダウンロードで落とし `ditto` で日本語の
  名前のまま展開、回数が 1 減る）、ファイルの回数の上限（200・200・410 と「このリンクは使えません」）。ページから cookie が読めないこと。
  取り消し（ダイアログから）、期限切れ、ワークスペースと場所のスイッチのオン・オフ、兄弟の id の 404、HEAD と Range、ヘッダ。管理 →「ドライブ」
  の一覧。app のログにトークンが 0 件。この Caddyfile（caddy:2）で `/s/*` が share.html とヘッダを返し、CSP の下で PDF.js のプレビューが
  動く（コンソールのエラーなし）。nginx 1.27 で `nginx-site.conf.example` が `nginx -t` を通り、アクセスログが `GET /s/*** …` になる。
- **確かめていないこと**：Safari・Firefox・スマホのブラウザでの公開ページ（§18 の D4 の完了条件の一部）、Tauri のアプリでの共有ダイアログ
  （Web と同じ部品）、本番の nginx への反映（共用のサーバなので運用者が行う、infra/README.md）。

## 24. 段階 D5 の実装（M164、2026-10-22）

Nextcloud からの移行のコマンド、移行のファイルのプレビューの後追い、バックアップの作り直し、サーバの外へのバックアップ（restic）と
別の機械での復元のリハーサル、移行の手順書（infra/README.md「Nextcloud からの移行」）。移行（DB の表）は無い（`import_refs` と D1 の表で足りた）。
**本番の Nextcloud からの移行の実行（§18 の完了条件の後半）はまだ**：利用者から Nextcloud の URL・アプリパスワード（またはデータ
ディレクトリの写し）とサーバの外のバックアップ先を受け取って、infra/README.md の手順で行う。

### 24.1 作ったもの

- **`app.cli import-nextcloud`**（`importer/nextcloud_source.py`・`importer/nextcloud_import.py`）：
  - 読み元：WebDAV（`--webdav URL --webdav-user U --webdav-password-file F`、または `NEXTCLOUD_WEBDAV_URL`・`NEXTCLOUD_USER`・
    `NEXTCLOUD_APP_PASSWORD_FILE` / `NEXTCLOUD_APP_PASSWORD`）か、データディレクトリの写し（`--data-dir …/data/<user>/files`）。WebDAV はフォルダ
    ごとに `PROPFIND`（`Depth: 1`。`infinity` は多くのサーバで止められている）を送り、Nextcloud のページ分け（`X-NC-Paginate`、1 ページ 1,000 件）を
    たどる。アプリパスワードは `Authorization` ヘッダだけに載せ、URL・例外の文・ログには出さない（利用者名やパスワードの入った URL は断る。
    `httpx` のログは WARNING 未満を出さない）。取ってくる本文は `aiter_bytes`（途中の gzip も戻す）。読み失敗は 3 回まで試し、10 件続けて失敗したら止める。
  - 対応表（§15.2 の TOML、`tomllib`）：`[[map]] source/target` と `[[skip]] source`。パスのまとまり（`/` で区切った部分）で比べ、いちばん長い
    source が勝つ（skip も含む。skip の中の map は戻る）。target は `workspace:/パス`・`channel:<名前>:/パス`・`user:<名前>:/パス`。無いチャンネル・
    DM・アーカイブしたチャンネル・無い人・ゲストと bot・消している途中のマイドライブは、実行なら何も書かずに止まり（全部を一度に出す）、
    `--dry-run` なら表に出す。先のフォルダは mkdir -p で作る（同じ名前のフォルダがあれば使う）。チャンネルのドライブ・マイドライブが無ければ作る。
  - 走査は対応表が覆うフォルダと、その下に map のあるフォルダだけに入る。入らないフォルダは「対応の無いもの」「[[skip]]」として大きさつきで
    出す（WebDAV は `oc:size`、データディレクトリは数える）。データディレクトリのシンボリックリンク・Nextcloud のアップロードの残り
    （`.ocTransferId*.part`）は移さず表に出す。
  - 計画（`--dry-run` と実行で同じもの）：件数（新しいフォルダ・既存のフォルダに入れる・変わらない・新しいファイル・新しい版・変わらない）、
    大きさ（新しいファイル・新しい版・対応の無いもの・飛ばしたもの・対応表が覆う Nextcloud のファイルの合計）、場所ごとの今の使用量・足す量・
    上限と、上限・全体の上限を超えるもの、名前が変わるもの（Nextcloud のパス → Taylis のパス・理由）、対応の無いもの、飛ばしたもの（理由つき）、
    Taylis にあって Nextcloud に無くなったもの、`--user` の無い Nextcloud の持ち主。
  - 実行：フォルダは 1 つずつ（親を `FOR UPDATE`、作るか使う、`import_refs`、場所の `item_count`、`drive.changed`）、ファイルは 1 つずつ
    （場所の上限を予約込みで先に確かめる → 本文を `drive.uploads.store_stream` で 16 MiB の部品ごとに S3 のマルチパートへ（1 部品に収まるものは 1 回の
    put）、流しながら SHA-256 → 1 トランザクションで項目・添付・版（`source = 'import'`、`content_modified_at` = Nextcloud の更新日時）・
    `import_refs`・`drive.changed`）。版を作るところはアップロードの完了から `uploads.add_version_in_tx` に切り出して共有した。止めても次の実行で続きから。
    最後に監査 `drive.import`（件数・バイト・止まった理由）。`--limit-bytes 500G` でその量に達したら止まる（次の実行が続ける）。
  - `--user NC_USER=USERNAME`：WebDAV の `oc:owner-id`（データディレクトリならその人）→ 上げた人。無ければ `--actor`（表に出す）。
  - `--previews`（既定はしない）：文書のプレビューをすぐ予約する。既定では `none` で入れ、後で `generate-previews --drive`。
  - SHA-256 は取り込みで分かるので、画像と動画でない版は media loop を通さない（`processed_at` を入れる）。画像・動画はサムネイル・ポスターのために通る。
  - `--list-shares`（WebDAV のときだけ）：OCS API の「自分が共有したもの（`reshares=true`）」と「共有されたもの（`shared_with_me=true`）」を、
    パス・種類（人・グループ・公開リンク・メールなど）・相手・持ち主・権限（`rwcds`）・期限・パスワードの有無で表に出す。トークンと URL は出さない。
- **`generate-previews --drive`**：ドライブのファイルの今の版（ゴミ箱を除く）で、プレビューが `none`（`--retry-failed` なら `failed` も）のものを
  1 件ずつ作る。各ファイルの前に、チャットの添付が preview loop を待っている（`pending` で期限の来ているもの）間は 2 秒ごとに待つ
  （1 ファイルあたり最大 `--chat-wait-seconds`、既定 600 秒）。プレビューができると `drive.changed`（loop と同じフック）。
- **`infra/backup.sh`** のオブジェクトの段（§16.2）：1 回の `find` とまとめた `stat` で「大きさ・更新日時（秒）・inode」の一覧
  （`objects.list`）を作り、前回の一覧と 3 つとも同じファイルは前回の写しへのハードリンク（前回の木を 1 回の `cp -al` で写してから、変わった・
  消えたものを外す）にして前回の `objects.sha256` の行を引き継ぐ。新しい・変わったファイルだけを `cp -p` で写して SHA-256 を取る。`BACKUP_VERIFY=1`
  ですべてを読み直し、引き継いだ値と違うハードリンクがあれば失敗にする（週 1 回などに）。`counts.txt`（人・メッセージ・添付・ドライブの項目と
  ファイルと大きさ）をダンプの直後に書く（別の機械での復元と比べるため）。
- **`infra/offsite-backup.sh`**（restic、公式イメージ `restic/restic:0.17.3` を Docker で）：`init`・`backup`（一番新しい完全なバックアップを
  `/backup` に読み取り専用でつないで送る。`--ignore-ctime --ignore-inode` でハードリンクにしたオブジェクトを読み直さない。保持 14 日・8 週・12 か月）・
  `maintain`（prune と、データの 5% の読み戻し）・`check [5%|all]`・`snapshots`・`restore SNAPSHOT DIR`（すべてのチェックサムを確かめる）。
  送り先は `infra/offsite.conf`（git に入れない。例は `offsite.conf.example`）の `RESTIC_REPOSITORY`：`sftp:USER@HOST:/path`（専用の鍵と
  known_hosts）か、マウントしたディスク・NAS の絶対パス。`.env` と `secrets/` は `OFFSITE_INCLUDE_SECRETS=1` のときだけ（暗号化されて入る）。
- **`infra/offsite-rehearsal.sh`**：別の機械で、スナップショットを戻し、使い捨ての compose（ポートを出さない）に `restore.sh` で入れ、`counts.txt`
  と件数を比べ、`verify-attachments`（`restore.sh` の中）と `drive-usage --verify` を通し、片付ける。
- `offsite-backup.sh` はリリースのアップロードの任意のファイル（`deploy-ssh.sh` の `OPTIONAL_FILES` と release.yml）。古い `chikuwa-deploy` のサーバは
  入れ直すまで受け取らない（infra/README.md）。

### 24.2 本書と違うところ・足したもの

| 本書 | D5 の実装 | 理由 |
| --- | --- | --- |
| §15.4 `source_id` = 対応表の source を外したパスの SHA-256 | 「Nextcloud の人（WebDAV の URL の人、データディレクトリなら `files` の上のフォルダ名、`--nextcloud-user`）・Nextcloud のパス全体・規則の target」の SHA-256 | 相対パスだけだと、同じ相対パスを持つ 2 つの規則・2 人の Nextcloud がぶつかる。target を含めるので、対応表を変えると新しい先に新しく置く（前の先のものは「無くなったもの」に出る）。人とパスは WebDAV とデータディレクトリで同じなので、写しでリハーサル → WebDAV で差分、ができる |
| §15.4「大きさと更新日時が同じなら飛ばし、違えば新しい版」 | 比べるのは**最後に取り込んだ版**。Taylis で新しい版が足されていて Nextcloud でも変わったものは移さず「両方で変わった」と出す。Taylis で消した・ゴミ箱に入れたもの（とその中）はもう一度は入れない（表に出す）。Taylis で別のフォルダ・場所へ動かしたものはそこに版を足す | Taylis での変更・削除を移行が上書きしない |
| §15.3 名前 | 断られる名前は制御文字を空白・`/` を `_` にして使える名前にし、さらに重なれば「(1)」。データディレクトリの UTF-8 でない名前は U+FFFD にして出す。先のフォルダに Taylis で作った**同じ名前のフォルダ**があれば、その中に入れる（「(1)」にしない）。ファイルは常に「(1)」 | フォルダを分けると研究室ドライブに同じ名前のフォルダが 2 つ並ぶ。ファイルは上書きしない |
| §15.1 `--no-previews`（既定） | `--previews` / `--no-previews`（既定は付けない） | 既定を変えず、付けたいときだけ |
| §15.4 16 MiB ずつマルチパート | 1 部品（`DRIVE_PART_BYTES`）以下のファイルは 1 回の put、それより大きいものはマルチパート。部品は 8 MiB まではメモリ、それを超えると一時ファイル（アップロードの部品と同じ） | 数百の小さなファイルで呼び出しを 3 回から 1 回に |
| §15.4 止めても続きから | Ctrl-C（SIGINT）では途中のマルチパートを取りやめて終わる（終了コード 130）。SIGKILL・停電では途中のマルチパートが残り、drive の周期ジョブの孤児の掃除（§6.2）が 24 時間後に取りやめる | — |
| §6.4 media loop が SHA-256 を取る | 取り込みは流しながら SHA-256 を取り、画像・動画でない版は media loop を通さない | 100 GB を 2 回読まない |
| §16.2「`find -printf '%s:%T@ %p'` を前回の一覧と比べる」 | `find -print0` とまとめた `stat`（BusyBox の `find` に `-printf` が無い）で「大きさ・更新日時（秒）・inode」。inode も比べる | versitygw はオブジェクトを一時ファイル + rename で置き換えるので、同じ秒・同じ大きさの置き換えも inode で分かる |
| §16.2 SHA-256 の引き継ぎ | 前回のバックアップに無いファイル（壊れた・消した）はハードリンクにせず写し直す。`BACKUP_VERIFY=1` で全部を読み直して比べる | 引き継いだ値が実物と合わないままにならないように |
| §16.2 の段の置き場所 | `backup.sh` の中に POSIX sh の文字列として持ち、オブジェクトストアのコンテナで `sh -c` で動かす（`backup.sh --objects-step` で手元でも） | デプロイの鍵の強制コマンド（`deploy-ssh.sh`）は決まったファイルしか置かないので、別のスクリプトは今のサーバに届かない |
| §16.2 オブジェクトのディレクトリを直接ハードリンクにする案 | 採らない | 変わらない夜が数秒になり、置き場所の作りを変える理由が無くなった |
| §16.2 restic | 公式イメージを Docker で動かし（サーバに何も入れない）、決まったパス `/backup` につなぐ | パスが毎晩同じなので前のスナップショットが親になり、変わらないオブジェクトを読み直さない |
| §16.2「リハーサルはサーバの外で」 | `offsite-rehearsal.sh`（restic から）。今の `restore-rehearsal.sh`（同じサーバの中）は小さな構成のために残す | — |
| §15.1 `--list-shares` | 共有したものに加えて**共有されたもの**も出す | 共有されたフォルダは WebDAV の木に出るので、対応表に書くかどうかを決めるため（データディレクトリには無い。その人自身のファイルだけ） |
| — | 報告に「対応表が覆う Nextcloud のファイルの件数と合計」 | 移した後の比べ方：もう一度の `--dry-run` で、すべてが「変わらない」・新しいもの 0・失敗 0 なら、件数と大きさが合っている |
| — | NFD の名前：Nextcloud 31 は NFD の名前のファイルを「incompatible encoding」として WebDAV に出さない。データディレクトリの写しには残りうる（取り込みでは NFC） | WebDAV とデータディレクトリで件数が 1 つ違いうる（§24.3） |

### 24.3 確かめたこと

- pytest：`tests/test_nextcloud_import.py`（19 件：対応表のいちばん長い一致と skip と skip の中の map・走査の入る / 入らない・対応表の検査、
  データディレクトリの通し（`--dry-run` は何も書かない・場所ごと・対応の無いものの大きさ・SHA-256・更新日時・media loop の印・
  監査・`drive-usage --verify`）、2 回目で何も増えない・変わったファイルが版 2 になる・更新日時だけの変更・Nextcloud で消したものの表、名前の衝突
  （大文字小文字・Taylis の既存のファイル・既存のフォルダを使う・断られる名前）と 2 回目で名前が変わらないこと、無い先で何も書かずに止まる、
  容量（全体の上限で 2 件入り 3 件 `drive_quota_exceeded`）、`--limit-bytes` で止まって続く、途中で止めて（マルチパートの途中）続きから、
  Taylis で変えた・ゴミ箱に入れたものと持ち主、偽の WebDAV サーバ（Depth 1・ページ分け（Nextcloud 31 と同じく 2 ページ目からヘッダ無し）・
  NFD の href・`% & #?` の名前・401・404・URL の資格情報を断る）、OCS の共有の表、データディレクトリのシンボリックリンクと `.part`、
  `generate-previews --drive`（今の版だけ・ゴミ箱を除く・チャットの待ちを先に・待ちの上限））、`tests/test_backup_objects.py`（5 件：初回、
  変わらない夜はすべてハードリンクで SHA-256 を読まずに引き継ぐ、同じ秒・同じ大きさの置き換え（inode）・足した・消したファイルとフォルダ、
  M164 より前の一覧の無いバックアップ、前回から消えたファイルを写し直す、`BACKUP_VERIFY`、空のストア）。サーバの全体 1,676 件・ruff・
  ruff format・mypy。
- 手で（使い捨ての compose：PGroonga・versitygw v1.8.0・この版の app と、公式の `nextcloud:31-apache`（31.0.14、SQLite））：
  - Nextcloud に 300 ファイル・39 フォルダ（日本語の入れ子・全角の空白と括弧・半角カナ・7 段の深さ・空のフォルダ・大文字小文字だけ違う 2 つ・
    100 MiB のファイル・NFD の名前）と 2 人目の人・グループ・共有 4 つ（グループ・人・パスワードと期限つきの公開リンク・共有された
    フォルダ）を作り、`occ user:auth-tokens:add` のアプリパスワードで：`--list-shares` が 4 つを出す（トークンなし）。`--dry-run` が 214 ファイル・
    27 フォルダ・100.4 MiB、場所ごと、「Readme.txt → Readme (1).txt」、対応の無いもの 11、skip 1 を出す。実行は 4 秒、100 MiB のファイルの SHA-256 が
    Nextcloud のものと一致、更新日時が残る、共有されたフォルダの持ち主は `--user` のとおり、`drive-usage --verify` 0。もう一度で 214 件すべて
    「変わらない」・何も増えない。WebDAV の PUT（`X-OC-Mtime`）で変えた 1 件が版 2（`import`、更新日時も）、足した 1 件が新しく、消した 1 件が
    「無くなったもの」。データディレクトリの写しの `--dry-run` は WebDAV で入れたものを 211 件「変わらない」とし（違いは共有されたフォルダの 3 件と
    NFD の 1 件）、実行で NFD の名前が NFC で入った。
  - 中断：600 MB を流している途中の SIGINT で終了コード 130、3 件が入り、途中のマルチパートは取りやめ（`.sgwtmp` が空）。続けて SIGKILL で
    2 件が入り、途中のマルチパートが残る（孤児の掃除の対象）。もう一度で残り 3 件が入り、8 件の SHA-256 が一致、`verify-attachments` 0。
  - ページ分け：本物の Nextcloud 31 は Depth 1 でも `X-NC-Paginate` に答え、トークンと合計は 1 ページ目だけに付く（最初の実装は 2 ページ目で
    止まっていたのを、ここで見つけて直した）。1 ページ 5 件での走査が 1 ページでの走査と一致（358 件、PROPFIND 99 回）。
  - `generate-previews --drive`：本物の PDF のプレビューができ、PDF でない「.pdf」120 件は失敗として残る。
  - 速さ：WebDAV からの取り込みは約 220 MB/s（Mac の SSD の Docker の中、同じ機械の Nextcloud）。研究室のサーバでの値はリハーサルで測る。
- バックアップ（同じ compose）：`backup.sh` の 1 回目 385 オブジェクトを写す、2 回目はすべてハードリンク（全体 0.8 秒）、`counts.txt`。
  2 回目を `restore.sh` で新しい compose に戻して `verify-attachments` 0・件数一致・`drive-usage --verify` 0。オブジェクトの段だけを
  オブジェクトストアのイメージ（BusyBox）で 20,020 ファイル・2 GB に対して前の版と比べた：初回 12 秒 → 8 秒、変わらない夜 16 秒 → 1 秒、
  2 件足した夜 1 秒、`BACKUP_VERIFY=1` 7 秒。
- restic（手元のディレクトリのリポジトリ、`OFFSITE_INCLUDE_SECRETS=1`）：`init`、`backup`（1.278 GiB）、`backup.sh` の後の 2 回目は親の
  スナップショットを使い 387 ファイルを「変わらない」とし、足したのは 588 KiB、`maintain`（prune と 5% の読み戻し）、`check all`、`snapshots`、
  `offsite-rehearsal.sh`（スナップショットを戻して新しい compose へ、件数が `counts.txt` と一致、`drive-usage --verify` 0、restic の戻し 6 秒・
  `restore.sh` 13 秒、片付け）。
- **確かめていないこと**：SFTP の送り先（手元のディレクトリだけ）、研究室のサーバと本物の Nextcloud（100 GB）での速さと所要時間、
  Nextcloud のグループフォルダ・外部ストレージ（§19 Q1 で使っていないと聞いている。WebDAV には出るが、データディレクトリの写しには無い）。

## 25. 段階 D6 の実装（M165、2026-10-22）

会話との連携（§13）。サーバ（`drive/conversation.py`、`core/pages.py`）と Desktop / Web。移行は無い（表と列は D1 のまま足りた）。新しいエラーの
コードも無い（`attachment_too_large`・`attachment_not_found`・`drive_*` を使う）ので、エラーの表と iOS / Android は変わらない。

### 25.1 作ったもの

- **サーバ**：
  - `POST /drive/items/{id}/attach-copy` → 201 `AttachmentOut`：読めるファイルの今の版を、サーバの中で写した（`BlobStore.copy`。サムネイル・
    ポスターとできているプレビューも写す。版を戻すのと同じ `clone_object`）**自分の pending の添付**にする。名前は項目の今の名前。
    `ATTACHMENT_MAX_BYTES`（100 MB）を超えれば 413 `attachment_too_large`（`details.limit_bytes`）、フォルダ・ゴミ箱・読めない項目は
    404 `drive_item_not_found`。送り方は今までのアップロードと同じ（`attachment_ids`）。送られなければ今までどおり 24 時間で GC が消す。
    速度制限はアップロードと同じ `upload` の枠。
  - `POST /drive/save-attachment {attachment_id, folder_id, name?, on_conflict: "rename" | "fail", client_op_id?}` → 201 `ItemOut`：
    読める添付（`get_for_access`。メッセージ・キャンバス・ページの添付）を書けるフォルダに新しいファイルとして写す（版 1、`source = 'attachment'`）。
    先に容量（進行中のアップロードの予約込み）と、`fail` なら名前を見てから写し、1 トランザクションでフォルダをロックして書く権利・名前・
    深さ・フォルダの空き・容量をもう一度確かめて置く（コピー §10.3 と同じ順）。置けなければ写したオブジェクトを消す。同じ `client_op_id` は
    200 で同じファイル（`drive_items.client_op_id` に添付の id から作った値）。media loop が SHA-256 とサムネイル・ポスターを作り直す。
  - `GET /drive/items/{id}/reach?channel_id=` → `{readable, unreadable}`：その会話のメンバーのうちサインインできる人（bot と無効のアカウントを除く、
    ゲストは数える）で、項目の場所を今読める人と読めない人の数。場所の読める人（`access.readers`）との積で数える。
  - `GET /drive/items/{id}` に `location_kind`（カードが場所の名前を端末の言語にするため）。
  - `pages.py` の `/d/<id>`：`/m/`・`/c/`・`/p/` と同じ案内ページ（「Taylis のドライブのファイル」。id の形だけを確かめ、引かない）。Caddy では
    今の SPA の扱いで Web のアプリが開く（Caddyfile は変えていない）。
- **Desktop / Web**：
  - **カード**（`ui/DriveLinkCard.tsx`）：本文の `<このサーバ>/d/<id>`（文字のままでも `[名前](…)` でも）をカードにする。読める人には今の項目
    （サムネイルか 1 ページ目かアイコン・今の名前・「研究室ドライブ › 論文 · 4.6 MB」・フォルダは「フォルダ」）。押すと、写真・動画・プレビューの
    ある文書は今のビューア（`DriveViewer`）、フォルダとほかのファイルは「ドライブ」のそのフォルダ（ファイルは右の「ドライブで表示」でも）。
    読めない人（404。ゴミ箱の項目も同じ）には「表示できないファイル」と「このファイルを見る権限が無いか、ゴミ箱に移されたか削除されました。」
    だけで、名前・大きさ・場所は出さない（リンクの `[名前]` も描かない）。読み込みの失敗は「ファイルを読み込めませんでした」（押すともう一度）。
    `controller.driveLink` が 1 項目 1 分まで覚える。ほかのサーバの `/d/` は普通のリンク。自分のサーバの `/d/` にはリンクのプレビュー
    （案内ページの OGP）を出さない。ブラウザで `/d/<id>` を開くと、そのフォルダを「ドライブ」で開く（読めなければトースト）。
  - **入力欄の ＋ →「ドライブから」**（`ui/DriveConversation.tsx` の `DrivePickerDialog`）：読める場所の列（その会話のドライブがあれば最初に開く）、
    パンくず、フォルダとファイルの一覧、全部の場所のファイル名の検索。選ぶと `reach` を読んで、読めない人がいれば「このチャンネルの 1 人は
    このファイルを見られません。コピーとして送りますか？」（DM・グループ DM は「この会話の…」）と出し、「コピーを添付」を主のボタンにする。
    全員が読めれば「この会話のメンバーは全員このファイルを見られます。」。「リンクを入れる」は入力欄のカーソルの位置にリンクを入れる
    （リッチの欄でも）。「コピーを添付」は `attach-copy` の添付を入力欄の添付に足す（フォルダと 100 MB を超えるファイルは押せない。理由を
    ボタンの説明に）。
  - **下書きの注意**（`DriveLinkWarning`）：入力欄の文にこのサーバの `/d/` のリンクがあり（貼った・選んだ・「会話に送る」）、その会話に読めない人が
    いれば、文の上に「「修論_最終版.pdf」：このチャンネルの 1 人はこのファイルを見られません。」と「コピーとして送る」（リンクを文から外し、
    コピーを添付に足す）・「このまま」。リンクは最初の 3 つまで見る。送るのは止めない。
  - **「ドライブに保存」**（`SaveToDriveDialog`）：メッセージの ⋯（とスマホ幅の操作のシート）・ビューアの見出し・「ファイル」の一覧の行。
    メッセージからはその添付すべて（印で外せる）、1 つなら名前を変えられる。保存先は書ける場所のフォルダ（移動・コピーのダイアログと同じ
    `FolderPicker` に切り出した）。始めはその会話のドライブ（無ければ作る）、DM・書けなければマイドライブ（ゲストは書ける最初の場所）。
    添付ごとに `client_op_id` を 1 つ持つので、答えが失われた送り直しでも 1 つしかできない。保存すると「1 件を #共同研究 に保存しました」と「表示」。
  - **ドライブの行のメニュー**：「会話に送る」（会話を選ぶと、その会話の入力欄の文の最後にリンクを入れて開く。下書きの注意がそこで出る）と
    「リンクをコピー」。
  - 文言は日本語・英語・簡体字中国語。

### 25.2 本書と違うところ・足したもの

| 本書 | D6 の実装 | 理由 |
| --- | --- | --- |
| §5.6 `save-attachment` の `on_conflict` | `"rename"`（既定）か `"fail"` だけ。`"version"`（既存のファイルの新しい版にする）は受けない | 会話の添付を保存して既存のファイルを置き換えるのは思わぬ上書きになりうる。要れば足す |
| §13.2 読める添付 | `get_for_access` が読めないものは、非公開チャンネルのメンバーでない 403 も含めて 404 `attachment_not_found`。pending の自分のアップロードとドライブの版そのもの（`drive_item_id` のある添付）も 404 | 保存の経路で存在を明かさない。ドライブのファイルは `POST /drive/items/copy` で写す |
| §5.6 `reach` | 呼べるのはその会話のメンバー（でなければ 403 `not_a_member`）で、項目を読める人（でなければ 404）。数えるのはサインインできる人（bot・無効のアカウントは数えない） | 項目を読めない人が数を問い合わせて存在を知るのを防ぐ。bot は「見られない人」ではない |
| §13.1「送る前に…と出す」 | 送るときの確認のダイアログではなく、入力欄の上に出し続ける注意（「コピーとして送る」「このまま」）。ドライブから選んだときはダイアログの中でも出す | 貼った・ほかの画面から入れたリンクにも同じに効き、送るのを止めない（読めない人が出るのは知ったうえで送ってよい） |
| §13.1 カード「名前・大きさ・1 ページ目」 | 小さなサムネイル（画像・動画のポスター・文書の 1 ページ目）と名前・場所・大きさ | メッセージの中で大きなプレビューは場所を取る。押せばビューアで全部見られる |
| §5.2 `GET /drive/items/{id}` | `location_kind` を足した | カードの場所の名前（研究室ドライブ・マイドライブ）を端末の言語にする（検索の結果の `location_kind` と同じ） |
| §17.2 右クリックの「会話に送る」 | 会話の入力欄にリンクを入れて開く（その場で投稿はしない）。「リンクをコピー」も足した | 送る前に下書きの注意（読めない人）とコピーへの切り替えを見せる |
| §13.2 ビューアの「ドライブに保存」の既定 | ビューアからは会話が分からないので、マイドライブ（ゲストは書ける最初の場所）から始まる | — |
| §13.1 Caddy の `/d/` | Caddyfile は変えない（今の SPA の `handle` がそのまま Web のアプリを返す） | — |
| — | 公開リンクの本文の経路 `GET/HEAD /shares/{token}/items/{id}/content` の operation id を明示した | FastAPI はルートのメソッドの集合の最初の 1 つで名前を付け、その順はハッシュの種で変わる。`export-openapi` が `_get` と `_head` を行き来し、CI の「OpenAPI is up to date」が落ちることがあった（D4 からの不具合） |

### 25.3 スマホ

本書は `/d/` のカードをスマホの段階 D7 に置いている（§17.6・§18）ので、iOS / Android は変えていない。今のスマホのリンクの扱いは `/m/`・`/c/`・
`/p/`・`/e/` の接頭辞だけを見るので、`/d/` は普通のリンク（押すとブラウザで Web のアプリが開き、読める人にはそのフォルダ、読めない人には
トースト）。Web のスマホ幅は Desktop / Web と同じコードなので、カード・「ドライブから」・「ドライブに保存」（操作のシート）がそのまま出る。

### 25.4 確かめたこと

- pytest：`tests/test_drive_d6.py`（7 件：コピーの添付が pending で自分のもの・送るとゲストが読める・後の版で変わらない、ゲスト・大きすぎる・
  フォルダ・ゴミ箱のコピーを断る、保存（版 1 の `attachment`・中身・同じ `client_op_id` で 200 と容量は 1 回・名前の「(1)」・`fail` の 409・
  自分の名前・不正な名前・元のメッセージを消しても残る）、読めない添付（非公開チャンネルの外の人・pending・ドライブの版）は 404、書けない先
  （ゲストと研究室ドライブ・投稿がオーナーだけ・アーカイブ・ファイル）、全体の容量の超過で何も残らない、`reach`（研究室ドライブ・その
  チャンネル・別のチャンネル・マイドライブ・別の会話から、bot と無効の人を数えない、メンバーでない 403・読めない 404）、`location_kind`）、
  `tests/test_pages.py` に `/d/` の案内ページ。サーバの全体・ruff・ruff format・mypy。
- vitest：`tests/driveConversation.test.tsx`（15 件：リンクの認識・下書きの中のリンク・入口の URL・リンクを外す、`driveLink` の 404 とゴミ箱が
  同じ「読めない」・1 回だけ問う・5xx は失敗、カード（読める：名前・場所・大きさ・開く・ドライブで表示、読めない：「表示できないファイル」で名前が
  どこにも出ない、ほかのサーバ、フォルダとチャンネルの場所）、注意の文（チャンネル・DM・0 人）、下書きの注意（「コピーとして送る」・「このまま」・
  全員が読めるときは出ない）、「ドライブから」（その会話のドライブから開く・注意・リンクを入れる・コピーを添付・フォルダはコピー不可）、
  「ドライブに保存」（その会話のドライブ・`client_op_id`・名前・トースト、断られたときの表示、既定の場所、メッセージの操作））。Desktop の tsc と
  vitest の全体。
- 手で（使い捨ての compose：PGroonga・versitygw v1.8.0・この版の app、Vite 1422、ヘッドレスの Chrome を CDP で操作）：ゲストのいる非公開
  チャンネルに研究室ドライブの PDF のリンクを貼ると入力欄の上に「このチャンネルの 1 人はこのファイルを見られません。」、送るとカード
  （「研究室ドライブ › 論文 · 4 KB」）、「ドライブで表示」でそのフォルダ。「ドライブから」で研究室ドライブのファイルを選ぶとダイアログの中に
  同じ注意と「コピーを添付」が主のボタン、コピーを添付して送るとふつうの添付。三井さんの添付を ⋯ →「ドライブに保存」でチャンネルのドライブへ
  （トーストと「表示」、チャンネルのドライブに入っている）。ドライブの行のメニューの「会話に送る」「リンクをコピー」。ゲストでログインすると
  リンクのカードは「表示できないファイル」（名前なし）、コピーの添付はふつうに見える。サーバの `/d/<id>` は案内ページ。
- **確かめていないこと**：Tauri のアプリでの実機の動き（Web と同じコード）、iOS / Android（変えていない）。

## 26. 段階 D7 の実装（M166、2026-10-22）

スマホ（iOS / iPadOS・Android）の読むだけのドライブ（§17.6）。サーバの変更は無い（D1〜D6 の API で足りた）。`apps/shared/nav-items.json` の
`drive` を両方の形（`desktop`・`mobile`）にし、スマホの既定の並びで「ファイル」の次に置いた（`cases` は規則のとおり計算し直し、スマホの既定と
ドライブより前に保存した並びの 2 件を足した）。

### 26.1 作ったもの

- **置き場所**：ホームのタイル「ドライブ」（「ファイル」の次。iPad のサイドバー・Android タブレットのホームの一覧も同じ）。タイルは
  サーバがドライブを持つとき（`GET /drive/locations` が 200）だけ出し、「ホームのタイル」の設定にも出る。公開・非公開チャンネルの
  会話のタブに「ドライブ」（「タスク」の次。DM には出さない）。
- **場所の一覧**：研究室ドライブ・マイドライブ・自分のチャンネルのドライブ（`GET /drive/locations`）。名前は種類で端末の言語に。マイドライブは
  開くときに `resolve {kind: "me"}`（ゲストには出さない）。各行に使用量（上限があれば併記）。
- **フォルダ**：パンくず（押すとそのフォルダへ）、並べ替え（名前・更新日時・大きさ、昇順・降順）、下へ引いて読み直し、100 件ずつの
  カーソル（下まで見えたら続き）、その場所の中のファイル名の検索（`/search/drive?location_id=`、場所の一覧からは全部の場所）、詳細
  （大きさ・種類・更新日時・作った人・更新した人・版の数・場所）。フォルダは画面のスタックに 1 つずつ積む（iOS は戻る、Android は
  システムの戻るとバーの ← で 1 つ上へ）。会話のタブとリンクのシートの中は、その場でフォルダを替える（‹ で 1 つ上へ）。
- **プレビュー**：今のビューアをそのまま使う。写真は写真のビューア（同じフォルダの写真を左右に）、動画はダウンロードのチケットの URL を
  そのまま再生（Range でシーク。端末に保存しない）、PDF と Office は `/attachments/{id}/preview/pdf`（プレビューが `ready` のとき。
  `pending` なら詳細）。ほかのファイルは詳細。
- **ダウンロード・共有**：1 つのファイルは D2 のチケット（§21.2）、フォルダは ZIP のチケット（§22）の URL を、本文をメモリに持たずに
  ファイルへ流す（iOS は URLSession のダウンロードタスク、Android は 64 KiB ずつ）。進み具合と取りやめ。iOS は終われば共有シート
  （ほかのアプリで開く・AirDrop・「“ファイル”に保存」）か「“ファイル”に保存」（`UIDocumentPickerViewController` の書き出し）、
  Android は共有（`ACTION_SEND`、今の FileProvider）か「ダウンロードに保存」（API 29 以上は MediaStore の Downloads へ直接流す）。
  キャッシュに置いた写しは、iOS はシートを閉じると消し、Android は次のダウンロードで置き換える。
- **`/d/` のリンク**（§13.1・§25）：このサーバの `/d/<id>` は、本文の中では今の名前（「📎 名前」「📁 名前」）か「表示できないファイル」、
  読み込むまでは「ドライブのファイル」と読む（**送った人が書いた `[名前]` は出さない**）。本文の下に 1 メッセージ 3 つまでカード
  （小さなサムネイルか種類のアイコン・名前・「研究室ドライブ › 論文 · 4.6 MB」、読めなければ「表示できないファイル」と説明だけ）。
  押すと、ビューアのあるファイルはビューア、フォルダはそのフォルダ、ほかは詳細。`/d/` のリンクには普通のリンクのプレビューを出さない。
  1 項目 1 分まで答えを覚える。
- **同期**：`drive.changed`（場所ごとに古い `seq` を捨てる）で開いているフォルダを 300 ms まとめて読み直し、`drive.location.updated`・
  再接続・自分のチャンネルの参加と退出・ロールの変化で場所の一覧を読み直す。開いているフォルダが 404 になれば場所の根へ、根も読めなければ
  場所の一覧へ。
- 文言は日本語・英語・簡体字中国語（iOS は `Localizable.xcstrings`、Android は `strings_drive.xml`）。

### 26.2 本書と違うところ・決めたこと

| 本書 | D7 の実装 | 理由 |
| --- | --- | --- |
| §17.6「ダウンロード・ほかのアプリで開く・共有」 | フォルダの ZIP のダウンロードも足した（共有・保存はファイルと同じ） | 同じ流す経路で済み、フォルダごと渡したいことがある |
| §17.1「チャンネルを選ぶ」 | スマホには作らない。場所の一覧は `GET /drive/locations` のチャンネルだけで、まだドライブの無いチャンネルは会話の「ドライブ」タブが作る | 選ぶ画面を増やさない |
| §13.1 リンクは「カードにする」 | 本文の中は短い文字（今の名前か「表示できないファイル」）のまま残し、カードは本文の下（リンクのプレビューの位置）に出す | スマホの本文は文字の並びで、途中に部品を入れられない |
| §17.2 リスト / グリッド・前後のファイルへの移動 | リストだけ。写真の左右だけ（iOS）。Android はビューアの間の移動なし | 読むだけの最初の形 |
| §17.2 並べ替え | iOS は端末に覚える、Android はその画面の間だけ | — |
| §25 カードの「読めない」は 404 | iOS は `GET /drive/items/{id}` がゴミ箱の項目を返したとき（`trashed_at` つき、§20.2）も「表示できないファイル」にする | ゴミ箱の中身は戻すまで見せない（Desktop / Web の D6 と同じ扱い） |
| 写真の元の画像 | iOS はダウンロードのチケットから版ごとにキャッシュへ、Android は `/attachments/{id}/content`（`get_for_access` がドライブの版を通す） | どちらもサーバの権限の確かめは同じ |
| Web の `/d/` を開く | アプリの外から `/d/` を開く（Universal Links / App Links）は無い | `/m/` もまだ無い |

### 26.3 確かめたこと

- iOS：`xcodebuild build`、XCTest の `DriveTests.swift`（25 件：リンクの認識と 3 つまで・本文の文字が `[名前]` を出さないこと、場所の名前・パス・
  カードの行・日付・大きさ・ビューアの選び方・サムネイル、ハブ（サーバの有無・`seq` の順と重複・カードの 1 分・404 とゴミ箱は読めない・
  失敗で前の答えを残す・フォルダの変化で聞き直す）、フォルダのページ・並べ替え・404・まとめた読み直し、タイルとタブの置き場所、スタックの
  フォルダへ戻る、スタブの上でファイルへ流すこととエラーの答え、API のパス）と `NavItemsFixtureTests`・`LocalizationTests`、iOS の全体（1,400 件）。
- Android：`:app:compileDebugKotlin`、`:app:testDebugUnitTest`（全体 1,417 件、`DriveTest.kt` 16 件）、`:app:lintDebug`（新しいコードに警告なし）。
- Desktop：nav-items の変更で tsc と vitest の全体（3,240 件）。
- 手で（使い捨ての compose：PGroonga・versitygw v1.8.0・converter・この版の app、デモ研究室と、PDF・docx・写真・動画・300 MiB のファイル・
  日本語の入れ子のフォルダ・150 件のフォルダを入れたドライブ）：iOS シミュレータ（iPhone 17 Pro・iPad Pro 13" の iOS 26.5、リポジトリの外の
  XCUITest）と Android エミュレータ（ChikuwaChat_Pixel_9）で、タイル → 場所 → 入れ子のフォルダとパンくず、PDF と Office のプレビュー、写真と動画、
  150 件のページ、並べ替え、検索、300 MiB のファイルのダウンロードと共有・保存（iOS はキャッシュに書いたファイル、Android は Downloads のファイルの SHA-256 が元と一致。Android のヒープは 39 MB のまま）、
  フォルダの ZIP（Android）、メッセージの `/d/` のカード（読める PDF・フォルダ・動画と、読めない項目の「表示できないファイル」）、
  チャンネルの「ドライブ」タブ、API で足したフォルダが開いている一覧に出ること（Android）。
  iPad は分割の右にドライブの一覧とフォルダが出ることまで。
- **確かめていないこと**：実機、Android 8〜9 の保存（システムの保存ダイアログ）、Android タブレット、iPad の分割の中のビューア、iOS のフォルダの ZIP と
  「“ファイル”に保存」の保存先を選んだ後（ピッカーが開くことまで）。

## 27. 使ってみての手直し（2026-10-22）

Nextcloud から 2,500 件を入れて使ってみた後の 4 点（とせまい窓の一覧）。

### 27.1 クリックで開く

- フォルダの行・タイルは **1 回のクリックで開く**（前はダブルクリック）。ファイルも 1 回のクリックで、ビューアのあるもの（写真・動画・
  PDF・Office）はビューア、ほかは詳細のペイン（「ダウンロード」はそこと右クリックにある）を開く。クリックだけでダウンロードには
  ならない。Enter も同じ、Space はビューアのあるものだけ。
- 選ぶのは ⌘ / Ctrl + クリック・Shift + クリック・↑↓・⌘A と、行の左（タイルの左上）の**チェックボックス**（何か選んでいる間・
  マウスを乗せた時・フォーカスの時・タッチの端末では常に見える）。ダブルクリックの 2 回目は何もしない（フォルダを開いた後の 2 回目が
  開いたフォルダの行に当たらないように、`MouseEvent.detail > 1` を捨てる）。規則は `drive/listing.ts` の `clickAction`。
- 行とタイルは `cursor: pointer`、マウスを乗せると薄い地の色（タイルは枠も少し濃く）。左の色の帯は使わない。

### 27.2 戻る・進むがフォルダにも効く

- 「ドライブ」の今の場所（場所・フォルダ・ゴミ箱）を MainScreen が持ち（`drivePlace`、`DriveView` の `place` / `onPlace`）、
  場所の履歴（`placeHistory.ts`、M67）の 1 つの場所にした：`drive:<場所>:<フォルダ>[:trash]`。フォルダを移る・場所を変える・ゴミ箱を
  開くたびに 1 件。← →・⌘[ ⌘]（Windows は Alt + ← →）・マウスの戻る / 進むボタン・Web のブラウザの戻る / 進むで行き来する。
- 「ドライブ」を開いた直後（まだフォルダを選んでいない）の場所は、最初に着いたフォルダで置き換える（開いたことと最初のフォルダを
  2 回の戻るにしない）。
- 戻ったフォルダは前のスクロールの位置に戻る（M75 の `useViewScrollMemory`。一覧に `data-scroll-memory`、行に `data-row-key`）。
  新しく開いたフォルダは上から。
- チャンネルの「ドライブ」のタブの中のフォルダは履歴に入れない（会話のタブは場所ではない、M67 の決まりのまま）。

### 27.3 PDF を開くとダウンロードになることがあった

- **原因**：ビューアで開くのはプレビューが `ready` か `pending` のものだけで、ほかはダウンロードしていた（§17.2「ほかはダウンロード」）。
  Nextcloud の取り込みはプレビューを作らずに入れる（§24、`generate-previews --drive` を後で回す）ので、取り込んだ PDF・Office は
  プレビューが無く（`preview: null`）、開くとダウンロードになった。アップロードした PDF でもプレビューが `failed`（PDFium が 1 ページ目を
  描けない）・上限（50 MB）超えなら同じ。ヘッダの前に余分なバイトのある PDF は `filetype` が `application/octet-stream` とし、
  プレビューの対象にもならなかった。取り込みの MIME の判定そのものはアップロードと同じ（`uploads.sniffed_type`）で、間違いではない。
- **直したこと**：
  - PDF は**いつも PDF のビューア**で開く。プレビューができていればそれを、無ければ（作っていない・作っている途中・失敗・大きすぎ）
    ファイルそのもの（`/drive/items/{id}/content` をトークンつきで読む）を PDF.js で描く。読めない PDF はビューアの中で
    「プレビューを読み込めませんでした」と「再試行」「ダウンロード」。
  - Office はビューアを開き、プレビューが無ければサーバに作らせ（下）、「プレビューを作成中…」。できれば `drive.changed`（プレビューの
    ループの合図）か 4 秒ごとの読み直しで分かり、そのままページに替わる。作れない（converter が無い・大きすぎ）・失敗したものは
    「このファイルはプレビューできません」「プレビューを作れませんでした」と「ダウンロード」のボタン。
  - サーバに **`POST /drive/items/{id}/preview`** → `{preview: AttachmentPreviewOut | null}` を足した。読める人なら誰でも。今のバージョンの
    添付が `none` でプレビューの対象なら `pending` にしてループを起こす。`ready` / `pending` / `failed` はそのまま答える（`failed` を
    やり直さない。押し続けても何度も作らない）。`null` はこのファイルにはプレビューが無いこと。
  - `preview_kinds.source_kind`：`application/octet-stream` で名前が `.pdf` なら PDF として扱う（PDFium が PDF かどうかを決め、
    違えば `failed`）。端末も `isPdf`（型か、型の分からない `.pdf`）でアイコンとビューアを決める。
  - ダウンロードになるのは「ダウンロード」のボタン・メニューだけ。
- **本番のデータの手直し**：要らない。取り込んだファイルは開いた時にプレビューを作る。前もってサムネイルを揃えたければ、今ある
  `app.cli generate-previews --drive --limit 200`（何度回してもよい。`none` のものだけを作る）を夜に回す。名前が `.pdf` で
  `application/octet-stream` の行も、今回の変更でこの対象に入る。

### 27.4 せまい窓の一覧

- 名前の列が他の列に重なっていた（`table-fixed` で固定幅の列の合計が一覧の幅を超えると、名前の列が 0 になり、はみ出した名前が
  隣に描かれた。列を隠す目安が窓の幅（`max-md` / `max-lg`）で、レール・サイドバー・場所の列を引いた一覧の幅ではなかった）。
- 一覧そのものの幅（ResizeObserver）で列を決める（`driveColumns`）：700 px 未満で「更新した人」、520 px 未満で「大きさ」、420 px 未満で
  「更新日時」を隠す。詳細のペインが横にあればその 288 px を引いて考える。名前のセルは `overflow: hidden`、名前は拡張子を残して
  「…」で切り（`FileName`）、全体は `title`。
- 詳細のペインは一覧が 640 px 未満なら一覧の右に重ねて出す（横に並べると名前が読めなくなる）。グリッドのタイルは最小 148 px か
  一覧の幅、スマホ幅は 2 列。
- 確かめた幅：1280（更新日時・更新した人・大きさ）、1000（更新日時）、800（名前だけ）、600 とスマホ幅 390（Web のスマホの画面）。

### 27.5 確かめたこと

- pytest：`test_nextcloud_import.py::test_opening_an_imported_file_asks_for_its_preview`（取り込んだ PDF・ヘッダの前に余分なバイトの
  ある PDF・テキスト：`preview: null` → `pending`（2 回目も 1 回だけ）、テキストは `null`、フォルダは 404、ループで両方 `ready`、
  `/preview/pdf` が inline の PDF、`failed` は頼んでも戻らない）、`test_previews.py`（`source_kind`）。サーバの ruff・mypy。
- vitest：`driveListing.test.ts`（`viewerKind`・`documentSource`・`isPdf` / `isOffice`・`clickAction`・`driveColumns`）、
  `driveBrowser.test.tsx`（1 回のクリックでフォルダ、ダブルクリックの 2 回目、取り込んだ PDF がファイルそのものからビューアに出て
  ダウンロードしない、Office が作成中 → `drive.changed` でページ、プレビューの無い Office、詳細・⌘ クリック・チェックボックス、
  列の隠れ方とポインタ）、`placeHistory.test.ts`（フォルダと場所の場所の鍵、最初のフォルダの置き換え）、`historyNavigation.test.tsx`
  （本物の MainScreen でフォルダ 2 つと場所を移り、← で 1 つずつ戻って会話まで、→ と ⌘] で進む）。全体。
- 手で（使い捨ての compose：このバージョンの app・PGroonga・versitygw・Gotenberg、Vite 1422、ヘッドレスの Chrome を CDP で操作。
  `import-nextcloud --data-dir` で PDF 3（1 つはヘッダの前に余分なバイト）・docx・xlsx・pptx・写真・長い名前のテキスト 60 件を入れた）：
  1 回のクリックでフォルダへ、本物のダブルクリックで 1 段だけ、PDF 2 つ・docx・xlsx・pptx がすべてビューアで開きダウンロードは 0 件、
  converter を止めて docx が「プレビューを作成中…」、converter を戻すと開いたままページに替わる、⌘[ ⌘] と ← ボタン・ブラウザの
  戻る / 進むでフォルダと場所を行き来、マウスを乗せると `cursor: pointer` と薄い地の色、1280 / 1000 / 800 / 600 / 390 px で名前が
  他の列に重ならない（「…」で切れる）こと、詳細のペイン（重ねて出す）とグリッド。
- **確かめていないこと**：Tauri のアプリでのマウスの戻る / 進むボタン（Web のブラウザのボタンは確かめた）、とても大きな PDF
  （数百 MB）をファイルそのものから開いた時のメモリ。
