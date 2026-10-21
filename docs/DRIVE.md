# DRIVE（ドライブ：研究室の Nextcloud の置き換え）

2026-10-21 の設計。**段階 D1（M160、サーバの土台）を実装（2026-10-21、§20）**、D2〜D7 は未実装。マイルストーンは M160〜M166（段階 D1〜D7、§18）。

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
| アクセスログ（`core/logging.py` の `_SECRET_PATH`） | 共有リンクのトークンが URL のパスに入る | `/s/` と `/api/v1/shares/` を伏せる対象に足す。ホストの nginx のアクセスログにも残るので、`/s/` と `/api/v1/shares/` の `access_log` を伏せる設定例を `nginx-site.conf.example` に足す（§9.5） |
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
| POST | `/drive/items/copy` | `{item_ids, target_folder_id, on_conflict, client_op_id}` → 202 `{job_id}` か 200 `{results}`（§10.3） |
| POST | `/drive/items/trash` | `{item_ids}` → `{results}`。部分木ごと |
| GET | `/drive/locations/{id}/trash?cursor=` | ゴミ箱のまとまりの根の一覧（入れた人・時刻・中の件数と大きさ） |
| POST | `/drive/items/{id}/restore` | `{on_conflict: "rename" \| "fail"}` → `ItemOut`。元の親がゴミ箱か無ければ場所の根に戻す |
| DELETE | `/drive/items/{id}` | 完全削除（ゴミ箱の中のものだけ、409 `drive_not_in_trash`）。§3.2 の人だけ |
| GET | `/drive/items/{id}/versions` | `{versions: [VersionOut]}`（新しい順） |
| POST | `/drive/items/{id}/versions/{version_id}/restore` | その版を新しい今の版として写す（§10.2）→ `ItemOut` |
| DELETE | `/drive/items/{id}/versions/{version_id}` | 古い版を消す（今の版は 409 `drive_version_current`） |
| GET | `/drive/items/{id}/content?version_id=` | ダウンロード（Range、§7.1） |
| POST | `/drive/zip` | `{item_ids: [..]}` → `{url, expires_in, entries, size_bytes}`（§7.2）。`GET /drive/zip/{ticket}` が ZIP を流す |

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
- 形：**圧縮しない ZIP（stored）+ ZIP64**。標準の `zipfile` をスレッドで回し、書いたそばから応答に流す（一時ファイルを作らない）。
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
- Web：`<a href download>`（cookie で認証されるので 1 つのファイルもそのまま、ZIP はチケットの URL）。ブラウザのダウンロードが
  大きなファイルを流し、途中で切れれば（Range があるので）ブラウザの「再開」が効く。

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

- リンクのカードは `GET /drive/items/{id}` を読んで描く（404 なら「表示できないファイル」）。ドキュメントの `/p/<id>` と同じ扱いで、
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
  | `drive.location.updated` | 同上 | `{location: DriveLocationOut}`（外部リンクの可否・上限の変更） | 場所の一覧の行を置き換える |
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
  64 文字。`source_id` の幅 64 に収める）、`target_id` = `drive_items.id`。
- もう一度実行すると、既にある項目は大きさと更新日時が同じなら飛ばし、違えば新しい版として足す（Nextcloud を使い続けながら、
  切り替えの日に差分だけ流せる）。Nextcloud で消したファイルは消さない（表に出す）。
- バイト列は WebDAV から読みながら（またはファイルから）16 MiB ずつ S3 のマルチパートへ流す（一時ファイルを作らない。§6 と同じ
  `BlobStore` の関数、同じ版の作成の関数）。ファイルごとにコミットするので、止めても続きから。
- 速さの目安：研究室のサーバの中で 100 GB を流すと、ディスクと versitygw の書き込みで数時間（D5 で実測して infra/README.md に書く）。
  夜に `--limit-bytes` で分けて流せる。WebDAV が学外の機械なら回線の速さで決まる。
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

- サーバの中の世代（ハードリンクの増分）は「消した・壊したファイルを昨日に戻す」ためで、ディスクの故障・サーバの喪失には効かない。
  ドライブで研究室のファイルの正本をここに置く以上、**サーバの外の 1 組が無ければ Nextcloud を止めない**ことを切り替えの条件にする（§18 D5）。
- オブジェクトのディレクトリのハードリンクを同じファイルシステムの中で直接作る（写さない）案は、versitygw がオブジェクトを書き換えず
  置き換える（一時ファイル + rename）なら領域をほとんど使わない。ただし Docker のボリュームとバックアップの置き場所が別のマウントだと
  ハードリンクは作れない（EXDEV）ので、置き場所の作りを変える必要がある。D5 で確かめてから決める（採らなくても上の対応で足りる）。

## 17. 画面（Desktop / Web）

### 17.1 置き場所

- 場所のレール（MOBILE_UI.md §18）に「ドライブ」（`apps/shared/nav-items.json` に `drive`、Desktop / Web だけ。スマホは D7 で）。
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
- 右のペイン（任意で開く）：詳細（大きさ・型・更新日時・上げた人・パス・版・リンク）。
- カーソルで 100 件ずつ読み、下までスクロールしたら続きを読む。

### 17.3 アップロードの欄

- OS からのドラッグ＆ドロップ（一覧全体・フォルダの行・パンくず。今の `FileDropZone` の作り。フォルダは
  `DataTransferItem.webkitGetAsEntry()` でたどる）と、「アップロード」のファイルの選択・フォルダの選択（`<input webkitdirectory>`）。
  **Tauri の macOS（WKWebView）と Windows（WebView2）でフォルダのドロップと `webkitdirectory` が動くかを D2 の最初に確かめる**
  （動かなければ dialog プラグインのフォルダの選択から読む）。
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
| **D2** Desktop / Web の画面 | M161 | 場所のレールの「ドライブ」、場所の列、一覧（リスト / グリッド、パンくず、並べ替え、カーソル）、アップロードの欄（ファイル・フォルダ・ドロップ・再開・衝突の質問）、ダウンロード（Desktop は塊ごとに保存、Web はブラウザ）、ビューア、名前・移動・ゴミ箱、ファイル名の検索（`/search/drive` を含む）、チャンネルのタブ | tsc・テスト（アップロードの状態機械、衝突の質問、パンくず）。macOS と Windows のアプリと Web で、フォルダのドロップ・2 GB のファイルの再開・ZIP でない 1 ファイルの 2 GB のダウンロードを手で確かめる |
| **D3** 版・コピー・ZIP・容量 | M162 | 版（上書き・一覧・戻す・消す・整理のジョブ）、コピー（上限つき）、ZIP（§7.2）、場所と全体の上限、管理者の使用量の画面、`drive-usage --verify / --rebuild` | pytest：版の数と日数の整理、ZIP の中身（名前・UTF-8・ZIP64・空のフォルダ・Content-Length が実際の長さと一致）、容量の超過と減らす操作。5,000 ファイル・10 GB のフォルダの ZIP をブラウザで落として展開できる（Windows のエクスプローラーと macOS で） |
| **D4** 外部共有リンク | M163 | リンクの表と API、公開 API・`share.html`・解錠の cookie、働く条件（§9.2）、速度制限、`drive_share_events` と 180 日の整理、監査、ワークスペースと場所のスイッチ、admin の一覧、Caddy / nginx / ログの伏せ、robots.txt、プライバシーの説明 | pytest：部分木の外の id（兄弟・親・別の場所・ゴミ箱・古い版）がすべて 404、作った人が抜けた・ゲストになった・無効化で止まる、回数の同時の数え方、パスワードの失敗の制限、ヘッダ（noindex・nosniff・sandbox・attachment）。ログインしていないブラウザ（Chrome・Safari・Firefox、スマホ）で、フォルダの一覧・PDF のプレビュー・ZIP を確かめる。SECURITY.md に「外部共有リンク」の節を足し、§12 のようなレビューの一覧で見直す |
| **D5** Nextcloud の移行とバックアップ | M164 | `import-nextcloud`（WebDAV・データディレクトリ・対応表・`--list-shares`・`--dry-run`・再実行の差分）、`generate-previews --drive`、backup.sh の SHA-256 の引き継ぎと比較の作り直し、restic でのサーバの外へのバックアップの手順、リハーサルの手順、infra/README.md | pytest：対応表の解決（いちばん長い一致・skip・無い先）、再実行で増えない・変わったファイルが版になる、名前の衝突の表。本番の Nextcloud から `--dry-run` の表を利用者と見て対応表を決める。**サーバの外のバックアップが 1 回取れて、そこから別の機械に戻せることを確かめてから**、本番に移す。移した後に件数と合計の大きさが Nextcloud と合う |
| **D6** 会話との連携 | M165 | `/d/<id>` のパーマリンクとカード（Desktop / Web）、入力欄の「ドライブから」（リンク / コピー）、`reach` の注意、「ドライブに保存」、`pages.py` の案内ページ | pytest：コピーの添付の権限、保存の権限（読めない添付・書けない先）、`reach` の数。Desktop / Web で、ゲストのいるチャンネルに研究室ドライブのリンクを貼ると注意が出て、ゲストには「表示できないファイル」と出る |
| **D7** スマホ（読むだけ） | M166 | iOS / Android：ドライブのタイル、一覧・検索・プレビュー・ダウンロード・共有、`/d/` のカード | xcodebuild・Gradle のビルドとテスト。実機で PDF・Office のプレビューと大きなファイルのダウンロード |

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

サーバだけ（画面は D2）。移行 0118、`app/modules/drive/`（`models`・`names`・`access`・`repository`・`service`・`uploads`・`media`・
`housekeeping`・`events`・`router`）、`BlobStore` のマルチパート・範囲の読み出し・`head`、添付の `/content` の Range、
`get_for_access` の注入、`drive.changed` / `drive.upload.updated`、`drive.admin`、Caddy の部品の枠（17 MB）、エラーの文言 22 件
（`apps/shared/errors.json` と 3 つの端末の表）。versitygw の実測は §6.6。

### 20.1 作ったもの

- 場所：`GET /drive/locations`、`POST /drive/locations/resolve`（チャンネル・`me`、冪等）。研究室ドライブは移行が作り、無ければ最初の
  読み出しで作り直す。名前は研究室ドライブ「研究室ドライブ」・マイドライブ「マイドライブ」・チャンネルはチャンネル名（端末は `kind` で
  自分の言語の名前にしてよい）。`can_share` と `link_count` は D4 まで常に false / 0。
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
