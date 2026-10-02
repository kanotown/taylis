# CANVAS (Slack Canvas 相当の設計)

2026-09-28 の設計提案 (復元、[ROADMAP.md](ROADMAP.md) 参照)。編集方式は利用者の回答どおり「自動保存 + サーバ側マージ」。マイグレーション番号 (「0036〜」) は当時のもので、着手時点の次の番号に読み替える。

**状態 (2026-09-30)**: サーバの中核 (ROADMAP の M32) を **M41** で実装した (マイグレーション 0046)。表、保存 / マージ / 冪等、
権限、イベント、履歴、ゴミ箱、テンプレート。残りのサーバ (ROADMAP の M33) を **M42** で実装した (マイグレーション 0047):
検索 (`canvases_search_idx`、`/search/canvases`)、画像 (`attachments.canvas_id`)、版の整理とゴミ箱の完全削除、会話への共有と `/c/`。
**サーバは完成。** Desktop / Web の表示・編集・自動保存は **M43**、履歴・検索・画像・共有・管理のテンプレートは **M44** (Desktop / Web はこれで揃った)。
実装で決めたこと・設計から変えたことは末尾の「§11 実装メモ (M41)」「§12 実装メモ (M42)」「§13 実装メモ (M43 Desktop / Web)」「§14 実装メモ (M44 Desktop / Web)」「§15 実装メモ (M45 iOS)」「§16 実装メモ (M46 Android)」。iOS の閲覧と編集は **M45**、Android は **M46** (Phase 1 はこれで完了)。
**Phase 2** (メンション通知・編集中の表示・チェックリストからタスク) は **M72** でサーバと Desktop / Web (移行 0065)、**M73** で iOS / Android。決めたことは「§18 Phase 2 (M72)」。範囲に付けるコメントは入れない (§18.4)。
メンションの判定 (3 端末): `@` の前が ASCII の英数字・`._-`・`@`・`<` 以外なら (行頭を含む) メンションにする。「まとめます。@kano」も
メンション、`a@b.jp` と保存済みの `<@uuid>` はそのまま (M46 で見つけた不具合を、メッセージの入力欄も含めて 3 端末で直した)。

## 0. 結論

- **MVP の推奨は案 (a) を一段強くしたもの**です。本文は Markdown で、版による楽観的な並行制御をかけ、他の人の保存と重なったらサーバが 3-way マージします。解決できない重なりだけを競合として画面に出します。
  - 保存は自動です。入力が 2 秒止まるたびに「どの版を元に書いたか」(`base_rev_id`) を付けて本文全体を送ります。
  - その間に他の人が保存していれば、サーバが **行 → 語句** の単位でマージします。
  - 同じ語句を別々に書き換えたときだけ、本人に「自分の版 / 相手の版 / 両方残す」を選んでもらいます。
  - **マージのコードはサーバ (Python) の 1 か所だけ**です。クライアントは「入力が止まったら最新の本文に差し替える」だけで済みます (§4.4)。
- **キャンバスは必ず会話に属します** (チャンネル / DM / グループ DM / 自分との DM)。
  - 閲覧・編集・検索・画像・通知の権限は、既存の `channel_members` でそのまま決まります。新しい ACL は作りません。
  - 「個人のキャンバス」は自分との DM に置きます。
  - 研究計画は学生と教員の DM か非公開チャンネルに置けば、非公開のまま保てます。
- **CRDT (Yjs / Automerge) は後回し**にします。
  - Swift / Kotlin / Python のバインディングはどれも 1.0 前です。
  - モバイルをネイティブで作るという方針にも合いません。
  - 必要になったら、デスクトップ / Web だけをリアルタイム共同編集にします。モバイルは MVP と同じ保存 API のまま使えます (§9)。
- **ブロック型 (案 b) は採りません。** 正しさの面では良い案ですが、3 端末それぞれにブロックエディタ (Enter で分割、Backspace で結合、ブロックをまたぐ選択) を作る費用が MVP に見合いません。

主な測定値 (詳細は §7):

| 項目 | 結果 |
| --- | --- |
| 検索 | 5,000 キャンバス / 4,725 万字で 1.8〜12 ms |
| 保存 1 回のトランザクション | 3.8 ms (約 1 万字) 〜 18 ms (約 8 万字) |
| 版のスナップショット | 約 1 万字で 9.6 KB |
| 試作マージ (別の行を 2 人が編集) | 300 回中 300 回が競合なし |
| 試作マージ (同じ行の別の位置を 2 人が編集) | 200 回中 200 回が競合なし |
| 試作マージの所要時間 | 10 万字で 30 ms |

## 1. 研究室での使い方と、そこから決めた要件

| 使い方 | 例 | 必要なこと |
| --- | --- | --- |
| 会話のキャンバス (タブ) | #lab の研究室ルール、学会・締切一覧 (表)、ゼミの発表順、よく使うリンク | 会話ごとの「キャンバス」タブ。教員だけが本文を変えられる設定と、誰でも付けられるチェック |
| 議事録 | ゼミ・ミーティングのたびに 1 つ | テンプレート。書記と他の人が同時に追記しても消えないこと。決定事項と TODO (担当は @) |
| 週報 | 学生ごとに毎週 (times チャンネルや教員との DM) | テンプレート。教員のコメント (スレッド)。どこを直したかが分かる履歴 |
| 研究計画 | 学生と指導教員の DM、非公開チャンネル | 非公開のまま扱えること。版の比較。「提出版」のような名前付きの版 |
| 学会準備、卒論 / 修論スケジュール | 参加登録、旅費申請、予稿、発表練習 | チェックリスト。別々の項目を同時にチェックしても消えないこと |

ここから決めた要件:

- 同時編集は「数人がときどき」を前提にします。10 人が常に同時に書く想定ではありません。
- 一方で、チェックの同時操作はよく起きます。
- スマホでの操作は、閲覧・チェック・短い修正が中心です。
- 日本語 / 英語の全文検索、履歴、非公開の保護、テンプレートは必須です。

## 2. 既存の設計に合わせる点

| 既存の型 | キャンバスでの使い方 |
| --- | --- |
| 書き込みは REST、WS はヒント (SYNC_PROTOCOL §3、D7) | 保存は REST の `PUT` だけ。WS は `canvas.*` イベント (本文は載せない) で「新しい版がある」と知らせるだけ |
| Transactional Outbox | 保存・作成・削除では、同じトランザクションで outbox に行を書く |
| 状態ベースの同期、「大きい方が勝つ」 | `canvases.version` が大きい方を採用する。取りこぼしは、会話を開いたときと再接続後の読み直しで回復 (channel_links と同じ) |
| 冪等キー | 保存ごとに `client_save_id` (UUIDv4) を付ける。再送しても版は 1 つ |
| 監査 (audit.record_in_tx) | 削除・復元・版の消去・編集権限の変更を記録 |
| 権限 (require_member / require_not_guest / require_writable / posting_policy) | そのまま使う (§4.7) |
| 添付 (pending → attached、channel_id で判定) | `attachments.canvas_id` を足すだけで、アクセス判定は変えない |
| PGroonga | キャンバスの題名と本文に索引を 1 つ張る |
| 本文の軽量 markdown (3 端末で同じ字句解析) | 同じ解析に、タスクリスト・画像・区切り線を足した「キャンバス用の方言」 |
| パーマリンク `/m/<id>` (M12b) | `/c/<canvas_id>` を同じ方式で追加 |
| スレッド (THREADS.md) | キャンバスへのコメントに使う (§4.13) |

キャンバスの編集は、チャンネルの `seq` を**消費しません**。タイムラインの項目ではないので、編集のたびに未読が増えないようにするためです。channel_links と同じ扱いです。

## 3. 3 案の比較

| 観点 | (a) Markdown 全体 + 版 (If-Match) + サーバ側マージ ★推奨 | (b) ブロック型 + ブロックごとの版 | (c) CRDT (Yjs / Automerge) でリアルタイム共同編集 |
| --- | --- | --- | --- |
| 正しさ | 版の直列化 (行ロック) で上書き事故が起きない。マージできない重なりは必ず本人に見せ、黙って消さない | ブロック単位で安全。競合は同じブロック内だけ | 同時編集に最も強く、オフラインも自動で収束。ただし「意図しない混ざり方」は起こりうる |
| 同時編集の体験 | 相手の変更は数秒遅れて、入力が止まった時点で現れる。同じ語句だけ競合 | 他人のブロックがリアルタイムに更新される | カーソル単位でリアルタイム |
| サーバ | テーブル 2〜3 つ、マージ関数 1 つ (試作 約 100 行、標準の difflib のみ) | ブロックの CRUD・移動・分数インデックス。messages と同じ seq 型の差分同期 | pycrdt (Rust 拡張、0.14.6 で 1.0 前) を導入し、更新ログ・圧縮・本文 (Markdown) の導出を担う。WS 受信専用 (D7) の例外か、バイナリ更新の REST 化が要る |
| Desktop / Web | textarea ベースの Markdown エディタ + 既存の描画 | ブロックエディタを自作 (contenteditable か、ブロックごとの textarea) | Yjs 本体は 22.7 KB (gzip)。エディタ連携 (CodeMirror か ProseMirror) で依存が増える。Automerge なら wasm が 1.87 MB (gzip で 644 KB) |
| iOS / Android | 既存の描画 + TextEditor / TextField による区切り (見出し) 単位の編集 | SwiftUI と Compose でブロックエディタ (フォーカス移動、分割・結合) を 2 回作る | ネイティブのバインディングが 1.0 前 (automerge-swift 0.7.2、automerge-java v0.0.9)。現実的には WebView のエディタになり、ネイティブ UI の方針から外れる |
| オフライン | 手元の本文と base を保存しておき、再接続時にマージ。24 時間を超えたら比較画面 | ブロック操作を再送。ブロックごとに競合 | 自動で収束 |
| 検索 (PGroonga) | `ARRAY[title, body]` に索引 1 つ | ブロック単位で当たる (ブロックへ直接飛べる) | CRDT から導出した本文列を索引 (a と同じになる) |
| 履歴 | 版ごとのスナップショット。比較も復元も簡単 | ブロック単位は簡単、文書全体の復元は難しい | 誰が何を変えたかを追うには追加の仕組みが要る |
| 権限 | 会話のメンバーシップ | 同じ | 更新ごとにサーバで検証が必要 |
| 画像・メンション・チェック | 本文のトークンで表す (§4.2)。チェックは 1 行の変更としてマージされる | ブロックの種類で表す | 同等 |
| テンプレート | Markdown の文字列 | ブロック列 | 初期状態の生成が必要 |
| 規模感 | 小 | 中〜大 (エディタ 3 つ) | 大 |
| CLAUDE.md の方針との整合 | ◎ | ○ | △ (依存と複雑さ、D7) |

## 4. 推奨 MVP の設計

### 4.1 位置付けと画面

- 会話には複数のキャンバスを置けます。そのうち 1 つを「会話のキャンバス」として、見出しの **「メッセージ | キャンバス」タブ**に出します。Slack のモバイル版と同じ形で、スマホ UI を Slack に寄せる方針とも合います。
- 他のキャンバス (議事録 10/1、週報 第40週 など) は会話の「キャンバス一覧」と、サイドバーの「キャンバス」(自分の会話すべて、更新順) に並べます。
- 個人用は自分との DM に置きます。別の会話への移動は Phase 2 で扱います (権限が変わるので監査対象)。

### 4.2 本文の形式 (キャンバス用の Markdown 方言)

メッセージの軽量 markdown (DATA_MODEL.md「本文の形式」) に、次を足します。

- タスク: `- [ ] 項目` / `- [x] 項目` (`*` と、2 スペースの入れ子も同じ扱い)
- 画像: `![説明](attachment:<uuid>)`。キャンバスの添付だけを描画し、外部 URL の画像は描画しません (追跡画像と CSP のため)
- 区切り線: `---` (前後が空行のとき)
- メンションは `<@uuid>` / `<@group:uuid>` をそのまま使います。エディタ上では既存の encode / decode (mentions.ts ほか) で `@username` として見せます。`<!channel>` は描画だけで、通知はしません

3 端末の字句解析 (markdown.ts / MessageBodyView.swift / BodyTokenizer.kt) に `canvas: true` の設定を足し、共通のフィクスチャ `apps/shared/canvas_markdown.json` で揃えます。メッセージでは従来どおり、これらを文字のまま表示します。

### 4.3 データモデル (マイグレーション 0036〜)

```sql
CREATE TABLE canvases (
  id              uuid PRIMARY KEY,                        -- UUIDv7
  channel_id      uuid NOT NULL REFERENCES channels(id),   -- 所属する会話。権限はすべてここから
  title           varchar(200) NOT NULL,
  body            text NOT NULL DEFAULT '',                -- キャンバス用 markdown。最大 100,000 文字
  version         bigint NOT NULL DEFAULT 1,               -- 本文・題名・設定の変更ごとに +1 (大きい方が勝つ)
  head_rev_id     uuid NOT NULL,                           -- 現在の本文の版 (保存の base に使う)
  is_channel_tab  boolean NOT NULL DEFAULT false,          -- 会話の「キャンバス」タブ (1 会話 1 つ)
  edit_policy     varchar(16) NOT NULL DEFAULT 'members',  -- 'members' | 'owners' (作成者・owner・admin だけが本文を変えられる。チェックは全員)
  template_key    varchar(40),
  share_message_id uuid REFERENCES messages(id),           -- 会話に共有したメッセージ (コメントのスレッドになる)
  task_total      integer NOT NULL DEFAULT 0,              -- 一覧に「3/8」と出すため、保存時に数える
  task_done       integer NOT NULL DEFAULT 0,
  created_by      uuid NOT NULL REFERENCES users(id),
  updated_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,                             -- ゴミ箱。30 日後に完全削除
  deleted_by      uuid REFERENCES users(id),
  CHECK (edit_policy IN ('members', 'owners'))
);
CREATE INDEX canvases_channel_idx ON canvases (channel_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX canvases_tab_uniq ON canvases (channel_id) WHERE is_channel_tab AND deleted_at IS NULL;
CREATE INDEX canvases_search_idx ON canvases USING pgroonga ((ARRAY[title::text, body]));  -- 題名と本文を 1 つの式で (§4.8)

CREATE TABLE canvas_revisions (
  id              uuid PRIMARY KEY,                        -- UUIDv7
  canvas_id       uuid NOT NULL REFERENCES canvases(id),
  version         bigint,                                  -- この版で canvases.version がいくつになったか。side は NULL
  kind            varchar(16) NOT NULL,                    -- create | save | merge | side | restore | erased
  parent_rev_id   uuid,                                    -- 編集の元にした版
  author_id       uuid NOT NULL REFERENCES users(id),
  title           varchar(200) NOT NULL,
  body            text NOT NULL,
  client_save_id  uuid,                                    -- 冪等キー
  label           varchar(80),                             -- 名前付きの版 (「提出版」など)。整理の対象外
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX canvas_revisions_canvas_idx ON canvas_revisions (canvas_id, created_at);
CREATE UNIQUE INDEX canvas_revisions_save_uniq ON canvas_revisions (author_id, client_save_id) WHERE client_save_id IS NOT NULL;

CREATE TABLE canvas_templates (
  id          uuid PRIMARY KEY,
  key         varchar(40) UNIQUE,     -- 組み込み: weekly_report | minutes | research_plan | conference_checklist | thesis_schedule
  name        varchar(80) NOT NULL,
  description varchar(200),
  title       varchar(200) NOT NULL,  -- 例: '週報 {{week}} {{me_name}}'
  body        text NOT NULL,          -- {{date}} {{week}} {{me}} {{channel}} は作成時にサーバが展開
  position    integer NOT NULL,
  builtin     boolean NOT NULL DEFAULT false,
  hidden      boolean NOT NULL DEFAULT false,
  created_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE attachments ADD COLUMN canvas_id uuid REFERENCES canvases(id);
-- キャンバスの画像は message_id が NULL、channel_id はキャンバスの会話。get_for_access は変更不要
```

`ChannelOut` には `canvas_tab_id` (無ければ null) を足します。こうすると bootstrap と一覧だけでタブの有無が分かります。

上限: 本文 100,000 文字、題名 200 文字、会話あたり 200 キャンバス、キャンバスあたり画像 100 枚、保存はユーザーあたり 120 回 / 分。

本文の上限の根拠は 2 つあります。

- Caddy の /api は 1 MB までです。日本語は 3 バイト / 字なので、100,000 文字で約 300 KB に収まります。
- マージは 10 万字で 30 ms でした (§7)。

### 4.4 保存プロトコル (この設計の中心)

リクエスト:

```
PUT /api/v1/canvases/{id}/content
{ "base_rev_id": "...", "body": "...", "client_save_id": "uuid4", "on_conflict": "fail" | "ours" | "theirs" | "both" }
```

サーバの処理 (1 トランザクション):

```
canvas = SELECT … FROM canvases WHERE id=$id FOR UPDATE      -- このキャンバスへの保存を直列化 (channels.last_seq の行ロックと同じ考え方)
require_editor(actor, canvas, base, body)                     -- §4.7。本文が変えられない人でも、チェックの変更だけなら許す
if (actor, client_save_id) の版がある: 200 で現在の状態と submitted_rev_id を返す        -- 再送
base = 版 base_rev_id (見つからない → 409 canvas_base_expired + 現在の本文)
if base == head: new = body
else:
    new, conflicts = merge3(base.body, body, head.body)      -- スレッドプールで実行。200 ms を超えたら競合として扱う
    if conflicts and on_conflict == "fail": ROLLBACK → 409 canvas_conflict {head, conflicts:[{base, ours, theirs}]}
    それ以外は方針で解決 (ours / theirs / both = 相手の版の後に自分の版を引用で残す)
    INSERT 版 kind='side' (body=送られた本文, parent=base, client_save_id)   ← この端末の次の保存の base
if new == head.body: 変更なし (イベントは出さない)
else:
    INSERT 版 (kind = base==head ? 'save' : 'merge', client_save_id は直接保存のときだけ)
    UPDATE canvases SET body, version+1, head_rev_id, task_total/done, updated_by, updated_at
    本文に新しく現れた、自分の pending 画像を bind
    write_outbox('canvas.updated', audience=channel, payload=CanvasMeta)   -- 本文は載せない (191 B)
COMMIT → 200 { canvas: CanvasOut, submitted_rev_id, merged }
```

**マージの規則** (試作済み。scratchpad/perf/canvas/merge3.py):

1. 行単位で、base と自分、base と相手の一致区間を difflib (autojunk=False) で取ります。
2. 片側だけが変えた区間はその側を採ります。両側が同じに変えた区間は 1 回だけ入れます。
3. 両側が同じ位置に挿入した場合は、両方を残します (相手 → 自分の順)。議事録で 2 人が同じ箇条書きの末尾に追記する場面がこれに当たります。
4. 行数が同じ区間は 1 行ずつ比べます。両側が同じ行を変えていたら、その行を語句 (「。、，．！？」と空白の後ろで区切る) に分けて、同じ規則で比べます。
5. それでも重なる箇所だけが競合です。
6. 共通の JSON フィクスチャ `server/tests/fixtures/canvas_merge/*.json` で固定します。

**クライアント側の規則** (マージのコードは持ちません):

```
状態 (キャンバスごと、端末のストアに保存): base_rev_id, editor_text, dirty, in_flight {client_save_id, sent, base} | null

編集したら dirty。入力が 2 秒止まったとき、画面を閉じるとき、背面に回るときに save()
save():
  送信中なら終わってからもう一度。sent = editor_text。in_flight をストアに保存 (落ちても、オフラインでも同じ key で再送できる)
  2xx:
    base_rev_id = (editor_text == sent) ? r.canvas.head_rev_id : r.submitted_rev_id
    editor_text == sent で、本文が sent と違えば (マージで他の人の変更が入った) エディタを差し替える
      (カーソルは、変わる前と後で共通する先頭・末尾の長さを使って保つ)
  409 canvas_conflict: 競合パネル (該当箇所の base / 自分 / 相手) → 選んだ方針で、同じ base・新しい key で再送
  409 canvas_base_expired: 自分の本文と現在の本文を並べて見せる (24 時間以上オフラインで編集した場合だけ)
  401 token_expired: refresh して 1 回だけ再試行。403 / 404: 編集を止めて理由を出す (手元の本文は残す)
  429 / 5xx / 通信エラー: in_flight を保ったまま、バックオフして同じ key で再送 (重複しない)
閲覧中 (dirty でない) に canvas.updated で新しい version が来たら、GET /canvases/{id} (0.5 秒デバウンス、If-None-Match)
編集中に来たら何もしない。次の保存でマージされ、入力が止まった時点で相手の変更が現れる
```

次の保存の base は、常にサーバが持っている版です (head か、送った本文そのものを保存した side 版)。このため、マージはいつもサーバで閉じます。

**チェックの切り替え**に専用の API は作りません。表示中の版の該当行の `[ ]` を `[x]` に変えて、その版を base に `PUT` します。最新の版とはサーバがマージするので、隣り合う項目を 2 人が同時にチェックしても消えません (§7 で確認済み)。

### 4.5 API (すべて /api/v1。OpenAPI と ws-events.json を再生成)

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | /channels/{id}/canvases | 会話のキャンバス一覧 (メタのみ、更新順) |
| POST | /channels/{id}/canvases | 作成。`{title?, template_key?, body?, tz, as_tab?, share_to_channel?, client_save_id}`。テンプレートはサーバが `tz` で展開 |
| GET | /canvases?cursor=&limit= | 自分の会話すべてのキャンバス (keyset: updated_at, id) |
| GET | /canvases/{id} | メタ + 本文 + head_rev_id。ETag = version (If-None-Match なら 304) |
| PUT | /canvases/{id}/content | 保存 (§4.4) |
| PATCH | /canvases/{id} | 題名、edit_policy、is_channel_tab |
| DELETE / POST | /canvases/{id}、/canvases/{id}/restore | ゴミ箱へ移す / 戻す |
| POST | /canvases/{id}/share | 会話に共有 (共有メッセージが残っていれば何もしない。M42 で追加、§12) |
| GET | /canvases/{id}/revisions?cursor= | 版の一覧 (本文なし: 作者、時刻、種類、ラベル、差分の行数) |
| GET | /canvases/{id}/revisions/{rev} | 版の本文 |
| POST | /canvases/{id}/revisions/{rev}/restore | その版を新しい版として復元 |
| PATCH / DELETE | /canvases/{id}/revisions/{rev} | ラベルを付ける / 版の本文を消去 (owner・admin、監査に残る) |
| GET | /canvas-templates | テンプレート一覧 |
| POST / PATCH / DELETE | /admin/canvas-templates[/{id}] | テンプレートの管理 (admin) |
| GET | /search/canvases?q&channel_id&from_user_id&after&before&sort&limit&offset | 検索 (§4.8) |
| GET | /c/{canvas_id} | ブラウザ向けの案内ページ (pages.py。認証なし、中身は出さない) |

新しいエラーコード (apps/shared/errors.json に日本語文言を追加し、tests/test_error_codes.py で確認):

- `canvas_not_found` (404)
- `canvas_conflict` (409)
- `canvas_base_expired` (409)
- `canvas_too_large` (422)
- `canvas_edit_restricted` (403)
- `too_many_canvases` (409)
- `canvas_tab_taken` (409)
- `template_not_found` (404)

### 4.6 イベントと同期

| type | audience | seq | data |
| --- | --- | --- | --- |
| `canvas.created` | channel | — | `{ canvas: CanvasMeta }` |
| `canvas.updated` | channel | — | `{ canvas: CanvasMeta, change: "content" \| "title" \| "settings" \| "restore" }` |
| `canvas.deleted` | channel | — | `{ canvas_id, channel_id }` |
| `canvas.mentioned` (Phase 2、M72) | user | — | `{ canvas_id, channel_id, rev_id, title, by_user_id }`。PushPlanner が扱う (§18.1) |
| 揮発フレーム `canvas_presence` (Phase 2、M72) | channel (中継) | — | `{ canvas_id, channel_id, user_id, editing, section }`。typing と同じ中継で、45 秒で消える (§18.2) |

`CanvasMeta` は次の項目を持ちます: id, channel_id, title, version, head_rev_id, is_channel_tab, edit_policy, task_total, task_done, share_message_id, created_by, updated_by, created_at, updated_at。

同期の規則:

- メタは「version が大きい方が勝つ」でマージします。
- 取りこぼしは、会話を開いたときと再接続後に `GET /channels/{id}/canvases` を読み直して回復します。開いているキャンバスは `GET /canvases/{id}` (If-None-Match) を読み直します。
- 自分が会話から外れたとき (`channel.member_removed`) は、その会話のキャンバスと保存待ちを手元から消します。
- アーカイブされた会話のキャンバスは閲覧だけにします。
- 非公開 → 公開の変換では、過去ログと同じくキャンバスも公開されます。変換の確認文にその旨を書き足します。
- 手順は SYNC_PROTOCOL.md に「§14 キャンバス」として書き、ここは 3 端末共通の仕様にします。

### 4.7 権限

| 操作 | public / private | dm / group_dm / 自分との DM |
| --- | --- | --- |
| 閲覧・検索・履歴・画像 | メンバー (guest を含む) | メンバー |
| 作成 | メンバー (guest を除く。投稿制限チャンネルでは owner / admin) | メンバー |
| 本文の編集 | edit_policy=members: 作成と同じ人。owners: 作成者・owner・admin | メンバー |
| チェックの切り替え (本文の差分がタスク記号だけ) | guest 以外のメンバー全員 (edit_policy に関係なく) | メンバー |
| 題名・edit_policy・タブの指定 | 作成者・owner・admin | メンバー |
| 削除・復元 | 作成者・owner・admin | 作成者 |
| 版の本文の消去 | owner・admin (監査に残る) | 作成者 |
| アーカイブ済みの会話 | 閲覧のみ (409 channel_archived) | — |

- すべて `channels.require_member` を通します。
- 作成者・更新者はサーバが認証情報から決めます。クライアントが送る user_id・時刻・ロールは使いません。

### 4.8 検索

- 索引は `canvases_search_idx` (`ARRAY[title::text, body]`) の 1 つにします。
- クエリの形:

  ```
  WHERE ARRAY[title::text, body] &@~ $q AND deleted_at IS NULL AND channel_id IN (自分の会話)
  ORDER BY pgroonga_score DESC, updated_at DESC LIMIT n
  ```

- **`title &@~ q OR body &@~ q` の形は使いません。** 測定では PGroonga の索引が使われず、1,374 ms かかりました (§7)。
- 抜粋は LIMIT の後に作ります。サーバが一致語の前後 60 字をプレーンテキストで返し、クライアントは応答の `keywords` で強調します (メッセージ検索と同じ。HTML は返しません)。
- 修飾子は既存と同じです: `in:#会話`、`from:@人` (作成者か最終更新者)、`before:` / `after:` / `on:`。
- UI は M16b の検索画面に「キャンバス」タブを足します (「メッセージ / ファイル」の隣)。
- ARCHITECTURE.md §5 の「search は他モジュールを読み取り専用で参照してよい」という例外に canvases を足します。

### 4.9 履歴

- 版の一覧から、版の表示、現在の版との行単位の差分、復元 (新しい版として)、ラベル付けができます。
- 履歴は閲覧できる全員に見せます。教員が学生の変更を追えるようにするためです。誤って貼った秘密は、owner・admin (DM では作成者) が版の本文を消去できます。
- 版の整理 (周期ジョブ `_purge_loop` に追加):
  - 24 時間以内の版はすべて残します。編集中の端末のマージの base になるためです。
  - 24 時間を過ぎたら、side 版を消します。同じ作者の連続した版は 10 分ごとの最後の 1 つだけ残します。
  - create・restore・ラベル付き・現在の版は常に残します。
- 容量の見積もり: 1 時間の議事録を 5 秒ごとに自動保存すると、約 700 版 × 9.6 KB で約 6.7 MB が 1 日だけ残ります。整理後は 6〜12 版、約 0.1 MB です。

### 4.10 画像・添付

- アップロードは既存の `POST /attachments` (pending) を使います。保存時に、本文に現れた自分の pending をキャンバスに bind します (status=attached、canvas_id、channel_id=会話、message_id=NULL)。
- アクセス判定 (`get_for_access`) は channel_id で行うので変更不要です。
- 本文から画像を消しても、添付は残します。履歴の版が参照しているためです。キャンバスの完全削除のときに deleted にし、既存の GC がバイト列を消します。
- 他人の添付や別キャンバスの添付は bind しません。表示は「表示できない画像」になります。
- 描画はサムネイル → `content?inline=1` (画像だけ) です。外部 URL の画像は描画しません。
- MVP ではファイル一覧 (`GET /files`) にキャンバスの画像を含めません。

### 4.11 メンション、チェックリスト、通知

- MVP: 本文の `<@uuid>` はメンションとして表示するだけです。タスクの件数は一覧に「3/8」と出します。
- Phase 2 (M17g。実装は M72・M73 で、決めたことは §18。`kind` は `canvas`、`canvas_tasks` は作らず TASKS.md のタスクにした):
  - 保存で**新しく増えた**メンションのうち、会話のメンバーだけに `canvas.mentioned` を送ります。PushPlanner が `kind=canvas_mention` にし、タップでキャンバスを開きます。
  - 保存時に `canvas_tasks` (canvas_id, 行のキー, 本文, 完了, 担当 = 項目内のメンション, 期限 = `📅 2026-10-15`) を導出し、「自分のタスク」一覧 (全キャンバス横断) を作ります。
  - 編集中の表示 (`canvas_presence`) も Phase 2 です。

### 4.12 テンプレート

- 組み込みはマイグレーションで入れます: 週報 / 議事録 / 研究計画 / 学会準備チェックリスト / 卒論・修論スケジュール。
- admin はデスクトップの管理画面で編集・追加・非表示にできます。
- 展開 (`{{date}}` = 2026-10-01 (木)、`{{week}}`、`{{me}}`、`{{channel}}`) は作成 API の中でサーバが `tz` を使って 1 か所で行います。
- 例 (議事録):

  ```markdown
  # 議事録 {{date}}
  ## 出席

  ## 議題

  ## 決定事項

  ## TODO
  - [ ] 担当 @ / 期限 📅
  ```

- times チャンネルの週報にもそのまま使えます。

### 4.13 共有とコメント

- `<server>/c/<id>` を本文中で認識し、`/m/` と同じようにカードで表示します (題名、会話、更新者、進捗)。見られない人には「表示できないキャンバス」と出します。
- 作成時の「会話に共有」は、パーマリンクを含む**普通のメッセージ**として投稿します。既読・プッシュ・検索は既存の経路がそのまま効きます。
- **コメントはその共有メッセージのスレッド**にします。キャンバス画面の「コメント」から開き、共有メッセージが無ければその場で作ります。週報・研究計画への教員の指摘は、既存のスレッド (フォロー、通知、未読) で扱えます。
- 文章の特定の範囲に付けるコメントは後回しにします。

### 4.14 監査・保持・バックアップ・エクスポート・AI

- 監査: `canvas.delete` / `canvas.restore` / `canvas.purge` / `canvas.revision_erased` / `canvas.edit_policy`
- ゴミ箱: 30 日後に完全削除 (版を消し、画像を deleted にする)
- バックアップ: pg_dump で DB 側はそのまま含まれます。`verify-attachments` もキャンバスの画像を含みます (`all_live` の対象)
- エクスポート: `export-channel` の JSONL に `{"type":"canvas", …}` を追加します
- 将来の RAG: 本文はプレーンな Markdown なので、`canvas_embeddings (canvas_id, head_rev_id, chunk_index, embedding)` を、メッセージと同じメンバーシップの絞り込みで足せます

### 4.15 サーバのモジュール

新しいモジュール `app/modules/canvases/` を作ります: models / schemas / repository / service / router / events / merge.py / templates.py。

依存の向き:

- `canvases → channels, attachments, messages (共有メッセージ), audit`
- `search → canvases` (読み取り専用の例外)
- `sync → canvases` (`canvas_tab_id`)

`messages` は `canvases` に依存しないので、依存は一方向のままです。

## 5. クライアントごとの作業

### Desktop / Web (React / TS)

- 入口:
  - 会話の見出しに「メッセージ | キャンバス」タブ
  - 会話のキャンバス一覧 (ポップオーバー)
  - サイドバーの「キャンバス」ビュー (FilesView と同じ作り)
  - ⌘K の候補にキャンバスを追加
- 表示:
  - markdown.ts の Block に `task`、`image`、`hr` を追加し、MessageBody の描画を使い回す
  - チェックはクリックで保存 (§4.4)
  - 長い文書のために見出しの目次 (右側)
- 編集:
  - textarea ベースのエディタ。composerEdit.ts (太字・リスト・見出し・コード。`continueStructure` に `- [ ] ` の継続を追加) と mentions.ts / 絵文字補完を使い回す
  - 画像は貼り付け・ドラッグでアップロードし、`![](attachment:…)` を挿入
  - 広い画面では「編集 | プレビュー」の 2 列。狭い画面 (Web のスマホ幅) は切り替え
- 保存: 純粋な状態機械 `src/sync/canvasSave.ts` (テスト可能) と、競合パネル (3 択)
- 履歴ダイアログ: 一覧、表示、差分、復元、ラベル
- テンプレートの選択、検索の「キャンバス」タブ、`/c/` のカード、admin のテンプレート管理タブ
- ストア: Tauri は SQLite (メタ・本文・保存待ち)、Web はメモリだけ。Web は自動保存の間隔 (2 秒) で失う量を抑える
- 検証: tsc、vitest、vite build、`cargo check`

### iOS (SwiftUI)

- 会話の見出しに「メッセージ | キャンバス」のタブ (Picker、segmented)
- 表示: MessageBodyView のブロック描画を拡張して ScrollView に並べる (タスク・画像・区切り線)。チェックはタップで保存。見出しのメニューで移動、引っ張って更新
- 編集:
  - 見出しごとの「このセクションを編集」と「全体を編集」を用意する
  - どちらもシートの TextEditor に、キーボード上のツールバー (太字・リスト・チェック・@・画像。PhotosPicker とカメラ) を付ける
  - セクション編集は、元の版の該当区間を差し替えた本文全体を送る。サーバがマージするので、他の区間の同時編集は消えない
  - 保存の状態機械 `Sync/CanvasSave.swift` と、競合の選択 (3 択)
- テンプレートから作成、履歴 (MVP は閲覧と復元のみ)、検索の「キャンバス」、プッシュや `/c/` リンクから開く導線
- ストア: SQLite に canvases (オフライン閲覧) と保存待ちを持つ
- テスト: XCTest (状態機械、字句解析のフィクスチャ、セクションの差し替え、カーソル保持)。スナップショット (`TEST_RUNNER_SNAPSHOT_DIR`) で見た目を確認
- 検証: xcodegen と xcodebuild で `-collect-test-diagnostics never`

### Android (Compose)

- 見出しに TabRow
- 表示: MessageBody.kt / BodyTokenizer.kt を拡張して LazyColumn に並べる
- 編集: セクション / 全体の編集を ModalBottomSheet で。フォトピッカーでアップロード
- `sync/CanvasSave.kt`、Room のテーブル、`CanvasApi` (ChannelLinksApi と同じく別の interface)
- Store を読む composable には `version: Int` を渡す (strong skipping の既知の落とし穴)
- 長い本文の TextField は重くなりやすいので、既定はセクション編集にする
- 検証: `testDebugUnitTest`、`lintDebug`、`assembleDebug`、エミュレータでの確認

### 3 端末で共通にするもの (フィクスチャで揃える)

- 字句解析 (タスク・画像・区切り線)
- セクションの切り出しと差し替え
- カーソル保持の計算
- 保存の状態機械のシナリオ (直接保存 / 入力中にマージ / 409 と各方針 / 同じ key での再送 / オフライン → 再接続)

## 6. テスト

サーバ (pytest、実 PostgreSQL):

- merge3 の単体テスト: フィクスチャ 8 種 + 乱数による性質テスト (別の行 300 回、同じ行の別の位置 200 回で「編集が消えない」) + 時間予算 (同じような行が 3,000 行並ぶ文書は 200 ms を超えたら競合として扱う)
- 作成: テンプレート展開、タブの一意性、会話への共有
- 閲覧: メンバー / 非メンバー / guest / 非公開 / DM / 自分との DM
- 保存: 直接・マージ・競合・各方針・同じ key の再送・base の期限切れ・変更なし
- 権限: edit_policy=owners でのチェックだけの保存、アーカイブ 409、除外されたメンバー 403、削除 404 と復元
- 履歴: 一覧・復元・消去 (監査)。版の整理ジョブ
- 画像: bind・アクセス・完全削除時の GC
- 検索: 日本語 / 英語、メンバーシップの絞り込み、削除済みは除外。EXPLAIN に `canvases_search_idx` が出ることを確認し、OR の書き方への退行を防ぐ
- イベント: 形と配信先
- 上限とレート制限
- openapi.json / ws-events.json の差分と errors.json

クライアント:

- 上記の共通フィクスチャ
- 各端末のライブテスト: dev サーバで、2 つのセッションが同じキャンバスを同時に編集してどちらの変更も残ることを確かめる
- Desktop は vitest (偽サーバ付き)、iOS は XCTest、Android は JUnit

## 7. 測定 (実際に実行したもの)

環境:

- compose の PostgreSQL 17.11 + PGroonga 4.0.9 (Docker VM: 10 CPU、8 GB)
- スクラッチ DB `canvas_scratch_257fe0a8` を作り、終了後に DROP しました
- スクリプトと出力: `/tmp/scratch`
- 本番の VPS (2〜4 vCPU) では、数倍遅い前提で読んでください

データ: docs/*.md (437 段落、日英混在) から合成したキャンバス 5,000 件、合計 4,725 万字 (中央値 7,047 字、p90 18,430 字、最大 81,574 字)、UTF-8 で 74 MB。

**検索と索引**

| 項目 | 結果 |
| --- | --- |
| 保存容量 (pglz) | 43 MB |
| PGroonga 索引の作成 | 6.8 s (本文) / 7.0 s (`ARRAY[title, body]`) |
| 本文だけ、30 会話の IN 絞り込み、上位 20 件 | 1.8 ms |
| `ARRAY[title, body]` で同じ条件 | 12.4 ms |
| まれな語 | 0.6 ms |
| `title &@~ q OR body &@~ q` (Seq Scan) | **1,374 ms** |
| 同じ OR で、btree を使い `&@~` を 1 行ずつ照合 | 272 ms |
| 抜粋を LIMIT の後に作る (20 件) | 1.4〜3 ms |
| 抜粋を並べ替えの前に作る | 1,187 ms |

**保存 1 回のトランザクション** (FOR UPDATE、UPDATE + PGroonga の再索引、版の INSERT、outbox の INSERT。各 30 回)

| 本文の長さ | 中央値 | p90 |
| --- | --- | --- |
| 9,730 字 | 3.8 ms | 4.5 ms |
| 54,844 字 | 13.1 ms | 15.1 ms |
| 81,574 字 | 18.3 ms | 34.6 ms |

**版のスナップショット**

| 本文の長さ (UTF-8) | 保存サイズ (pglz) |
| --- | --- |
| 約 1 万字 (17.0 KB) | 9.6 KB |
| 約 5.5 万字 (91.6 KB) | 51.5 KB |
| 約 8.2 万字 (135.7 KB) | 73.5 KB |

- lz4 もほぼ同じでした (10.1 KB / 46.0 KB / 68.1 KB)。
- メタだけの `canvas.updated` の outbox ペイロードは 191 B でした。

**マージの試作** (Python 標準の difflib だけ)

- 正しさ:
  - シナリオ 8 種はすべて期待どおりでした。別の区間の編集、同じ箇条書きへの同時追記、隣り合うチェック、同じ段落の別の文、再送、チェックとその行の文言変更は、すべて競合なし。同じ語の別々の変更と、削除された区間の中の編集は、競合になりました。
  - SYNC_PROTOCOL.md (21,380 字) で、乱数で選んだ別の行を 2 人が編集する試行: 300 回中 300 回が競合なし、編集の消失 0。
  - 同じ行の両端を 2 人が編集する試行: 200 回中 200 回が競合なし。
- 所要時間:

  | 文書 | 1 回のマージ |
  | --- | --- |
  | 21k 字 | 3.2 ms |
  | 38k 字 | 5.0 ms |
  | 100k 字 | 30.4 ms |
  | 167k 字 | 73 ms |
  | 同じような行が 3,000 行並ぶ文書 | 334 ms、しかも誤った競合が 1 つ出た (→ 時間予算と上限が必要) |

- 1 行の中の文字単位マージは遅すぎました: 1 千字 4 ms、5 千字 362 ms、2 万字 3,055 ms。語句トークンに切り替えると 5 千字 1.8 ms、2 万字 9.0 ms で、元に戻したときに文字が失われないことも確認しました (→ 行の中は語句単位で比べる)。

**CRDT の比較**

- Yjs 13.6.33:
  - バンドルは 75 KB (min) / 22.7 KB (gzip)
  - 2 人が 1 万字を 1 文字ずつ入力する模擬 (15% の打ち直しあり): 12,983 回の更新、平均 13 B。状態は 38.2 KB で、本文 15.9 KB の 2.4 倍
- Automerge 2.2.9:
  - wasm は 1.87 MB (gzip で 644 KB)
  - 1 万字を 1 文字ずつ入力した文書は、保存すると 7.4 KB (本文の 0.47 倍)
- バインディングの版: pycrdt 0.14.6 (wheel 約 1 MB)、automerge-swift 0.7.2、automerge-java v0.0.9。どれも 1.0 前です

## 8. リスクと対策

| リスク | 対策 |
| --- | --- |
| 同じ語句の同時編集で競合が出る | 3 択の競合パネル。「両方残す」で内容は失わない。Phase 2 の「編集中」表示で起きにくくする |
| 単一プロセスで大きなマージが CPU を占める | スレッドプールで動かし、200 ms の予算を超えたら競合として扱う。本文は 100,000 字まで。行の中は語句単位で比べる (測定で 3 s → 9 ms) |
| 版が増え続ける | 24 時間後に整理する (§4.9) |
| モバイルの TextField が長い本文で重い | 既定はセクション編集。全体の編集は注意書き付き |
| 検索の書き方の落とし穴 (OR で索引が使われない) | 索引は 1 つの式にし、テストで EXPLAIN を確認する。メッセージ検索の `_matching` も同じ形なので別途確認 (現状の欄を参照) |
| Web 版はローカル保存が無い | 2 秒ごとの自動保存で、失う量を最小にする |
| 学生にとっての Markdown の敷居 | ツールバーとプレビュー、テンプレート。WYSIWYG は決めごとの 2 で判断 |
| 履歴に秘密が残る | 版の消去 (監査付き) |
| Caddy の 1 MB 制限 | 本文 100,000 字の上限 (約 300 KB) |
| 長いオフライン編集 | base が無くなっていたら、2 つの本文を並べて見せる |
| 3 端末の字句解析のずれ | 共通のフィクスチャで揃える |
| 非公開 → 公開の変換でキャンバスも公開される | 変換の確認文に明記する |

## 9. 将来の拡張経路

1. Phase 2 (M17g): メンション通知、「自分のタスク」、編集中の表示、範囲に付けるコメント。
2. リアルタイム共同編集: 保存とマージの体験で足りないと分かってから入れます。
   - デスクトップ / Web は CodeMirror 6 + Yjs (`Y.Text` に Markdown を持たせる。HackMD と同じ方式) にします。
   - サーバは pycrdt で Y.Doc を持ち、本文列 (`canvases.body`) を毎回導出します。検索・エクスポート・履歴・権限・モバイルの `PUT /content` はそのまま使えます。
   - モバイルの保存は、サーバが base との差分を `Y.Text` の操作に変換して適用します。
   - データモデルは MVP のまま引き継げます。
3. WYSIWYG: 必要ならデスクトップだけ TipTap にし、Markdown との往復変換を持たせます。モバイルは表示とセクション編集のままです。
4. 意味検索 / RAG: `canvas_embeddings` を足します。

## 10. 更新する docs (実装と同時に)

- ARCHITECTURE.md: §5 のモジュールと依存、§9 の API、判断 D24 (D23 は別の判断で使用済み)「キャンバスは Markdown + 版 + サーバ側マージ。CRDT は保留」
- DATA_MODEL.md: テーブル、キャンバス用の方言、版の整理
- SYNC_PROTOCOL.md: §6 のイベント、§14 キャンバスの保存と同期
- SECURITY.md: §3.2 の行、画像、履歴の消去
- PUSH_NOTIFICATIONS.md: Phase 2 の `canvas_mention`
- IMPLEMENTATION_PLAN.md: M17 の表
- apps/shared/errors.json

## 11. 実装メモ (M41)

設計が選択を残していたところと、設計から変えたところ。

- **モジュール**: `server/app/modules/canvases/` (models / schemas / repository / service / router / events / merge.py /
  templates.py)。依存は `canvases → channels, audit` だけ (M42 で attachments・messages)。`sync` が bootstrap の
  `ChannelOut.canvas_tab_id` を埋める (bootstrap だけ。ほかの応答では null)。
- **マージ** (`merge.py`、純粋関数・決定的):
  - 行の対応付けは、共通の先頭・末尾を除いた後、小さい区間 (25,000 セル以下) は difflib (`autojunk=False`)、大きい区間は 1 回だけ
    現れる行を目印に分割する (無ければ両側で同じ回数だけ現れる行を順に対応させる)。これで §7 の「同じような行が 3,000 行」
    (試作 334 ms、誤った競合 1 つ) が 2〜4 ms・競合なしになった。目印の無い 250,000 セル超の区間は丸ごと置き換えとみなす。
  - **語句の単位**: 設計の「。、，．！？ と空白の後ろで区切る」を細かくし、改行・空白の並び・区切り記号 1 字・同じ文字種
    (漢字 / ひらがな / カタカナ / 英数字 / その他) の並びを 1 語にした。日本語の文は空白が無くても句で分かれる
    (「研究計画 / を / 来週 / までに / 提出 / する / 。」)。`[ ]` → `[x]` は 1 語の置き換えになり、チェックと文言の変更が同じ行でも
    マージされる。
  - 設計の規則 3 (同じ位置の挿入は両方) は行ではそのまま。**語句では**、どちらの挿入も前後の語から空白・記号で離れている
    ときだけ両方を残し、そうでなければ競合にした (`@` の直後に別々の名前を入れると「@ebikano」になるため)。片方がもう片方を
    先頭か末尾に含む挿入は長い方だけにした (両方とも同じ行を足し、片方がもう 1 行多い、など)。
  - 両側が変えた区間の行数が違うとき (設計では競合) は、区間全体を語句でマージする (改行も 1 語)。1 行を直し、隣の行を
    相手が消した、のような場合も両方が効く。
  - `on_conflict` は競合した区間 (1 行、または区間全体) ごとに効く。競合の応答には区間の先頭行 (`ours_line` / `theirs_line`)
    も入れた。
  - フィクスチャは `server/tests/fixtures/canvas_merge/*.json` (19 種)。マージはサーバだけなので、3 端末の共通フィクスチャ
    (§5) には入れていない。
  - 測定 (Apple Silicon、この機械): 10 万字で 40 行を 2 人が編集 3.4 ms、同じような行 3,000 行 3.3 ms、同一の行 3,000 行 1.8 ms、
    1 行 2.7 万字の両端 24 ms、全行を両側が書き換え (1,359 競合) 150 ms。テストで 200 ms 以内を確かめている。
- **保存**: 冪等キーが既にあれば、権限の確認より先に (ただしメンバーであることは確かめてから) その結果を返す (メッセージの
  再送と同じ考え方)。本文が head と同じなら版も side も作らない。チェックだけの人 (guest 以外で本文を変えられない人) の
  保存は `on_conflict` に `ours` / `both` を使えない (他の人の文言を戻せてしまうため)。erased の版を base にした保存は
  `canvas_base_expired`。
- **履歴**: `canvas_revisions` に `lines_added` / `lines_removed` を足した (履歴の一覧に本文なしで「差分の行数」を出すため。
  行の多重集合の差で数える)。一覧は side を出さない。版の復元は本文だけ (題名は戻さない)。ラベルは本文を変えられる人。
  現在の版は消去できない (`409 canvas_revision_is_head`)。
- **ゴミ箱**: `GET /channels/{id}/canvases?trashed=true` で一覧 (設計に無かった)。戻すと `canvas.created` (端末は一覧に足す)。
  戻したときに会話に別のタブができていれば、戻した方はタブでなくなる。削除・復元とも `version` を +1。
- **テンプレート**: `canvas_templates.key` は NOT NULL (admin が足したものも `custom_…` の key を持ち、作成は常に
  `template_key` で指定する)。組み込みは削除できず (`409 template_builtin`)、非表示にする。組み込みはマイグレーションが入れ、
  起動時にも欠けていれば入れ直す。`GET /admin/canvas-templates` (非表示を含む一覧) を足した。テンプレートの変更はイベントを
  出さない (作成の画面を開くたびに読む)。`{{me_name}}` を足し、`{{me}}` は題名では表示名にした。`tz` を省くと UTC。
- **作成時の「会話に共有」** (`share_to_channel`) は M42 に回した。パーマリンク `<server>/c/<id>` の組み立てと `/c/` の案内
  ページが一緒に要るため。`share_message_id` の列は用意してある。
- **上限**: 保存 (と作成・版の復元) は 1 人 1 分 120 回 (`canvas_save_rate_limit_per_user`)。本文 100,000 字は
  `422 canvas_too_large`。
- **M42 への引き継ぎ**: `canvases_search_idx` と `/search/canvases`、`attachments.canvas_id` と画像の bind・GC、版の整理と
  ゴミ箱の 30 日での完全削除 (`canvas.purge` の監査) を `_purge_loop` に、会話への共有と `/c/`。

## 12. 実装メモ (M42)

M42 でサーバの残り (検索・画像・版の整理・完全削除・共有・`/c/`) を実装した。マイグレーション 0047。

- **検索** (`GET /search/canvases`、search モジュール。canvases を読み取り専用で参照):
  - 索引は設計どおり `canvases_search_idx` (`ARRAY[title::text, body]`) の 1 つ。クエリはメッセージ検索と同じく、語だけを条件に
    した MATERIALIZED の段から入り、範囲 (自分がメンバーの会話・ゴミ箱でない・修飾子) はその結果にかける。`enable_seqscan = off`
    も同じ。テストが EXPLAIN に `canvases_search_idx` が出ることを確かめる。
  - **落とし穴**: SQLAlchemy は配列の隣の文字列を配列として bind する (`ARRAY['東','京']`)。PostgreSQL が「演算子が無い」と
    返し、それがメッセージ検索と同じ「構文エラーならエスケープして再検索」の経路に落ちて、Groonga の構文 (OR、`-`) が効かない
    だけで結果は出てしまった。語を text として渡し、テストで `実験 OR tokyo` と `東京 -研究計画` を確かめている。
  - 対象は自分がメンバーの会話 (DM を含む) だけ。メッセージと違い、未参加の公開チャンネルのキャンバスは出ない (§4.7)。
  - 修飾子: `in:#`、`from:@` (作成者か最終更新者)、`before:` / `after:` / `on:` (updated_at)。`has:` / `is:` は `unresolved` に返す。
    同時実行の上限・時間切れ・レート制限はメッセージ検索と共有 (`search` の limiter と gate)。
  - 抜粋は LIMIT の後に作る (`search/snippet.py`): 空白と改行を 1 つにまとめ、最初の `keywords` の前後 60 字。題名だけに当たった
    ときは本文の先頭 120 字。全角英数は NFKC で比べる (PGroonga の正規化に合わせる)。
  - 測定 (この機械、サービス全体: 会話の一覧・検索・件数 (1,001 件で打ち切り)・keywords・抜粋。1 回温めた後の中央値):
    - 開発 DB の複製に docs/*.md の段落から作った 5,000 件 / 5,921 万字 (§7 と同じ規模、全件が自分の会話): 当たらない語 7.4 ms、
      `PGroonga` 22.7 ms、`マージ 競合` 26.5 ms、`キャンバス` (全件の題名) 31.4 ms、`Tauri OR SwiftUI` 42.5 ms、`検索` 46.8 ms
      (どれも 1,000 件以上に当たる)。§7 の 12.4 ms はクエリ 1 本の値で、件数のための 2 本目と抜粋の分が加わる。
    - pytest (HTTP 経由) の約 5,000 字 × 400 件: 10〜13 ms。
- **画像** (`attachments.canvas_id`、ON DELETE SET NULL、部分索引):
  - bind は作成・保存・版の復元のたびに、本文の `attachment:<uuid>` (大文字の id も。Swift の `uuidString` は大文字) が指す、
    **保存した本人の pending** だけ。設計の「新しく現れたもの」は、本文が指す自分の pending すべてと同じ結果になるので区別しない。
  - 画像以外のファイルも bind する (設計は「画像」。本文にリンク `[名前](attachment:…)` を書く端末があっても、24 時間で消えない
    ように)。描画するのは画像だけ。1 キャンバス 100 件 (`400 too_many_canvas_images`。errors.json に足した。端末の表は `gen_errors.py` で作り直す)。
  - 他人の pending・別のキャンバスやメッセージの添付は bind せず、エラーにもしない (本文から作る参照なので)。
  - 読むのは会話のメンバーだけ (`get_for_access` で `canvas_id` のある添付は `require_member`)。公開チャンネルの添付の
    「参加前のプレビュー」(M27) は当てはまらない。`GET /files` とメッセージ検索のファイル名には出ない (messages と結合するため)。
  - 設計は「本文から消しても完全削除まで残す」だったが、版の整理で古い版が消えると、どこからも参照されない画像が残り続ける。
    そこで周期ジョブが、bind から 24 時間を過ぎて、本文にも残っている版のどれにも id が無い画像を deleted にする (整理された版・
    消去された版にだけあった画像)。24 時間以内の版はすべて残るので、編集中に消えることはない。消去した版の秘密の画像も
    これで消える。
- **版の整理** (`_purge_loop`、1 時間ごと): SQL 1 文 (窓関数)。24 時間を過ぎた side を消し、同じ作者の連続した save / merge は
  `date_bin('10 minutes')` の区切りごとに最後の 1 つを残す。create・restore・erased・ラベル付き・現在の版は残し、連続を区切る。
  読み直すのは 24 時間〜8 日前の版だけ (1 回で済むため。止まっていた期間の版は少し多く残るだけ)。
- **ゴミ箱の完全削除**: 30 日 (`canvas_trash_retention_days`)。画像を deleted にしてから行を消す (版は CASCADE)。監査
  `canvas.purge` は actor なしで、会話・題名・削除者・版の数を残す。共有メッセージは会話に残す (普通のメッセージなので)。
  イベントは出さない (ゴミ箱の一覧は開くたびに読み直す)。
- **共有**: 作成時の `share_to_channel` に加えて `POST /canvases/{id}/share` を足した (§4.13 の「共有メッセージが無ければ
  コメントを開くときに作る」のため。設計の API 表に無かった)。本文は `📄 題名\n<server>/c/<id>` の普通のメッセージで、
  `messages.create_message(commit=False)` でキャンバスと同じトランザクションに入れる (`canvas.created` が最初から
  `share_message_id` を持つ)。`<server>` は要求の届いた先 (uvicorn の `--proxy-headers` と Caddy の trusted_proxies で
  https とホスト名になる)。設定の公開 URL は足していない。題名の `<` は全角 `＜` にする (共有した人の名前で `<!channel>` が
  飛ばないように)。共有メッセージが残っていれば何もしない。消されていれば新しく投稿する。`POST …/share` は version だけ
  +1 して `canvas.updated` (change=settings) を出す (updated_by / updated_at は変えない。編集ではないため)。
  権限は投稿と同じ (`create_message` の検査。投稿制限のチャンネルでは owner / admin)。
- **`/c/<id>` のページ**: `/m/` と同じく認証なし・照会なしの案内ページ (id の形だけ確かめ、存在するかも出さない)。
  「メンバーには開き、他の人には 404」は、アプリと Web クライアントが `GET /canvases/{id}` で解決するときに決まる (非メンバーは
  403 `not_a_member`、無いものは 404 `canvas_not_found`)。本番では Caddy が `/c/` も Web クライアントに渡す (`/m/` と同じ)。
- **残したこと**: クライアント (M34〜M37 の計画。`python3 apps/shared/gen_errors.py` で `too_many_canvas_images` を 3 端末の表に入れる)、`/c/` のカードを軽くする専用の API (今は `GET /canvases/{id}` が本文も返す)、
  Phase 2 (メンション通知・タスク・編集中の表示)。

## 13. 実装メモ (M43 Desktop / Web)

§5 の Desktop / Web のうち、表示・編集・自動保存。設計が選択を残していたところと、設計から変えたところ。

- **入口**: 広い画面は会話の見出しに「メッセージ | キャンバス」の切り替え (ピン留め・ファイルは今までどおり右のペインと
  ビュー)。スマホ幅は会話のタブ列の 2 番目に「キャンバス」。タブは会話のキャンバス、無ければ更新が新しいものを開く。
  会話の一覧 (§5 の「ポップオーバー」) は、題名のボタンから開く (新規・ゴミ箱もここ)。一覧は会話を開いたときに読む
  (bootstrap の `canvas_tab_id` は使っていない。一覧で分かるため)。
- **表示と編集**: 広い画面の既定は「編集」(エディタ + プレビューの 2 列)、スマホ幅は「閲覧」(§1: スマホは閲覧・チェック・
  短い修正が中心)。閲覧では見出し 3 つ以上で右に目次。エディタは等幅ではなく本文と同じ字体 (日本語の Markdown が
  読みやすい)。
- **メンション**: エディタは `@username`、保存は `<@uuid>` (mentions.ts の encode / decode)。`@channel` / `@here` は
  補完に出さない (キャンバスでは通知しないため)。
- **保存ループ** (`src/sync/canvasSave.ts`): §4.4 どおり。決めたこと:
  - 再送の間隔は 1 → 2 → 5 → 10 → 30 秒 (429 は `retry_after_seconds`)。再接続で待たずに送る。
  - 何も打っていなくても、IME の変換中は差し替えない。その場合は送った本文の版 (`submitted_rev_id`) を base にし、次の
    保存か、変換が終わった後の読み直しで相手の変更が入る。
  - プレビューのチェックもエディタと同じループで保存する (その場で送る)。本文を変えられない人のチェックは、表示中の版の
    `[ ]` だけを変えた本文になる (§4.7 のサーバの判定どおり)。
  - 競合パネルの「あとで」で閉じられる。保存状態の「競合」を押すと戻る。選ぶまで自動保存は止まる (入力は続けられ、
    選んだときにその本文を送る)。
  - `canvas_base_expired` は「自分の本文で上書き」(今の版を base に保存) と「今の本文にする」(手元を捨てる) の 2 つ。
    自分の本文のコピーも出す。
  - 403 / 422 などは「保存できません」と理由を出して止める (本文は残し、コピーできる)。次の入力で再開。ゴミ箱に移ったら
    (`canvas.deleted` か 404) 保存はしない。
- **保存待ちの保持**: Tauri はストアの meta (`canvas:<id>`、SQLite) に base・本文・送信中の key を残し、再起動後の接続で
  同じ key から送る。Web はメモリだけ (§5 のとおり)。
- **ストア**: 会話ごとの一覧は保存しない (会話を開くたびに読む)。
- **3 端末の共通フィクスチャ**: `apps/shared/canvas_markdown.json` に字句解析 (タスク・画像・区切り線)、チェックの切り替え、
  カーソル保持。保存ループのシナリオは vitest (`tests/canvasSave.test.ts`) で固定し、共通の JSON にはまだしていない
  (iOS の M で必要なら切り出す)。セクションの切り出しはモバイル向けなので未実装。
- **M44 への引き継ぎ**: 履歴ダイアログ (一覧・差分・復元・ラベル)、検索の「キャンバス」タブ、画像 (貼り付け・ドラッグで
  アップロードし `![](attachment:…)` を挿入、描画は今は枠だけ: `data-attachment-id`)、`/c/` のカードと会話への共有 (コメント =
  共有メッセージのスレッド)、サイドバーの「キャンバス」ビュー (`GET /canvases`、`ApiClient.myCanvases` は用意済み)、⌘K の候補、
  admin のテンプレート管理タブ。

## 14. 実装メモ (M44 Desktop / Web)

§5 の Desktop / Web の残り (履歴・検索・画像・共有とコメント・「キャンバス」一覧・⌘K・テンプレートの管理) と、Web でタブを閉じる
ときの保存。サーバの変更はない。設計が選択を残していたところと、設計から変えたところ。

- **入口**: キャンバスの見出しバーに「コメント」と「履歴」(スマホ幅は ⋯ の「履歴…」)。⋯ は全員に出す (会話に共有・リンクを
  コピー・履歴。題名・編集できる人・会話のキャンバス・ゴミ箱は権限のある人だけ。M43 はチェックだけの人に ⋯ を出さなかった)。
  自分の会話すべてのキャンバスは、広い画面はサイドバーの「キャンバス」(「ファイル」の下)、スマホ幅はホームのタイル「キャンバス」
  (MOBILE_UI.md §10 9. で空けておいた場所)。一覧は `GET /canvases` のページ (50 件、「さらに読み込む」)、題名で絞り込み、Enter
  で本文も検索 (検索の「キャンバス」タブ)。行・⌘K・検索結果・`/c/` カードからは、その会話の「キャンバス」タブで開く (スマホは
  通知と同じく会話のタブに移る。検索からは「検索結果に戻る」が残る)。
- **履歴** (`ui/CanvasHistory.tsx`): ダイアログの左に版の一覧 (作者・時刻・種類・`+n −m`・ラベル・「現在の版」)、右に
  「前の版との差分」(既定。一覧で 1 つ古い版、無ければ `parent_rev_id`)・「現在の版との差分」・「この版の本文」。スマホ幅は一覧 →
  版の 2 画面。
  - **差分はクライアントで作る** (`ui/canvasDiff.ts`、表示専用。マージはサーバだけのまま): 行は Myers の差分 (先頭・末尾の共通部分を
    除いてから)。削除と追加が並んだ行は順に組にして、サーバのマージと同じ語句 (空白・記号 1 字・漢字 / ひらがな / カタカナ / 英数字の
    並び) で比べ、共通部分が長い方の 40% 以上なら変わった語句だけに色を付ける (「来週までに[研究計画→予稿]を提出する」、`[ ]`→`[x]`)。
    変わっていない行が 3 行より長く続くところは「… n 行 …」に畳む。3,000 を超える編集は区間全体の置き換えとして出す (メモリは
    O(D²) に抑えた。4,000 行を全部書き換えても 1 秒かからない)。
  - 本文はメンションを名前にしてから比べる (`<@uuid>` のままだと読めないため)。
  - **復元**: 確認ダイアログの後、手元の入力を先に保存してから `POST …/restore`。`client_save_id` は操作ごとに 1 つで、通信エラーは
    同じ key で 2 回まで送り直す (版は 1 つ)。開いているエディタは `canvas.updated` と同じ読み直しで復元後の本文になる。
  - **ラベル**: 本文を変えられる人 (サーバの `label_revision` と同じ)。空にすると外す。**本文の消去**: owner・admin (DM は作成者、
    `canvasAccess.ts` の `erase`)、現在の版には出さない。「戻せない・監査に残る」確認の後 `DELETE`。消去済みの版は本文も比較も
    出さない。
- **検索** (`ui/CanvasSearch.tsx`): 検索結果に「キャンバス」タブ (「メッセージ / ファイル」の隣)。語と打ち込んだ修飾子 (`in:#`・
  `from:@`・`before:` / `after:` / `on:`) は `q` のまま送り、チップは「作成・更新した人」「チャンネル」「期間」だけ (種類・スレッド内は
  キャンバスに無い。`has:` などは `unresolved` として出す)。語が無く条件も無いときは送らない。抜粋はサーバのプレーンテキストに
  `keywords` で印を付け、画像の参照は「[画像]」と読めるようにする。**⌘K**: 開くたびに `GET /canvases?limit=200` を読み、題名の部分
  一致 (NFKC・大小無視) を会話の候補の後に 6 件まで。題名だけなのでサーバの検索は使わない。
- **画像** (`CanvasEditor.tsx`・`ui/CanvasImage.tsx`): 貼り付け・ドロップ・書式バーの「画像」(ファイル選択) で、**画像だけ**を
  既存の `POST /attachments` に送り、カーソルの位置に `![](attachment:<id>)` を 1 行で入れる (保存は普段の自動保存。サーバが保存時に
  bind)。画像以外は「キャンバスに入れられるのは画像だけです」で断る (設計 §4.10 どおり描画するのは画像だけ。サーバは画像以外も bind
  するが、この端末からは入れない)。**上限**: 本文の `attachment:` の参照 (重複なし) と新しい画像の合計が 100 を超えるときは送らずに
  `too_many_canvas_images` の文言を出す。それでもサーバが 400 を返せば保存ループの「保存できません」に同じ文言が出る。
  - 描画: `GET /attachments/{id}` (メタ、セッション中キャッシュ) → サムネイル (無ければ本体) を認証付きで取り、押すとメッセージの
    写真と同じ拡大表示。読めない参照 (他人の pending、別の会話、消えた添付) は「表示できない画像」。画像以外の添付はダウンロードの
    行。要素は位置ではなく id で key を付ける (上に文を足しても画像を取り直さない)。字句解析は大文字の id も画像にする (Swift の
    `uuidString`。共通フィクスチャは変えていない)。
- **共有とカード** (`ui/CanvasLinkCard.tsx`): ⋯「会話に共有」は投稿できる人だけ (`canvasAccess.ts` の `share`。投稿制限の
  チャンネルでは owner・admin)、共有メッセージがあれば出さない。メッセージ本文の `<server>/c/<id>` (ログイン中のサーバのものだけ。
  `/m/` と同じ) はカード: 題名・会話・最終更新者と時刻・タスクの進捗バー。押すとその会話の「キャンバス」タブで開く。メタは手元の
  一覧 (イベントで最新) を優先し、無ければ `GET /canvases/{id}` をセッション中キャッシュ (§12 の「カード用の軽い API」は作って
  いない。本文ごと返るが 1 キャンバス 1 回)。403 は「メンバーではありません」(中身は何も出さない)、404 は「表示できない
  キャンバス」。押したときは読み直す (参加した後・ゴミ箱から戻った後)。Web は `/c/<id>` の URL で開いたときも同じ (`routes.ts`)。
- **コメント**: 見出しの「コメント」で共有メッセージのスレッドを右のペイン (スマホ幅は全画面、戻るとキャンバス) に開く。共有
  されていない (または共有メッセージが消えた) キャンバスは、その場で `POST …/share` してから開く (§4.13)。投稿できない人には
  共有済みのときだけ出す。
- **テンプレートの管理** (`ui/CanvasTemplatesTab.tsx`、「管理」の「キャンバス」タブ): 非表示を含む全件 (`GET /admin/canvas-templates`)、
  追加・編集 (名前・説明・題名・本文、置き換えの説明付き)・上下の並べ替え (位置を 0 から振り直す)・非表示 / 表示・削除 (追加した
  ものだけ。組み込みには削除ボタンを出さない)。
- **Web でタブを閉じるとき** (§5 の「Web はメモリだけ」を補う): `pagehide` で、入力の残るキャンバスごとに `PUT /content` と同じ
  本文・base・`client_save_id` を `fetch(…, {keepalive: true})` で送る (`CanvasSaver.unloadSave`、`CanvasHub.unload`)。その保存は
  保存ループの送信中として記録するので、ページが bfcache で生き残ればループが同じ key で送り直す (サーバは 1 回として答える)。
  送信中の保存の後に打った文は、その保存の base に新しい key で送る (どちらが先に着いてもサーバがマージする)。keepalive で送れる
  のは 64 KiB までなので、本文 (JSON) が 60,000 バイトを超えるとき・競合の選択待ち・拒否中は `beforeunload` で確認を出す
  (`mustStay`)。sendBeacon はヘッダを付けられない (Bearer) ので使わない。アクセストークンが切れていると 401 で届かない (最後の数秒の
  入力だけ)。Tauri は SQLite に残るので対象外。
- **テスト**: vitest 652 (新規 22: 差分 8、閉じるときの保存 3、字句と画像の挿入 2、画面 9 = 履歴 (一覧・語句の差分・ラベル・復元)・
  owner の消去・共有とカードとコメント・未共有のコメント・非メンバーのカード・画像の貼り付けと 100 件・一覧と ⌘K と検索・タブを
  閉じるとき・テンプレートの管理)。`tests/fakeServer.ts` に版の履歴・復元・ラベル・消去・共有・検索・添付・テンプレートの管理を足した。
- **残したこと**: 範囲に付けるコメント・メンション通知・タスク (Phase 2)。`/c/` カード用の軽い API。iOS / Android の履歴・検索・
  画像・共有 (M45 / M46 の担当)。

## 15. 実装メモ (M45 iOS)

§5 の iOS のうち、閲覧と編集 (ROADMAP の M36)。設計が選択を残していたところと、設計から変えたところ。

- **入口**: 会話のタブ列 (M29 の ChannelTabsRow) の 2 番目に「キャンバス」(Desktop のスマホ幅と同じ順。§5 の segmented の
  Picker ではなく、ピン留め・ファイルと同じタブ)。ピン留め・ファイルと同じく会話の上に重ねるので、下のメッセージの位置・
  既読・下書きはそのまま。開くのは会話のキャンバス、無ければ更新の新しいもの。**最初に開いたものは、他の人の保存で一覧の
  順が変わっても入れ替わらない** (Desktop は一覧の先頭が変わると表示も変わる)。題名のボタンで一覧 (シート)・新規・ゴミ箱。
- **閲覧が既定** (§1)。「閲覧 | 編集」は本文を変えられる人にだけ出す。見出し 3 つ以上で右下に「目次」(メニュー)、引っ張って
  読み直し (If-None-Match)。
- **編集**: 「編集」は本文全体、見出しの ✎ は「このセクションを編集」(シート)。§5 は両方ともシートだったが、全体の編集は
  タブの中で行う (切り替えで閲覧に戻れる)。エディタは TextEditor ではなく UITextView (選択範囲・IME の変換中・Return を
  扱うため)。スマート引用符・ダッシュ・挿入は無効 (`---` が「—」にならない)。書式バーはキーボードの上 (見出し 1〜3・
  箇条書き・チェックリスト・太字・リンク・メンション・区切り線・キーボードを閉じる)。§5 の「画像 (PhotosPicker とカメラ)」は
  M45 では入れていない (表示はする)。
- **セクション編集** (`CanvasText.section` / `relocateSection`): 見出しの行から、同じか上の階層の次の見出しの前 (その前の
  改行は含まない) まで。セクションを差し替えた本文全体を同じ保存ループで送る。マージで本文が変わったら、見出しの行を
  (移ったはずの位置に近いものを) 探し直し、終わりは「元のセクションの次にあった行」までにする。他の人がセクションの末尾に
  足した行はセクションに入り、自分がセクション内に書いた見出しで切れることもない。見出しの行が見つからなければ両端を
  カーソルと同じ規則で動かす。3 端末共通のフィクスチャにはまだ入れていない (Android の M で必要なら切り出す。
  テストは `CanvasTextTests`)。
- **保存ループ** (`Sync/CanvasSave.swift`): Desktop の canvasSave.ts と同じ状態機械・同じ待ち (2 秒、読み直し 0.5 秒、再送
  1 → 2 → 5 → 10 → 30 秒、429 は `retry_after_seconds`)。違い:
  - 送信中に打った本文も、待ちが明けた時点で保存待ち (SQLite の meta `canvas:<id>`) に書く。Desktop は送信中の本文だけを
    残すので、オフラインが長いと送信後に打った分が再起動で消えた。
  - 時計を差し替えられる (`CanvasClock`)。テストは手で進める時計で「1.999 秒では送らない」まで確かめる。
  - 409 の `details` (競合の箇所・今の版) は `ApiClient.saveCanvas` が `CanvasSaveFailure` にして返す (ほかの API の
    `ApiError` には details を持たせていない)。
- **競合の選択**はシート。保存状態が「競合」になるとキーボードを閉じて開く。「あとで」で閉じ、保存状態の「競合」から
  戻れる。チェックだけの人は「相手の版 / あとで」。
- **IME**: 変換中 (`markedTextRange`) は保存ループが本文を差し替えない (§13 と同じ)。書式バーも変換中は効かない。
- **同期** (`Sync/CanvasHub.swift`): 一覧は会話を開いたとき (engine.openChannel) と再接続後。保存待ちはアプリの再起動後、
  接続したときに (キャンバスを開かなくても) 同じ key で送る。会話から外れたら (`Store.removeChannel`) 一覧と保存待ちを消す。
  サインアウトと背面に回るときは入力中の分をすぐ送る。
- **`/c/<id>`**: メッセージ中の自サーバの `/c/` リンクは「📄 キャンバスを開く」と表示し、タップでキャンバスの画面をシートで
  開く (会話へ移るボタン付き)。`GET /canvases/{id}` が 403 なら「メンバーではありません」、404 なら「キャンバスが見つかり
  ません」。リンクのプレビューカードは出さない (`/m/` と同じ)。
- **画像**: `attachment:` の添付を認証付きでサムネイル、サムネイルが無ければ (`thumbnail_not_found`) `content?inline=1`。
  読めなければ「表示できない画像」(タップで再試行)。拡大表示は無い。
- **履歴**: ⋯ の「履歴」で一覧 (作者・種類・時刻・増減の行数・ラベル) と版の表示だけ (§5 の「MVP は閲覧と復元」のうち
  閲覧)。復元・ラベル・消去は Desktop (M44)。
- **残したこと**: ~~画像の挿入 (PhotosPicker・カメラ)、検索の「キャンバス」、履歴の復元、会話への共有とコメント (共有
  メッセージのスレッド)、スナップショットテスト~~ (M58 で済み、下)。~~キャンバスのオフライン閲覧 (§5 の「SQLite に canvases」)、
  版の本文の消去 (owner・admin)~~ (M74 で済み、§19.1)、~~プッシュからの入口~~ (M73)。残り: サイドバーの「キャンバス」ビュー
  (Desktop の CanvasesView。iOS は会話のタブ・検索・`/c/`・プッシュから開く)。
- **M58 (iOS、2026-10-01)**: Desktop の M44 (§14) にそろえた。サーバの変更なし。
  - **画像**: 書式バーの「画像」(メニュー: 写真を選ぶ・写真を撮る)。写真は作成欄と同じく JPEG にして `POST /attachments`、
    カーソルの位置に `![](attachment:<id>)` を 1 行で入れる (打った文字と同じ経路: 自動保存・マージ・取り消しに乗る。
    カーソルを置いていなければ末尾)。本文の参照と新しい画像が 100 を超えるときは送らずに `too_many_canvas_images` の文言。
    アップロード中は書式バーの上に「画像をアップロード中… (n)」。セクションの編集シートでも使える。
  - **検索**: 検索結果のタブに「キャンバス」(メッセージ・ファイルの隣)。語・修飾子・人・会話・期間を送り、種類・スレッド内の
    チップは出さない (人のチップは「作成・更新した人」)。抜粋はメンションを名前に、画像を「[画像]」にして語に印。押すと
    検索の中でそのキャンバスを開く (戻ると結果。「会話へ」で会話に移る。`/c/` のシートと同じ `CanvasOpenView`)。
  - **履歴** (`UI/CanvasHistory.swift`、差分は `UI/CanvasDiff.swift` = `canvasDiff.ts` の移植): 一覧 → 版の画面
    (「前の版と比較 / 現在の版と比較 / この版の本文」、既定は前の版)。下のバーに「名前を付ける」(空で外す、80 字) と
    「この版に戻す」(確認の後、入力中の分を先に保存、key 1 つで通信エラーと 5xx は 2 回まで送り直す)。どちらも本文を
    変えられる人だけ。戻すと一覧に戻り、新しい版を読み直す。
  - **共有とコメント**: ⋯ に「会話に共有」(投稿できる人・未共有のとき)。バーの吹き出し「コメント」で共有メッセージの
    スレッドを開く (会話のタブからは会話の上に、`/c/` のシートと検索からはその中に積む)。未共有なら先に共有する。投稿
    できない人には共有済みのときだけ出す。`CanvasRights.share` (Desktop の `share` と同じ。guest も投稿できる会話では共有できる)。
  - **テスト**: `CanvasCatchUpTests.swift` (差分 9 = Desktop の canvasDiff.test.ts の移植、履歴の「前の版」、画像の行と参照の
    数、抜粋、共有とコメントの権限、要求の本文 (共有・復元・ラベル・検索の query)、コメントの共有、復元の再送で同じ key)、
    スナップショット (履歴の一覧・比較 2 種・検索の「キャンバス」・コメントの入口・書式バーの「画像」、ライト / ダーク)。

## 16. 実装メモ (M46 Android)

§5 の Android のうち、表示・編集・自動保存 (ROADMAP の「M37 Android の閲覧と編集」、実際の番号は M46)。Desktop / Web の M43 (§13) と
同じふるまい・同じ文言にした。設計が選択を残していたところと、設計から変えたところ。

- **入口**: 会話のタブ列の 2 番目に「キャンバス」(メッセージ | キャンバス | ピン留め | ファイル)。ピン留め・ファイルと同じく
  タイムラインの上に重ねるページで、見ている間は既読にしない。開くのは会話のキャンバス、無ければ更新が新しいもの。題名の
  ボタンで一覧 (ボトムシート: 題名・更新者と時刻・「タブ」・進捗「3/8」、「新しいキャンバス」「ゴミ箱」)。どのキャンバスを
  開いているかは戻るスタックの `Route.Channel.canvasId` に入る (回転しても残る)。一覧は会話を開いたときと再接続後に読み、
  Store には保存しない (Desktop と同じ)。
- **表示** (`ui/CanvasBody.kt`、`ui/CanvasPane.kt`): `parseBlocks(body, canvas = true)` (`ui/BodyTokenizer.kt`) にタスク・画像・
  区切り線と見出しの行番号。メッセージの描画 (`MessageBody.kt`) を `bodyInline()` と `BodyBlockView()` に分けて使い回す
  (メンション・リンク・カスタム絵文字・`/m/` と `/c/`)。LazyColumn に 1 ブロックずつ。見出しが 3 つ以上なら目次 (スマホは
  バーのボタンのメニュー、840 dp 以上は右の列)。画像は `GET /attachments/{id}` で種類を見てからサムネイル (無ければ
  `content?inline=1`) を認証付きで読み、タップで既存の ImageViewer。読めないものは「表示できない画像」。
- **閲覧 / 編集**: 既定は閲覧 (§1、Desktop のスマホ幅と同じ)。本文を変えられる人だけ「閲覧 | 編集」が出る。編集は Markdown の
  テキスト欄 (BasicTextField + TextFieldValue) と書式バー (見出し 1〜3・太字・箇条書き・チェックリスト・番号・引用・リンク・
  メンション・区切り線)、`@` 補完 (`@channel` / `@here` は出さない)、Enter でリスト・チェックリスト・引用の続き (空の項目で
  終わる)。600 dp 以上はバーを 1 行に、840 dp 以上は編集とプレビューの 2 列、閲覧の横に目次。
- **セクション編集** (§5 の「既定はセクション編集」): 閲覧で見出しの右の鉛筆「このセクションを編集」から、その見出しの下の行
  (次の見出しまで、見出しの行は含まない) をシートで編集する (`CanvasSections`、`ui/CanvasText.kt`)。書いた行を元の本文に
  戻した全体を保存するので、ほかの区間の同時編集はサーバのマージで残る。見出しは「見出しの行の文字列 + 同じ行の何番目か」
  で探し直す。見出しの行そのものはシートでは変えない (変えると探し直せないため。全体の編集で変える)。シートに見出しを書いた
  ときは、閉じるまでマージ結果に差し替えない (その見出しで区間が切れるため。本文は次の保存でマージされる)。相手が見出しを
  消したり変えたりしたら「見出しが変わったため、セクションの編集を閉じました」と出して閉じる。本文全体の編集もいつでも使える
  (設計の「全体の編集は注意書き付き」は付けていない。10 万字まで打ち込みで重くならないことは未測定)。セクションの切り出しは
  3 端末の共通フィクスチャにまだ入れていない (iOS が同じ規則にするなら `canvas_markdown.json` に足す)。
- **保存ループ** (`sync/CanvasSave.kt` の `CanvasSaver`): `src/sync/canvasSave.ts` の移植で状態・遷移・再送の間隔 (1 → 2 → 5 →
  10 → 30 秒、429 は `retry_after_seconds`、再接続で即時) も同じ。メインスレッドの scope で動き、タイマーは差し替えられる
  (JUnit は手で進める時計)。違い:
  - **IME**: 変換中 (`TextFieldValue.composition` が null でない) は差し替えない。変換が文字を変えずに確定した (かなのまま
    確定) ときは、次の打鍵まで相手の変更が画面に出なかったので、確定したら `replaceable()` で読み直す (保存するものが
    無いときだけ)。Desktop の onCompositionEnd には無い (直すなら同じ手当て)。
  - **メンションの往復**: 編集欄は `<@uuid>` を `@username` で見せ、保存で戻す。メッセージの作成欄の規則 (`@` の前が空白か
    「(」) だと「まとめます。@android2」のように日本語の直後のメンションが最初の保存でただの文字になった (エミュレータで
    見つけた)。キャンバスでは `@` の前が英数字・`.`・`_`・`-`・`@` 以外なら戻す (`CanvasText.encodeMentions`。メール
    アドレスはそのまま)。**Desktop の `encodeMentions` (mentions.ts) も同じ規則なので同じ問題がある** (M46 では触っていない)。
  - 保存待ちの保持は Room の `meta` 表の `canvas:<id>` (Desktop の Tauri と同じキー、スキーマは変えていない)。打った時点で
    書く (2 秒の待ちの間にプロセスが終わっても残る)。起動後の接続で `CanvasHub.online()` が、画面に出ていないキャンバスの分も
    同じ key で送る。背面に回ったときは `flushAll()`、ログアウトは送ってから最大 3 秒待つ。
  - 401 は再試行に含めた (ApiClient が refresh するか、セッションが終わってサインアウトする)。
- **エラーの `details`**: `ApiException.Api` にエラー封筒の `details` を持たせた (409 の現在の本文、429 の待ち時間)。
  `If-None-Match` の 304 は `requestRaw` が通す (キャンバスの GET だけが送る)。
- **競合**: 自分の版 / 相手の版 / 両方残す / あとで (チェックだけの人は相手の版 / あとで)。状態表示の「競合」を押すと戻る。
  `canvas_base_expired` は 2 つの本文を並べ、「自分の本文をコピー」「今の本文にする」「自分の本文で上書き」(本文を変えられる人)。
  403 / 422 は「保存できませんでした: 理由」と「本文をコピー」、次の入力で再開。ゴミ箱に移されたら (`canvas.deleted` か 404)
  保存しない。
- **⋮**: 題名を変更、会話のキャンバスにする / から外す (ほかにタブが無いとき)、本文を編集できる人 (DM では出さない)、履歴、
  本文をコピー、ゴミ箱に移す (確認あり)。ゴミ箱からの「戻す」は一覧の「ゴミ箱」。
- **履歴**: 読むだけ (版の一覧: 作者・時刻・種類・ラベル・+/− 行数、押すとその版の本文)。比較・復元・ラベルは作らなかった
  (Desktop の M44)。
- **`/c/<id>`**: メッセージとキャンバスの本文の `<server>/c/<id>` を「📄 キャンバスを開く」(ラベル付きのリンクはラベル) に
  して、押すと `GET /canvases/{id}` で会話を調べ、その会話の「キャンバス」タブで開く (通知・パーマリンクと同じ着地)。
  403 は「このキャンバスの会話のメンバーではありません」、404 は「キャンバスが見つかりません」。カード表示は作っていない。
- **Compose の落とし穴** (§5 の「version を渡す」と同じ種類): `CanvasSaver` は同じオブジェクトのまま中身が変わるので、状態を
  読む子 (保存状態の表示、注意の行、⋮) は `revision` を collect するか状態を引数でもらう。シートの中の保存状態と、読み込み中に
  描いた「チェックだけ付けられます」の行が更新されなかった (エミュレータで見つけて直した)。
- **テスト** (JUnit): `CanvasMarkdownTest` (共通フィクスチャ `apps/shared/canvas_markdown.json` の字句解析・チェック・カーソル、
  目次、書式バー、Enter の続き、メンションの往復、セクションの切り出しと差し替え・探し直し) と `CanvasSaveTest` (2 秒の待ち、
  マージの差し替え、保存中の入力と side 版、IME の間は差し替えず確定で出す、同じ key の再送 (応答が失われた場合も版は 1 つ)、
  429 / 5xx、再接続、競合の 3 択、base の期限切れの 2 択、拒否と再開、ゴミ箱、オフラインの初回読み込み、If-None-Match の
  読み直しと入力中は読まない、再起動後の再送 (送信中と未送信)、権限の表、CanvasHub の一覧・version・ゴミ箱・会話から外れた
  とき・起動後の再開)。偽のサーバ `FakeCanvasServer` のマージは行単位の代用品 (本物のマージはサーバのテスト)。
- **エミュレータで確かめたこと** (Pixel_9、dev サーバ、android1 / android2): タブと一覧、チェックが即保存され android2 の
  チェックが数秒で反映、別の行の同時編集が両方残る、同じ語で競合 →「両方残す」、Gboard の日本語入力 (ローマ字で変換中に
  android2 が別の行を変えても変換が崩れず、確定後に反映)、チェックだけの人の競合は「相手の版」だけ、オフラインで打って
  プロセスを終了 → 起動後に保存、テンプレートから作成・ゴミ箱と戻す・題名の変更・履歴、`/c/` のリンク (メンバーでない
  キャンバスは注意)、ライト / ダーク、横向き (1 行のバー) と 840 dp 以上 (2 列と目次)。
- **M58 で足したこと** (2026-10-01、Desktop の §14 にそろえた。サーバ変更なし):
  - **画像**: 書式バーの「画像」(リンクの次) → 「写真を選ぶ」(フォトピッカー、画像だけ・10 枚まで) /「カメラで撮る」(作成欄と同じ
    FileProvider の `camera/`、`rememberCameraCapture` に切り出して共用)。`POST /attachments` の後、カーソルの位置に
    `![](attachment:<id>)` を 1 行で入れる (`CanvasText.insertImageLine`、Desktop と同じ文字列)。書式バーと同じ `apply` → 保存
    ループなので自動保存・マージに乗る。編集欄を閉じた後に終わったアップロードは本文の末尾に入れる。参照 (重複なし) と新しい
    画像の合計が 100 を超えるときは送らずに `too_many_canvas_images` の文言。画像以外の種類が返ったら「キャンバスに入れられる
    のは画像だけです」。アップロードした画像のメタはセッション中キャッシュ (すぐ描ける)。
  - **検索**: 検索結果に「キャンバス」タブ (メッセージ / ファイル の隣)。`q` はそのまま、チップは「作成・更新した人」「チャンネル」
    「期間」だけ。語も条件も無いときは送らない。抜粋はメンションを名前にし、画像の参照は「[画像]」、`keywords` で強調。押すと
    その会話の「キャンバス」タブで開き、「検索結果に戻る」が残る (`MainNav.openCanvasFromSearch`)。
  - **履歴** (`ui/CanvasHistory.kt`、全画面。スマホは一覧 → 版、840 dp 以上は並べる): 版の一覧 (作者・時刻・種類・`+n −m`・名前・
    「現在の版」、「さらに読み込む」) と「前の版との差分」(既定)・「現在の版との差分」・「この版の本文」。差分は `ui/CanvasDiff.kt`
    (canvasDiff.ts の移植: Myers と語句の色付け、3 行より長い共通部分は畳む)。「この版に戻す」は確認の後、入力を保存してから
    `POST …/restore` (key は 1 回の操作に 1 つ、通信エラーは同じ key で 2 回まで)。名前を付ける / 変更 / 外す (本文を変えられる
    人)、本文の消去 (owner・admin、DM は作成者。現在の版には出さない)。**落とし穴**: 語句の正規表現に `(?U)` を付けると Android の
    ICU が受け付けず履歴で落ちた (JVM の JUnit は通る。エミュレータで見つけた)。空白は文字クラスで書き、文字種は `\p{script=Han}`。
  - **共有とコメント**: ⋮「会話に共有」(投稿できる人、共有メッセージが無いとき)。見出しバーの「コメント」は共有メッセージの
    スレッドを開く (戻るとキャンバス)。未共有なら投稿できる人にだけ出し、押すと共有してから開く。共有メッセージが手元に無ければ
    `GET /messages/{id}` で読んで Store に入れる (スレッドの親として出すため)。消えていたら共有し直す。
  - **`/c/` のカード**: メッセージの段落で、その行が自サーバの `/c/` リンクだけならカード (`CanvasCards.split`、題名・会話・
    最終更新者と時刻・タスクの進捗バー)。文中のリンクは今までどおり「📄 キャンバスを開く」。メタは Store の一覧を優先、無ければ
    `GET /canvases/{id}` をセッション中キャッシュ。403 は「メンバーではありません」、404 は「表示できないキャンバス」(押すと読み
    直す)。読み込み中も同じ高さ。`/c/` リンクにはリンクのプレビューを出さない。
  - **エミュレータで確かめたこと** (ChikuwaChat_Pixel_9、android1): メンバーでないカード、履歴の前の版 / 現在の版との差分と
    語句の色、名前「v2-draft」、確認の後の復元 (version 3 になり差分が出る)、「コメント」で共有してスレッド (カード付きの
    共有メッセージ)、メッセージのカードから開く、フォトピッカーで画像を入れて自動保存・閲覧で表示、検索の「キャンバス」と
    「検索結果に戻る」。カメラは実機で未確認。
- **残したこと**: ~~キャンバスのオフライン閲覧~~ (M74、§19.2)、~~キャンバスのプッシュから開く導線 (Phase 2)~~ (M73)、10 万字近い本文での編集欄の重さの測定、
  画像の貼り付け (キーボードの画像)、カメラの実機確認。

## 17. 表の編集画面 (M57、2026-10-01)

キャンバスの表は今まで Markdown の記号 (`| a | b |` と `| --- |`) を直接書くしかなかった。編集欄のツールバーに「表」を足し、
マスで表を直せるようにする。本文は今までどおり Markdown なので、サーバ・自動保存・マージ・履歴は変えない。

- **入口**: 編集欄のツールバーの「表」。カーソルが表の中にあればその表を、なければカーソルの行の後に 3 列 × 2 行の新しい表
  (見出し「列1〜列3」) を入れて、その表を表の編集画面で開く。前後に文字があれば空行を挟む。
- **表の編集画面**: 見出しと各行のマスを直接書き換える。行を上・下に足す、消す、上下に動かす。列を左・右に足す (見出しは
  「列N」)、消す (最後の 1 列は消せない)、列ごとの位置揃え (なし / 左 / 中央 / 右)。「完了」で本文の表の行をまとめて書き換える
  (1 回の編集として自動保存と元に戻すに乗る)。「キャンセル」で何も変えない。
- **読み書きの規則** (3 端末で同じ。共通のケースは `apps/shared/canvas_table.json`、生成は `gen_canvas_table.py`):
  - 読む: 外側の `|` を外し、エスケープされていない `|` で分け、`\|` は `|` として読み、前後の空白を取る。本文の行は見出しの
    列数に合わせて足りなければ空、多ければ切る。区切りの行から位置揃えを読む (`:---` 左、`:---:` 中央、`---:` 右、`---` なし)。
  - 書く: `| a | b |` (区切りは空白 1 つ)、区切りの行は `| --- | :--- | :---: | ---: |`。マスは 1 行 (改行は空白に)、`|` は
    `\|` に、前後の空白を取る。
  - 見つける: カーソルの行を含む「`|` で始まる行が続き、2 行目が区切りの行」のまとまり。行頭に `|` の無い表は対象にしない
    (書き戻すときは必ず `|` 付きになる)。
- **端末**: Desktop / Web はダイアログ (表の形のマス、Tab で次のマス)。iOS / Android は全画面 (行ごとのカードでマスを縦に並べる。
  横にスクロールする表の形も見られる)。
- **iOS の実装メモ** (`UI/CanvasTable.swift` は gen_canvas_table.py の移植、画面は `UI/CanvasTableEditor.swift`): 書式バーの、書き込みの決まり** (3 端末で揃える、2026-10-01): 新しい表は「完了」のときに初めて本文に入る (開いただけでは入らない。
  「表」(tablecells) で全画面。既定は「行ごと」(見出しのカードが先頭で、列ごとの ⋯ に位置揃え・左/右に列を追加・列を削除、、入る場所は開いたときのカーソルの行。その行がほかの人の編集で動いていれば同じ中身の近い行の後)。「キャンセル」は何も変えない。
  各行のカードの ⋯ に 上に行を追加・下に行を追加・上へ・下へ・行を削除、末尾に「行を追加」)、切り替えで「表の形」(縦横、既にある表を直さずに「完了」しても何も書かない (書式の整え直しもしない)。書き戻しは、開いたときに控えた行がまだ同じ場所に
  スクロールする読むだけのマス)。セクションの編集でも使える (見せている範囲の中で探して入れる)。、あればそこを置き換え、無ければ同じ行のまとまり (表 1 つとして) を近くから探して置き換え、表そのものが変わっていれば
  - **新しい表は「完了」で初めて入れる** (開いた時点では本文を変えない)。キャンセルで消し戻す必要が無く、空の表が自動保存で、(ほかの人がマスを直した・行を足した等) 上書きせず、今その場所にある表の下 (無ければ元の場所) に新しい表として入れる。
    他の人に一瞬見えることも、履歴が 2 回分になることも無い。見た目は「入れてから開く」と同じ。、- **Desktop / Web の実装** (M57): 規則は `apps/desktop/src/ui/canvasTable.ts` (gen_canvas_table.py の移植)、ダイアログは
  - **書き戻し**は開いた時の行の範囲で表を探し直す。その範囲が開いた時の行と同じならそこを置き換える。違えば (上で行が増減した)、`CanvasTableDialog.tsx`、入口は `CanvasEditor.tsx` のツールバー「表」(Table アイコン)。書き戻しは作曲欄と同じ
    同じ行のまとまりを、開いた位置が移ったはずの所 (`CanvasText.preserveCaret`) に近いものから探して置き換える。見つからない、`replaceThroughBrowser` (変わった範囲だけを `execCommand("insertText")`) なので ⌘Z / Ctrl+Z で 1 回で戻り、自動保存とマージにも
    (編集中に他の人が表を変えた・消した) ときは**上書きせず**、今そこにある表の後 (無ければ元の位置) に新しい表として入れる。、そのまま乗る (この変更で編集欄のほかのツールバー操作も ⌘Z で戻せるようになった)。ダイアログ: 開くと見出し 1 を選んだ状態、Tab /
    何も変えずに「完了」なら本文は変えない (`|a|b|` を `| a | b |` に整形するだけの保存はしない)。、Shift+Tab でマスを移動、最後のマスで Enter で行を追加、⌘/Ctrl+Enter で完了、各行・各列の「…」メニュー (マスから Shift+F10 /
  - 書き込みは打った文字と同じ経路 (テキストビューの `replace` → 保存ループ) なので、自動保存・マージ・元に戻すに乗る。、メニューキーでも開く。見出しでは列のメニュー)、マスのラベルは「見出し 1」「2 行目 1 列」(見出しを 1 行目と数える)。外側の
    メンションは画面上の `@名前` のままマスに出て、書き戻しで `<@uuid>` に戻、クリックでは閉じない (編集が消えるため)。Esc と × は「キャンセル」。表が変わっていて新しい表として入れたときは通知で知らせる。
- **新しい表と書き戻し** (3 端末で揃えた決定): 新しい表は「完了」のときに初めて本文に入る (開いた時点では入れない。
  「キャンセル」は何も変えない)。既にある表を変えずに「完了」したら何も書かない (`|a|b|` を `| a | b |` に整形しない)。
  書き戻しは、開いたときの行がその位置にまだそのままあればそこを置き換え、無ければ同じ行の並びを近くで探して置き換え、
  表がもう開いたときのままで無ければ (相手が行を足した・消した) 上書きせず、その位置の表の後 (表が無ければその位置) に
  編集した表を別のまとまりとして入れる。
- **Android の実装メモ** (M57): 規則は `ui/CanvasTable.kt` (`gen_canvas_table.py` の移植。Python の `strip()` / `\s` と同じ
  空白の集合で切る。区切りの行の判定は正規表現でなく同じ意味の手書き)、`CanvasTableTest` が `canvas_table.json` の全ケースと
  書き戻し (位置ずれ・相手の変更・新しい表の位置) を確かめる。画面は `ui/CanvasTableEditor.kt` の全画面ダイアログ:
  「行ごと」(先頭に「見出しと列」のカード: 見出しの名前・位置揃え (なし / 左 / 中央 / 右)・⋮ の「左に列を追加」「右に列を
  追加」「列を削除」(最後の 1 列は押せない)、続いて行ごとのカードに見出しを名札にしたマス、⋮ に「上に行を追加」「下に行を
  追加」「上へ」「下へ」「行を削除」、末尾に「行を追加」) と「表の形」(メッセージと同じ表の描画で横にスクロール)。
  「表」はツールバーの最後 (区切り線の後)。セクションの編集シートでも使える (行番号はセクションの中で数える)。表の編集は
  編集欄の文字 (メンションは `@username`) に対して行い、「完了」は書式バーと同じ経路 (`apply` → 保存ループ) で書いてすぐ
  保存する。相手の変更と重なって別の表として入れたときは「表がほかの人に変更されていたため、編集した表を別の表として
  入れました」。戻るキーは変更があれば「表の変更を破棄しますか？」。編集中の表は回転しても残る (`rememberSaveable`)。

## 18. Phase 2 (M72)

2026-10-02、利用者の回答「推奨の案で」。§4.6・§4.11・§9 の Phase 2 のうち、メンション通知・編集中の表示・チェックリストからタスク
(TASKS.md のタスクを使う。2 つ目のタスクの仕組みは作らない) を入れる。範囲に付けるコメントは入れない。M72 はサーバと Desktop / Web、
M73 は iOS と Android (§18.5)。

### 18.1 メンション通知

- **何を数えるか**: 本文の `<@uuid>` と `<@group:uuid>` (グループは保存の時点の有効なメンバーに展開)。`<!channel>` / `<!here>` は
  キャンバスでは通知しない (M43 から補完にも出していない。会話全員に保存のたびに飛ぶのを避けるため)。メッセージと同じく本文全体
  (コードブロックの中も) を見る。
- **いつ**: head の本文が変わる保存 (直接の保存とマージ) と作成で、「保存後の本文でメンションされている人」から「保存前の head の
  本文でメンションされていた人」を引いた人だけに 1 回。すでにメンションされている人に、同じキャンバスで 2 つ目のメンションを足しても
  通知しない。消してから足し直すと、足した保存でもう一度届く。版の復元・チェックだけの保存では出さない (復元は昔の本文を戻すだけで、
  新しく呼んだわけではないため)。
- **誰に**: その会話のメンバー (キャンバスを読める人) で、保存した本人以外の有効なユーザー。1 回の保存で 50 人まで (メッセージの
  `MAX_MENTIONS` と同じ)。メンバーでない人の `<@uuid>` は表示されるだけ。
- **イベント**: `canvas.mentioned` (audience user、seq なし) `{canvas_id, channel_id, rev_id, title, by_user_id}`。保存と同じ
  トランザクションで outbox に入る。保存の再送 (`client_save_id`) は版を作らないのでイベントも増えない。(canvas, rev, user) で 1 つ。
  §4.6 の `by` は他のイベント (task.assigned) に合わせて `by_user_id` にした。題名は通知の文に使う (メタなので載せてよい)。
- **プッシュ** (PushPlanner、`kind = canvas`): タイトル「キャンバス」、サブタイトル「#チャンネル」(DM は無し)、本文「〇〇 が「題名」で
  あなたをメンションしました」(`PUSH_INCLUDE_CONTENT=false` なら「キャンバスでメンションされました」)。`channel_id` と `canvas_id`
  (APNs の本体と FCM の data) でそのキャンバスを開く。`collapse_key = canvas:<canvas_id>`。メッセージのメンションと同じ判定: その会話の
  level が none・ミュート中・DND・別端末でアクティブなら出さない (level が mentions でも出す。メンションなので)。計画の時点で
  キャンバスがゴミ箱にある・本人が会話から抜けていれば出さない。(event, device) ごとに 1 件 (既存の一意性)。
- **アクティビティには入れない (M72)**。アクティビティの項目 (`ActivityItem`) は `message` が必須で、配布済みの iOS / Android は
  知らない種類の項目を含む一覧を読めない (一覧ごと失敗する)。キャンバスの項目を足すなら `canvas_mentions` の表と、古い端末に返さない
  仕組み (端末の版) が要るので、要望が出てから。それまではプッシュと、アプリを開いている端末の通知だけ (Desktop / Web はデスクトップ
  通知。イベントは条件に関係なく届くので、DND・一時停止・その会話がミュート / なしの判定は端末がする。押すとそのキャンバス)。

### 18.2 編集中の表示 (`canvas_presence`)

- **WS フレーム** (揮発。DB に書かない。typing と同じ中継):
  - 端末 → サーバ: `{type: "canvas_presence", canvas_id, editing: bool, section?: string | null}`。`section` はカーソルのある見出し
    (120 字まで。無ければ null)。
  - サーバ → 端末: `{type: "canvas_presence", canvas_id, channel_id, user_id, editing, section}`。そのキャンバスの会話の、送った本人
    以外のメンバーに届く。
- **サーバ**: キャンバスがあり (ゴミ箱でない)、送った人がその会話のメンバーのときだけ中継する。1 接続・1 キャンバスにつき、同じ内容
  (`editing`・`section`) は 2 秒に 1 回まで (`typing_min_interval_seconds`)、内容が変わったら (編集をやめた・見出しが変わった) すぐ。
  接続が切れたら、その接続が最後に `editing: true` を送ったキャンバスに `editing: false` を中継する (ウィンドウを閉じた・落ちたときに
  早く消える)。接続ごとに覚えるのは 20 キャンバスまで。プロセス内の状態だけ (presence と同じく、複数プロセスでは Redis の後)。
- **端末**: 編集欄にフォーカスがあって打っている間 `editing: true` を送り、見出しが変わったらすぐ、そのままなら 20 秒ごとに送り直す。
  フォーカスが外れた・画面を閉じた・別のキャンバスにしたら `editing: false`。受けた側は 45 秒送り直しが無ければ消す (typing の 5 秒
  ではなく、考えながら書く間を見込んで長め)。自分のフレームは来ない。
- **Desktop / Web の表示**: キャンバスの見出しバーに編集中の人のアイコン (3 人まで重ね、残りは「+N」) と「〇〇 が編集中」
  (2 人なら「〇〇、△△ が編集中」、3 人以上は「〇〇 ほか N 人が編集中」)。ツールチップに人ごとの見出し (「〇〇: TODO」)。
  閲覧だけの人にも見せる (誰かが書いている最中だと分かる)。
- 範囲 (カーソルの位置) の共有と、相手のカーソルの表示はしない (リアルタイム共同編集の段階、§9 2.)。

### 18.3 チェックリストからタスクを作る

- **入口 (Desktop / Web)**: 表示 (閲覧・プレビュー) のチェックリストの未完了の行にホバーで出るボタン「タスクにする」(タッチでは常に
  薄く出す)。タスクのダイアログ (TASKS.md §6) を次の値で開く:
  - 題名: 行の文 (`- [ ] ` を外し、メンションは名前に、`📅 YYYY-MM-DD` は外す。200 字まで)
  - 期限: 行の `📅 YYYY-MM-DD` (議事録のテンプレートの書き方、§4.12)
  - 担当者: 行の中でメンションされた人 (グループは展開しない)。追加先がボード (や共有する DM) のときだけ。サーバがメンバーか確かめる
  - 追加先: メッセージの「タスクにする」と同じ規則 (チャンネルのボードに足せればそのボード、DM・グループ DM のキャンバスは自分の
    タスクで、担当者を選べばその DM で共有 (L9))
- **API**: `POST /tasks` に `source_canvas_id` と `source_canvas_line` (行そのもの、`- [ ] …`、1000 字まで) を足した。両方そろって
  いること、`source_message_id` と同時でないこと (`400 task_invalid_source`)。キャンバスは読めるもの (ゴミ箱でなく、その会話の
  メンバー) でなければ `404 canvas_not_found`。ボードのタスクはそのチャンネルのキャンバスからだけ (`400 task_invalid_source`。
  メッセージと同じく、別の会話の本文をボードのメンバーに見せないため)。行は今の本文にあるチェックリストの行でなければ `400
  task_invalid_source` (端末は送る前に手元の入力を保存する)。
- **持つもの**: `tasks.source_canvas_id` (キャンバスが完全に消えたら NULL。`ON DELETE SET NULL`) と `tasks.source_canvas_excerpt`
  (行の文を 1 行のプレーンテキストにしたもの。200 字まで。メンションは名前)。移行 0065。
- **出力**: `TaskData.canvas_source` = `{canvas_id, excerpt}` か null (キャンバスから作ったタスクだけ)。`source` (メッセージ) とは
  別の項目にした: 配布済みのスマホは `source.message_id` が null だと「元のメッセージは削除されました」と出すため。完全に消えた
  キャンバスは `canvas_id` が null (端末は「元のキャンバスは削除されました」)。ゴミ箱のキャンバスは id のまま (開くと「表示できない
  キャンバス」)。
- **リンクは一方向**: キャンバスのチェックを付けてもタスクは完了にならず、タスクを完了にしてもチェックは付かない。行を書き換えても
  抜粋は変わらない (作った時の写し。題名と同じ扱い)。双方向にするには行の識別子 (本文の中の印) と保存のたびの照合が要り、マージ
  (§4.4) と競合しやすいので入れない。キャンバスの行にタスクの有無も出さない (後で必要なら `GET /tasks?canvas_id`)。
- **権限・通知・同期**は TASKS.md のまま (作る人はそのボードに投稿できる人、担当に加えた人への `task.assigned` など)。

### 18.4 入れないもの (後で)

- **範囲に付けるコメント**: 入れない。会話への共有メッセージのスレッド (§4.13) が議論の場のまま。範囲の固定 (本文の編集・マージで
  ずれない印) の設計が要るので、要望が出てから。
- アクティビティのキャンバスの項目 (§18.1)、キャンバスの行とタスクの双方向の同期 (§18.3)、`@channel` の通知。
- §4.11 の `canvas_tasks` (本文から導出する「自分のタスク」の一覧): TASKS.md のタスクがあるので作らない。チェックリストのうち
  担当や期限を追いたい行だけをタスクにする (§18.3)。

### 18.5 M73 (iOS / Android) の範囲

- `kind = canvas` のプッシュ: `canvas_id` でそのキャンバスを開く (会話の「キャンバス」タブ)。`canvas:<id>` ごとに 1 つの通知。
  アプリを開いている間の `canvas.mentioned` は通知 (DND・ミュートでは出さない)。
- `canvas_presence`: 編集のシートを開いている間 `editing: true` (20 秒ごと)、閉じたら false。見出しに「〇〇 が編集中」。セクション
  編集なら `section` はその見出し。45 秒で消す。
- チェックリストの行の長押し (iOS は contextMenu、Android はメニュー) に「タスクにする」。値の決め方は §18.3 と同じ (規則は Desktop の
  `ui/canvasTasks.ts` の移植)。タスクの詳細に `canvas_source` (「元のキャンバス」と抜粋、押すと開く、消えていれば「元のキャンバスは
  削除されました」)。
- **Android (M73)**: 編集欄 (全体・セクションのシート) にフォーカスがある間、フォーカス・入力・見出しの変化で送り、2 秒ごとに
  確かめる (同じ内容は 20 秒ごと、見出しの変化は前のフレームから 2 秒後。sync/CanvasPresence.kt)。フォーカスが外れた・編集欄が
  消えた・アプリが裏に回ったら false。「編集中」はバーの下の行 (アイコン 3 人まで + 「+N」、押すと人ごとの見出し)、セクションの
  シートにも出す。「タスクにする」は未完了の行の長押しメニュー (と TalkBack の操作)。作る前にキャンバスの入力を保存し終える
  (5 秒まで待つ)。タスクのカードの「元のキャンバス」の印は押すとそのキャンバスを開く。アプリを開いている間の `canvas.mentioned` は
  スナックバーと端末の通知 (`canvas:<id>`、会話の既読では消えない)。
- **iOS (build 71)**: 通知を押すと会話を開いて「キャンバス」タブでそのキャンバスを選ぶ (`AppController.canvasOpen`。会話が端末に
  無ければキャンバスのシート)。前面の `canvas.mentioned` は下の通知 (「📝 〇〇 が「題名」であなたをメンションしました」、押すと開く。
  会話の level が none・ミュート・DND、そのキャンバスを表示中なら出さない)。編集中は編集欄にフォーカスがある間 (全体の編集と
  セクションのシート) に送り、入力・カーソル移動では 2 秒に 1 回だけ見出しを見て、5 秒ごとの確認で 20 秒ごとに送り直す。フォーカスが
  外れた・画面を閉じた・アプリが背面に回ったら false。受けた側は見出しバーの下の 1 行 (アイコン 3 つ + 「+N」と「〇〇 が編集中」、
  VoiceOver は人ごとの見出しも読む)。「タスクにする」は閲覧の未完了の行の長押し (contextMenu) と、編集欄の長押しの編集メニュー
  (カーソルの行が未完了のチェックリストのとき)。送る前に手元の入力を保存する。カードには元のキャンバスの印、ボードのカードの
  メニューに「元のキャンバスを開く」、タスクの詳細に「元のキャンバス: 題名」と抜粋と「キャンバスを開く」。`canvas_source` は
  形が違っても読み飛ばす (タスクは落とさない)。

## 19. スマホのオフライン閲覧と版の本文の消去 (M74、2026-10-02)

§5 の「ストア: SQLite に canvases (オフライン閲覧)」と、Desktop の M44 (§14) / Android の M58 にある版の本文の消去。サーバの変更なし。

### 19.1 M74 iOS (build 72)

- **持つもの**: SQLite の表 `canvases (id, channel_id, saved_at, meta, body)`。サーバから本文付きのキャンバスを受け取るたび
  (開いたときの読み込み・読み直し、保存の答え、409 の `head`) に書く。古い版 (`version` が小さい) は持っているものを上書きしない。
  304 は `saved_at` だけを進める (今もその版が最新)。起動時に読むのはメタだけで、本文は開くときに読む。`canvas.updated` の
  メタだけを被せたもの (`applyMeta`) は書かない (本文と版がずれるため)。
- **範囲**: メンバーの会話のものだけ。上限は **200 件**。超えたら `saved_at` (最後にサーバから受け取った / 確かめた時刻) の
  古いものから消す。消すのは: 会話から外れた・消えた (`Store.removeChannel`。保存待ちと一緒)、起動時にメンバーでない会話の
  もの、ゴミ箱 (`canvas.deleted`・自分で移したとき、`CanvasHub.trashed`)、読み込みが 404。サインアウトはアカウントの DB ごと消える
  (保存待ちと同じ)。
- **開くとき**: 持っていれば、まずそれを出し (閲覧も編集もすぐできる。次の保存の base はその `head_rev_id`)、その版で
  `If-None-Match` を付けて読む。304 ならそのまま、新しい版なら入れ替える (何も打っていなければ。打っていれば次の保存でマージ)。
  読めない (通信・429・5xx) ときは見出しバーの下に「オフライン — 最後に読み込んだ時点 (2026年10月2日 (金) 14:30) の内容です」。
  再接続 (`online()`) か引っ張って更新で読み直し、答えが来たら消える。持っていなければ今までどおり (「再読み込み」)。
- **オフラインの編集**: 保存の状態機械は変えていない。打った分は保存待ち (`canvas:<id>`) に入り、同じ key で送り直す。保存待ちが
  ある状態で開いたときも、持っている版を出して保存待ちを送る (今までは最初の読み込みが通るまで「読み込めませんでした」だった)。
  持っている版が整理で消えていれば 409 `canvas_base_expired` の選択になる。
- **一覧**: 会話のキャンバスの一覧はメモリだけのまま。一度も読めていない会話で一覧が通信などで読めないときは、持っている
  キャンバスで代わりに一覧を作る (タブが開ける)。404 などの答えは代わりにしない。`/c/` リンク・検索の結果から開くときも、
  持っていてメンバーの会話なら先に画面を出す。
- **版の本文の消去**: 履歴の版の画面の右上 (⋯) に「本文を消去」。会話の owner・admin (DM はキャンバスの作成者。作成者でも
  チャンネルでは消せない: サーバの `_require_eraser` と同じ)、現在の版と消去済みの版には出さない (`CanvasRights.erase`、
  `CanvasHistoryModel.offersErase`)。「戻せない・監査に残る」の確認の後 `DELETE /canvases/{id}/revisions/{rev}`、答えの版で
  一覧の行を置き換える (「本文を消去」と出る)。エラーは今までどおりの文言 (`canvas_revision_is_head` など)。
- **テスト**: `CanvasOfflineTests.swift` (SQLite で再起動後も残る・古い版で上書きしない・304 の時刻、メンバーでない会話と
  removeChannel、200 件の上限、サインアウトで DB ごと消える、オフラインで持っている版を出して編集し再接続で同じ key で送る、
  304 / 新しい版、持っていないときは今までどおり、ゴミ箱と 404、一覧の代わり、`/c/` から開くときの判断、通知の文言、消去の
  権限・現在の版・行の置き換え・要求のパスと 409)。

### 19.2 M74 Android

- **保存する場所**: Room のスキーマを 2 にして `canvases` 表 (`id`・`channelId`・`savedAt`・`json`、`channelId` に索引) を
  足した。`json` は `CachedCanvas` (サーバが返した `CanvasOut` そのもの = 本文・`version`・`head_rev_id`・題名・`updated_at`
  など、と `fetchedAt`)。1 → 2 は `MIGRATION_1_2` (空の表を作るだけ。SQL は Room が生成するものと同じ)。破壊的な
  フォールバックは外した (古い版を入れ直したときだけ `fallbackToDestructiveMigrationOnDowngrade`)。起動時には読まない
  (メッセージと違い、開くときに 1 件ずつ読む。Room の書き込み用スレッドで読むので、直前の書き込みが見える)。
- **書くとき**: サーバがキャンバスを丸ごと返したとき — 最初の GET、読み直し、保存の応答 (`canvas`)、409 の `head`。304
  (If-None-Match) は今の写しが最新という意味なので `fetchedAt` だけ新しくする (写しの `version` が聞いた版と同じときだけ)。
  `canvas.updated` の metadata だけを古い本文に重ねたもの (`applyMeta`) は書かない (本文と `head_rev_id` が食い違うため)。
- **上限**: 200 件。書くたびに `savedAt` (最後に読んだ・保存した時刻) の新しい順に 200 件を残し、残りを消す。スマホでは
  開いたキャンバスを必ず読み直すので、実質「最近開いた 200 件」。保存待ちのあるキャンバスも同じ規則 (写しが消えても
  保存待ちは消えない。その場合は今までどおりオンラインになるまで「再読み込み」)。
- **開くとき** (`CanvasSaver.load`): 写しがあれば最初の GET の前に画面に出し (閲覧も編集もできる)、続けて
  `If-None-Match: <写しの version>` で読み直す。新しい版なら差し替え、304 ならそのまま。保存待ち (再起動前の入力) があれば
  その本文と base が写しより優先し、読み直しの代わりに保存待ちを送る (同じ key)。写しが無ければ今までどおり。
- **オフライン**: 読み直しが通信エラー・5xx などで失敗したら、写しのまま状態は「オフライン」、バーの下に
  「オフライン — 最後に読み込んだ時点 (10/2 14:05) の内容です」と「再読み込み」(年が違えば年も)。編集は保存待ちと同じ
  状態機械のまま: base は写しの `head_rev_id`、送れなければ同じ key で保持して再接続で送り、サーバがマージする (24 時間を
  超えて base が無くなっていれば今までどおり比較画面)。サーバが答えたら注意は消える。
- **一覧**: 会話のキャンバス一覧が通信エラーで読めず、まだ一覧が無いときは、その会話の写しを一覧の代わりに出す (既定の
  キャンバスもそこから選ぶ)。読めたら一覧で置き換える。404 (古いサーバ) や 403 では写しを出さない。
- **消すとき**: `canvas.deleted` と自分でゴミ箱に移したとき (`CanvasHub.trashed`)、読み直しが 403 / 404 のとき (403 は
  写しを見せずに「読み込めません」と「再読み込み」)、会話が端末から消えたとき (`Store.removeChannel`、保存待ちを消すのと
  同じ所)、サインアウトとワークスペースを外したとき (プロファイルのデータベースのファイルごと消える。`RoomPersistence.delete`)。
- **テスト** (`CanvasOfflineTest`、JUnit): 写しの読み書きと上限、会話が消えたとき・サインアウト (別のプロファイル) で
  残らない、注意の文言、オンラインでは写しを先に出して If-None-Match で確かめる・新しい版で差し替える、オフラインでは写しと
  注意を出して打った分を写しの head で保持し再接続で同じ key で送る、写しが無ければ「再読み込み」、保存待ちが写しより優先、
  403 / 404 とゴミ箱で消える、metadata だけの更新では写しを書き換えない、一覧の代わり。`RoomPersistenceTest` は
  マイグレーションが 1 から今のスキーマまで続くことを確かめる。
- **エミュレータで確かめたこと** (ChikuwaChat_Pixel_9、dev サーバ、android1): スキーマ 1 のデータベースがある端末に
  入れて 2 に上がり、メッセージとログインが残る。キャンバスを作って開いた後、Wi-Fi とモバイル通信を切ってアプリを
  終了 → 起動 → 会話の「キャンバス」タブで、一覧の代わりの写しから開いて本文と注意が出る。オフラインでチェックを付け、
  通信を戻すと保存される。

