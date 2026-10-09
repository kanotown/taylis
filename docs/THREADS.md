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
| 一覧 | `GET /threads?filter=all|unread&limit&cursor` | `following=true` で返信が 1 件以上ある親を `last_reply_at` の新しい順に。各行は `{ parent: MessageOut, state: ThreadState, latest_replies: [MessageOut] }`（`latest_replies` は最新の返信のプレビュー、§5。2026-10-07）。応答の `next_cursor` (最後の行の `last_reply_at`) をそのまま `cursor` に渡すと次ページ。`summary` (下記) も同梱 |
| 状態 | `GET /messages/{id}/thread` | 自分の `ThreadState` 1 件。スレッドパネルのフォロー表示と「新しい返信」の区切りに使う。行が無ければ `following=false, last_read_seq=0` |
| 既読 | `PUT /messages/{id}/thread/read {last_read_seq}` | 単調、最新の返信の `seq` で clamp。スレッドを開いて表示できた返信の最大 `seq` を 1 秒デバウンスで送る。`id` は返信の id でもよい (親に解決する) |
| フォロー | `PUT /messages/{id}/thread/follow {following}` | false で一覧と通知から外れる (チャンネルの通知レベルが「すべて」でも返信は通知しない)。手動で外したものは自動フォローで戻さない。既読 API はフォローを作らない |
| すべて既読 | `POST /threads/read-all` (本文なし) | 「スレッド」一覧の「すべて既読にする」(2026-10-09)。下の §3.2 |
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

### 3.2 すべて既読 (2026-10-09)

テスターの声：アクティビティの「すべて既読にする」の後も「スレッド」の未読が残る。アクティビティの既読は
`users.activity_read_at` だけを進め、スレッドの位置はスレッドごと (`thread_follows.last_read_seq`) なので、別の
操作にした。**アクティビティの「すべて既読」はスレッドに触れない**。スレッドは一覧の見出しの「すべて既読にする」で読む。

- `POST /threads/read-all` (認証のみ、本文なし)。1 トランザクションで、自分の `thread_follows` のうち
  `following = true`、今も参加しているチャンネル、親が削除されていない行 (= バッジの `summary` が数える行) の
  `last_read_seq` を、そのスレッドの削除されていない最新の返信の `seq` へ進める (進むだけ。それより先にある位置は
  そのまま)。フォローを外したスレッド、抜けたチャンネルのスレッド、他の人の位置は動かない。
- 1 つの `UPDATE` 文で、最新の `seq` はその文のスナップショットから取る。呼び出し中に確定した返信は、新しい位置に
  含まれるか未読のまま残るかのどちらかで、半端にはならない (残ったものは応答の各行の `unread_count` と `summary` に
  数えられ、その返信の `thread.updated` (`reply`) も今までどおり届く)。
- 応答 `ThreadsReadAllOut`：`{ summary: ThreadSummary, threads: [{ parent_id, channel_id, last_read_seq,
  unread_count, mention_count }] }`。`threads` は位置が動いた行だけ (数はその後の値。ふつうは 0)。何も動かなければ
  `threads: []` でイベントも出さない (冪等)。
- 他の端末へは **`threads.read_all` 1 件** (audience=user、data は応答と同じ)。スレッドごとの `thread.updated` に
  しなかったのは、フォロー中のスレッドが数百ありうるため (outbox の行と、受けた端末の 300 ms 後の取り直しがスレッドの
  数だけ増える。`participant_ids` などこの操作で変わらない値も毎回運ぶことになる)。
- アクティビティ：そのスレッドの返信 (`thread_reply`) と返信の中のメンション (`mention`) は「スレッドで読んだ」規則
  (MOBILE_UI.md §6.4) でそのまま既読になる。`activity_read_at` は動かさない。
- 制限：`POST /channels/read-all` と同じく回数の制限はかけない (1 回の文で済み、何も動かなければ書き込まない)。
- テスト：`server/tests/test_threads_read_all.py`。

## 4. イベント

- `thread.updated` (audience=user、フォロワー全員): 返信の作成 / 削除はフォロワー全員に、フォロー変更と既読更新は
  本人 (の全端末) に送る。payload は `ThreadState` + `reason` (`reply` / `deleted` / `read` / `follow`)。
  outbox 経由 (ARCHITECTURE.md §6)。位置が動かない既読送信はイベントを出さない。
- `threads.read_all` (audience=user、本人の全端末): `POST /threads/read-all` で位置が動いたとき 1 件 (§3.2)。
  data は `{ summary, threads: [{ parent_id, channel_id, last_read_seq, unread_count, mention_count }] }`。
  クライアントは保持している行の位置を進め (下げない)、数を置き換え、バッジを `summary` にし、
  `thread.updated` (`read`) と同じくアクティビティのバッジを取り直す。
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
- 最新の返信のプレビュー（2026-10-07、3 端末。Slack のスレッド一覧と同じ）：カードの親の下に、そのスレッドの新しい
  返信を最大 2 件（古い順）並べる。各行はアバター・名前・時刻・本文（ふつうのメッセージの描画で、約 4 行で切る）。
  本文が無い返信は添付の説明（「画像」など）。返信が表示より多いときは、その上に「他 n 件の返信」（n =
  `reply_count` − 表示した件数）。
  - サーバ：`GET /threads` の各行に `latest_replies: [MessageOut]`（スレッドの画面と同じ形。リアクション・添付・
    メンション入り）。削除済みは除く。自分がブロックした人の返信も除く（アクティビティの一覧と同じ扱い。スレッドの
    画面は折りたたみの 1 行で出すが、プレビューに折りたたみの行を並べても意味がないため）。`reply_count` は今までどおり
    すべての返信を数える。ページ全体で 1 回の問い合わせ（親の id の配列を `unnest` し、`LATERAL` で各親の返信を
    `messages_parent_idx (parent_id, seq)` から新しい順に 2 件）。親とまとめて 1 回の `messages_out` に通すので、
    ページの問い合わせ数はスレッドの数で増えない（`tests/test_thread_list_previews.py`）。件数は
    `threads.service.LATEST_REPLIES`。
  - 未読の印：自分以外の返信で `seq` が `state.last_read_seq` より大きいものは名前を太字にし、点を付ける（スレッドの
    画面の「新しい返信」と同じ基準）。
  - 押すと：返信の行はスレッドを開いてその返信に着地する（`messageFocus`。Desktop / Web は開いてからフォーカスが届くと
    スクロールする。iOS / Android はスレッドが 1 回だけ位置を決めるので、フォーカスを取ってから開く。取れなければ
    いつもの位置で開く）。「他 n 件の返信」とカードのほかの部分はスレッドを開く。チャンネル名のリンクは今までどおり。
  - 即時の更新：`message.created` / `message.updated` / `message.deleted`（自分の送信の応答も）がプレビューを持つ
    スレッドの返信なら、一覧を取り直さずにその行のプレビューを差し替える（新しい 2 件を保つ）。表示中の返信が
    消えたら、端末が持っているそのスレッドの返信から埋める（無ければ次の一覧の取得で埋まる）。ブロックした人の返信は
    入れず、一覧を取った後にブロックした人の返信は表示のときに外す。
  - 古いサーバ（`latest_replies` が無い）：行は親だけの今までのカードのまま。`thread.updated` だけから作った行も
    同じ（次の一覧の取得でプレビューが付く）。
  - 実装：Desktop / Web `ui/ThreadsView.tsx`・`ui/threadCard.ts`・`sync/store.ts`（`applyThreadPreview`）、
    iOS `UI/ThreadsListView.swift`（`ThreadCardRules`）・`Sync/Store.swift`、Android `ui/ThreadsPane.kt`
    （`ThreadCardRules`）・`sync/Store.kt`。
- 元のメッセージの削除（2026-10-09、3 端末）：開いているスレッドの親（元のメッセージ）が削除されたら、そのスレッドを閉じる。
  - サーバ（変えていない）：親の削除は親だけを削除済みにする（本文は空、`message.deleted` をチャンネルへ。`thread.updated` は
    出さない）。返信は DB に残るが、`GET /messages/{親}/replies` と `GET /messages/{親}` は 404 `message_not_found` を返し、
    返信の投稿とその親への下書きの保存も 404 で断る。`GET /threads` は削除された親を出さず、`GET /drafts` もその親への
    下書きを隠す。
  - 削除を知る経路：`message.deleted`（自分の削除の応答・他の端末・他の人・管理者）、差分や取りこぼしの補完で届く削除済みの行、
    再接続などで取り直した返信の 404 `message_not_found`（削除と同じに扱う）。タイムラインを持たない会話でも、「スレッド」の
    一覧や開いたスレッドが持つ親なら削除を受け取る。
  - 閉じるのは、その画面でスレッドを表示できていた（親があるうちに返信を取得できた）ときだけ。Desktop / Web は右のペインを
    閉じ（✕ と同じ）、iOS / Android はスレッドの画面を開いた元へ戻す。下に会話が無い（通知から開いたなど）ときは、その会話を開く。
  - 閉じたら「元のメッセージが削除されたため、スレッドを閉じました」を短く出す（操作を妨げない通知）。ただし、自分がその
    スレッドの画面の親の行から削除したときは出さずに閉じるだけ。チャンネル側・他の端末からの自分の削除では出す。
  - 親が削除済みのスレッドを開いたとき（古いリンク・アクティビティ・通知・パーマリンク）は閉じず、「元のメッセージは
    削除されました」とだけ出す。親の行・返信・入力欄は出さず、返信の 404 はエラーとして出さない。
  - 親が削除されたら、その行を「スレッド」の一覧からすぐに外し、その親への返信の下書きも端末から消す（サーバも隠し、
    保存を断るため）。入力欄も残らない。
  - 実装：Desktop / Web `sync/store.ts`（`wasDeleted`・`forgetThread`）・`sync/engine.ts`（`forgetDeletedRoot`）・
    `ui/ThreadPane.tsx`・`state/app.ts`（`deleteMessage` の `fromThread`）。iOS `Sync/Store.swift`（`threadRootDeleted`）・
    `UI/ThreadView.swift`（`ThreadRootWatch`）・`App/AppController.swift`。Android `sync/Store.kt`（`dropDeletedRoot`）・
    `ui/ThreadRootWatch.kt`・`ui/MainNav.kt`（`threadGone`）・`app/AppController.kt`。
- すべて既読（2026-10-09、3 端末。§3.2）：一覧の見出しに「すべて既読にする」。フォロー中のスレッドに未読の返信が
  あるときだけ押せる。確認はチャンネルの「すべて既読」に合わせる（Desktop / Web はサイドバーと同じく確認なし、iOS /
  Android は確認のあと）。押すと保持している行（フォロー中）の未読と位置（手元にある最新の返信まで、下げない）と
  バッジをすぐ既読にし、応答の位置・数・`summary` を当てる。失敗したら（その間に他で変わっていない）行とバッジを戻し、
  いつものエラーを出す。他端末の `threads.read_all` も同じく当て（位置は下げない）、一覧とバッジの取り直しと
  アクティビティのバッジの取り直しを予約する。アクティビティの「すべて既読」はスレッドに触れない。
  - 実装：Desktop / Web `ui/ThreadsView.tsx`・`sync/engine.ts`（`markAllThreadsRead`・`applyThreadsReadAll`）・
    `sync/store.ts`（`markAllThreadsReadLocally`・`restoreThreadsRead`）。見出しのボタン。
  - iOS `UI/ThreadsListView.swift`（ツールバーのボタンと確認）・`Sync/SyncEngine.swift`（`markAllThreadsRead`・
    `applyThreadsReadAll`）・`App/AppController.swift`。
  - Android `ui/ThreadsPane.kt`（フィルタの行の右端のボタンと確認。アクティビティの段階 A の中では出さない）・
    `sync/SyncEngine.kt`（`markAllThreadsRead`）・`sync/Store.kt`（`readAllThreadsLocally`・`restoreThreadsReadAll`・
    `applyThreadsReadAll`）・`app/AppController.kt`。
- 既読: チャンネルと同じく「表示できた返信の `seq`」で送る。開いただけでは既読にしない。
- スレッドのスクロール（iOS、2026-10-07）：チャンネルと同じ規則（MOBILE_UI.md 6.6「iOS の新しい行」）。最新の返信に
  いるとき来た返信は見え、上から自分が返信すると最新の端へ飛び（途中をくぐるアニメーションはしない）、古い返信を
  読んでいるとき他人の返信が来ても読んでいる行は動かない。そのときは右下に「新着 N 件」/ ↓（チャンネルと同じボタン）。
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
