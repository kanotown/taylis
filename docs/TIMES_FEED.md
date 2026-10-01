# Times フィードと `is:times` (L8、M61〜M62)

ROADMAP の L8 (LAB.md §B の「(L8)」の 2 行)。研究室の times (作業ログ、M24) が 20〜30 本になると、1 本ずつ開いて読むのは
つらい。参加している times のトップレベルの投稿を、新しい順に 1 本の流れで読めるようにする。あわせて、検索で times だけに
絞る `is:times` を足し、卒業した人の times も「引き継ぎの資料」として探せるようにする。

**状態**: §8 は全部推奨の案に決まった (2026-10-02)。M61 のサーバは完了 (移行 0055)。Desktop / Web と M62 (iOS / Android) は作業中。

## 1. 方針

- **フィードは読むための画面**。投稿は今までどおり各 times で行う (フィードに入力欄は置かない)。返信 (スレッド)、
  リアクション、「チャンネルで開く」はフィードの行から行える。
- **対象**は自分が参加している times (`channels.times_owner_id` が入っているチャンネル) のタイムラインの行。
  times の「フォロー」は今までどおり参加 (join) のこと。新しいフォローの仕組みは作らない。
- **静かな未読 (SYNC_PROTOCOL §10.5) は変えない**。フィードを開いても既読位置は動かさない (§4)。
- **新しいイベントは足さない**。フィードの最初のページは REST で取り、その後は既存の `message.*` イベントで保つ
  (会話の最後のメッセージ M49 と同じ考え)。
- **プッシュは変えない**。

## 2. フィードに出すもの

1 件 = 1 つのメッセージ (`MessageOut` そのまま)。次の全部を満たすもの:

| 条件 | 理由 |
|---|---|
| 自分が会員のチャンネルで、`times_owner_id IS NOT NULL` | 参加 = フォロー。ゲストも同じ規則 (会員のチャンネルだけ) |
| ミュートしていない (`muted(c)` が偽、§10.5 の定義) | ミュートは「見なくてよい」の意思表示。フィードから外す手段を別に作らない (§8 の 2) |
| タイムラインの行 (`parent_id IS NULL OR also_in_channel`) | チャンネルで見えるものと同じ。スレッドだけの返信は親の「返信 N 件」で見せる |
| 消されていない、`type = user` | 参加・退出などの system の行は出さない。ボット (定期投稿) は `type = user` なので出る |
| アーカイブされた times も含む | 卒業した人の times (L7 でアーカイブ) に会員のまま残っている人は、古い投稿を遡れる。新着は来ないので邪魔にならない |

自分の times の投稿も出す (研究室全体の流れとして読むため。決めてほしいこと 1)。

並びは `(created_at DESC, id DESC)`。seq はチャンネルごとの番号なので、チャンネルをまたぐ並びには使えない
(`id` は UUIDv7 で、同じ時刻の行の順を決める)。

## 3. API (`/api/v1`)

### `GET /times/feed?cursor=&limit=50`

- `limit` は 1〜100 (既定 50)。
- 応答 `TimesFeedOut = {items: MessageOut[], next_cursor: string | null}`。`next_cursor` は最後の行の
  `(created_at, id)` を表す不透明な文字列 (`<ISO 8601>_<uuid>`)。null は終わり。他の一覧 (`/bookmarks`、`/activity`) は
  時刻だけのカーソルだが、フィードは取り込み (Mattermost) で同じ時刻の行が並びうるので id も入れる。
- 返すのは §2 の行。`MessageOut` は会話の履歴と同じもの (リアクション、返信数、添付、回収 `collection` …) なので、
  クライアントは行をそのまま描ける。チャンネルと人は bootstrap で持っているもの (会員のチャンネルなので必ずある)。
- times に 1 本も参加していなければ `items = []`。

**クエリ** (LAB.md §5 の計測どおり): 会員の times の id を先に取り、**チャンネルごとに LATERAL で上位 `limit` 件**を取って
から混ぜ、上位 `limit` 件を返す。素直な `channel_id IN (...) ORDER BY created_at DESC LIMIT 50` は履歴に比例して遅い
(465k 件で 43 ms 対 0.95 ms)。

```sql
SELECT m.* FROM unnest(:channel_ids) AS c(id)
CROSS JOIN LATERAL (
  SELECT * FROM messages
  WHERE channel_id = c.id AND deleted_at IS NULL AND type = 'user'
    AND (parent_id IS NULL OR also_in_channel)
    AND (created_at, id) < (:cursor_at, :cursor_id)      -- 2 ページ目から
  ORDER BY created_at DESC, id DESC
  LIMIT :limit
) m
ORDER BY m.created_at DESC, m.id DESC
LIMIT :limit;
```

- 索引: 部分索引 `messages_timeline_created_idx ON messages (channel_id, created_at DESC, id DESC) WHERE deleted_at IS NULL
  AND (parent_id IS NULL OR also_in_channel)` (移行 0055)。無いと各チャンネルの読み取りが `messages_created_idx` を新しい側から
  辿って他のチャンネルの行を飛ばすので遅い。計測 (M61、19 万件のうち times 30 本 × 3,000 件、他 10 本 × 1 万件): 索引なし
  最初のページ 238 ms・深いページ 6.8 ms、索引あり 0.5 ms・0.6 ms。

## 4. 未読と既読

- フィードを開いても、スクロールしても、各 times の既読位置は**動かさない**。他人の times は静かな未読なので、残っていても
  太字にもバッジにもならない。自分の times に付いた他人のコメントは普通の未読のまま (会話を開いて読む)。
- 行の左に、その times の既読位置より新しい行 (`seq > last_read_seq`) だけ小さな点を付ける (「新しい」の目印)。
  クライアントが持っている既読位置から決める (サーバは何も足さない)。
- フィードの見出しに「すべて既読にする」を置く (§8 の 3)。既存の `POST /channels/read-all` (M12a) に
  本文 `{"scope": "times"}` を足し、フィードの対象 (§2 の会員でミュートしていない times) だけを末尾まで既読にする。
  本文が無ければ今までどおり全部。応答とイベント (`read.updated`、reason = advance) は今と同じ。

## 5. クライアントでの保ち方 (3 端末共通)

```
開いたとき / 再接続のあと / 引っ張って更新:
    GET /times/feed (cursor なし) で置き換える
下端に近づいたら:
    next_cursor があれば次のページを足す (同じ id は足さない)
on message.created (m):
    if feedVisible and isFeedRow(m): 先頭側の並びの位置に入れる (created_at, id の順)
on message.updated / message.deleted (m):
    同じ id の行があれば置き換える。消されたら外す
on channel の変化 (退出、ミュート、times の解除、参加):
    退出・ミュート・解除: その channel_id の行を外す。参加・ミュート解除: 次に開いたときの取り直しで入る

isFeedRow(m) = m.type == user and not deleted and (m.parent_id == null or m.also_in_channel)
               and channel(m).times_owner_id != null and 会員 and not muted(channel(m))
```

- フィードの行は会話の履歴 (500 件の上限、§7.7) とは別に持つ。端末のローカルストアには保存しない (開いたら取り直す。
  オフラインでは「オフラインです」と、最後に開いたときの行をメモリにあれば出す)。
- 見ていない間 (`feedVisible` でない) はイベントで行を足さない。次に開いたときに取り直す。

## 6. 検索の `is:times`

- `is:times` (別名 `is:time`) を `is:thread` と同じ並びで受け付ける (`search/query.py` の `IS_ALIASES`)。ほかの条件と
  組み合わせられる (`is:times from:@sato 実験`、`is:times is:thread`)。
- 範囲は **times のチャンネル**に絞る:
  - 会員の times (アーカイブ済みも)。
  - **会員でない公開の times も入れる** (§8 の 4)。今の検索は会員のチャンネルだけだが、`is:times` のときだけ
    広げる。新しく入った学生が、参加していない先輩・卒業生の作業ログを「引き継ぎの資料」として探せるようにするため。
    ゲストは広げない (M13e: 会員でない公開チャンネルは見えない)。非公開の times は会員のときだけ。
  - `in:#times-sato` と一緒なら、そのチャンネルが上の範囲にあれば絞り込み、無ければ今までどおり解決できない修飾子
    (`unresolved`) として何も返さない。
- 応答 `SearchFilters.is_times: bool` を足し、クエリのパラメータ `is_times` (チップ用、`is_thread` と同じ形) も受ける。
- 応答 `SearchOut.channels: ChannelOut[]` に、結果のうち会員でないチャンネル (`membership = null`) を入れる。アーカイブ済みの
  公開 times は bootstrap に無いので、クライアントはここから名前を出し、開くときに使う。
- `is:times` と `channel_id` (チャンネルの中の検索) を一緒に使い、そのチャンネルが範囲外 (times でない) なら何も返さない。
- キャンバスの検索では `is:times` は使えない (`is:thread` と同じく `unresolved` で返す)。
- 会員でない公開チャンネルの検索結果を開くと、参加前のプレビュー (M27) になる。
- クライアント: 検索のチップに「Times」を足す (今の「スレッド内」の隣)。入力が空のときの候補に「is:times」を足す。
  iOS の説明文 (SearchView.swift の「語の中で from:@名前 …」) に `is:times` を足す。

## 7. 画面

| 場所 | Desktop / Web | iOS / Android |
|---|---|---|
| 入口 | サイドバーの「Times」節の最初の行「フィード」(節を畳んでいても見出しの右にアイコン)。狭い画面 (ホームの画面) はタイルの「Times」 | ホームのタイルに「Times」(スレッドの次)。「Times」節の見出しの右にも「フィード」 |
| フィード | 中央に一覧。行 = アバター・名前・**times の名前** (押すとそのチャンネル)・時刻・本文・添付・リアクション・「返信 N 件」。押すとスレッド (返信があれば) かチャンネルのその行へ | 同じ行を縦に。行を押すとチャンネルのその行へ、「返信 N 件」でスレッドへ |
| 見出し | 「Times フィード」、「すべて既読にする」、「自分の times に書く」(無ければ「自分の times を作る」) | 同じ (⋯ の中) |
| 空のとき | 「参加している times がありません。チャンネル一覧から times に参加すると、ここに新しい投稿が並びます」 | 同じ |
| 検索 | チップ「Times」、候補「is:times」 | 同じ |

- 行の見た目は会話の行に合わせる (「連続した投稿をまとめる」M47 はフィードでは使わず、毎行に名前と times の名前を出す)。
  times の名前は、その人の表示名と同じなら「times」とだけ出すと短いが、今は `times-<username>` をそのまま出す。
- 行の長押し / ホバーの操作は、会話の行と同じもの (リアクション、スレッドで返信、保存、リンクをコピー …) から、
  その場で使えないもの (編集は自分の行だけ、など) を除く。
- 並びはサーバの順 (新しいものが上)。会話の画面と違い、上下を反転しない (読み物として上から読む)。

## 8. 決めたこと (2026-10-02、全部推奨の案)

| # | 項目 | 決めた案 | 採らなかった案 |
|---|---|---|---|
| 1 | 自分の times の投稿もフィードに出すか | **出す** (研究室全体の流れとして読む) | 出さない / 見出しで切り替え |
| 2 | 参加していてもフィードから外したい times | **ミュートした times は出さない** (新しい設定を作らない) | 全部出し、チャンネルごとに「フィードに出さない」を足す |
| 3 | フィードで読んだら既読にするか | **しない**。見出しの「すべて既読にする」で明示的に | 開いたら全部既読 / 画面に出た行まで既読 |
| 4 | `is:times` で参加していない公開の times も探すか | **探す** (卒業生・先輩の作業ログを引き継ぎに使う) | 参加している times だけ (今の検索と同じ範囲) |
| 5 | 置き場所 | **ホームのタイル + Times 節の見出し** (Desktop はサイドバーの Times 節) | アクティビティのタブの中 / 下のタブを 1 つ増やす |

あとで (今回は作らない): 人・学年 (名簿の @b4 など) で絞り込むチップ、フィードからの投稿、フィードの新着のバッジや
プッシュ、フィードの行のローカル保存。

## 9. 実装の順番

- **M61**: サーバ (`GET /times/feed`、索引の要否の計測、`read-all` の `scope`、`is:times` と `is_times`、テスト、openapi) と Desktop / Web
  (フィードの画面、サイドバーとタイル、検索のチップと候補)。
- **M62**: iOS と Android (タイル、フィードの画面、検索のチップと候補、iOS の説明文)。

サーバのテスト: 参加している times だけ・ミュートは除く・スレッドだけの返信は除く・`also_in_channel` は入る・消した行と
system の行は除く・アーカイブ済みは入る・ゲスト・カーソル (同じ時刻の行が 2 ページに分かれても漏れも重複もない)・
`is:times` の範囲 (会員でない公開 / 非公開 / ゲスト / `in:` との組み合わせ)。
