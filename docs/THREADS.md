# フォロー中スレッドの一覧 (設計、未実装)

Slack の「スレッド」ビュー、Mattermost の Collapsed Reply Threads (CRT) に相当する機能の設計。
実装は IMPLEMENTATION_PLAN.md のバックログから着手する。この文書は着手前に読み、変更するなら実装と一緒に更新する。

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
| 一覧 | `GET /threads?filter=all|unread&limit&cursor` | `following=true` の親を `last_reply_at` の新しい順に。各行は `MessageOut` (親) + `ThreadState` |
| 既読 | `PUT /messages/{id}/thread/read {last_read_seq}` | 単調。スレッドを開いて表示できた返信の最大 `seq` を 1 秒デバウンスで送る |
| フォロー | `PUT /messages/{id}/thread/follow {following}` | false で一覧と通知から外れる |
| bootstrap | `threads: {unread_count, mention_count}` を追加 | サイドバーの「スレッド」バッジ用 |

```text
ThreadState
- parent_id
- following
- last_read_seq
- unread_count
- mention_count
- last_reply_at
- participant_ids
```

`GET /messages/{id}/replies` と `GET /messages/{id}/context` は変えない。

## 4. イベント

- `thread.updated` (audience=user、フォロワー全員): 返信の作成 / 削除、フォロー変更、既読更新で送る。
  payload は `ThreadState` + 親の `reply_count` / `last_reply_at`。outbox 経由 (ARCHITECTURE.md §6)。
- 返信そのものは今までどおり `message.created` としてチャンネルの購読者に届く。一覧はイベントで
  更新し、開いたスレッドは `replies` で埋める。
- プッシュ: 現在の「スレッド参加者」判定 (`participant_ids`) を `thread_follows.following` に置き換える。
  チャンネルのミュートはスレッド通知にも効かせる。

## 5. クライアント

- サイドバー / 一覧の先頭に「スレッド」。未読スレッド数をバッジに出す (ミュート規則はチャンネル側に従う)。
- スレッド一覧: チャンネル名、親の抜粋、返信数、最終返信時刻、未読バッジ、「未読のみ」フィルタ。
  行をタップすると既存のスレッドパネル / 画面を開く。
- 既読: チャンネルと同じく「表示できた返信の `seq`」で送る。開いただけでは既読にしない。
- Store はスレッド状態を `thread_follows` の形で保持し、`thread.updated` で置き換える。
  ローカル永続化はチャンネルと同じ JSON 行。

## 6. 進め方

1. サーバ: 表とマイグレーション、`threads` 葉モジュール (`messages → threads` 依存)、自動フォロー、
   API、イベント、プッシュ判定の置き換え、テスト (契約フィクスチャ 10 を追加、マイグレーションは 0010)。
2. Desktop: サイドバー項目と一覧、既読送信、契約テスト。
3. iOS / Android: 同じ順。
4. docs: DATA_MODEL.md §3 と SYNC_PROTOCOL.md §6 / §10、PUSH_NOTIFICATIONS.md §4 を更新。

規模は M8 と同程度。Redis や新しいミドルウェアは要らない。
