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
| フォロー | `PUT /messages/{id}/thread/follow {following}` | false で一覧と通知から外れる。自動フォローは false を上書きしない |
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
- 既読: チャンネルと同じく「表示できた返信の `seq`」で送る。開いただけでは既読にしない。
- Store はスレッド状態を `thread_follows` の形で保持し、`thread.updated` で置き換える。
  ローカル永続化はチャンネルと同じ JSON 行。

## 6. 進め方と状況

1. サーバ (実装済み 2026-09-27): 表とマイグレーション 0010、`threads` 葉モジュール (`messages → threads` 依存。
   返信の作成 / 削除トランザクションの中で `on_reply_created_in_tx` / `on_reply_deleted_in_tx` を呼ぶ)、
   自動フォロー、API、イベント、プッシュ判定の置き換え、`tests/test_threads.py`。
2. Desktop: サイドバー項目と一覧、既読送信、スレッドパネルのフォロー切替。
3. iOS / Android: 同じ順。契約フィクスチャ 10 (スレッドの既読収束) は 3 端末の契約ランナーが `reply` /
   `client.thread_read` / `expect.threads` を解釈できるようになった時点で追加する。
4. docs: DATA_MODEL.md §3 と SYNC_PROTOCOL.md §4.1 / §6、PUSH_NOTIFICATIONS.md §4 (更新済み)。

規模は M8 と同程度。Redis や新しいミドルウェアは要らない。
