# フォロー中スレッドの一覧

Slack の「スレッド」ビュー、Mattermost の Collapsed Reply Threads (CRT) に相当する機能の設計と実装メモ。
サーバは 2026-09-27 に実装 (M11a、`server/app/modules/threads`)。変更するなら実装と一緒に更新する。

## 1. 目的

- 自分が関わったスレッドの返信を、チャンネルを開かなくても一覧で追える。
- スレッドごとに未読の返信数とメンション数を持ち、一覧と端末間で同期する。
- チャンネルの未読 (`read_states`) とは独立させる。返信は今までどおりチャンネルの未読には数えない
  (DATA_MODEL.md `read_states`)。

## 2. モデル

新しい表 `thread_follows` を追加する。親メッセージ 1 件 × ユーザー 1 人につき 1 行。

```text
thread_follows
- parent_id        uuid  (messages.id、parent_id IS NULL の行)
- user_id          uuid
- following        bool  (false = 手動で外した。自動フォローで再び true にしない)
- last_read_seq    int   (このスレッドで読んだ最後の返信の channel seq。0 = 未読なし)
- created_at / updated_at
PRIMARY KEY (parent_id, user_id)
INDEX (user_id, following)
```

未読数は保存せず導出する (`read_states` と同じ方針):

```sql
SELECT count(*) FILTER (WHERE deleted_at IS NULL),
       count(*) FILTER (WHERE deleted_at IS NULL AND (mentioned_user_ids @> ARRAY[$me] OR mention_all))
FROM messages
WHERE parent_id = $parent AND seq > $last_read_seq AND sender_id <> $me;
```

返信もチャンネルの `seq` を消費しているので、スレッド内の位置は `seq` で表せる。

自動フォロー (Mattermost の ThreadAutoFollow と同じ):

- 親メッセージを投稿した人
- スレッドに返信した人
- スレッド内 (親または返信) でメンションされた人

いずれも `following=false` の行があれば上書きしない。自分の返信は `last_read_seq` をその返信まで進める。

## 3. API

| 操作 | エンドポイント | 備考 |
| --- | --- | --- |
| 一覧 | `GET /threads?filter=all|unread&limit&cursor` | `following=true` で返信が 1 件以上ある親を `last_reply_at` の新しい順に。各行は `{ parent: MessageOut, state: ThreadState }`。応答の `next_cursor` (最後の行の `last_reply_at`) をそのまま `cursor` に渡すと次ページ。`summary` (下記) も同梱 |
| 状態 | `GET /messages/{id}/thread` | 自分の `ThreadState` 1 件。スレッドパネルのフォロー表示と「新しい返信」の区切りに使う。行が無ければ `following=false, last_read_seq=0` |
| 既読 | `PUT /messages/{id}/thread/read {last_read_seq}` | 単調、最新の返信の `seq` で clamp。スレッドを開いて表示できた返信の最大 `seq` を 1 秒デバウンスで送る。`id` は返信の id でもよい (親に解決する) |
| フォロー | `PUT /messages/{id}/thread/follow {following}` | false で一覧と通知から外れる (チャンネルの通知レベルが「すべて」でも返信は通知しない)。手動で外したものは自動フォローで戻さない。既読 API はフォローを作らない |
| bootstrap | `threads: { unread_count, mention_count }` | 未読の返信があるフォロー中スレッドの数と、そのうち未読メンションがあるものの数。サイドバーの「スレッド」バッジ用 |

```text
ThreadState
- parent_id
- channel_id
- following
- last_read_seq
- unread_count       (seq > last_read_seq、他人の返信、削除済みを除く)
- mention_count      (そのうち自分宛てのメンション / @channel)
- reply_count        (親と同じ値)
- last_reply_at      (親と同じ値)
- participant_ids    (現在のフォロワー。thread.updated とプッシュの宛先)
```

いずれもメンバーだけが呼べる (`messages` の所属判定を通す)。

`GET /messages/{id}/replies` と `GET /messages/{id}/context` は変えない。

### 3.1 親の「返信した人」(C3、2026-09-30)

スレッドの親の `MessageOut` は `reply_count` と `last_reply_at` に加えて `reply_user_ids` を持つ。削除されていない
返信の送信者を、最近の返信の順に重複なく最大 5 人 (親の投稿者も返信していれば入る。返信の無い行は空)。タイムラインの
「N 件の返信」の行に先頭 3 人のアバターを出すため (MOBILE_POLISH.md C3)。

- 保存: `messages.reply_user_ids` (uuid[]) に `reply_count` と同じく非正規化して持つ。返信の作成では返信者を先頭へ
  動かすだけ (追加の問い合わせなし)、返信の削除ではその親の返信から数え直す (`messages_parent_idx` を使う 1 回)。
  読むときは列をそのまま返すので、履歴・差分・スレッド一覧のどのページでも問い合わせは増えない。
  読むたびに返信から集計する案は、ページ分を 1 回で取れるが、`MessageOut` を作るすべての経路 (イベントの
  `to_message_out` を含む) に集計を足す必要があり、足し忘れた経路が空のリストを配って端末の表示を消してしまう。
- 同時の返信: 返信は親を読んだ後にチャンネルの行ロック (seq の採番) を取るので、ロックの後に親を読み直してから
  `reply_count` と `reply_user_ids` を進める (読み直さないと、間に確定した返信の分が失われる)。
- Mattermost の取り込み (M18) はバッチごとに対象の親を返信から数え直す。移行 0049 は既存の親を同じ規則で埋める。
  埋めた親はチャンネルごとに seq を 1 つ取り (編集と同じ)、その値を `updated_seq` にする。これで既に親を持っている端末にも
  差分同期 (SYNC_PROTOCOL.md §7.3) で一覧が届く (updated_seq を動かさないと、次の返信まで一覧が空のままだった)。
- イベント: 返信の作成 / 削除の `parent_thread` にも `reply_user_ids` を入れる (SYNC_PROTOCOL.md §6)。親への
  それ以外の変更 (`message.updated`) は `MessageOut` ごと届くのでそのまま入っている。

## 4. イベント

- `thread.updated` (audience=user、フォロワー全員): 返信の作成 / 削除はフォロワー全員に、フォロー変更と既読更新は
  本人 (の全端末) に送る。payload は `ThreadState` + `reason` (`reply` / `deleted` / `read` / `follow`)。
  outbox 経由 (ARCHITECTURE.md §6)。位置が動かない既読送信はイベントを出さない。
- 返信そのものは今までどおり `message.created` としてチャンネルの購読者に届く。一覧はイベントで
  更新し、開いたスレッドは `replies` で埋める。
- プッシュ: `message.created` の `parent_thread.participant_ids` は `thread_follows.following=true` の
  ユーザー (返信者を自動フォローした後の値)。フォローを外すとスレッドの返信は通知されない。チャンネルのミュートは
  今までどおりスレッド通知にも効く (PUSH_NOTIFICATIONS.md §4)。

## 5. クライアント

- サイドバー / 一覧の先頭に「スレッド」。未読スレッド数をバッジに出す (ミュート規則はチャンネル側に従う)。
- スレッド一覧: チャンネル名、親の抜粋、返信数、最終返信時刻、未読バッジ、「未読のみ」フィルタ。
  行をタップすると既存のスレッドパネル / 画面を開く。
- 一覧から会話へ（2026-10-07、3 端末）：行の先頭のチャンネル名（DM は相手の名前）はリンクで、押すと会話そのものを開き、
  親メッセージを強調して表示する（検索結果・ピン・メンションの行と同じ着地。スレッドは開かない）。行のほかの部分は
  今までどおりスレッドを開く。行の右クリック（Desktop / Web）・長押し（iOS / Android）のメニューに「スレッドを開く」と
  「チャンネルを開く」（DM・グループ DM は「会話を開く」）。リンクの読み上げは「#general を開く」。
  - Desktop / Web：`revealFromList`（広い画面は中央を会話に替え、スレッドのペインを閉じる。電話幅はそのタブの画面に積む）。
  - iOS：`AppController.revealThreadParent` で親を `messageFocus` にし、`MainNavigation.show` でそのタブのスタックに
    会話を push（iPad は詳細の列に足す）。戻るで一覧へ。
  - Android：`controller.revealMessage` のあと `MainNav.openConversationFromThreadList`（上のスレッドは閉じ、戻るで一覧へ）。
    親を取れなかった（オフラインなど）ときも会話はいつもの位置で開く。
  - アクティビティのタブの「スレッド」（段階 A）の一覧も同じ。
- 既読: チャンネルと同じく「表示できた返信の `seq`」で送る。開いただけでは既読にしない。
- Store はスレッド状態を `thread_follows` の形で保持し、`thread.updated` で置き換える。
  ローカル永続化はチャンネルと同じ JSON 行。
- 「チャンネルにも送信」(M15c): スレッドの入力欄のチェックで返信に `also_in_channel` を付ける。その返信は
  チャンネルのタイムラインにも「スレッドに返信: 親の抜粋」の見出し付きで並び (押すとスレッドを開く)、
  スレッド側には「チャンネルにも送信済み」と出す。チャンネルに投稿できない人 (M15a) にはチェックを出さない。

## 6. 進め方と状況

1. サーバ (実装済み 2026-09-27): 表とマイグレーション 0010、`threads` 葉モジュール (`messages → threads` 依存。
   返信の作成 / 削除トランザクションの中で `on_reply_created_in_tx` / `on_reply_deleted_in_tx` を呼ぶ)、
   自動フォロー、API、イベント、プッシュ判定の置き換え、`tests/test_threads.py`。
2. Desktop (実装済み 2026-09-27): サイドバー先頭の「スレッド」(未読スレッド数のバッジ、Ctrl/⌘+Shift+T) →
   中央カラムの一覧 (すべて / 未読、ページング) → 右ペインにスレッド。スレッドパネルはフォロー切替と
   「新しい返信」の区切りを持ち、表示できた返信の最大 `seq` を 1 秒デバウンスで送る。
   区切りの位置は、スレッドの返信がそろった (ready) ときの既読位置で 1 回だけ決め、開いている間は動かさない。
   そのとき他人の未読の返信が無ければ区切りは出さず、開いている間に届いた返信にも出さない (チャンネルの
   「新着メッセージ」と同じ。3 端末とも、2026-09-30: 既読位置から毎回計算すると、読んだ瞬間に消えていた)。
3. iOS / Android (実装済み 2026-09-27): チャンネル一覧の先頭に「スレッド」行 (バッジ)、一覧画面 (すべて / 未読、
   さらに表示)、行タップでスレッド画面 (フォロー切替はツールバー / アプリバー)。既読は完全に表示された返信の
   `seq`。iOS はスレッド内メンションをアプリバッジに足す。契約フィクスチャ 10 (スレッドの既読収束) は 3 端末の
   契約ランナーが `reply` / `client.thread_read` / `expect.threads` を解釈できるようになった時点で追加する
   (各端末のエンジンテストが同じ筋書きを FakeServer で検証している)。
4. docs: DATA_MODEL.md §3 と SYNC_PROTOCOL.md §4.1 / §6、PUSH_NOTIFICATIONS.md §4 (更新済み)。

クライアント側の共通規則 (3 端末とも同じ):

- Store は `threads` (parent_id → 親 `MessageOut` + `ThreadState`) と `threadSummary` を持つ。永続化しない:
  バッジは bootstrap に含まれ、一覧は開いたときに `GET /threads` で取る (§5 の「JSON 行で永続化」は不要と判断した)。
- `thread.updated` は保持している行にすぐ適用し、300 ms 後にサーバから一覧 (開いていれば) とバッジを取り直す。
  返信が連続しても取り直しは 1 回にまとまる。保持していないスレッドの変化もこれで拾える。
- `GET /threads` のページは行にマージする (フィルタ切替や取り直しで開いているスレッドが消えない)。1 ページ目で
  サーバが返さなかった行のうち、そのページに載るはずだった (フォロー中で `last_reply_at` がページ内の最古以上) ものは
  削除する (他端末でフォローを外した / 親が削除された)。
- 既読は楽観的に進め、`PUT .../thread/read` の応答と `thread.updated (reason=read)` で置き換える。

規模は M8 と同程度。Redis や新しいミドルウェアは要らない。
