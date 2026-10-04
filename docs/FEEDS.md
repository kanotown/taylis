# チャンネルのフィード (RSS / Atom、M97)

研究室では各自が週報のサイト (ブログ) を持っている。「#週報」のようなチャンネルに各自が自分のサイトのフィード (RSS 2.0 か
Atom。RSS 1.0 (RDF) も読む) を登録すると、新しい記事をボットが定期的にチャンネルへ投稿する。研究室以外でも使える汎用の機能
(チームのブログ、リリースノート、論文の新着など) として作る。

**状態**: M97 (サーバと Desktop / Web) は実装済み (2026-10-04、移行 0076)。iOS / Android は画面を足さない (ボットの投稿を
ふつうのメッセージとして見るだけ。§5)。

定期投稿と提出の回収 (RECURRING.md、`recurring` / `collections`) とはつながない。記事はチャンネルに投稿されるだけで、提出済みには
数えない。

## 1. 方針

- **フィードはチャンネルに付き、登録した人のもの**。チャンネルのメンバー (ゲストを除く) なら誰でも追加できる。止める・再開・
  削除は、追加した本人・チャンネルのオーナー・管理者。
- **投稿するのはチャンネルのフィードのボット**。受信 Webhook (M13a) や定期投稿と同じ `role = bot` のユーザーで、チャンネルの
  メンバーになり、ふつうのメッセージの経路 (seq・outbox・WS・プッシュの規則・検索) で投稿する。ボットは **チャンネルに 1 つ**
  で、そのチャンネルのフィードが共有する。名前は「RSS」(フィードの題名は人によって違うので、ボットの名前ではなく本文で誰の
  記事かを示す)。BOT の印は 3 端末が既に出す。
- **本文**は次の形 (本文から @メンションを取らない。`mentions=False`。題名・抜粋・名前の `<@` `<!` は全角の `＜` にする、
  ワークフローの打った値と同じ):

  ```text
  📝 {追加した人の表示名} の新しい記事: {題名}
  {記事の URL}
  > {要約の先頭 200 文字 (HTML を除き、空白を詰める)}
  ```

  題名は 200 文字まで。要約が無い・題名と同じなら引用の行は出さない。記事の URL は http(s) だけ (`javascript:` などは捨てる)。
- **追加の時点の記事は投稿しない**。追加のときに 1 回だけ取りに行き、フィードとして読めることを確かめ、そのとき載っている記事を
  すべて「見た」として記録する。

## 2. データ

`channel_feeds` (DATA_MODEL.md)

| 列 | 意味 |
|---|---|
| id, channel_id, owner_id, bot_user_id | owner は追加した人。bot はチャンネルのフィードのボット |
| url (≤ 2048) | チャンネルの中で一意 (`channel_feeds_channel_url_uniq`) |
| title, site_url | フィードの題名とサイト (取るたびに更新) |
| enabled | 止めた (false) ものは取りに行かない |
| needs_baseline | 次の取得は「見た」の記録だけで投稿しない (再開のとき、アーカイブ・登録者不在で取得を飛ばしたあと) |
| etag, last_modified | 条件付き GET 用 (`If-None-Match` / `If-Modified-Since`) |
| seen_keys (varchar(32)[]) | 見た記事の印 (§4)。今のフィードに載っているものを先頭に、最大 500 |
| next_fetch_at, last_fetched_at, last_success_at | 予定と結果 |
| last_error_code, last_error, consecutive_failures, failure_notified_at | 失敗の記録 (§4) |
| post_count, last_post_at | 投稿した数 |

フィードの削除は行ごと消す (投稿は残る)。

## 3. API (`/api/v1`)

- `GET /channels/{id}/feeds` — チャンネルを読める人なら誰でも (公開チャンネルならメンバーでなくても、ゲストを除く)。古い順。
  応答 `FeedOut` は `id, channel_id, owner_id, bot_user_id, url, title, site_url, enabled, owner_active, can_manage,
  last_fetched_at, last_success_at, last_error_code, last_error, consecutive_failures, post_count, last_post_at, created_at,
  updated_at`。`owner_active` は追加した人が有効でチャンネルのメンバーか、`can_manage` は呼んだ人が止める・削除できるか。
- `POST /channels/{id}/feeds {url}` (201) — チャンネルのメンバー (ゲスト不可 `403 guest_restricted`、メンバーでなければ
  `403 not_a_member`)。DM は `400 feed_channel_unsupported`、アーカイブ中は `409 channel_archived`。URL の形 (http(s)・認証情報
  なし・`localhost` / `*.local`・非公開の IP リテラル) が駄目なら `400 url_not_allowed`。同じ URL が既にあれば `409 feed_exists`。
  チャンネルに 20 件 (`409 too_many_channel_feeds`)、1 人 20 件 (全チャンネル、`409 too_many_feeds`)。その場で 1 回取りに行き、
  読めなければ `422 feed_invalid` と `details.reason` (`not_a_feed` / `unsafe_xml` / `http_error` / `too_large` / `timeout` /
  `dns_failed` / `network` / `too_many_redirects`)。リダイレクトの先が内部なら `400 url_not_allowed`。
  **サイトのページの URL でもよい**: 取ったものが HTML で `<link rel="alternate" type="application/rss+xml">` (atom・rdf も) を
  含めば、その先 (最初の http(s) のもの) を 1 回だけ取りに行き、そちらの URL で登録する。
  追加はユーザーごとに 1 分 60 回まで (リンクプレビューと同じ設定、別の枠)。
- `PATCH /feeds/{id} {enabled}` — 止める / 再開。再開はすぐ (次の worker の周期で) 取りに行き、止めていた間の記事は投稿しない。
  アーカイブ中のチャンネルでは再開できない (`409 channel_archived`)。
- `DELETE /feeds/{id}` (204) — 投稿は残る。チャンネルの最後のフィードを消すとボットはチャンネルを抜けて無効化される (次に
  追加したときは新しいボット)。
- 止める・再開・削除は追加した本人・チャンネルのオーナー (メンバー)・管理者 (チャンネルを読める人) だけ (`403
  feed_manage_restricted`)。チャンネルを読めない人にはフィードの有無も見せない (`404 feed_not_found`)。
- 一覧の変更はイベントを出さない (開くたびに読む。定期投稿と同じ)。監査 `feed.created` / `feed.updated` / `feed.deleted`。

## 4. 取得と投稿

- **worker**: 専用のループ (`FEED_CHECK_INTERVAL_SECONDS`、既定 60 秒) が `next_fetch_at <= now` の有効なフィードを 20 件ずつ
  取り (`FOR UPDATE SKIP LOCKED`)、まず `next_fetch_at` を `FEED_POLL_INTERVAL_MINUTES` (既定 30 分) 後に進めてコミットしてから、
  1 件ずつ取りに行く。ネットワークの待ちの間はトランザクションを持たない。遅いサイトがリマインダーや定期投稿の worker を止め
  ないように、別のループにした。
- **取りに行かない**: チャンネルがアーカイブされている、追加した人が無効化されている・チャンネルのメンバーでない。そのときは
  `needs_baseline` を立てる。戻ったときの最初の取得は記録だけで、その間に出た記事は投稿しない (定期投稿の「止めていた間の分は
  投稿しない」と同じ考え)。
- **取得**: リンクプレビュー (SECURITY.md §14) の検査をそのまま使う `build_feed_fetcher` (`app/modules/link_previews/fetcher.py`):
  公開の http(s) ホストだけ、リダイレクトは 3 回まで各ホップで同じ検査、タイムアウト `FEED_TIMEOUT_SECONDS` (10 秒)、本文は
  `FEED_MAX_BYTES` (2 MB) を超えたら失敗 (`too_large`。切れた XML は読めないので切り詰めない)。ETag / Last-Modified を送り、
  304 なら何もしない (成功に数える)。
- **解析** (`app/modules/feeds/parser.py`): 標準ライブラリだけ。pyexpat を直接使い、**実体の宣言があれば読まずに拒否**
  (`unsafe_xml`: 内部実体は billion laughs、外部実体はファイルや URL の読み出し)、外部実体の参照も拒否、パラメータ実体は
  読まない、DTD は取りに行かない (`<!DOCTYPE … SYSTEM "…">` があるだけなら読める)。expat 自身が読まない文字コード
  (Shift_JIS・EUC-JP など) は Python で UTF-8 に直してから読む。defusedxml・feedparser は使わない (必要な防御は数行で、
  依存を増やさない)。読む形式は RSS 2.0 / 0.9x (`rss/channel/item`)、RSS 1.0 (RDF)、Atom 1.0。1 回に 200 記事まで。
- **記事の印** (`seen_keys`): guid / Atom の id / RDF の `rdf:about`、無ければリンク、それも無ければ題名と日付の SHA-256 の先頭
  32 桁。**記事を直しても (題名や本文が変わっても) guid やリンクが同じなら再投稿しない**。guid もリンクも無いフィードで題名を
  直すと新しい記事に見える (受け入れる)。今のフィードに載っている印は必ず残し、合わせて 500 個まで。
- **新しい記事**: 印が無いもの。ただし日付がフィードの追加より 1 日以上前のものは古い記事として投稿しない (サイトの移転などで
  guid が全部変わったときにまとめて流れないように)。**1 回の取得で投稿するのは新しい順に 5 件まで**
  (`FEED_MAX_POSTS_PER_FETCH`。日付の無い記事は新しいほうに数え、同じなら文書の順)、投稿は古い順。残りは見たことにして後で
  流さない。
- **投稿**: `create_message` (`advance_read=False`、`mentions=False`) を記事ごとの savepoint で。`client_msg_id` はフィードの id と
  記事の印から作る UUIDv5 (再試行で同じメッセージ)。ボットがチャンネルから外されていたら入れ直す。投稿に失敗した記事は印を
  残さず、次の取得で ETag を送らずにもう一度試す。リンクのプレビューはボットの投稿なので自動では取らない (SECURITY.md §14:
  bot の投稿は「プレビューを表示」を押したときだけ)。
- **失敗**: 取得・解析の失敗ごとに `consecutive_failures` を 1 増やし、`last_error_code` / `last_error` を残す (一覧に出る)。
  **`FEED_FAILURE_NOTIFY_AFTER` (6、30 分ごとなら 3 時間) 回続けて失敗したら 1 回だけ**、追加した人にボットから DM を送る
  (「⚠️ #週報 のフィード「…」の取得が 6 回続けて失敗しています (…)。URL を確かめてください。…」、ふつうの DM のプッシュ)。
  成功 (304 を含む) で数と記録と通知済みの印を戻す。止めはしない (サイトが戻れば続く)。

## 5. 画面

| 場所 | Desktop / Web | iOS / Android |
|---|---|---|
| チャンネル詳細 (狭い画面) | 「フィード」: 一覧 (題名・URL・追加した人・最終取得と投稿数 / 取得の失敗と回数、「停止中」「取得を休止中」「エラー」の印)、URL を入れて「追加」(確かめている間は「確認中…」、サーバの理由を添えた誤り)、止める / 再開・削除 (確認あり、出せる人だけ) | なし |
| ヘッダーの ⋯ (広い画面) | 「フィード…」(同じ一覧のダイアログ) | なし |
| 投稿 | ボット「RSS」(BOT の印) のふつうのメッセージ | 同じ (変更なし) |
| 失敗の知らせ | 「RSS」ボットからの DM | 同じ |

## 6. 残り・やらないこと

- スマホでの一覧と管理。
- ボットの名前・アイコンの変更 (チャンネルごとに「RSS」固定)。
- フィードごとの投稿先のスレッド、キーワードでの絞り込み、要約の長さの設定。
- DNS リバインディングはリンクプレビューと同じく受け入れている (SECURITY.md §14)。
- 複数のプロセスで worker を動かしても `SKIP LOCKED` と `next_fetch_at` の先送りで同じフィードを同時に取らないが、1 プロセスの
  前提で試験している。
