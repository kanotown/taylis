# CANVAS (Slack Canvas 相当の設計)

2026-09-28 の設計提案 (復元、[ROADMAP.md](ROADMAP.md) 参照)。編集方式は利用者の回答どおり「自動保存 + サーバ側マージ」。マイグレーション番号 (「0036〜」) は当時のもので、着手時点の次の番号に読み替える。

**状態 (2026-09-30)**: サーバの中核 (ROADMAP の M32) を **M41** で実装した (マイグレーション 0046)。表、保存 / マージ / 冪等、
権限、イベント、履歴、ゴミ箱、テンプレート。残りのサーバ (ROADMAP の M33) を **M42** で実装した (マイグレーション 0047):
検索 (`canvases_search_idx`、`/search/canvases`)、画像 (`attachments.canvas_id`)、版の整理とゴミ箱の完全削除、会話への共有と `/c/`。
**サーバは完成、クライアントは未着手。** 実装で決めたこと・設計から変えたことは末尾の「§11 実装メモ (M41)」と「§12 実装メモ (M42)」。

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
| `canvas.mentioned` (Phase 2) | user | — | `{ canvas_id, channel_id, rev_id, by }`。PushPlanner が扱う |
| 揮発フレーム `canvas_presence` (Phase 2) | channel (中継) | — | `{ canvas_id, user_id, editing }`。typing と同じ中継で、45 秒で消える |

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
- Phase 2 (M17g):
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
