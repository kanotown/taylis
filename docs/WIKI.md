# WIKI（ドキュメント：研究室のマニュアルとノート、Notion の置き換え）

2026-10-07 の設計。**M120（サーバ：木と権限）・M121（Desktop / Web）・M122（iOS / Android）・M123（データベース：サーバと Desktop / Web）・M124（スマホのデータベース）・M125（Notion の取り込み）は実装済み**（2026-10-07、§14〜§21）。残りは M126（任意）。
2026-10-08 に「Notion の使い心地に近づける」（データベースとビューを利用者が育てる・テンプレート・見たまま編集、スマホの見たまま編集も後で）を設計して利用者が決めた（§22、M144〜M153）。**M144・M145・M147・M149・M150・M151 は実装済み**（2026-10-08、§23〜§28）。
利用者（研究室の教員）の要望：研究室の Notion を Taylis の中の GitBook / Notion のような知識ベースに置き換えたい。
§13.2 の質問は 2026-10-07 に利用者が推奨どおりに決めた。Q8（データベース）は同じ日に答えがあった：**関係（relation）とカレンダーのビューを使っている、行数は数百**。これで M123 の範囲を広げた（§5.7・§5.8・§12）。Q9（書き出しのサンプル）は 2026-10-07 に実物の書き出しをもらった（§6.1）。

利用者の回答（2026-10-07）：

| 質問 | 回答 |
| --- | --- |
| Notion で使っているもの | ふつうのページ（見出し・リスト・画像・表）、**データベース**（論文リスト・備品台帳・学生の進捗などの表）、**入れ子のページ**（ページの木） |
| 見える人の決め方 | Notion のような**ページごとの共有設定**（チャンネルのメンバーだけでは足りない） |
| ログインしていない人への公開 | 今は要らない（後で足せるようにしておく） |
| Notion からの取り込み | ほぼ確実に要る（Notion の書き出し「Markdown & CSV」、サブページを含む zip） |

画面の名前は「ドキュメント」（英語 Docs、中国語 文档。2026-10-07 決定、§13 Q12）、コード上の名前は `wiki`（モジュール `app/modules/wiki/`、表 `wiki_*`、API `/wiki/*`）。

## 0. 結論

- **新しい実体「ページ」（`wiki_pages`）を作り、キャンバスの本文・版・保存・マージ・描画・エディタを部品として使い回す。**
  キャンバスに「持ち主 = 会話 | ウィキ」を足す一般化は採らない（§2）。
- **木は 1 つ**（ワークスペースの「ドキュメント」）。最上位のページが Notion のチームスペースの代わりになる。スペースの表は作らない。
- **権限は Notion と同じ「親から受け継ぐ + ページごとに足す / 絞る」。** 相手は「ワークスペースの全員（ゲストを除く）」「グループ」
  「人」、段階は「閲覧 / 編集 / フルアクセス」。受け継いだ結果（実効の権限）を表 `wiki_effective_grants` に持ち、権限・移動の
  たびに同じトランザクションで部分木を計算し直す。読めないページは存在ごと隠す（404）。管理者も黙っては読めない（§4）。
- **データベースは「行がページ」**：型付きのプロパティ（テキスト・数値・セレクト・マルチセレクト・日付・人・チェック・URL・作成 / 更新の
  日時と人）と**関係（relation、一方向 / 双方向、読めない行は「アクセスできないページ」）**、表のビュー（並べ替え・絞り込み・列）と
  **カレンダーのビュー**。ロールアップ・数式・ボード・ギャラリーは v1 に入れない（§5。2026-10-07 の Q8 の答えで関係とカレンダーを v1 に入れた）。
- **Notion の取り込みは管理者のコマンド**（`app.cli import-notion`、Slack・Mattermost と同じ `import_refs` で何度でも実行できる）。
  ページ・木・データベース（CSV → 型を推測）・画像とファイル・ページ間のリンクを移す。共有設定・コメント・ビューは移らない（§6）。
- **検索と「AI に聞く」は、本人が読めるページだけ**（同じ実効の権限で絞る）。全体に公開されていないページは、ボットの
  `allow_private` があるときだけ AI に送る（§8）。
- マイルストーンは **M120〜M126**（§12）。v1 は M120〜M125（木と権限 → Desktop / Web → スマホ → データベース → 取り込み）。

## 1. 目標と、v1 に入れないもの

### 1.1 研究室にとっての「Notion の置き換え」

| Notion での使い方 | 研究室の例 | v1 でできること |
| --- | --- | --- |
| マニュアル（入れ子のページ） | 新入生ガイド > 計算機の使い方 > GPU サーバの予約、実験装置の手順、研究室の決まり | 木・パンくず・目次・ページ間のリンクとバックリンク・画像・表・数式・コード |
| ノート | ゼミの資料、勉強会のメモ、学会の参加報告 | ページ（キャンバスと同じ Markdown と自動保存・マージ・履歴） |
| データベース | 論文リスト（著者・年・会議・タグ・読んだ人）、備品台帳（品名・場所・購入日・担当）、学生の進捗（学年・テーマ・段階・指導教員） | 型付きのプロパティと表のビュー、行ごとの本文、CSV の書き出し |
| 共有設定 | 「教員だけ」のページ、M2 の学生だけのページ、個人のメモ | ページごとの共有、受け継ぎ、グループ（`faculty`・`m2` など名簿の管理グループも使える） |
| 取り込み | 今の Notion の全部 | `import-notion`（§6） |

### 1.2 v1 に入れないもの（理由）

| 入れないもの | 理由・代わり |
| --- | --- |
| ブロック単位の編集とドラッグ & ドロップ | 本文は Markdown 全体（D24、CANVAS.md §3 の案（b）を採らなかった理由と同じ：3 端末にブロックエディタを作る費用）。並べ替えはページ単位（木）だけ |
| データベースのロールアップ・数式 | 実装と 3 端末の表示の費用が大きい。取り込みでは「取り込んだ時の値」をテキストとして残す（§6.4）。関係（relation）は 2026-10-07 の Q8 の答えで v1 に入れた（§5.7） |
| ボード・ギャラリーのビュー | 表とカレンダー（§5.8、Q8 の答えで v1 に入れた）から。ビューは種類の値を足すだけで増やせる形にした（ボードは次の段、§5.6） |
| 行ごとの共有設定 | 行はデータベースの権限をそのまま使う（表を見る人ごとに行を絞らずに済む） |
| ページへのコメント（範囲・ページ全体） | v1 は作らない（§13 Q7、2026-10-07 決定）。ページのリンクを会話に貼り、そのスレッドで話す |
| リアルタイムの共同編集・カーソル | キャンバスと同じ「自動保存 + サーバのマージ」。編集中の表示（presence）は後（M126 以降） |
| ログインしていない人への公開（公開リンク・Web 公開） | 今は要らない。§4.9 で後から足せる形を残す |
| 見たまま編集（WYSIWYG） | v1 はキャンバスと同じ Markdown + プレビュー。Desktop / Web のリッチ入力（TipTap、2026-10-06 のリッチな入力欄）の流用は後（§7.3、§13 Q6）。**2026-10-08 に見直した**：Desktop / Web は M150〜M151、スマホは M153（§22.6・§22.7） |
| 複数のスペース（チームスペース） | 最上位のページとその共有設定で足りる。必要になれば `wiki_spaces` を足しても今の表は変えずに済む（§3.1） |

## 2. 中心の決定：キャンバスを広げるか、新しい実体か

### 2.1 キャンバスの今の作り（読んだもの）

- サーバ `server/app/modules/canvases/`（約 3,000 行）。`merge.py`（3-way マージ、純粋関数、412 行）、`markers.py`（タスクの印、純粋関数）、
  `service.py`（1,346 行）。
- `service.py` のほぼすべての操作が会話に結び付いている：`_load` は `channels.require_member`、権限は `channel.is_dm`・
  `posting_policy`・チャンネルの owner、イベントは `audience_type="channel"`、検索は `channel_id IN (自分の会話)`、画像の
  アクセスは `attachments.channel_id`、共有メッセージ（コメントのスレッド）、会話のタブ、`export-channel`、タスクとの連携（M80）。
- 純粋で会話に依存しないもの：マージ（`merge.merge3`）、本文の整形（`clean_body`）、タスクの数（`count_tasks`、
  `only_tasks_toggled`）、差分の行数（`line_changes`）、画像の参照（`attachment_refs`）、メンションのトークン（`mention_tokens`）、
  版の整理の方針（24 時間・10 分ごと）。
- Desktop：`CanvasBody.tsx`（描画）・`CanvasEditor.tsx`（エディタ、ツールバー、表、@ の候補）・`canvasSave.ts`（保存の状態機械）・
  `CanvasHistory.tsx`・`canvasText.ts`・`canvasScrollSync.ts` はほぼ会話に依存しない。会話に依存するのは `CanvasPane.tsx`（会話の
  タブ・共有）と `canvasAccess.ts`（権限の表示）。iOS・Android も同じ分け方（`CanvasBodyView`、`CanvasSave`、セクション編集）。

### 2.2 案の比較

| 観点 | （a）キャンバスを一般化（`owner = channel \| wiki`） | （b）新しい実体 `wiki_pages` + キャンバスの部品を共有 ★推奨 |
| --- | --- | --- |
| 権限 | `service.py` のすべての関数に「会話 / ページの権限」の分岐が入る。1 か所の見落としがそのまま漏れになる | ページの権限は `wiki` モジュールの 1 つの関数（`require_level`）だけ。キャンバスの権限のコードは触らない |
| 木・並び・データベース | `canvases` に `parent_id`・`position`・`kind`・`props` を足し、会話のキャンバスでは使わない列が増える | ページだけの列として素直に持てる |
| 今のキャンバスへの影響 | 成熟した機能（M41〜M83、3 端末）を作り直すことになり、回帰の危険が大きい | 純粋な部品を `app/core/doctext/` に移すだけ（振る舞いは変えない、キャンバスのテストで確かめる） |
| イベント・同期 | 会話の audience とページの audience が同じイベントに混ざる | `wiki.*` イベントとして別に設計できる（§10） |
| 「会話に属するキャンバス」と「ドキュメントのページ」の使い分け | 1 つの一覧に 2 種類が混ざる | 別の物として説明できる（会話の議事録・週報はキャンバス、長く残す知識はドキュメント）。行き来は「ドキュメントへ移す」（§2.4） |
| 費用 | 小さく見えるが、分岐とテストの組み合わせが増える | 表と API は新しく作るが、保存の手順・マージ・描画・エディタは使い回す |

**推奨は（b）。** 理由：

1. 権限の境界がはっきりする（ページの権限は会話のメンバーシップとまったく別の仕組みなので、同じコードに混ぜない）。
2. キャンバスは 3 端末で完成しており、触る量を最小にしたい（CLAUDE.md「小さな変更で済むなら大きな書き直しをしない」）。
3. 本文の形式・保存のプロトコル・マージ・版の作りは **同じもの** を使うので、3 端末の利用者には同じ編集の感覚になる。

### 2.3 共有する部品（M120 で切り出す）

| 部品 | 今 | 切り出し先 | 使う所 |
| --- | --- | --- | --- |
| 3-way マージ | `canvases/merge.py` | `app/core/doctext/merge.py`（中身はそのまま移す。`canvases/merge.py` は再エクスポート） | キャンバス・ページ |
| 本文の整形・タスクの数・差分の行数・画像の参照・メンションのトークン・タスクの印 | `canvases/service.py`・`markers.py` | `app/core/doctext/body.py`・`markers.py` | 同上・検索・アクティビティ |
| 保存の手順（冪等キー → base → マージ → side 版 → head） | `canvases/service.save_content` | 手順は共通の関数 `doctext.save_flow(...)` にし、行のロード・権限・イベントはモジュールが渡す | 同上 |
| 版の整理（24 時間、10 分ごと、ラベル・create・restore は残す） | `canvases/repository.thin_revisions` | 方針の関数だけ共通。SQL は表ごと | 同上 |
| Desktop の描画・エディタ・保存の状態機械・履歴・差分 | `CanvasBody`・`CanvasEditor`・`canvasSave.ts`・`CanvasHistory`・`canvasDiff.ts` | 名前は変えず、エンドポイントと権限を props で受ける（`DocTarget = canvas \| page`） | 同上 |
| iOS / Android の描画・セクション編集・保存 | `CanvasBodyView`・`CanvasSave` など | 同じく呼び先を渡せるようにする | 同上 |

本文の形式はキャンバスの方言（CANVAS.md §4.2、`apps/shared/canvas_markdown.json`）に次を足す（3 端末で同じ解析、共通のケースを
`canvas_markdown.json` に追加）：

- **ページのリンク**：`[表示名](page:<uuid>)`。描画では今の題名とアイコンに置き換える（表示名は題名が取れないときの予備）。
  読めないページは「表示できないページ」。メッセージ・キャンバスからはパーマリンク `<server>/p/<uuid>`（`/c/` と同じカード）。
- **ファイル**：`[名前](attachment:<uuid>)`（画像以外の添付をファイルのチップで出す。取り込みの PDF などに要る）。

### 2.4 今のキャンバスの扱い

- キャンバスはそのまま残す（会話に属する議事録・週報・会話のタブ）。ドキュメントは研究室全体の長く残す知識。
- **「ドキュメントへ移す」**（M126、任意）：キャンバスのメニューから、選んだ親の下に新しいページとして写す。本文は head の版、
  画像は BlobStore の中で複製して新しい添付（`page_id`）にする（キャンバスの版がまだ参照するので付け替えない）。
  元のキャンバスの本文の先頭に「ドキュメントへ移しました：`[題名](<server>/p/<id>)`」の行を足す（新しい版。履歴は残る）。
  移した先の共有は親から受け継ぐので、確認の画面で「見える人」を出す（非公開の会話から全員に見えるページへ移すときは警告）。

## 3. 木

### 3.1 スペース

- **ワークスペースに 1 つの木**。最上位のページが「研究室マニュアル」「教員」「勉強会」「備品」のような区分になる。
- サイドバーの「ドキュメント」には 2 つの見出しで出す：
  - **共有**：自分が読める最上位のページ（と、親が読めないため最上位に見えるページ。§4.6）。
  - **プライベート**：自分だけが読めるページ（実効の権限が自分 1 人だけの最上位のページ）。Notion の「プライベート」と同じ。
- スペースの表を作らない理由：最上位のページの共有設定で同じことができ、表が 1 つ減る。必要になれば
  `wiki_spaces (id, name, …)` と `wiki_pages.space_id` を足せばよく、今の列・API は変えずに済む。

### 3.2 親子・並び・移動

| 項目 | 決めたこと | 理由 |
| --- | --- | --- |
| 親子 | `parent_id`（NULL = 最上位）と `path uuid[]`（根から親までの id。パンくず・部分木の検索） | 深さは浅い（20 段まで）。`path` で部分木を 1 回の問い合わせで取れる |
| 並び | 兄弟の中の `position`（分数の索引、`collate "C"` の文字列）。クライアントは「この id の前 / 後」を送るだけで、キーはサーバが作る | 並べ替えで他の行を振り直さない（イベントが 1 つで済む）。キーを作るコードがサーバの 1 か所 |
| 移動 | `POST /wiki/pages/{id}/move {parent_id, before_id \| after_id, keep_access, dry_run}`。自分の子孫の下へは動かせない（`409 wiki_move_cycle`） | 部分木ごと動く（子の `path` を同じトランザクションで直す） |
| 移動と権限 | 受け継いでいるページは移動先の権限になる。`dry_run` で「見える人が増える / 減る」を返し、端末は確認を出す。`keep_access: true` なら、移動の前の実効の権限をそのページの自前の設定に写して受け継ぎを止める | Notion と同じ「受け継ぐ」が既定、驚かないように確認を出す（§4.5） |
| ゴミ箱 | 削除は部分木ごと（`deleted_at`、子孫には `trash_root_id`）。復元も同じまとまり。30 日で完全削除（版・画像・リンク・権限）。親が完全に消えていれば最上位に戻す | キャンバスと同じ 30 日。部分木の一部だけが戻る事故を防ぐ |
| 複製 | v1 は入れない（テンプレートで代わりにする）。後で「部分木を複製」 | — |
| アイコン | 絵文字 1 つかカスタム絵文字（`icon varchar(64)`、`:name:` か Unicode）。カバー画像は作らない | サイドバーで見分けるのに足りる |
| サブページの一覧 | ページの下に自動で「サブページ」の一覧を出す（本文には書き込まない） | 本文に子のリンクを自動で足すと、マージ・取り込みと衝突する |
| 目次 | キャンバスと同じ（見出し 3 つ以上で右に目次。スマホはメニュー） | 既存の部品 |
| テンプレート | `canvas_templates` をそのまま使う（作成の画面で選べる） | 表を増やさない |

### 3.3 リンクとバックリンク

- エディタで `[[` を打つと、読めるページの題名の候補（`GET /wiki/pages/lookup?q=`）。選ぶと `[題名](page:<uuid>)` を入れる。
  題名を変えても壊れない（id で指す）。`<server>/p/<uuid>` を貼っても同じページのリンクとして扱う。
- 保存のたびに本文のリンク先を `wiki_links (src_page_id, dst_page_id)` に入れ直す（同じトランザクション）。
- **バックリンク**：ページの下に「このページへのリンク」。**読めるページからのリンクだけ**を出す（読めないページの題名を出さない）。
  メッセージ・キャンバスからのリンクは v1 では数えない。
- 本文の中のリンクの題名は `POST /wiki/pages/resolve {ids}` で取る（読めるものだけ返る。読めない・消えたものは「表示できない
  ページ」）。端末は木のキャッシュにあればそれを使う。

## 4. 権限（いちばん難しい所）

### 4.1 相手と段階

| 相手（`principal_type`） | 意味 | ゲスト |
| --- | --- | --- |
| `workspace` | ワークスペースの全員（admin と member。bot は除く） | 含まない |
| `group` | ユーザーグループのメンバー（手で作るものと名簿の管理グループ `faculty`・`students`・`m2` など。DATA_MODEL.md user_groups） | 含まない（§4.4） |
| `user` | 1 人 | 名前を挙げればゲストにも共有できる |
| `channel`（v1 では作らない） | 会話のメンバー | v1 はグループで足りる（§13 Q4、2026-10-07 決定）。列はこのまま値を足せる |

| 段階（`level`） | できること |
| --- | --- |
| `view`（閲覧） | 読む・検索・履歴を見る・画像・バックリンク・書き出し。チェックも付けられない（キャンバスの「チェックだけは誰でも」の規則は**採らない**：閲覧は本文を一切変えない） |
| `edit`（編集） | 本文・題名・アイコン、子ページを作る、版のラベル、データベースの行の追加・変更 |
| `full`（フルアクセス） | 上に加えて、共有設定、移動、ゴミ箱・復元、版の本文の消去、データベースのプロパティの削除・型の変更・双方向の関係（M144 から。プロパティの追加・名前・並び・選択肢の追加とビューは `edit`、§22.2） |

複数の項目に当たるときは強い方（`full > edit > view`）。

### 4.2 受け継ぎ

```text
own(p)        = p の自前の項目（wiki_grants）
effective(p)  = p.inherit_access ? merge(effective(parent(p)), own(p)) : own(p)
merge         = 相手ごとに強い方の段階
最上位のページの parent は無い（effective(parent) = 空）
```

- **既定は受け継ぐ**（`inherit_access = true`）。子ページで人を**足す**のは自前の項目を足すだけ（受け継ぎは保つ）。
- **絞る**（受け継いだ項目を外す・弱める）と、受け継ぎを止める（`inherit_access = false`）。その時点の実効の項目を自前の項目に写し、
  そこから外す。Notion で受け継いだ相手を外したときと同じ。共有の画面に「親から受け継いでいません」と出し、「親に合わせる」で戻せる。
- データベースの**行は必ず受け継ぐ**（行に自前の項目は付けない）。
- 新しい最上位のページの既定：「共有」の ＋ から作ると `workspace: edit` と作った人の `user: full`、「プライベート」の ＋ から作ると
  作った人の `user: full` だけ（§13 Q2、2026-10-07 決定）。子ページは何も付けずに受け継ぐ。

### 4.3 管理者

- **管理者でも、共有されていないページは読めない**（自分との DM のキャンバスを管理者が読めないのと同じ。学生の個人のメモを守る）。
- その代わり、管理画面の「ドキュメント」で**題名と共有の要約**（実効の相手と段階、最終更新）を一覧でき、次ができる：
  - **引き取り**（`POST /admin/wiki/pages/{id}/takeover`）：自分に `full` を付ける。監査ログ `wiki.access_takeover` に必ず残る。
    卒業でフルアクセスの人がいなくなったページ、間違えて全員から外したページを戻すため。
  - 完全削除（ゴミ箱）。
- 一覧に題名を出すことは許す（管理者は運用者であり、SECURITY.md §1 のとおり技術的にはすべて読める。題名まで隠すと引き取りが
  できない）。2026-10-07 に利用者が決めた（§13 Q5）。

### 4.4 ゲスト

- ゲストは **`user` の項目で名前を挙げたときだけ**読める（`workspace`・`group` の項目はゲストに効かない）。
- 理由：卒業生をゲストにする運用（LAB.md I、L7）で、`alumni` グループや全員向けのページが黙って卒業生に見え続けるのを防ぐ。
  見せたいページは名前で共有する（共有の画面でゲストには「ゲスト」の札を出す）。
- ゲストは最上位のページを作れない。共有されたページの下には `edit` 以上なら子ページを作れる（受け継ぐので同じ人にだけ見える）。
- ロールを guest に変えたとき、実効の権限は計算し直さなくてよい（判定でロールを見るため）。接続は今までどおり張り直させる。

### 4.5 移動・復元・グループの変化

| 変化 | 実効の権限 | 知らせ |
| --- | --- | --- |
| 受け継いでいるページを移動 | 移動先の親に合わせて部分木を計算し直す | 読めなくなった人には §10 の変更のフィードで「消えた」。読めるようになった人には何も送らない（バッジにしない） |
| `keep_access` で移動 | 移動の前の実効の項目を写し、受け継ぎを止める | なし（見える人は変わらない） |
| ゴミ箱から復元 | 元の親が生きていればその下で計算し直す（受け継いでいれば親の今の権限） | 同上 |
| グループのメンバーの変化・ロールの変化 | 計算し直さない（実効の表は相手を「グループ」のまま持ち、判定のときにメンバーを見る） | 端末は `group.updated` で木を読み直す（§10） |
| ユーザーの無効化・匿名化 | 計算し直さない（無効なユーザーはログインできない）。匿名化では `user` の項目を消す | — |

### 4.6 判定の作り（数百〜数千ページ）

- **実効の表** `wiki_effective_grants (page_id, principal_type, principal_id, level, source_page_id)` を持つ。権限・受け継ぎ・移動・
  復元・作成のたびに、そのページの部分木を Python で根から順に計算し直して書き換える（同じトランザクション。木の形の変更は
  `pg_advisory_xact_lock` 1 つで直列化する。権限の変更はまれなので十分）。
- 1 ページの判定：

  ```sql
  SELECT max(level_rank) FROM wiki_effective_grants
  WHERE page_id = :page AND (
        (principal_type = 'workspace' AND NOT :is_guest)
     OR (principal_type = 'group' AND NOT :is_guest AND principal_id = ANY(:my_group_ids))
     OR (principal_type = 'user' AND principal_id = :me))
  ```

- 読めるページの集合（検索・木・AI）：同じ条件で `page_id` を取る（索引 `(principal_type, principal_id, page_id)`）。
  2,000 ページ × 平均 3 項目で約 6,000 行。1 回の問い合わせで済み、ページの深さに関係しない。
- 大きさの見積もり（M120 で実測する）：1 万ページ、実効 3 万行、部分木 1,000 ページの移動の計算し直し。目標は判定 1 ms 以下、
  読める集合 10 ms 以下、1,000 ページの移動 300 ms 以下。
- **ずれの検査**：`app.cli wiki-acl --verify`（全部を根から計算し直して表と比べる。テストでも毎回）と `--rebuild`。
- 親が読めず子だけ読めるページ（人を足した子）は、木の上では最上位に出し、パンくずの読めない祖先は「…」にする（題名を出さない）。

### 4.7 どこで守るか（サーバだけ。クライアントの表示は隠すだけ）

| 経路 | 守り方 |
| --- | --- |
| すべての `/wiki/*` | `wiki.access.require_level(actor, page, level)`。読めなければ **404 `page_not_found`**（存在と題名を隠す）。読めるが段階が足りなければ 403 `page_edit_restricted` / `page_manage_restricted` |
| 画像・ファイル | `attachments.page_id` を足し、`get_for_access` で `page_id` があれば `view` を確かめる（今は `channel_id` が NULL なら 404 になる所の前に入れる）。移動で見える人が変われば、画像も同じに変わる（判定がページの権限だから） |
| 検索 | `/search/pages` は読める集合で絞る（§8） |
| AI に聞く | 本人として検索した結果だけ。全員に公開されていないページはボットの `allow_private` のときだけ（§8.2） |
| リンク・バックリンク・パンくず | 読めないページの題名を返さない |
| メンション・アクティビティ・プッシュ | 本文で新しくメンションされた人のうち、**そのページを読める人だけ**に知らせる（キャンバスの「会話のメンバーだけ」と同じ考え方） |
| イベント | 題名や本文を含むイベントは読める人だけに届ける（§10 の audience `page`）。全員に届くものは番号だけ |
| 書き出し | ページ・部分木の Markdown 書き出しは読めるページだけ（部分木の中の読めない子は入れない） |
| 管理者の CLI のエクスポート・バックアップ | 運用者として全部（今の `export-channel` と同じ扱い） |

### 4.8 権限の変更の制約

- 共有設定を変えるのは `full` の人（とゲストでないこと）。`full` の相手が 1 人も（ゲストでない有効な人として）残らない変更は
  `409 page_last_manager`（管理者の引き取りは除く）。
- 共有の変更・受け継ぎの停止 / 再開・`keep_access` の移動は監査ログ（`wiki.access_changed`、前後の項目）。
- 名前を挙げて共有された人（`user` の項目が増えた人）には「〇〇さんがページを共有しました」をアクティビティとプッシュで知らせる
  （グループ・全員への共有では知らせない。数十人に一斉に届くため）。

### 4.9 公開ページへの道（今は作らない）

後で足すときは `principal_type = 'public'`（ログインしていない人に `view`）を値として足し、`/p/<id>` の案内ページが中身を描く。
実効の表と判定はそのまま使える。添付は署名付きの短い URL で出す必要がある（SECURITY.md の presigned URL の課題と一緒に考える）。

## 5. データベース

### 5.1 形

- **データベースはページの一種**（`kind = 'database'`）。木に出て、共有・移動・ゴミ箱はふつうのページと同じ。本文（説明）も持てる。
- **行もページ**（`kind = 'row'`、親はデータベース）。題名（タイトルのプロパティ）、プロパティの値（`props jsonb`）、本文
  （ふつうのページと同じ Markdown・自動保存・マージ・履歴・画像）を持つ。木には出さない（表に出す）。
- スキーマとビューは `wiki_databases (page_id, schema, views, schema_version)`。
- 上限（v1）：1 データベース 5,000 行、プロパティ 50 個、セレクトの選択肢 200 個、ビュー 20 個。

### 5.2 プロパティの型（v1）

| 型 | 値（`props` の JSON） | 表示・編集 | 備考 |
| --- | --- | --- | --- |
| `title` | `wiki_pages.title` | 1 つだけ、消せない | — |
| `text` | `"..."`（2,000 字まで、1 行の軽い Markdown とメンション） | 1 行 / 折り返し | email・電話も v1 はこれ |
| `number` | `12.5`（format: 整数 / 小数 / % / 円） | 右寄せ | — |
| `select` | 選択肢の id | 色付きの札 | Notion の status もこれに取り込む |
| `multi_select` | 選択肢の id の配列 | 札を並べる | — |
| `date` | `{"start": "2026-10-07", "end": null, "time": false}`（時刻ありは ISO 8601 とタイムゾーン） | 日付の選択 | — |
| `person` | user id の配列 | アバターと名前 | 無効化された人も名前は出す |
| `checkbox` | `true` / `false` | チェック | — |
| `url` | `"https://..."` | リンク | http / https だけ |
| `relation`（M123） | 値は `props` に入れず `wiki_relations` に持つ。API では行の id の配列 | 行のチップ（読めない行は 1 つの「アクセスできないページ」） | §5.7 |
| `files`（v1.1） | 添付の id の配列 | チップ | 取り込みでは v1 から本文の末尾にファイルとして入れる（§6.3） |
| `created_time` / `updated_time` / `created_by` / `updated_by` | 行から計算 | 読むだけ | 列を足すだけで使える |

型の変更はサーバが値を変換する（テキスト → セレクトは同じ文字の選択肢を作る、など）。変換できない値は消さずに
`props_legacy` に 30 日残す（取り消せるように）。

### 5.3 編集と同時編集

- プロパティの変更は `PATCH /wiki/rows/{id}/props {set: {prop_id: value}, client_op_id}`。**マスごとの後勝ち**
  （1 つのマスの値はまとまった 1 つの値なので、マージは要らない）。同じ `client_op_id` の再送は 1 回だけ効く。
- 行の本文はページと同じ保存（`PUT /wiki/pages/{id}/content`、マージ）。
- 行の変更履歴：プロパティの変更も版（`kind = 'props'`、`props` の写し）として残し、履歴の画面で「段階：実験中 → 執筆中（〇〇、10/7）」
  のように出す。整理はふつうの版と同じ。
- スキーマの変更（列の追加・名前・削除・型・選択肢）は `full` の人。`schema_version` で直列化し、古い版を元にした変更は 409
  （画面は読み直して出し直す）。**M144 で見直した**：壊さない変更（追加・名前・並び・選択肢の追加と名前・色・数の形）は `edit`、
  値が消える・変わる変更（削除・選択肢の削除・型の変更）と双方向の関係は `full`（§22.2）。

### 5.4 ビュー（表とカレンダー）

- ビューはデータベースに保存して全員で共有する（`full` の人が作る・直す。**M144 から `edit`**、§22.2）。端末ごとの一時的な並べ替え・絞り込みもできる（保存しない）。
- 表：見せる列と順番・幅、並べ替え（複数のキー）、絞り込み（条件の AND。型ごとの演算：含む / 等しい / 空 / 範囲 / 自分）。
  まとめる（group by）は v1.1（M147 で入れた。ボード・リスト・ギャラリーとともに §22.4・§25）。
- **並べ替えと絞り込みはサーバが行う**（`GET /wiki/databases/{id}/rows?view_id=&sort=&filter=&cursor=&limit=100`）。
  理由：3 端末で同じ規則を 3 回書かずに済む。行は 5,000 までなので、サーバは該当のデータベースの行（本文なし）を読み込んで
  Python で並べる（文字の並びはサイドバーの日本語の名前順（`apps/shared/sidebar-order.json` の規則）と同じキー）。数 ms の見込み
  （M123 で測る）。
- 端末は結果を表示するだけ。Desktop / Web で読み込んだ範囲の中の見た目の並べ替えはしない（結果がずれるので）。

### 5.5 スマホでの見せ方

- ビューを選ぶ（保存されたビュー）→ 行を**カードの一覧**（題名 + ビューで最初に見せる 3 つのプロパティ）。タブレットの広い画面は
  横にスクロールする表。
- 行を開くと、上にプロパティのフォーム（型ごとの入力：セレクトはシート、日付は DatePicker、人は候補）、下に本文（ページと同じ）。
- スマホではスキーマとビューの設定はしない（読むだけ）。

### 5.6 v1 と後

| v1（M123・M124） | 後 |
| --- | --- |
| 上の型、関係（一方向 / 双方向）、表とカレンダーのビュー、並べ替え・絞り込み、行の本文、CSV の書き出し、行の追加・削除（ゴミ箱）、行の履歴 | ボード（セレクトでまとめる）、まとめる（group by）、ギャラリー、`files` の型、CSV の読み込み（既存のデータベースへ）、ロールアップ・数式、ページの中に埋めるデータベース（インライン） |

CSV の書き出し：ビューの今の並べ替え・絞り込み・列で、UTF-8（BOM 付き、Excel のため）。人は表示名、セレクトは名前、日付は ISO 8601。

### 5.7 関係（relation、M123 で v1 に入れた）

利用者の Notion のデータベースは関係を使っている（2026-10-07、Q8）。Notion と同じ形にする。

- 関係のプロパティは、相手のデータベース（同じデータベースでもよい）の行を指す。**一方向**（このデータベースにだけ列がある）と
  **双方向**（相手のデータベースにも「逆の」プロパティができ、どちらから変えても同じつながりになる）。
- つながりは `wiki_relations (src_page_id, prop_id, dst_page_id, src_database_id, position, seq)` に 1 行ずつ持つ。双方向の逆の
  プロパティ（`relation.primary = false`、`pair_id` が元のプロパティ）は同じ行を反対の端から読む（並びは作った順）。行の `props` には
  入れない（つながりの両側を 1 回の書き込みで正しく保つため）。
- **読めない行は漏らさない**：マスに出すのは読める行だけ。読めない行へのつながりがあれば「アクセスできないページ」を **1 つ**
  出す（`hidden_relations`。id・題名・件数は出さない）。マスを書き換えても読めない行へのつながりは残す（サーバが合わせる）。
  読めない行には新しくつなげない（無い行と同じ 422）。候補（`…/candidates`）は相手のデータベースの読める行だけ。相手の
  データベースを読めない人には、プロパティの `relation.database_id` と題名も出さない。絞り込みの「含む」は読める行でだけ当たる。
  検索の `props_text` に関係の題名を入れない（つながった行から読めない題名を探せないように）。CSV も読める題名と「アクセスできないページ」。
- **保存したビューの絞り込みも同じ**（REVIEW-v0.1.43 #2）：ビューの関係の条件の値（行の id）が、見る人の読めない行（ゴミ箱の行・
  消えた行も）なら、`GET /wiki/databases/{id}` と `GET /wiki/rows/{id}` の `views[].filter.conditions[].value` を
  `"restricted:<n>"`（`n` は保存したビューの中のその条件の番号）に置き換えて返す。サーバに保存した条件はそのまま（実際の
  絞り込みはサーバが持つ）。条件を消したり「どの行でも」に広げたりはしない。
  - その人がこの印のままビューを保存し直すと（`PUT …/views/{view_id}`）、サーバは同じビューの `n` 番目の条件（同じプロパティ）の
    行の id に戻して保存する。権限の弱い人が名前や列を変えて保存しても、見えない条件は失われない（条件の順を入れ替えてもよい。
    条件そのものを消すのは、その人が画面で「アクセスできないページ」の条件を消した、という明示の操作）。どの条件も指さない印
    （番号が範囲外・別のプロパティ・別のビュー）は `400 wiki_invalid_view`。
  - 問い合わせ（`POST …/query` の `filter`）の印は「読めない行」として扱う（`contains` は何にも当たらず、`not_contains` はすべてに当たる）。
    読める人が同じビューを使うときと同じ規則（読めない行は当たらない）なので、印から何も分からない。
  - Desktop / Web は絞り込みの値の選択肢に「アクセスできないページ」として出し、保存・問い合わせでは印をそのまま送る。iOS・Android は
    ビューを編集せず `view_id` で問い合わせるだけなので、値を読まない（Android は `JsonElement` のまま持つ）。
- 双方向の関係を作る・消すには相手のデータベースのフルアクセスも要る（相手のスキーマが変わるため）。元のプロパティを消すと
  逆のプロパティとつながりも消える。逆のプロパティだけを消すと元は一方向になる（つながりは残る）。
- 一方向の関係で自分を指している行は、行のページの「（データベース）の（プロパティ）」に読めるものだけ出す（`referenced_by`）。
- ロールアップ・数式は入れない（v1 の後）。取り込み（M125）では Notion の関係の列を関係として作れるようにする（§6.3 の 8 を直す）。

### 5.8 カレンダーのビュー（M123 で v1 に入れた）

- ビューの種類 `calendar`。日付のプロパティ（日付・作成日時・更新日時）を 1 つ選び（`date_prop_id`）、月の格子（月曜始まり、6 週）に
  行を置く。終わりのある日付は日をまたいで帯になり、週の中で重ならない段に積む（1 日に 3 段まで、超えた分は「ほか n 件」）。
- 日をクリックするとその日の日付で行を作って開く。帯をドラッグして別の日に落とすと日付が動く（終わりも同じだけ動く、時刻は保つ）。
- サーバは月の範囲（`range {prop_id, start, end}`）に重なる行だけを返す。並べ替え・絞り込みはビューのものを同じく使う。
- 狭い画面（スマホの Web）と M124 のスマホは、月の格子の代わりに**予定の一覧**（日ごとに、その日にかかる行）。
- ボードは同じ「ビューの種類」の値として後で足せる（`type` に `board` と `group_by_prop_id` を足すだけで、表・API の形は変わらない）。

## 6. Notion からの取り込み

**M125 で実装した（2026-10-07、§21）。** 利用者の実際の書き出し（「Markdown & CSV」、サブページを含む、zip 1 つ・約 80 MB・
約 530 項目・ページとデータベースと行で約 430）で形を確かめ、§6.1 を確かめた形に書き直した。ここには形だけを書く（中身は書かない）。

### 6.1 書き出しの形（実物で確かめた、2026-10-07）

- **zip**：項目の名前は UTF-8。この書き出しは UTF-8 の印（汎用ビット 11）が付いていたが、macOS の `unzip` は名前を化けさせる
  （Python の `zipfile` は正しく読む）。印の無い zip では `zipfile` が cp437 として読むので、cp437 に戻して UTF-8（だめなら
  Shift-JIS）で読み直す。macOS で作られた名前は NFD のことがあるので NFC にそろえる。大きいワークスペースは zip の中に zip
  （`Export-…-Part-1.zip` …）。外側にページが 1 つも無く zip だけがあるときは、中の zip をすべて同じ木の部分として読む
  （ページのフォルダの中にある利用者の `.zip` は添付として扱う）。
- **ページ**：`<題名> <32 桁の 16 進の id>.md`。先頭は `# <題名>`。題名が空のページは言語ごとの「無題」（`無題`・`Untitled`）。
- **フォルダ**：サブページ・行・画像とファイルは、**id を付けない** `<題名>/` のフォルダの中（§6.1 の推測の「id 付きの
  フォルダ」は違った）。兄弟に同じ題名のページがあると、2 つ目以降は `<題名> <id の先頭 4 桁>-<末尾 4 桁>/`。同じ題名の
  ページとデータベースが**同じフォルダを分け合う**こともある（中身がどちらのものかは、ページの本文のリンクと CSV の行の題名で
  分ける）。ファイル名の題名は全角の空白が半角になり、末尾の空白が落ちる。
- **データベース**：`<題名> <id>.csv`（既定のビューに見えている列、ビューの並び）と `<題名> <id>_all.csv`（すべての列）。
  どちらも BOM 付きの UTF-8、最初の列が題名。データベース自身の `.md` は無い（説明は書き出されない）。行のページは
  データベースのフォルダの中の `<題名> <id>.md`。**CSV の行には id が無い**ので、行のページとは題名で結ぶ（題名が重なるときは
  値で）。行のページは `# 題名` の後に、空でない値ごとに `列名: 値` の行がある。**テンプレート**は CSV に無い行のページとして
  フォルダに入っている。行のページの下のサブページは、行のフォルダの中。
- **CSV の値**：日付は書き出した人の言語の形（日本語 `2026年10月7日`、時刻 `2026年10月7日 10:00 (JST)`、作成日時は
  `2026年10月7日 13:40` のようにタイムゾーンなし。英語 `October 7, 2026 3:30 PM`、範囲は `→`）。チェックは `Yes` / `No`、
  マルチセレクトと人は `, ` 区切り（値に `,` があれば CSV の引用符）、URL はそのまま。関係は `題名 (相対パス%20<id>.md)` の
  並び（新しい書き出しは `https://www.notion.so/…<id>` のこともある）。この書き出しには関係の列が無かったので、関係は
  合成のテストで確かめた（§13 の残り）。カレンダー・ボードなどのビューの設定は書き出されない。
- **本文**：ページ・データベースへのリンクは URL エンコードした相対パス（`[t](フォルダ/題名%20<id>.md)`、データベースは
  `….csv`）。サブページ・データベースは本文の中の 1 行のリンクとして、Notion で置いた場所（見出しの下など）に出る。
  画像は `![](フォルダ/image.png)`、ファイルは `[名前.pdf](フォルダ/名前.pdf)`。**ファイル名の丸かっこはエンコードされない**
  （`(フォルダ/資料(第2版).pdf)`）。ファイル名そのものが `%E3…` とエンコードされていることがある（リンクは `%25E3…`）。
  本文に埋め込まれた画像（`data:image/png;base64,…`）もある。コールアウトは `<aside>` の行で囲まれ、最初の行がアイコンの絵文字。
  トグルは箇条書き（この書き出しに `<details>` は無かった）。入れ子の箇条書きは 4 つの空白。数式は `$$` の行。表・コードは
  Markdown のまま。人のメンションは `@名前` の文字。
- **入っていないもの**：アイコン・カバー、共有設定、コメント、ページの履歴、作成者・作成と更新の日時（CSV に「作成日時」の
  列があればその値だけ）、ビュー（絞り込み・並べ替え・カレンダー・ボード）、データベースの説明。

### 6.2 対応

| Notion | Taylis |
| --- | --- |
| ページ（`.md`） | ページ。題名は `# ` の行（無ければファイル名から id を除いたもの）、本文はその後 |
| サブページ・データベース | 子ページ・子のデータベース。並びは親の本文に出てくる順、出てこないものは題名順。行の下のページとデータベースの中のデータベースは置けないので、いちばん近いページの下へ（報告に出す） |
| データベース（`_all.csv`、無ければ `.csv`） | `kind = 'database'` のページ。最初の列が題名のプロパティ、ほかの列はプロパティ（型を推測、§6.3）。CSV の行の順に行を作る。表のビューの列は `.csv`（既定のビュー）の列と順、残りは隠した列。**日付のプロパティがあればカレンダーのビューを足す**（「日付」「Date」などの名前のもの、無ければ最初の日付） |
| 行のページ | 行の本文（先頭の `列名: 値` の行は外す：値は CSV からプロパティに入る）。CSV に無い行のページ（テンプレートなど）も行にして、報告に数を出す。ページの無い CSV の行も行にする |
| 画像・ファイル | 添付（BlobStore、`page_id`）。アップロードと同じ検査（空・`attachment_max_bytes`・中身から形式・画像の画素数）で、サムネイル・動画の情報・文書のプレビューの予約も同じ。`![](attachment:<id>)`、ブラウザが出せない画像（HEIC など）と画像以外は `[名前](attachment:<id>)`。どのページからもリンクされていないフォルダのファイルは、そのページの末尾にファイルのリンクとして足す。1 ページ 200 個まで |
| ページ間のリンク（相対パス・`notion.so` の URL・リンクでない `notion.so` の URL） | 取り込んだページなら `[題名](page:<uuid>)`。取り込んでいない Notion の URL はそのまま、相対パスで見つからないものはリンクの文字だけにして、どちらも報告に出す |
| `<aside>` | 引用（`> 💡 …`、アイコンを最初の行の前に） |
| `<details>` | 箇条書き（`- 要約`、中身は 1 段下げる） |
| ほかの HTML（`<span>`・`<u>`・`<mark>` など） | タグを外して文字だけ。`<br>` は改行（表の中は空白）。`<img src>` は画像 |
| `@名前` | 名前が 1 人のユーザーの表示名かユーザー名と一致すれば `<@uuid>`（`--user` / `--user-map` で指定もできる）。取り込みではメンションの通知を出さない |
| 数式・コード・表 | そのまま（コードの中は何も書き換えない） |
| 本文が 95,000 字を超えるページ | 行の区切りで分け、残りを「題名（続き 2）」…の子ページにする（報告に出す） |

### 6.3 CSV の型の推測（実装した順）

列ごとに空でない値を全部見て、最初に当てはまるもの：

1. すべて `題名 (…<id>…)` の並びで、指す行が取り込む**1 つのデータベース**の行 → `relation`（そのデータベースへ）。
   2 つの関係の列のつながりがちょうど逆向きで同じなら、1 つの**双方向**の関係（先に出た方が元、もう片方が逆側）。
   取り込まない行・ふつうのページを指すときは `text`（題名の並び）
2. すべて `Yes` / `No` → `checkbox`
3. すべて数（`,` の位取り・`%`・`¥`・`円`）→ `number`（すべて `%` なら書式 percent、すべて円なら yen）
4. すべて日付（§6.1 の形、時刻・タイムゾーン・`→` の範囲。タイムゾーンの無い時刻は `--timezone`、既定 Asia/Tokyo）→ `date`
5. すべて `http(s)://` → `url`
6. すべて（`, ` で分けた）名前が Taylis のユーザー（`--user` と、ほかの人と重ならない表示名・ユーザー名）→ `person`
7. 100 字以下で、`, ` で分けると値が繰り返し出る（異なる値が 50 個以下）→ `multi_select`
8. 100 字以下で、異なる値が 50 個以下で繰り返しがある → `select`（選択肢は出てきた順、色は順に回す）
9. それ以外 → `text`（2,000 字を超えた分は切って報告）。**空の列**は名前が「日付」「Date」「期限」などなら `date`（カレンダーに
   使える）、それ以外は `text`

`--dry-run` は列ごとに推測した型を出す。`--column-types FILE`（`列 = 型` か `データベース / 列 = 型` の行）で指定し直せる。
数式・ロールアップの列は CSV では値だけなので、その値の型として入る。型に合わない値は空にして数を出す。

### 6.4 誰が・どう動かすか

- **管理者がサーバで実行するコマンド**：

  ```text
  python -m app.cli import-notion /import/notion-export.zip --actor admin \
    [--parent <page_id>] [--access workspace-edit | workspace-view | private] \
    [--user "Notion の名前=username"] [--user-map users.txt] [--column-types types.txt] \
    [--timezone Asia/Tokyo] [--dry-run]
  ```

  Slack・Mattermost の取り込み（infra/README.md）と同じ流れ：試し読み（`--dry-run`：ページ・データベース・行の数と、
  前回から増えた / 上書きする / 編集されたので触らないものの数、列ごとの型、取れないファイル、つながらないリンク、書き換えた
  ブロックの数、警告）→ 本番。zip はサーバの `/import` に置く（Caddy を通さない）。展開しないで zip のまま読む（unzip した
  フォルダも渡せる）。進み具合は標準エラーに 100 ページ・20 ファイルごと。
- **共有**：書き出しに共有設定は無い。最上位に取り込む（既定）と、取り込んだ根のページに `--access`（既定 `workspace-edit`：
  全員が編集、`workspace-view`：全員が閲覧、`private`：実行した管理者だけ）と実行した管理者の `full` を付け、残りは受け継ぐ。
  `--parent` の下に取り込むときは、何も付けずに親から受け継ぐ（`--access` を付けたときだけ根にその項目を足す）。**全員に
  見えてはいけないページがあるときは `--access private` で取り込み、確かめてから共有を広げる**（infra/README.md）。
- **作成者と日時**：書き出しに人がいないので、作成者・更新者・版の作者は実行した管理者。作成日時は取り込んだ時刻。Notion の
  「作成日時」などの列は日付のプロパティとして残る。
- **何度でも実行できる**：`import_refs (source = 'notion')`（`kind` = `page`：ページ・データベース・行の Notion の id、`row`：
  ページの無い CSV の行、`file`：添付）で対応を覚える。もう一度実行すると：
  - まだ無いページ・行・添付を足す（親の兄弟の最後に）。
  - **取り込んだ後に Taylis で変わっていないページ**（いちばん新しい版（side を除く）が取り込みの版で、それが head で、題名も
    同じ）は、書き出しの中身が変わっていれば新しい版（`kind = 'import'`）で上書きする。変わっていなければ何もしない（同じ
    書き出しの再実行は何も書かない）。
  - **編集されたページ・行**（本文の保存・プロパティの変更・題名の変更）は触らず、報告に出す。移動と共有の変更は編集に
    数えない（場所と共有は変えずに中身だけ直す）。ゴミ箱のページ・完全に消したページは作り直さず、その下にも足さない。
  - データベースは、今のスキーマに無い列（名前と型で照合）と選択肢を足す（Taylis で消したり型を変えた列は、同じ名前の
    新しいプロパティとして戻る）。ビューは作り直さない。
- 上限：展開後 20 GB、ページ 20,000、データベースの行 5,000（超えた分は報告して飛ばす）、プロパティ 50、選択肢 200、
  深さ 20 段（超えるページは報告して飛ばす）、ファイル 1 つは `attachment_max_bytes`、1 ページの添付 200。
- 監査ログ：`wiki.imported`（新しいページ・データベース・行・上書き・触らなかった数・添付の数、実行した人）。
- イベント：100 ページごとの書き込みで `wiki.changed`、上書きしたページに `wiki.page.updated`、行が増えた・変わった
  データベースに `wiki.rows.changed`。メンション・共有の通知は出さない。
- Web から zip を上げて進み具合を出す画面は、要望があれば後（ジョブの表と進み具合のイベントが要る。§13 Q9）。

### 6.5 取り込めないもの（利用者に伝える）

コメント、共有設定、ページの履歴、ビュー（絞り込み・並べ替え・ボード。カレンダーは日付のある表に 1 つ作り直す）、データベースの
説明、ロールアップ・数式の「生きた」計算（値だけ）、アイコンとカバー、作成者と作成・更新の日時（列にあれば値だけ）、同期ブロックの
同期（写しになる）、ボタン・AI ブロック、埋め込み（リンクになる）、文字の色と背景色、列のレイアウト（縦に並ぶ）、リンクされた
データベース（別のデータベースのビュー）。関係は取り込む 2 つのデータベースの行のあいだのときだけ（ほかはテキスト）。

## 7. 編集と共同作業

### 7.1 保存

キャンバスとまったく同じ（CANVAS.md §4.4）：入力が 2 秒止まるたびに `base_rev_id` と本文全体を送り、サーバが 3-way マージ、
同じ語句だけ競合、`client_save_id` で冪等、オフラインでは `in_flight` を保って再送。エンドポイントだけ違う
（`PUT /wiki/pages/{id}/content`）。上限も同じ（本文 100,000 字、ユーザーあたり保存 120 回 / 分）。

### 7.2 履歴

キャンバスと同じ（版の一覧・表示・差分・復元・ラベル・版の本文の消去（`full`）・整理）。題名・アイコン・移動・共有の変更は版では
なく「ページの記録」（監査ログと同じ内容を `GET /wiki/pages/{id}/activity` で読む人に見せる。共有の変更は `full` の人だけ）。

### 7.3 エディタ

- v1：キャンバスのエディタ（Markdown + ツールバー + 2 列のプレビューとスクロールの同期、表の編集画面、@ の候補、画像の貼り付け）に
  `[[` の候補（ページのリンク）と、行頭の `/` のメニュー（見出し・リスト・チェック・表・画像・コード・数式・ページのリンク・
  **子ページを作る**）を足す。`/` は Notion に慣れた学生のため（Markdown の記号を覚えなくてよい）。
- 見たまま編集：Desktop / Web の入力欄にあるリッチ入力（TipTap、`richMarkdown.ts`）をページに広げる案。表・数式・タスクの印の
  往復を先に揃える必要があるので後（M126 以降、§13 Q6）。
- 編集中の表示（presence）：キャンバスの `canvas_presence` と同じ揮発フレームを、読める人の接続にだけ中継する（M126 以降）。

### 7.4 スマホ

キャンバスと同じ：閲覧が既定、見出しごとの「このセクションを編集」と「全体を編集」、チェックはタップで保存、オフラインで最近開いた
ページを読める（M74 と同じ）。共有設定は見るだけ（変更は Desktop / Web）。

## 8. 検索と AI

### 8.1 検索

- 索引：`wiki_pages_search_idx`（PGroonga、`ARRAY[title::text, body, props_text]`。`props_text` は行のプロパティを文字にしたもの
  （セレクトの名前・テキスト・人の名前）、保存のたびに作る）。タスクの印は今のキャンバスの索引と同じく外す。
- `GET /search/pages?q&in_page&from_user_id&after&before&kind&sort&limit&offset`。条件は今の検索と同じ書き方（`from:@`、
  `before:` …）に `in:ページの題名`（その部分木。`path` で絞る）を足す。
- 必ず読める集合で絞る：`WHERE id IN (読める集合) AND deleted_at IS NULL AND <索引の条件>`。`title &@~ q OR body &@~ q` の形は
  使わない（CANVAS.md §4.8 の測定と同じ理由）。
- 検索の画面に「ドキュメント」のタブ（「メッセージ / ファイル / キャンバス」の隣）。⌘K の候補にページの題名。
  Desktop / Web では、ドキュメントのサイドバーの検索の欄（打つとすぐ結果）と、開いたページの中の ⌘F（§29.2・§29.3）。

### 8.2 AI に聞く（M126）

- AI.md §13 の「AI に聞く」に、メッセージと並べてページを拾う：本人として `/search/pages` と同じ問い合わせで上位 10 ページ、
  各ページから当たった語のまわりの見出しのまとまり（2,000 字まで）を資料にする。出典は `{n, kind: "page", page_id, heading, excerpt}`。
- **非公開の扱い**：実効の権限に `workspace` の `view` 以上を含まないページは「非公開」とみなし、ボットに `allow_private` が
  無ければ範囲から外して件数だけを `omitted_count` に入れる（会話の非公開と同じ規則）。
- 埋め込み（意味検索）は今と同じく後。本文はプレーンな Markdown なので、`wiki_page_chunks (page_id, head_rev_id, chunk_index,
  embedding)` を読める集合の絞り込みと一緒に足せる（ARCHITECTURE.md D18）。

## 9. 端末

### 9.1 Desktop / Web（M121）

- サイドバーの項目に「ドキュメント」（`apps/shared/nav-items.json` に `docs`）。開くと本文の領域を 2 つに分ける：左に木
  （共有 / プライベート、開閉、ドラッグで並べ替え・移動（確認つき）、＋で子ページ、⋯ のメニュー）、右にページ。
- ページ：パンくず、アイコンと題名、「閲覧 | 編集」、本文、右に目次、下にサブページとバックリンク。見出しの右に「共有」
  （Notion と同じ：相手を足す（人・グループ・ワークスペース全員）、段階、受け継いだ項目は「〇〇から」と薄く、受け継ぎの停止 / 再開、
  リンクをコピー）。⋯ に移動・ゴミ箱・履歴・Markdown で書き出し・ページの記録。
- データベース（M123）：表（列の幅・並べ替え・絞り込みの棒、マスをその場で編集、＋新規）、行は右のペインで開く（Notion の
  サイドピーク）。⋯ にプロパティの編集・ビューの編集・CSV の書き出し。
- ゴミ箱の画面、検索の「ドキュメント」タブ、`/p/` のカード（メッセージ・キャンバスの中）、管理 →「ドキュメント」（一覧と引き取り）。
- Tauri は SQLite に木とメタ・最近開いた本文・保存待ちを持つ。Web はメモリ。

### 9.2 iOS / Android（M122・M124）

- ホームのタイル「ドキュメント」→ 木を 1 段ずつたどる一覧（Files アプリのように。上に検索）。最上位は「共有」「プライベート」。
- ページ：キャンバスと同じ描画、パンくず（タップで戻る）、目次のメニュー、サブページ、バックリンク。編集はセクション / 全体。
- データベース：ビューを選んでカードの一覧、行はプロパティのフォーム + 本文（§5.5）。
- 共有設定は見るだけ。移動・ゴミ箱は v1 では Desktop / Web だけ。
- iPad / Android タブレットは一覧と本文の 2 ペイン（MOBILE_UI.md §12・§13 の作りのまま）。

### 9.3 リンクと通知

- パーマリンク `<server>/p/<page_id>`（`pages.py` の案内ページ。認証なし、中身は出さない、`/c/` と同じ）。アプリは本文中のこの URL と
  `page:` のリンクを開ける。行のページも同じ id。
- 通知（PushPlanner、PUSH_NOTIFICATIONS.md に追加）：
  - `page_mention`：ページで新しくメンションされた（読める人だけ。キャンバスの §18.1 と同じ規則、1 ページ 1 項目（未読の間））。
  - `page_shared`：名前を挙げて共有された（§4.8）。
  - アクティビティの項目（`include=page_mention,page_shared`。知らない端末には出ない）。開けば既読（2026-10-07、MOBILE_UI.md §6.4。
    開いた後のメンションは新しい項目）。
- ページの「フォロー」（変更の通知）は後（§13 Q13）。

## 10. 同期

- **bootstrap には木を入れない**。入れるのは `wiki: {change_seq}`（変更のフィードの今の番号。サーバが対応しているかの判定も兼ねる）。
- **木の変更のフィード**：`wiki_pages.meta_seq`（共通の連番 `wiki_change_seq`）。題名・アイコン・親・並び・ゴミ箱・共有（部分木の全部）
  が変わるたびに進める。**本文の保存では進めない**（2 秒ごとの保存で全員が読み直さないように）。
  - `GET /wiki/changes?since=<seq>` → `{pages: [PageMeta], removed: [id], cursor, reset}`。`since` より後に変わったページのうち、
    読めるものは `pages`、読めない・ゴミ箱のものは `removed`（id だけ）。完全に消したページは `wiki_tombstones (page_id, seq)` を
    30 日残し、それより古い `since` は `reset: true`（全部読み直す）。行（`kind = 'row'`）は木のフィードに入れない。
  - 初回とリセット：`GET /wiki/tree`（読めるページのメタ全部。2,000 ページで約 300 KB の見込み。ETag）。
- **WS イベント**（本文は載せない）：

  | type | audience | data |
  | --- | --- | --- |
  | `wiki.changed` | all | `{ seq }`。木のフィードが進んだ。中身は人ごとに違うので載せない（`reservation.updated` と同じ考え方）。端末は 300 ms まとめて `GET /wiki/changes` |
  | `wiki.page.updated` | page（読める人。リレーが送る時に実効の表で解決） | `{ page: PageMeta, change: "content" \| "props" \| "restore" }`。開いているページ・表を読み直す（編集中はキャンバスと同じく次の保存でマージ） |
  | `wiki.rows.changed` | page（データベースを読める人） | `{ database_id, seq }`。開いている表を読み直す |
  | `wiki.mentioned` | user | `{ page_id, rev_id, title, by_user_id }` |
  | `wiki.shared` | user | `{ page_id, title, level, by_user_id }` |

- audience `page` は outbox に新しく足す種類（`audience_type = 'page'`、`audience_id = page_id`）。リレーが送る時点の実効の権限で
  宛先を決めるので、書いた後に権限が狭まっても、読めなくなった人には届かない。
- 再接続の後：`GET /wiki/changes?since=`、開いているページは `GET /wiki/pages/{id}`（If-None-Match）、開いている表は行の読み直し。
- `group.updated`・自分のロールの変化（`user.updated`）では、読める範囲が変わりうるので `GET /wiki/tree` を読み直す。
- オフライン：木と最近開いたページ（スマホは 20 件、M74 と同じ）を読める。編集はキャンバスと同じ保存待ち。共有の変更・移動は
  オンラインのときだけ。

## 11. データモデル・API の下書き

### 11.1 表（移行 0095〜）

```sql
CREATE SEQUENCE wiki_change_seq;

CREATE TABLE wiki_pages (
  id              uuid PRIMARY KEY,                         -- UUIDv7
  parent_id       uuid REFERENCES wiki_pages(id),           -- NULL = 最上位
  path            uuid[] NOT NULL DEFAULT '{}',              -- 根から親までの id
  position        text COLLATE "C" NOT NULL,                -- 兄弟の中の分数の索引
  kind            varchar(16) NOT NULL DEFAULT 'page',      -- page | database | row
  title           varchar(200) NOT NULL DEFAULT '',
  icon            varchar(64),                              -- 絵文字か :custom:
  body            text NOT NULL DEFAULT '',                 -- キャンバスの方言 + page: リンク。100,000 字まで
  version         bigint NOT NULL DEFAULT 1,                -- 本文・題名・設定の変更ごとに +1
  head_rev_id     uuid NOT NULL,
  meta_seq        bigint NOT NULL,                          -- 木のフィード (wiki_change_seq)
  inherit_access  boolean NOT NULL DEFAULT true,
  props           jsonb,                                    -- 行だけ: {prop_id: value}
  props_text      text,                                     -- 行だけ: 検索用
  task_total      integer NOT NULL DEFAULT 0,
  task_done       integer NOT NULL DEFAULT 0,
  created_by      uuid NOT NULL REFERENCES users(id),
  updated_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  deleted_by      uuid REFERENCES users(id),
  trash_root_id   uuid,                                     -- 一緒にゴミ箱へ入った部分木の根
  CHECK (kind IN ('page', 'database', 'row')),
  CHECK ((kind = 'row') = (props IS NOT NULL))
);
CREATE INDEX wiki_pages_children_idx ON wiki_pages (parent_id, position) WHERE deleted_at IS NULL;
CREATE INDEX wiki_pages_path_idx ON wiki_pages USING gin (path);
CREATE INDEX wiki_pages_meta_seq_idx ON wiki_pages (meta_seq);
CREATE INDEX wiki_pages_search_idx ON wiki_pages
  USING pgroonga ((ARRAY[title::text, body, coalesce(props_text, '')]));

CREATE TABLE wiki_page_revisions (                          -- canvas_revisions と同じ形
  id uuid PRIMARY KEY, page_id uuid NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  version bigint, kind varchar(16) NOT NULL,                -- create | save | merge | side | restore | erased | props | import
  parent_rev_id uuid, author_id uuid NOT NULL REFERENCES users(id),
  title varchar(200) NOT NULL, body text NOT NULL, props jsonb,
  client_save_id uuid, label varchar(80),
  lines_added integer NOT NULL DEFAULT 0, lines_removed integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX wiki_page_revisions_save_uniq ON wiki_page_revisions (author_id, client_save_id)
  WHERE client_save_id IS NOT NULL;

CREATE TABLE wiki_grants (                                  -- 自前の項目
  id             uuid PRIMARY KEY,
  page_id        uuid NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  principal_type varchar(16) NOT NULL,                      -- workspace | group | user (後で channel / public)
  principal_id   uuid,                                      -- workspace は NULL
  level          varchar(8) NOT NULL,                       -- view | edit | full
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (page_id, principal_type, principal_id)
);

CREATE TABLE wiki_effective_grants (                        -- 受け継ぎを計算した結果 (§4.6)
  page_id        uuid NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  principal_type varchar(16) NOT NULL,
  principal_id   uuid,
  level_rank     smallint NOT NULL,                         -- 1 view / 2 edit / 3 full
  source_page_id uuid NOT NULL,                             -- どのページの項目から来たか (共有の画面の「〇〇から」)
  UNIQUE NULLS NOT DISTINCT (page_id, principal_type, principal_id)
);
CREATE INDEX wiki_effective_principal_idx ON wiki_effective_grants (principal_type, principal_id, page_id);

CREATE TABLE wiki_databases (
  page_id        uuid PRIMARY KEY REFERENCES wiki_pages(id) ON DELETE CASCADE,
  schema         jsonb NOT NULL,     -- {"properties": [{"id","name","type","options":[{"id","name","color"}],"format"}]}
  views          jsonb NOT NULL,     -- [{"id","name","type":"table","columns":[…],"sort":[…],"filter":{…}}]
  schema_version bigint NOT NULL DEFAULT 1
);

CREATE TABLE wiki_links (
  src_page_id uuid NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  dst_page_id uuid NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  PRIMARY KEY (src_page_id, dst_page_id)
);
CREATE INDEX wiki_links_dst_idx ON wiki_links (dst_page_id);

CREATE TABLE wiki_notices (                                 -- アクティビティの項目 (canvas_mentions と同じ考え方)
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id uuid NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  kind varchar(16) NOT NULL,                                -- mention | shared
  rev_id uuid, actor_id uuid REFERENCES users(id) ON DELETE CASCADE,
  excerpt varchar(200), at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wiki_tombstones (page_id uuid PRIMARY KEY, seq bigint NOT NULL, purged_at timestamptz NOT NULL);

ALTER TABLE attachments ADD COLUMN page_id uuid REFERENCES wiki_pages(id);
-- ページの画像・ファイル: message_id・channel_id・canvas_id は NULL。アクセスはページの view (§4.7)
```

### 11.2 API（すべて `/api/v1`。OpenAPI と ws-events.json を再生成）

| メソッド | パス | 内容 | 段階 |
| --- | --- | --- | --- |
| GET | /wiki/tree | 読めるページのメタ（行を除く）と `cursor`。ETag | — |
| GET | /wiki/changes?since= | 木のフィード（§10） | — |
| GET | /wiki/pages/{id} | メタ + 本文 + `head_rev_id` + `my_level` + パンくず（読めない祖先は題名なし） + サブページ。ETag = version | view |
| POST | /wiki/pages | 作成 `{parent_id?, before_id?, after_id?, kind, title, icon?, template_key?, body?, access?: "private" \| "workspace", tz, client_save_id}` | 親の edit（最上位はゲスト以外） |
| PUT | /wiki/pages/{id}/content | 保存（CANVAS.md §4.4 と同じ） | edit |
| PATCH | /wiki/pages/{id} | 題名・アイコン | edit |
| POST | /wiki/pages/{id}/move | 移動（`dry_run` で見える人の増減） | full + 移動先の edit |
| DELETE / POST | /wiki/pages/{id}、/wiki/pages/{id}/restore | ゴミ箱へ / 戻す（部分木） | full |
| GET | /wiki/trash | 自分が full のゴミ箱のページ | — |
| GET / PUT | /wiki/pages/{id}/access | 共有設定（自前の項目、受け継いだ項目と元のページ、`inherit_access`）／置き換え | view（読むだけ、相手の一覧）／ full |
| GET | /wiki/pages/{id}/revisions …（キャンバスと同じ 5 つ） | 履歴 | view / edit / full |
| GET | /wiki/pages/{id}/backlinks | 読めるページからのリンク | view |
| POST | /wiki/pages/resolve | `{ids}` → 読めるものの `{id, title, icon, kind}` | — |
| GET | /wiki/pages/lookup?q= | `[[` の候補（題名の前方・部分一致、読めるものだけ） | — |
| GET | /wiki/pages/{id}/export | Markdown（部分木は zip、読めるものだけ） | view |
| GET / PATCH | /wiki/databases/{id}、/wiki/databases/{id}/schema | スキーマとビュー／スキーマの変更 `{ops, base_schema_version}` | view／full（M144 から edit、削除・型の変更・双方向は full） |
| PUT / DELETE | /wiki/databases/{id}/views/{view_id} | ビューの保存・削除 | full（M144 から edit） |
| GET | /wiki/databases/{id}/rows?view_id=&sort=&filter=&cursor=&limit= | 行（本文なし） | view |
| POST | /wiki/databases/{id}/rows | 行の作成 `{title, props, client_save_id}` | edit |
| PATCH | /wiki/rows/{id}/props | `{set, client_op_id}` | edit |
| GET | /wiki/databases/{id}/export.csv?view_id= | CSV | view |
| GET | /search/pages | 検索（§8.1） | — |
| GET / POST | /admin/wiki/pages、/admin/wiki/pages/{id}/takeover | 管理者の一覧と引き取り（§4.3） | admin |
| GET | /p/{page_id} | ブラウザ向けの案内ページ | — |

新しいエラーコード（`apps/shared/errors.json`）：`page_not_found`（404）、`page_edit_restricted` / `page_manage_restricted`（403）、
`page_conflict` / `page_base_expired`（409、キャンバスと同じ形）、`page_too_large`（422）、`wiki_move_cycle`（409）、
`page_last_manager`（409）、`wiki_schema_conflict`（409）、`wiki_too_many_rows`（409）、`wiki_invalid_property_value`（422）。

### 11.3 モジュール

`app/modules/wiki/`（models / schemas / repository / access.py / service / router / events / databases.py / importer_notion.py）と
`app/core/doctext/`（§2.3）。依存：`wiki → users, groups, attachments, audit, core.doctext`。`search → wiki`（読み取り専用の例外、
ARCHITECTURE.md §5）。`ai → search`（今のまま）。`canvases → core.doctext`。`wiki` は `channels` に依存しない。

## 12. マイルストーン

v1 は M120〜M125。順番は「権限の土台（サーバ）→ 使う画面 → スマホ → データベース → 取り込み」。取り込みはデータベースの後
（論文リスト・備品台帳がデータベースなので、ページだけ先に取り込むと二度手間になる）。

| # | 名前 | 内容 | 完了条件 |
| --- | --- | --- | --- |
| M120 | ドキュメントのサーバ：木と権限（**実装済み 2026-10-07**、§14） | `core/doctext` の切り出し（キャンバスの振る舞いは変えない）、`wiki_pages`・版・自前 / 実効の権限・リンク・ゴミ箱・画像（`attachments.page_id`）・変更のフィード・`wiki.*` イベントと audience `page`・メンションと共有の通知・`/search/pages`・`/p/`・管理者の引き取り・`wiki-acl --verify`。移行 0095〜 | pytest：権限の表（受け継ぎ・足す・絞る・移動・`keep_access`・復元・ゲスト・グループ・管理者・最後の full）を全部の経路（ページ・画像・検索・バックリンク・解決・イベント・通知・書き出し）で確かめ、読めない人に題名が 1 か所も出ないこと。実効の表と全部の計算し直しが常に一致。キャンバスのテストがすべて通る。1 万ページの判定・読める集合・1,000 ページの移動を測って §4.6 の目標に入る。OpenAPI・ws-events を再生成 |
| M121 | ドキュメント：Desktop / Web（**実装済み 2026-10-07**、§15） | §9.1（データベースを除く）：木・ページ・編集（`[[`、`/` のメニュー、子ページを作る）・共有の画面・移動（確認）・ゴミ箱・履歴・バックリンク・検索のタブ・`/p/` のカード・アクティビティ・管理の一覧 | tsc・vitest（共有の画面の受け継ぎの表示、変更のフィードの取り込み、`page:` の字句解析のケース）・vite build・`cargo check`。ブラウザで 2 人（片方はゲスト）で、共有の追加・絞り込み・移動で見えたり消えたりすることを確認 |
| M122 | ドキュメント：iOS / Android | §9.2（データベースを除く）：木・閲覧・セクション / 全体の編集・オフライン閲覧・パーマリンク・プッシュ（`page_mention`・`page_shared`） | xcodebuild のテストと Gradle のビルド・テスト。`canvas_markdown.json` の追加のケースが 3 端末で通る。実機 / シミュレータで通知から開ける |
| M123 | データベース：サーバと Desktop / Web（**実装済み 2026-10-07**、§18） | §5：スキーマ・行・プロパティの変更（マスごとの後勝ち）・**関係（一方向 / 双方向、§5.7）**・ビュー（表、並べ替え・絞り込み・列、**カレンダー §5.8**）・行の履歴・CSV の書き出し（2026-10-07 の Q8 の答えで関係とカレンダーを足した） | pytest（型ごとの値の検査と変換、関係の両方向と読めない行の扱い、カレンダーの範囲、5,000 行で 50 ms 以下）、Desktop の表の編集・サイドピーク・カレンダー |
| M124 | データベース：iOS / Android | §5.5：ビューを選んで**表はカードの一覧、カレンダーは予定の一覧（日ごと）**・行のフォーム（関係は読める行の候補から選ぶ、読めない行は「アクセスできないページ」）・本文 | 3 端末で同じデータベースを開き、同じ並びと値になる。ビルドとテスト |
| M125 | Notion からの取り込み（**実装済み 2026-10-07**、§21） | §6：`app.cli import-notion`（試し読み・本番・再実行）、infra/README.md の手順 | 利用者からもらった書き出しのサンプルで、ページ・木・データベース・画像・リンクが移り、報告（取れないもの）が出る。もう一度実行しても増えない。編集したページを上書きしない |
| M126 | AI と仕上げ（任意） | §8.2 の「AI に聞く」をページへ、キャンバスの「ドキュメントへ移す」（§2.4）、編集中の表示 | AI：読めないページ・`allow_private` の無いボットへの非公開ページが資料に入らないことをテスト。移す：画像の複製と元のキャンバスの案内の行 |

v1 の後の候補：見たまま編集（Desktop / Web）、ボードのビューとまとめる、ページのコメント、ページのフォロー、ロールアップ・数式、
ページの中のデータベース、CSV の読み込み、Web からの取り込み、公開ページ。

### 12.1 実装と同時に直す docs

ARCHITECTURE.md（§5 のモジュールと依存、判断 D27「ドキュメントは別の実体、本文の部品はキャンバスと共有、権限は受け継ぎ +
実効の表」）、DATA_MODEL.md（表）、SYNC_PROTOCOL.md（§6 のイベント、新しい節「ドキュメント」）、SECURITY.md（§3.2 の行、§4 の
添付、§15 の AI）、PUSH_NOTIFICATIONS.md（`page_mention`・`page_shared`）、AI.md（§13 の拾い方）、MOBILE_UI.md（ホームのタイル）、
`apps/shared/nav-items.json`・`errors.json`・`canvas_markdown.json`、infra/README.md（取り込み）、website の使い方ガイド。

## 13. リスクと、利用者に確かめること

### 13.1 リスク

| リスク | 対策 |
| --- | --- |
| 権限の漏れ（題名・本文・画像・検索の抜粋・AI・通知のどれか 1 か所） | 判定は `wiki/access.py` の 1 か所。M120 のテストで「読めない人」をすべての経路に当てる表を作る。読めないものは 404 で存在も隠す |
| 実効の表のずれ | 同じトランザクションで計算し直す、直列化のロック、`--verify` をテストと日々の周期ジョブで回す（ずれたらログと `/readyz` の警告） |
| 範囲が広がる（Notion は巨大） | §1.2 の「入れないもの」を守る。データベースは表のビューだけで出す |
| Markdown のエディタが学生に合わない | `/` のメニューと `[[` で記号を覚えなくてよくする。使ってみて足りなければ見たまま編集を Desktop / Web に（§7.3） |
| 取り込みの再現度 | サンプルで先に確かめる。試し読みの報告。再実行できる |
| キャンバスの部品の切り出しで回帰 | 純粋な関数を移すだけ、キャンバスの全テストを通す、切り出しだけを先に 1 つのコミットにする |
| 木が大きくなったときの `GET /wiki/tree` | 変更のフィードで差分だけ。1 万ページで 1.5 MB の見込みなので、超えたら最上位から開いた所だけ読む形に変える（API は `parent_id` で絞れるようにしておく） |
| 3 端末の作業量 | スマホは閲覧と軽い編集。共有の設定・移動・スキーマは Desktop / Web だけ |

### 13.2 利用者の決定（2026-10-07）

利用者は、Q9 を除くすべてを決めた（Q8 は推奨ではなく使い方の答え。番号は本文からの参照のため元のまま）。

| # | 質問 | 決定 |
| --- | --- | --- |
| Q1 | 木は 1 つでよいか | **1 つ**（ワークスペースの「ドキュメント」に最上位のページを並べる。チームスペースの表は作らない） |
| Q2 | 新しい最上位のページの既定 | **全員が編集できる**（`workspace: edit` + 作った人の `user: full`）。「プライベート」の ＋ からは作った人だけ |
| Q3 | ゲスト（卒業生など） | **名前を挙げて共有したページだけ**読める（`alumni` などのグループ・全員の項目はゲストに効かない） |
| Q4 | 会話のメンバーを共有の相手に | v1 は作らない（グループで足りる）。`principal_type = 'channel'` を後から足せる |
| Q5 | 管理者は学生のプライベートなページを読めなくてよいか | **黙っては読めない**。題名と共有の一覧と、監査ログに残る「引き取り」だけ |
| Q6 | 編集の形 | **キャンバスと同じ Markdown + プレビュー + 行頭の `/` メニュー**（キャンバスのエディタ）。見たまま編集は要らない（後で検討）。**2026-10-08 に見直した**：使ってみて要望が出たので、見たままを既定にする（§22.8 R1） |
| Q7 | ページへのコメント | **v1 は作らない** |
| Q8 | データベースの使い方 | **関係（relation）とカレンダーのビューを使っている、行は数百**（2026-10-07）。M123 に関係（§5.7）とカレンダー（§5.8）を入れ、M124 のスマホは表をカード・カレンダーを予定の一覧で出す。ロールアップ・数式・ボードは v1 の後 |
| Q10 | キャンバスとの関係 | 推奨どおり：会話の議事録・週報はキャンバス、長く残すものはドキュメント。「ドキュメントへ移す」は M126（任意） |
| Q11 | スマホでどこまで | **閲覧・軽い編集（セクション / 全体）・データベースの行の値の変更**。共有の設定と移動はパソコン（Desktop / Web）だけ |
| Q12 | 画面の名前 | **「ドキュメント」**（英語 Docs、中国語 文档） |
| Q13 | ページのフォロー（変更の通知） | **後で**。v1 はメンションと共有の通知だけ |
| Q14 | 公開ページ | **後で**（§4.9 の形を残す） |

### 13.3 まだ利用者に確かめること

8. ~~**データベース**~~：答えがあった（2026-10-07、§13.2 Q8：関係とカレンダー、数百行）。
9. ~~**Notion の書き出しのサンプル**~~：2026-10-07 に研究室の書き出し全体（zip 1 つ、約 80 MB）をもらい、§6.1 を確かめた。
   取り込みはサーバでのコマンドで始める（Web から zip を上げる画面は要望があれば後）。残り：この書き出しには**関係の列が無かった**
   （§13.2 Q8 では「関係を使っている」）。関係を使っているデータベースが別のワークスペース・ページにあれば、その書き出しで
   `--dry-run` の型（`relation`・双方向）を確かめる。

## 14. M120 の実装（2026-10-07）

サーバだけ。端末（M121・M122）はこの API を使う。

### 14.1 作ったもの

- **`app/core/doctext/`**（§2.3）：`merge.py`（3-way マージ）・`markers.py`（タスクの印）は中身を変えずに移し、`canvases/merge.py`・
  `markers.py` は再エクスポートだけにした。`body.py`（本文の整形・タスクの数・差分の行数・画像の参照・ページのリンク・メンションの
  トークン）、`save.py`（保存の手順 `save_flow` とマージのスレッドプール）、`revisions.py`（版の整理の方針と、表ごとの SQL を作る
  `thin_statement`）。キャンバスの保存もこの `save_flow` を通る。キャンバスの既存のテストはすべてそのまま通る。
- **移行 0095**：§11.1 の表（`wiki_databases` は M123）。種類 `page | database | row` の制約は今から入れた（M120 の API は `page`
  だけを作る）。
- **`app/modules/wiki/`**：`access.py`（判定の 1 か所）、`ordering.py`（分数の索引）、`service.py`、`router.py`、`events.py`、
  `repository.py`、`schemas.py`。依存は `wiki → users, groups, attachments, audit, activity（抜粋の純粋な関数）, canvases（テンプレートの
  読み取り）, core.doctext`。`attachments → wiki` の判定は `main.py` が注入する（`set_page_access_check`）。
  `search → wiki`・`activity → wiki`・`notifications → wiki`・`admin → wiki`（匿名化で `user` の項目を消す）は読み取りか同じ
  トランザクションの呼び出し。
- **CLI**：`python -m app.cli wiki-acl --verify`（違いがあれば終了コード 1）と `--rebuild`。

### 14.2 API（M121・M122 が使うもの。すべて `/api/v1`）

| メソッド | パス | 返すもの / 要点 |
| --- | --- | --- |
| GET | `/wiki/tree` | `TreeOut {pages: [PageItem], cursor}`。行（row）は入らない。ETag（中身のハッシュ）、`If-None-Match` で 304 |
| GET | `/wiki/changes?since=` | `ChangesOut {pages: [PageItem], removed: [id], cursor, reset}`（§14.4） |
| POST | `/wiki/pages` | `PageCreate {parent_id?, before_id? \| after_id?, title?, icon?, template_key?, body?, access: workspace \| private, tz?, client_save_id}` → 201 `PageOut`（再送は 200）。最上位はゲスト不可（403 `guest_restricted`） |
| GET | `/wiki/pages/{id}` | `PageOut`（`PageItem` + `body` + `breadcrumbs: [Crumb {id?, title?, icon?, readable}]` + `children: [PageItem]`）。ETag `"v{version}-{my_level}"` |
| PUT | `/wiki/pages/{id}/content` | `PageContentSave {base_rev_id, body, client_save_id, on_conflict}` → `PageSaveOut {page: PageContent, submitted_rev_id, merged}`。409 `page_conflict` / `page_base_expired`（`details.head` と `conflicts`、キャンバスと同じ形）、422 `page_too_large` |
| PATCH | `/wiki/pages/{id}` | `{title?, icon?}`（`icon: ""` で外す）→ `PageOut` |
| POST | `/wiki/pages/{id}/move` | `PageMove {parent_id, before_id? \| after_id?, keep_access, dry_run}` → `MoveOut {dry_run, page, changes: [AccessChange {principal_type, principal_id, before, after}], manager_lost}` |
| DELETE / POST | `/wiki/pages/{id}`、`/wiki/pages/{id}/restore` | 部分木ごとゴミ箱へ（204）／戻す（`PageOut`）。一緒に入った子だけを戻すのは 409 `page_trashed_with_parent` |
| GET | `/wiki/trash` | 自分が full のゴミ箱の根（`PageMeta`、`deleted_at` 付き） |
| GET / PUT | `/wiki/pages/{id}/access` | `AccessOut {page_id, inherit_access, own: [GrantOut], effective: [EffectiveOut {…, source_page_id?（読めない祖先なら null）, inherited, source_title?}], my_level}`／`AccessUpdate {inherit_access, grants: [GrantIn]}`（自前の項目の置き換え、full かつゲストでない人） |
| GET | `/wiki/pages/{id}/revisions`、`…/revisions/{rid}` | `PageRevisionPage` / `PageRevisionOut`（キャンバスと同じ） |
| POST / PATCH / DELETE | `…/revisions/{rid}/restore`、`…/revisions/{rid}`、`…/revisions/{rid}` | 版の復元（edit、`client_save_id`）・ラベル（edit）・本文の消去（full、監査） |
| GET | `/wiki/pages/{id}/backlinks` | 読めるページからのリンク（`[PageItem]`） |
| POST | `/wiki/pages/resolve` | `{ids}`（200 まで）→ 読めるものだけの `[PageRef {id, title, icon, kind}]` |
| GET | `/wiki/pages/lookup?q=&limit=` | `[[` の候補（題名の部分一致、前方一致が先） |
| GET | `/wiki/pages/{id}/export[?subtree=true]` | Markdown（`text/markdown`）／読めるページだけの ZIP |
| GET | `/search/pages?q&in_page&from_user_id&after&before&kind&sort&limit&offset` | `PageSearchOut {hits: [{page: PageItem, snippet, score}], keywords, filters (in_page を足した), …}`。`in:<題名>` で部分木 |
| GET / POST / DELETE | `/admin/wiki/pages`、`/admin/wiki/pages/{id}/takeover`、`/admin/wiki/pages/{id}` | 管理者：題名と実効の相手の一覧（本文なし、`has_manager`）／引き取り（監査 `wiki.access_takeover`、ゴミ箱のページなら null）／ゴミ箱のページをすぐ完全削除（監査 `wiki.purge`） |
| GET | `/p/{id}` | ブラウザ向けの案内（`/c/` と同じく中身も存在も出さない） |

`PageItem` = `PageMeta {id, parent_id, position, kind, title, icon, version, head_rev_id, meta_seq, inherit_access, task_total,
task_done, created_by, updated_by, created_at, updated_at, deleted_at}` + `my_level`（view / edit / full）+ `private`（実効の権限が
自分だけ：サイドバーの「プライベート」）。兄弟の並びは `position` の文字列（バイト順）、同じなら id 順。

bootstrap に `wiki: {change_seq}`。アクティビティは `include=page_mention` / `include=page_shared` で `ActivityItem.page
{item_id, page_id, title, icon, excerpt, rev_id, level}`（そのページを今読める間だけ。未読数ではメンション扱い）。プッシュは
`kind: "page"`（`page_id`、`collapse_key: page:<id>`、題名「ドキュメント」）。新しいエラーコードは `apps/shared/errors.json`。

### 14.3 イベント

| type | audience | data |
| --- | --- | --- |
| `wiki.changed` | all | `{seq}`。木のフィードが進んだ。端末は 300 ms まとめて `GET /wiki/changes?since=` |
| `wiki.page.updated` | page（送る時点で読める人） | `{page: PageMeta, change: content \| meta \| restore}`。`page.parent_id` は常に null（場所はフィードから） |
| `wiki.mentioned` | user（送る時点で読める人だけ） | `{page_id, rev_id, title, by_user_id}` |
| `wiki.shared` | user（同上） | `{page_id, title, level, by_user_id}` |

### 14.4 設計からの違い・足したもの（理由）

- **`vis_seq` と `created_seq`**（`wiki_pages`）：§10 のとおり「読めないページは `removed`」にすると、読めない人にも題名の変更の
  たびにほかの人のプライベートなページの id が届く。見える人が変わりうる変更（作成・共有・移動・ゴミ箱・復元）だけ `vis_seq` を進め、
  作ってから見える人が変わっていないページ（`created_seq = vis_seq`）は `removed` に入れない。ゴミ箱のページは、そのページの実効の
  権限が今もある人にだけ `removed` で出す。完全に消したページの id（tombstone）は全員に出る（id だけ）。
- **フィードの番号は 1 つの変更（トランザクション）に 1 つ**：番号は木のロックの中で取るので、コミットの順と番号の順が一致する。
  `cursor` は「今見えている最大の番号」（シーケンスの値ではない）を先に読むので、走っている変更を飛ばさない。変わったページが
  5,000 を超えたら `reset`。`wiki_feed_state.purged_through`（tombstone を 30 日で消した位置）より古い `since` も `reset`。
- **親が読めないページの `parent_id` は null**（その人の木・フィード・ページ・検索の結果）：§4.6 の「最上位に出す」をサーバでそろえ、
  読めない親の id も出さない。`wiki.page.updated` の `parent_id` はいつも null。
- **移動の `page_last_manager`**：受け継ぐ移動で full の人（ゲストでない有効な人）がいなくなるなら 409（`keep_access` で移せる）。
  `dry_run` の `manager_lost` で先に分かる。
- **親のないページの扱い**：親がゴミ箱・完全に削除されたあとで子を戻すとき、子だけ先にゴミ箱に入っていて親が先に完全に消えるとき
  は、そのページを最上位に置き、実効の項目を自前の項目に写して受け継ぎを止める（見える人を変えない）。`parent_id` は
  `ON DELETE SET NULL`。
- **ゴミ箱は根だけを戻せる**：親と一緒に入ったページだけを戻すのは 409（親を戻す）。full の人が親を消すと、ほかの人だけの子も
  一緒にゴミ箱に入り、戻せるのは親の full の人（Notion と同じ動き）。
- **管理者の完全削除**：`DELETE /admin/wiki/pages/{id}`（§4.3 の「完全削除」）。
- **作っていないもの**：`GET /wiki/pages/{id}/activity`（§7.2 のページの記録。監査ログには残している）は端末を作る M121 で足す。
  `canvas_markdown.json` の `page:` のケースと `nav-items.json` の `docs` は端末の M121。データベース（§5）は M123。
- **全体の木の大きさ**：1 万ページ（読める 7,000）で `GET /wiki/tree` は約 3.6 MB・約 100 ms（`PageItem` は 1 ページ約 520 バイト）。
  §13.1 の見込み（1.5 MB）より大きい。差分は変更のフィードで取り、ETag で全体の読み直しを省く。超えたら木を開いた所だけ読む形にする。

### 14.5 性能（`tests/test_wiki_perf.py`、1 万ページ・実効 31,644 行、M5 Max の開発機の Docker の PostgreSQL）

| 測ったもの | 目標（§4.6） | 実測 |
| --- | --- | --- |
| 1 ページの判定（`access.level_of`、往復を含む中央値） | 1 ms 以下 | 0.6〜0.8 ms |
| 読める集合（`access.readable_ids`、7,000 件を取り出す） | 10 ms 以下 | 約 5 ms |
| 1,000 ページの部分木の移動（ロック・計算・3,000 行の書き換え・コミットまで） | 300 ms 以下 | 約 80 ms |

テストは目標の 2 倍を上限として毎回確かめる（並列のテストで遅くなっても落ちないように）。

### 14.6 テスト

`tests/test_wiki.py`（作成・保存とマージ・履歴・閲覧の制限・リンク・移動と受け継ぎ・絞る / 足す・最後の full・ゲスト・管理者の
引き取り・ゴミ箱と完全削除・変更のフィード・イベントの宛先・メンション・分数の索引・深さ・`/p/`・整理・`wiki-acl`）、
`tests/test_wiki_no_leak.py`（読めない人（メンバー・グループに入ったゲスト・管理者）に 34 の経路を当て、404 と題名・本文・id が
出ないことを確かめる 1 つのパラメータ化されたスイート）、`tests/test_wiki_acl_property.py`（無作為な操作の列と同時の変更のあとで
実効の表 = 全部の計算し直し）、`tests/test_wiki_search.py`（検索の絞り込みと索引、ページの画像、プッシュ）、`tests/test_wiki_perf.py`、
`tests/test_doctext.py`。

## 15. M121 の実装（Desktop / Web、2026-10-07）

§14 の API をそのまま使う。サーバは変えていない。

### 15.1 作ったもの

| 部分 | 内容 |
| --- | --- |
| サイドバー | `apps/shared/nav-items.json` に `docs`（「ドキュメント」、既定の並びはどちらも「キャンバス」の次）。今は `platforms: ["desktop"]`（スマホの M122 で `mobile` を足す）。iOS / Android の目録の写しも合わせた。サーバが `wiki` を返さないとき（M120 より前）は出さない。Web の狭い画面ではホームのタイル |
| 木 | 「共有」「プライベート」（`private`：実効の権限が自分だけ）の 2 つの見出し。兄弟は `position` のバイト順、同じなら id 順。親が読めないページは最上位（サーバが `parent_id` を null にして送る）。開閉は端末ごと・アカウントごとに覚える（`localStorage`）。開いたページまでの枝は自動で開く。＋（見出し：最上位、`access` は `workspace` / `private`。ページの行：子ページ）、⋯（開く・子ページ・名前・リンクをコピー・最上位へ移動・ゴミ箱）、最下部にゴミ箱 |
| 移動 | フルアクセスのページだけドラッグできる。行の上 / 下 3 割で「前 / 後」（`before_id` / `after_id`）、真ん中で「中」（最後の子の後）、見出しに落とすと最上位。自分の下へは落とせない。まず `dry_run` で聞き、見える人が変わらなければそのまま移す。変わるなら確認の画面（見られるようになる人・見られなくなる人、「移動先の共有に合わせる」/「今の共有のまま」= `keep_access`）。`manager_lost` のときは後者だけ |
| ページ | パンくず（読めない祖先は「…」：題名も id もリンクも出さない）、アイコン（絵文字・カスタム絵文字。外せる）と題名（その場で変える）、「閲覧 / 編集」、本文はキャンバスの描画（`CanvasBody`）、右に目次（見出し 3 つ以上）、下にサブページ（木から）とバックリンク（「このページへのリンク」）。⋯ にリンクのコピー・履歴・Markdown で書き出し・子ページ・ゴミ箱。閲覧だけの人には編集の札を出さず「閲覧だけできます」と出す |
| リンク | `[題名](page:<uuid>)` と `<server>/p/<uuid>` はページのチップ（今の題名とアイコン。木に無ければ `POST /wiki/pages/resolve` でまとめて聞く）。読めない・消えたページは「アクセスできないページ」（書かれた表示名も出さない）。`[名前](attachment:<uuid>)` はファイルのチップ（押すと保存）。字句はキャンバスの方言だけ（メッセージでは文字のまま。`/p/` の URL はメッセージでもチップ）。`canvas_markdown.json` に `page_links` の節を足した（スマホは M122 で読む） |
| 編集 | キャンバスのエディタ（ツールバー・表・画像の貼り付け・@ の候補・2 列のプレビューとスクロールの同期）に、`[[` の候補（`/wiki/pages/lookup`、選ぶと `[題名](page:<uuid>)`。題名の `[ ]` は全角にする）と、行頭の `/` のメニュー（見出し 1〜3・箇条書き・番号・チェック・引用・表・コード・数式・区切り線・画像・ページへのリンク・子ページを作る。英語・ローマ字でも絞れる）。「子ページを作る」はその場で子を作ってリンクを入れる。編集中の表示（presence）のフレームはページでは送らない |
| 保存 | キャンバスの保存の状態機械（`CanvasSaver`）を文書の型で一般化し、`page_conflict` / `page_base_expired` も同じに扱う。2 秒止まると保存、マージ、競合の選択、オフラインの再送、Web のタブを閉じるときの keepalive。保存待ちは Tauri では SQLite（`wikipending:<id>`） |
| 履歴 | キャンバスの履歴の画面（`DocHistoryDialog`）を呼び先を渡せるようにして使い回す（差分・本文・ラベル・この版に戻す・本文の消去（フルアクセス））。版の種類に「取り込み」「プロパティ」を足した |
| 共有 | 「共有」のボタン（誰でも見られる。変えられるのはフルアクセスでゲストでない人）。自前と受け継いだ項目（「〇〇から」、読めない祖先からは「上位のページから」）、人・グループ・ワークスペースの全員を閲覧 / 編集 / フルアクセスで足す（ゲストは名前で。札を出す）、段階の変更・外す。受け継いだ項目を弱める・外すと受け継ぎを止める（実効の項目を自前に写して変える、§4.2）。「受け継ぎを止める / 親に合わせる」。`page_last_manager` などはサーバのメッセージを出す |
| 同期 | bootstrap の `wiki.change_seq` で対応を知る。その接続で初めてのときは `GET /wiki/tree`（ETag、304 なら手元のまま。グループの変化を拾うため）、以後の再接続は番号が進んでいれば `GET /wiki/changes?since=`。`wiki.changed` は 300 ms まとめて読む。`removed` は下のページごと消す（同じ答えで来たものは残す）、`reset` は ETag なしで木を読み直す。`wiki.page.updated` は題名・アイコン・版を取り込み（場所はフィードだけ）、開いているページは編集していなければ読み直す。`group.updated` と自分のロールの変化で木を読み直す。木（`wiki:tree`）と最近開いた 20 ページ（`wikipage:<id>`）を保存し、オフラインでは読むだけで出す |
| 開く | `/p/<id>`（Web の入口。ブラウザでその URL を開くとログイン後にページ）、本文の `page:` / `/p/` のリンク、アクティビティの `page_mention` / `page_shared`（`include=` に足した）、デスクトップ通知（`wiki.mentioned` / `wiki.shared`、押すとそのワークスペースでページ）、検索の結果。Tauri の深いリンク（`chikuwachat://`）はサインイン専用のままで、`/p/` は `/m/` と同じくアプリの中のリンクとして開く |
| 検索 | 検索の画面に「ドキュメント」のタブ（`/search/pages`）。人（作った人・最後に編集した人）・期間のチップと、「探す場所」（`in_page`、木のページから選ぶ）。会話のチップは出さない |
| 管理 | 管理 →「ドキュメント」：題名・見られる人・最終更新、「フルアクセスの人なし」「受け継がない」「ゴミ箱」の札、「引き取る」（確認の画面に監査ログに残ることと、黙って読むためのものではないことを書く）、ゴミ箱のページの「完全に削除」。ゴミ箱の画面にも管理者だけ「完全に削除」 |
| 狭い画面（Web） | 木を 1 画面の一覧、ページは全画面（← で木へ）。編集・共有・移動の画面もそのまま使える（ドラッグは指では難しいので、⋯ の「最上位へ移動」と共有の画面が主） |

### 15.2 後に回したもの

- テンプレートから作る（`template_key`）：作成の画面に選択を足すのは後（API は対応済み）。
- ページの記録（§7.2 の `GET /wiki/pages/{id}/activity`）：サーバにまだ無い。
- 移動のメニュー（親を選ぶ画面）：今はドラッグと「最上位へ移動」だけ。
- 部分木の ZIP の書き出し（`?subtree=true`）：1 ページの Markdown だけ。
- ⌘K の候補にページの題名（§8.1）。
- データベース（M123）：`kind = "database" | "row"` は木と型で受けられる（行は木に出さない）が、表の画面は作っていない。

### 15.3 テスト

`tests/wiki.test.ts`（木の並びと見出し、変更のフィード（removed・reset）、ドロップの before / after、ハブ（ETag、`wiki.changed` のまとめ読み、`wiki.page.updated`、リンクの解決、wiki のエンドポイントでの自動保存と `page_conflict`）、共有の変更の組み立て、`[[` と `/`）、`tests/docsUi.test.tsx`（共有の画面を段階ごとに・読めない元は「上位のページ」、移動の確認と `manager_lost`、読めない祖先の「…」、閲覧だけのページ、読めないページのリンク、木の ＋ とゲスト、アクティビティの文言）、`tests/notificationClick.test.ts`（ページの通知を押すとそのワークスペースでページ）、`tests/routes.test.ts`、`tests/canvasMarkdown.test.ts`（`page_links`）、`tests/navItems.test.tsx`。ブラウザ（Vite + Chrome）で、木を作る・android2 だけに共有したページが android1 に見えない・dry run つきの移動・2 つのブラウザで同時に編集してマージ・履歴から戻す・検索・ゴミ箱と復元・狭い画面・アクティビティから開く・`/p/` を確かめた。

## 16. M122 の iOS（2026-10-07）

§9.2 のうちデータベースを除いたもの。サーバの変更なし。

- **入口**：ホームのタイル「ドキュメント」（キー `docs`、「キャンバス」の後。bootstrap に `wiki` があるサーバだけ）と iPad のサイドバーの同じ行。
  `apps/shared/nav-items.json` に `docs` を足した（両方の既定の並びで `canvases` の次。Desktop・Android の写しも同じにすること）。
- **木**（`UI/WikiViews.swift` の `DocsView`）：「共有」「プライベート」の 2 つの見出しに最上位のページ、行の ▸ で子を開閉（§9.2 の
  「1 段ずつたどる」ではなく開閉。ページを押すとそのページ）。並びは `position` のバイト順、同じなら id。親が読めないページは最上位。
  上の欄は題名で絞り込み、確定すると検索の「ドキュメント」タブで本文も探す。＋ は「共有に新しいページ」（`workspace`）と
  「プライベートに新しいページ」（`private`）、ゲストには出さない。
- **ページ**（`WikiPageScreen`）：パンくず（読めない祖先は「…」、押すとそのページへ戻る）、アイコンと題名、キャンバスと同じ描画
  （`CanvasBodyView`）、サブページ、「このページへのリンク」。`page:` のリンクは題名とアイコンに置き換え（木に無ければ
  `POST /wiki/pages/resolve`、答えの無いものは「表示できないページ」）、`[名前](attachment:<id>)` はファイルとして開く。
  `<server>/p/<id>` はメッセージ・キャンバスの中で「📄 ページを開く」になり、押すとシートでページを開く（`/c/` と同じ扱い）。
- **編集**：「編集」で全体、見出しの ✎ でセクション。キャンバスの `CanvasSaver`・`CanvasEditor`・競合の選択をそのまま使い、呼び先だけ
  `WikiSaverApi`（`PUT /wiki/pages/{id}/content`、ETag `"v<version>-<level>"`）にした。「編集中」の表示とタスクにするは出さない。
  題名とアイコン（⋯）、子ページの作成、履歴（閲覧だけ。戻す・名前はパソコン）。`my_level = view` のページは編集・チェック・作成を
  出さず「閲覧のみです。」。
- **同期**（`Sync/WikiHub.swift`）：bootstrap の `wiki` で、木が無ければ `GET /wiki/tree`（ETag）、あれば `GET /wiki/changes`。
  `wiki.changed` は 300 ms まとめて差分、`reset` で木を読み直す。`wiki.page.updated` は木の題名を直し、開いているページを読み直す。
  `group.updated` と自分のロールの変化で木を読み直す。木・最近開いた 20 ページ・保存待ちは SQLite の meta（`wiki:tree`、
  `wiki:page:<id>`、`wiki:pending:<id>`）に持ち、オフラインで読める。
- **通知**：プッシュ `kind = page` はホームのタブで「ドキュメント」の上にページを開く。アクティビティの `page_mention` /
  `page_shared`（`include=`）は押すとそのタブにページを積む。アプリを開いている間の `wiki.mentioned` / `wiki.shared` は下の知らせ
  （押すとページ）。検索に「ドキュメント」タブ（`/search/pages`、人と期間のチップ、会話のチップは出さない）。
- **テスト**：`WikiTests.swift`（木の並び・最上位・行の開閉、変更のフィードの取り込みと reset、ハブと偽のサーバ（bootstrap・
  `wiki.changed` のまとめ・ETag・保持と再起動・オフラインの保存待ちと同じ key・404・題名の変更・作成と解決・20 件の上限）、
  段階ごとの規則、パーマリンクと `page:` の字句解析、経路（パンくずで戻る・通知）、保存の要求と 409 の形、アクティビティの項目）。
  開発サーバで android1 / android2 の木・閲覧・リンク・チェックと全体の編集の保存・子ページの作成・閲覧のみのページ・
  プライベートのページが相手に見えないことを確かめた。

## 17. M122 の Android（2026-10-07）

§9.2 のうちデータベースを除く部分。サーバ（M120）の変更はない。

- **入口**：ホームのタイル「ドキュメント」（`HomeTile.DOCS`、キャンバスの次。`apps/shared/nav-items.json` に `docs` を足した。
  Desktop の M121 と同じ項目）。タブレットのホームの一覧も同じタイル。
- **木**（`ui/DocsPane.kt`、規則は `sync/WikiTree.kt`）：「共有」「プライベート」の見出しの下に最上位のページ、▸ / ▾ で 1 段ずつ開く
  （開いた行は回転・ページを開いて戻っても残る）。兄弟は `position` のバイト順、同じなら id。親が手元に無いページは最上位に出す。
  見出しの ＋ で最上位のページ（共有 = `access: workspace`、プライベート = `private`。ゲストには出さない）。上の欄で題名を絞り込み、
  検索キーで検索の「ドキュメント」タブ（`/search/pages`）。§9.2 の「Files アプリのように 1 段ずつたどる」ではなく、指示どおり
  その場で開閉する木にした。
- **同期**（`sync/Wiki.kt` の `WikiHub`）：bootstrap の `wiki.change_seq` で、木が無ければ `GET /wiki/tree`（ETag、304 なら手元の
  まま）、あれば `GET /wiki/changes?since=`。`wiki.changed` は 300 ms まとめて差分、`reset` は木を読み直す。`removed` はその下の
  手元の子孫も外す（`pages` に来たものは残す）。`group.updated` と自分のロールの変化で木を読み直す。木は Room の `meta`
  （`wiki:tree`）に置き、起動直後とオフラインで出す。
- **ページ**（`ui/DocPage.kt`）：パンくず（読めない祖先は「…」、押すとそのページへ戻る）、アイコンと題名、本文はキャンバスの描画
  （`page:` のリンクは木か `POST /wiki/pages/resolve` の今の題名とアイコン、読めないものは「表示できないページ」、`attachment:` は
  📎 のファイル）、サブページ、このページへのリンク。`<server>/p/<id>` はメッセージ・キャンバス・ページのどこでもアプリ内で開く
  （`LocalPageLinks`）。ページは戻るスタックに積む（`Route.DocPage`）。
- **編集**：`my_level` が edit / full のときだけ「閲覧 | 編集」・セクション編集・チェック・⋮ の「題名を変更」「子ページを作る」。
  閲覧（view）は「閲覧のみ」の行を出し、チェックも押せない。保存はキャンバスの `CanvasSaver` をそのまま使い、`WikiPageSource` が
  `/wiki/pages/{id}`（If-None-Match `"v<version>-<level>"`）と `…/content` に付け替える（409 `page_conflict` / `page_base_expired` は
  キャンバスの形にして同じ選択肢）。840 dp 以上は編集とプレビューの 2 列とスクロール同期。編集中の表示（presence）は送らない（§7.3）。
- **オフライン**：最近開いたページ 20 件を Room の `canvases` 表に会話 `wiki` として置く（キャンバスの一覧には出ない）。保存待ちは
  `meta` の `wikipage:<id>`。
- **通知**：プッシュ `kind = page` と前面の `wiki.mentioned` / `wiki.shared` はホームのタブでドキュメントの木の上にそのページを開く。
  アクティビティは `include=page_mention,page_shared`、行は「〇〇 が「題名」であなたをメンションしました」「〇〇 が「題名」を共有しました」。
- **作らなかったもの**：共有の設定の表示（§9.2 の「見るだけ」）、移動・ゴミ箱、履歴、`[[` の候補と `/` メニュー、アイコンの変更、
  タブレットの「一覧と本文の 2 ペイン」（今は木の上にページを重ねる）、アプリリンク（OS からの `/p/` を開く。`/m/` と同じく未対応）。
- **テスト**：`WikiTreeTest`（並び・最上位・開閉・差分の適用・メタの反映・段階・パンくず・ルート・`page:` の字句解析・プッシュ・
  アクティビティ）、`WikiSyncTest`（bootstrap・ETag・差分・reset・失敗・解決・保存・競合・閲覧の拒否・消えたページ・再起動後の
  再送・オフラインの写し）、`WikiApiTest`（要求の形）。エミュレータ（ChikuwaChat_Pixel_9、android1 / android2）で木・開閉・
  リンクでの移動・読めないリンク・チェック・編集と相手の変更のマージ・プライベートのページが相手に見えないこと・閲覧のみ・
  新しいページ・検索のタブを確かめた。

## 18. M123 の実装（データベース：サーバと Desktop / Web、2026-10-07）

§5（関係 §5.7・カレンダー §5.8 を含む）。移行は `0098_wiki_databases.py`（main の 0096 サイドバー・0097 通話の後）。

### 18.1 サーバ

- **表**：`wiki_databases (page_id, schema, views, schema_version)`、`wiki_relations (src_page_id, prop_id, dst_page_id,
  src_database_id, position, seq)`（相手側を読む索引 `(dst_page_id, src_database_id, prop_id)`）、`wiki_props_legacy`（変換できなかった値、
  30 日。種類を戻すと戻る）、`wiki_pages_rows_idx`（データベースの生きた行の並び）、シーケンス `wiki_rows_seq`。行の値は §11.1 の
  とおり `wiki_pages.props`（`{prop_id: value}`）と検索用の `props_text`（関係は入れない）。
- **モジュール**：`wiki/dbschema.py`（値の検査・型の変換・絞り込み・並べ替えの純粋な関数）、`wiki/databases.py`（スキーマ・ビュー・行・
  関係・問い合わせ・CSV）、`wiki/db_router.py`、`wiki/db_schemas.py`、`core/collation.py`（サイドバーと同じ日本語の名前順のキー。
  `apps/shared/sidebar-order.json` のケースで確かめる）。
- **行はページ**：`kind = 'row'`、親はデータベース、データベースの権限を必ず受け継ぐ（行への共有の変更・引き取りは 400 `wiki_row_access`、
  移動は 400）。木・変更のフィード・`[[` の候補には出ない。行の追加・値の変更・ゴミ箱と復元は**編集**の段階（ページのゴミ箱はフル。
  自分のゴミ箱の一覧に編集できる行も出す）。スキーマとビューは**フル**（M144 で壊さない変更とビューを**編集**に、§22.2）。
- **ロック**：スキーマとビューの変更は木のロックと関わるデータベースの行を `FOR UPDATE`（id 順）、値の書き込みは関わるデータベースを
  `FOR SHARE`（id 順）と行を `FOR UPDATE`。型の変換と古い型の値の書き込みが交わらない。
- **マスごとの後勝ち**：`PATCH /wiki/rows/{id}/props {set, client_op_id}`。変わったマスの前後を版（`kind = 'props'`、`props = {before,
  after}`、関係は書いた人に見えた id）に残す。`client_op_id` は版の `client_save_id` として一度だけ効く。`props` の版も整理の対象。
- **型の変換**（§5.2）：古い値を文字にしてから新しい型として読む（数：`¥1,200`・`50%`、日付：ISO・`2026/10/07`・`2026年10月7日`・
  `October 7, 2026`・`→` の範囲、チェック：Yes / はい / ✓、人：表示名かユーザー名）。テキスト → セレクトは同じ文字の選択肢を作る（200 まで）。
  セレクト ↔ マルチ、日時 → 日付、作成者 → 人はそのまま。変換できない値は `wiki_props_legacy`。関係からと関係へはつながり・値を持ち越さない。
- **問い合わせ**（§5.4）：`POST /wiki/databases/{id}/query`。行（本文なし）を全部読み、Python で絞り込みと並べ替え（空の値はどちらの向きでも
  最後、同じなら行の並び）、`range` で月の範囲に重なる行、`cursor`（`o:<offset>`）と `limit`（1,000 まで）。
- **イベント**：`wiki.rows.changed {database_id, seq, schema_version}`（audience `page` = データベース、送る時点で読める人）。行の追加・値・
  題名・ゴミ箱・復元・スキーマ・ビューで出す。双方向のつながりや題名が変わると、それを表示しているデータベースにも出す。行のページには
  `wiki.page.updated`（`change: "props"`）。`wiki.changed` は行では出さない。
- **CSV**：`GET /wiki/databases/{id}/export.csv?view_id=`。見出しと「アクセスできないページ」は読む人の言語（ja / en / zh-Hans）。

### 18.2 API（M124 のスマホが使うもの。すべて `/api/v1`）

| メソッド | パス | 返すもの / 要点 |
| --- | --- | --- |
| POST | `/wiki/pages`（`kind: "database"`） | データベースのページ（題名のプロパティと表のビュー 1 つ。名前は `""` で、端末が「名前」「表」と出す） |
| GET | `/wiki/databases/{id}` | `DatabaseOut {page_id, schema_version, properties: [PropertyOut {id, name, type, options, number_format, relation {database_id?, database_title?, pair_id?, primary}}], views: [ViewOut {id, name, type: table \| calendar, columns, sort, filter, date_prop_id}], my_level, row_count, limits}`。読めない相手のデータベースは `database_id` も題名も null |
| PATCH | `/wiki/databases/{id}/schema` | `{base_schema_version, ops: [add \| update \| retype \| delete \| reorder]}`（フル。M144 から編集、削除・選択肢の削除・型の変更・双方向の関係はフル、§22.2）。409 `wiki_schema_conflict` |
| PUT / DELETE | `/wiki/databases/{id}/views/{view_id}` | ビューの保存（id は端末が作る）・削除（フル。M144 から編集。最後の 1 つは 409 `wiki_last_view`） |
| POST | `/wiki/databases/{id}/query` | `RowQuery {view_id?, sort?, filter?, range? {prop_id, start, end}, cursor?, limit}` → `RowQueryOut {rows: [RowOut], refs: [RowRef], total, next_cursor, schema_version}`。`sort` / `filter` を送るとビューのものの代わり（保存しない並べ替え） |
| POST | `/wiki/databases/{id}/rows` | `RowCreate {title, icon?, props, body?, client_save_id}` → 201 `RowWithRefs`（再送は 200）。5,000 行で 409 `wiki_too_many_rows` |
| GET | `/wiki/rows/{id}` | `RowDetailOut {row, database, database_title, refs, referenced_by}`（行のページのプロパティ。本文は `GET /wiki/pages/{id}`） |
| PATCH | `/wiki/rows/{id}/props` | `{set: {prop_id \| "title": value}, client_op_id}` → `RowWithRefs`。422 `wiki_invalid_property_value` |
| GET | `/wiki/databases/{id}/properties/{prop_id}/candidates?q=` | 関係のマスに入れられる行（相手のデータベースの読める行だけ） |
| GET | `/wiki/databases/{id}/export.csv?view_id=` | CSV（BOM 付き UTF-8） |

`RowOut = {id, database_id, title, icon, position, version, head_rev_id, props, relations: {prop_id: [row id]}, hidden_relations:
[prop_id], created_at, created_by, updated_at, updated_by}`。値の形：テキスト・URL・セレクトの選択肢 id は文字、数、チェックは true
（外すと消える）、マルチ・人・関係は id の配列、日付は `{start, end, time}`（time なら ISO 8601 とオフセット）。行のゴミ箱と復元は
`DELETE /wiki/pages/{id}` と `POST /wiki/pages/{id}/restore`、題名だけなら `PATCH /wiki/pages/{id}` でもよい。

### 18.3 Desktop / Web

- データベースのページ：題名の下にビューのタブ（表・カレンダー、＋で追加、⋯で名前・削除）、並べ替え・絞り込み（「すべて / どれか」）・
  プロパティ（並び・表示・幅）の棒。画面で変えたものはすぐ問い合わせに効き、フルの人は「ビューを保存」、誰でも「元に戻す」。⋯ に CSV。
- 表：見出し（並べ替え・左右へ・隠す・プロパティを編集）、幅はドラッグ、マスはその場の編集（型ごとのポップオーバー。チェックは押すだけ、
  セレクトはフルの人なら新しい選択肢も作れる、日付は終わり・時刻、人は候補、関係は読める行の検索）、「＋ 新規」、題名の「開く」で右に
  行のペイン（行のページ。⤢ で全体）。狭い画面では横にスクロールし、行はページとして開く。マスの選択と編集の始め方は §29.1
  （2026-10-09 に見直した）。
- カレンダー：月の格子（月曜始まり）、範囲は日をまたぐ帯、日の ＋ で行を作って開く、帯のドラッグで日付を動かす。狭い画面は予定の一覧。
- 行のページ：題名の下にプロパティ（同じ編集）と「（データベース）の（プロパティ）」（一方向の関係で指している読める行）、⋯ に「行をゴミ箱へ」。
- `/` のメニューに「データベース」（子のデータベースを作ってリンクを入れる）、ページの ⋯ に「データベースを追加」、木ではデータベースに表のアイコン。
- `wiki.rows.changed` と再接続で開いている表・行を 300 ms まとめて読み直す（`WikiHub.onRows`）。

### 18.4 設計からの違い（理由）

- §11.2 の `GET …/rows?sort=&filter=` は `POST …/query`（絞り込みが JSON で、URL に入れると長く壊れやすい）。行の並べ替え（手で動かす）は
  作らない（作った順。Notion の「並べ替えなし」と同じ）。
- `rows_seq` は列にせず、`wiki.rows.changed` の `seq` を共通のシーケンスから取る（行の書き込みがデータベースの行を更新しないので、
  同時の書き込みが互いを待たない）。
- `apps/shared/wiki_db_query.json`（並べ替え・絞り込みの共通のケース）は作らなかった。並べ替えと絞り込みはサーバだけが行い、端末は結果を
  出すだけなので（§5.4）、ケースはサーバのテストに置いた。名前の並びはサイドバーの共通のケースで確かめる。
- 行のゴミ箱と復元は編集の段階（ページはフル）。行の削除は Notion でも編集する人の操作で、行は共有を持たないため。
- プロパティの削除は値を `wiki_props_legacy` に 30 日残すが、戻す画面はまだない（同じ名前・種類で作り直しても戻らない。運用者が SQL で戻せる）。

### 18.5 性能（`tests/test_wiki_db_perf.py`、5,000 行、M5 Max の開発機の Docker の PostgreSQL）

| 問い合わせ（行の読み込み・絞り込み・並べ替え・100 行・関係のマスまで、中央値） | 目標 | 実測 |
| --- | --- | --- |
| 題名で並べ替え + 題名を含む | 50 ms | 約 17 ms |
| 数の降順 + 題名 + セレクトの「等しくない」 | 50 ms | 約 21 ms |
| 日付で並べ替え（全部） | 50 ms | 約 18 ms |
| カレンダーの 1 か月（範囲、1,000 行まで） | 50 ms | 約 19 ms |

名前のキーはプロセスの中に覚える（初回だけ 5,000 件のキーを作る）。テストは目標の 2 倍を上限にする。

### 18.6 テスト

サーバ：`tests/test_wiki_databases.py`（行が木に出ない・作成の冪等と 5,000 の上限・型ごとの値と拒否・マスごとの後勝ちと op id・型の変換と
`props_legacy` からの復元・プロパティと選択肢の削除とビューの掃除・スキーマの 409 と段階・閲覧だけの人・並べ替え（日本語・空は最後）と
絞り込み（全部の型、and / or）・ページ送りと保存したビュー・カレンダーの範囲・CSV・双方向の関係（両側から書く・題名の変更のイベント・
消すと逆も消える）・同じデータベースの一方向の関係と `referenced_by`・**読めない行のつながり**（マス・データベース・行・CSV・絞り込み・
候補・書き込み・検索のどれにも題名と id が出ない、書き換えても残る）・イベントの宛先・検索）、`tests/test_wiki_no_leak.py` に 18 の経路
（読めないデータベース・行・ビュー・スキーマ・問い合わせ・CSV・行の作成と変更、読めるデータベースから読めない行への関係）、
`tests/test_wiki_db_perf.py`、`tests/test_collation.py`。Desktop：`tests/wikiDb.test.ts`（マスの文字・型ごとの演算子・列・月の格子・
日をまたぐ帯の段・予定の一覧・日付の移動）、`tests/dbUi.test.tsx`（表のマスと読めない行・チェックと新規・並べ替えと保存・閲覧だけ・
カレンダーの範囲と帯・予定の一覧・関係の候補・行のページ）。ブラウザ（自分のサーバ 8010 と Vite 1422、Chrome 9444）で android1 /
devadmin の表・行のペイン・関係の候補と双方向の表示・読めない行の「アクセスできないページ」・カレンダーと帯のドラッグ・狭い画面の
横スクロールと予定の一覧・絞り込み・プロパティの編集を確かめた。

## 19. M124 の iOS（データベース、2026-10-07）

§5.5・§9.2 のデータベース。サーバ（M123）の変更なし。

- **データベースのページ**（`UI/WikiDatabaseViews.swift` の `WikiDatabaseScreen`）：`kind = database` のページは本文の代わりに行を出す。
  上に保存したビューのチップ（2 つ以上のとき）。表のビューは**カードの一覧**（題名と、ビューで見せる列のうち題名を除く最初の 3 つ。
  値の無いものは行を詰める。セレクトは色付きの札）。並べ替えと絞り込みはビューの名前で `POST …/query` に任せる（端末では並べない）。
  100 行ずつ、最後に近づくと続きを読む。カレンダーのビューは**予定の一覧**：月を ‹ › で動かし、`range` でその月にかかる行
  （1,000 まで）を日ごとに出す。日をまたぐ行はかかる日のすべてに出し、右に「10/5 → 10/9」、時刻のある 1 日の行は時刻。時刻つきの値は
  端末のタイムゾーンの日に置く。引っぱって読み直し。＋ は名前を聞いて行を作り（`client_save_id` は 1 回の入力で同じ）、行のページを開く。
  カレンダーでは表示中の月の日付（今月なら今日）を日付のプロパティに入れる。
- **行のページ**：ふつうのページの画面（本文・編集・履歴）に、題名の下で**プロパティのフォーム**（`WikiRowPropertiesView`、
  `GET /wiki/rows/{id}`）。行を押すと型ごとのシート：テキスト・URL・数（`1,200`・全角・`50%`、パーセントの列は 50 を 0.5 に）、
  セレクト（押すと保存）・マルチ、日付（開始・終了・時刻、時刻は端末のオフセット付き ISO 8601）、人（検索）、関係（今のつながりを外す・
  `…/candidates` で読める行を探して足す）。チェックはその場のスイッチ。作成日時などは読むだけ。関係の札を押すとその行を開く。
  一方向の関係で指している行は「（データベース）の（プロパティ）」（`referenced_by`）。
- **保存**：`PATCH /wiki/rows/{id}/props {set, client_op_id}`。画面はすぐ変え、答えの行で置き換える。1 回の変更に 1 つの op id を作り、
  ネットワーク・5xx・429 では同じ id で 3 回まで送り直す（`DbCellWriter`）。403・422 は送り直さず、行を読み直してエラーを出す。
- **読めない行**：`hidden_relations` の列は「アクセスできないページ」の札を 1 つだけ（id・題名・件数は持たない）。関係を書き換えるときは
  読める行の id だけを送る（読めないつながりはサーバが残す）。相手のデータベースを読めない列は候補を出さない。
- **段階**：閲覧だけ（`my_level = view`）のデータベースと行は＋・編集のシート・スイッチを出さず「閲覧のみです。」。スキーマとビューの
  設定はスマホに出さない（§9.2）。行には「子ページを作成」を出さない。
- **同期**：`wiki.rows.changed` は `WikiHub.rowsSignal` を進め、開いているデータベースが 300 ms まとめて読み直す（`schema_version` が
  進んでいればスキーマも）。`wiki.page.updated`（`change: "props"`）は開いている行のフォームを読み直す。再接続でも両方を読み直す。
- **オフライン**：最後に開いたデータベースの行（ビュー・月・スキーマ・関係の題名）を SQLite の meta `wiki:db:last` に置き、読めないとき
  はそれを「オフライン」の帯つきで出す。その行のページのフォームもそこから（読むだけ）。
- **木**：データベースはアイコンが無ければ表の記号。`page:` のリンク・パーマリンク・検索からデータベースや行を開ける（ページと同じ画面で
  種類を見て切り替える）。
- **作らなかったもの**：保存しない並べ替え・絞り込み、iPad の横にスクロールする表（§5.5。今は iPad もカード）、行のゴミ箱、本文（説明）の
  表示（データベースのページでは行だけ）、送れなかったセルの変更の再起動後の再送（ページの本文と違い、失敗したら読み直して知らせる）。
- **テスト**：`WikiDatabaseTests.swift`（カードの列と空の値、型ごとの文字、予定の一覧（月をまたぐ・逆の範囲・時刻のタイムゾーン）、
  月の計算、型ごとの値の形（数・日付のオフセットと夏時間を含む）、op id の再送と 422、行のモデルの即時表示と読み直し、ビューと
  カレンダーの問い合わせ、まとめた読み直し、新しい行の key、オフラインの写し、読めない行、段階、イベント、要求の形）。シミュレータ
  （開発サーバ、android2）で木の表のアイコン、カード、予定の一覧（日をまたぐ行）、行のフォーム（セレクトの保存、関係の候補、日付・数の
  シート）、読めない行の札、閲覧だけのデータベース、行の追加、相手の変更がすぐ出ることを確かめた。

## 20. M124 の Android（データベース、2026-10-07）

§5.5・§5.7・§5.8 のスマホの部分。サーバ（M123）の変更はない。

- **入口**：木ではデータベースに表のアイコン（`PageTitleText` の `kind`）。データベース・行はページと同じ `Route.DocPage` で開き、
  `page:` のリンクとパーマリンクもそのまま開ける。ページの `kind` で中身を切り替える（`ui/DocPage.kt`、`ui/DocDatabase.kt`、規則は `sync/WikiDb.kt`）。
- **データベース**：説明（本文）の下にビューのチップ、行の数、「＋ 新規」（編集・フル）。表のビューは**カードの一覧**（題名と、ビューで見せる列の
  はじめの 3 つ（題名を除く）のうち値のあるもの）。並べ替え・絞り込みはサーバ（`POST …/query` に `view_id`）のまま、100 行ずつ「さらに読み込む」。
  カレンダーのビューは**予定の一覧**（月の切り替え、日ごとの見出し、今日は色付き）。日をまたぐ行はかかる日のすべてに出して下に範囲を書き、
  時刻のある日付は端末のタイムゾーンの日に置く。サーバには月の前後 1 日まで `range` で聞く。日付のプロパティはビューの `date_prop_id`、
  無ければはじめの日付。カレンダーで作る行は、その月なら今日、他の月なら 1 日の日付を持つ。引っぱって更新。
- **行**：題名の下にプロパティのフォーム、その下に本文（ページと同じ編集）。型ごとの入力：テキスト・数（`50%` は 0.5、`¥1,200` は 1200）・URL
  （http / https だけ）はダイアログ、セレクトは選ぶと保存、マルチセレクトと人はチェックの一覧、日付は開始・終了（切り替え）・時刻（切り替え、
  端末のオフセットの ISO 8601）、チェックは押すだけ、関係は今の行（× で外す）と候補（`…/candidates?q=`、読める行だけ）の検索。作成日時などは
  読むだけ。保存はマスごとに `PATCH /wiki/rows/{id}/props {set, client_op_id}`：すぐ画面に出し、ネットワークの失敗は同じ `client_op_id` で
  送り直し（`CanvasRequests.sameKey`）、断られたらそのマスだけ戻してエラーを出す。読めない行へのつながりは「アクセスできないページ」の
  チップ 1 つ（id・題名・数は出さない。関係の編集でも外せず、サーバが残す）。一方向の関係で指している行は「（データベース）の（プロパティ）」。
  閲覧（view）の人はフォームを読むだけ（「＋ 新規」も出さない）。スキーマ・ビューの編集はしない。
- **同期**：`wiki.rows.changed` は開いているデータベースを 300 ms まとめて読み直す。`wiki.page.updated`（`change: "props"`）は開いている行の
  プロパティを読み直す。再接続でも両方を読み直す（`WikiHub.rowsSignal` / `propsSignal` / `reconnects`）。木に無い行の題名はバーにも出す。
- **オフライン**：最後に開いたデータベース（スキーマ・ビュー・今のビューの行 500 まで）を Room の `meta`（`wiki:db`）に置き、開いた直後と
  読めないときに出す（「この端末の写し」の帯）。行の本文はページと同じ 20 件の写し。
- **タブレット**：840 dp 以上ではカードの一覧の右に選んだ行を開く（2 ペイン）。エミュレータでは確かめていない。
- **作らなかったもの**：スキーマ・ビューの編集（§5.5）、画面だけの並べ替え・絞り込み、行のゴミ箱と履歴、選択肢の作成（パソコンで）。
- **テスト**：`WikiDbTest`（カードの列と文字・型ごとの表示、予定の一覧の日をまたぐ範囲と月の端・終わりが前の値、タイムゾーンごとの日（東京 /
  ニューヨーク）、型ごとの値の形と日付・時刻の送り方、読めない関係のチップ、段階の規則、閲覧の行は送らない、ネットワークの失敗の再送が同じ
  op id・断られたマスが戻る、表のページ送りとオフラインの写し・再起動、カレンダーの範囲と新しい行の日付・作成の再送）。
  エミュレータ（ChikuwaChat_Pixel_9、android1）で木のアイコン・カードと並び・予定の一覧（範囲・時刻）・行のフォーム（セレクト・チェック・関係の
  候補・日付と時刻）・android2 の変更（題名・行の追加）がその場で出ること・読めない関係のチップと閲覧だけのデータベース・オフラインの写し・
  「＋ 新規」を確かめた。

## 21. M125 の実装（Notion からの取り込み、2026-10-07）

§6 のとおり。サーバの管理者のコマンドだけで、API・端末・移行は変えていない（`wiki_page_revisions.kind = 'import'` は M120 から
ある値）。

### 21.1 作ったもの

- **`app/modules/importer/notion_export.py`**（データベースを使わない純粋な部分）：zip（zip の中の zip、名前の文字コード、NFC）と
  展開したフォルダの読み込み、木の組み立て（フォルダの持ち主：`<題名>` と `<題名> <4>-<4>`、分け合うフォルダはリンクと CSV の
  題名で振り分け、行・行の下のページの持ち上げ、子の並び）、CSV と行のページの照合（題名、重なれば値）、行のページの
  `列名: 値` の行、日付（日本語・英語・数字の形、時刻・AM/PM・タイムゾーン・範囲）・関係のセルの読み取り、型の推測（§6.3）、
  Markdown の書き換え（コードを避けて `<aside>`・`<details>`・HTML・リンク・`notion.so` の URL・メンション）、長い本文の分割。
- **`app/modules/importer/notion_import.py`**：計画（`import_refs` の対応、今の状態：新しい / 同じ / 上書き / 編集された /
  ゴミ箱 / 消えた）→ スキーマ（双方向の関係の組、再実行では名前と型で今のプロパティに合わせる）とビュー → 値 → 書き込み
  （100 ページごとのトランザクション、木のロック、実効の権限の計算し直し、添付の検査と BlobStore、`wiki.changed`）→ 最後に
  リンク（`wiki_links`）と関係（`wiki_relations`）、`wiki.rows.changed`、監査ログ `wiki.imported`。
- **CLI**：`python -m app.cli import-notion EXPORT --actor ADMIN [--parent ID] [--access …] [--user 名前=username]…
  [--user-map FILE]… [--column-types FILE] [--timezone ZONE] [--dry-run]`。報告は件数・データベースごとの列と型・書き換えた
  ブロック・編集されたので触らなかったページ・つながらないリンク・取れないファイル・警告。進み具合は標準エラー。

### 21.2 設計からの違い（理由）

- **場所**：§11.3 の `wiki/importer_notion.py` ではなく `importer/notion_*.py`（Slack・Mattermost の取り込みと `import_refs`・
  `active_admin` と同じ所。`importer → wiki` の向きで、`wiki` は取り込みを知らない）。
- **書き込みはサービスの関数を通さず**、ページ・版・行・スキーマを直接書く（`wiki.service.create` は 1 ページごとにコミットし、
  メンションを通知し、版の種類が `create`）。権限・ロック・実効の権限・イベントは同じ部品（`access.lock_tree`・
  `recompute_subtree`・`repo.replace_own_grants`・`events.*`）を使う。テストで `wiki-acl --verify` と同じ確かめをする。
- **フォルダに id が無い**・**行と CSV は題名で結ぶ**・**関係は推測の最初**（§6.1・§6.3。関係のセルは題名とリンクの並びなので、
  ほかの型より先に見ないとテキストやマルチセレクトになる）。§5.7 の「関係の列を関係として作る」をここで入れた。
- **空の列**：値が無いと型が分からない。名前が日付らしいもの（「日付」「Date」「期限」など）は `date` にした（カレンダーに使えるように）。
- **「変わっていない」の判定**：`head` が取り込みの版で、それより新しい版（side を除く。プロパティの変更は `props` の版）が無く、
  題名も同じ。移動・共有の変更は数えない（取り込んだ後に整理しても、再実行で中身は直る）。
- **計画と書き込みの間の保存**（REVIEW-v0.1.48 #8）：計画の時点のページの状態（`version`・`head`・最新の版・題名・値・テンプレートか・
  ゴミ箱か）を覚え、書き込むバッチの中で行をロック（`FOR UPDATE`、コミットまで）してから比べる。違えば（計画の後に誰かが本文・
  題名・セルを変えた、ゴミ箱に入れた、消した。この間だけは移動・共有の変更も数える）上書きせず「編集された」として報告し、その
  ページのファイル・リンク・関係も書かない。ゴミ箱・削除は警告に出し、その下の新しいページも作らない。バッチのコミットの後、
  最後のリンクと関係の書き込みの前に変わったページも同じように比べ、リンクと関係を書かない（本人の保存が書いたものを残す）。
  データベースのレコードは行より先にロックする（セルの保存と同じ順で、デッドロックを避ける）。
- **テンプレート**：CSV に無い行のページも行にした（消すのは Taylis で簡単、黙って落とすと戻せない）。数は報告に出す。
- **リンクされていないファイル**：ページのフォルダにあって本文からリンクされていないファイルは、そのページの末尾にファイルの
  リンクとして足す（§6.2 には無かった。落とさないため）。

### 21.3 実際の書き出しでの結果（2026-10-07、使い捨てのデータベースとオブジェクトストア）

開発機の Docker の PostgreSQL に別のデータベースを作り、別の versitygw（Docker のボリューム）に、実際の書き出し（zip のまま）を
取り込んだ。内容はここに書かない（数だけ）。

| 項目 | 結果 |
| --- | --- |
| 試し読み | 約 0.7 秒。書き込みなし |
| 本番 | 約 3.5 秒（M5 Max、ローカルの versitygw） |
| ページ / データベース / 行 | 42 / 10 / 374（CSV に無い行のページ 4、ページの無い CSV の行 0） |
| 添付 | 99 個、約 87 MB（PNG 66、PDF 26（複数のページからリンクされた同じ PDF はページごとの添付）、HEIC 2、Office 3、ほか 2）。サムネイル 66。取れなかったもの 0 |
| プロパティの型（題名を除く 43） | select 17、text 9、date 7（空の列を名前から 1）、url 4、number 3、multi_select 2、checkbox 1。person は 0（取り込み先にユーザーがいなかったため。本番では表示名か `--user` で一致すれば person になる）。relation は 0（書き出しに関係の列が無かった） |
| カレンダーのビュー | 7（日付のあるデータベースすべて） |
| ページ間のリンク | `wiki_links` 65。つながらないリンク 0 |
| 書き換えたブロック | コールアウト → 引用 132。トグルは箇条書きで書き出されていた。HTML のタグ 0 |
| 警告 | 1（行の下のサブページを上のページへ） |
| 再実行 | すべて「同じ」、版・添付・行は増えない（取り込み後に変換を直したときは、変わったページだけ `import` の版で上書きされた） |
| 権限 | `wiki-acl --verify` で違い 0 |

### 21.4 テスト

`tests/test_notion_import.py`（31）：名前の文字コード（UTF-8 の印なし・Shift-JIS）、zip の中の zip と添付の zip、フォルダ（短い id の
フォルダ・データベースとページが分け合うフォルダ）、行の照合（題名の重なり・無題・テンプレート）、日付の形（日本語・英語・数字・
時刻・タイムゾーン・範囲）、関係のセル、型の推測の順、Markdown の書き換え（コードの中は触らない）、`--column-types`、試し読み
（型の一覧・何も書かない）、本番（木・リンク・メンション・コールアウト・トグル・HTML・ファイルとサムネイル・HEIC はファイル・
リンクされていないファイル・数式・型ごとの値・ビューの列・カレンダー・双方向の関係と API での逆側・版の種類と作者・実効の権限）、
共有の既定（全員が編集・`private` で他の人に木・ページ・添付・検索のどこにも出ない・`--parent` で受け継ぐ・`--access` の指定・
編集できない親は断る）、再実行（何も増えない・変わっていないページの上書き・編集されたページと行は触らず報告・新しいページと列）、
長い本文の分割と行の下のページ、大きい / 空のファイル、不正な入力、CLI の引数。

## 22. Notion の使い心地に近づける（2026-10-08 の設計と決定、M144〜M153）

利用者（研究室の教員）の要望（2026-10-08）：

> ドキュメント、できるだけ Notion ライクな使い心地にできないかな？ 自分でデータベース作ったりビュー追加したり。
> Notion（Word）風に、プレビューの見た目のまま編集ができると嬉しくもある。テンプレート機能も欲しい。

同じ日に推奨どおりに決め（§22.8）、さらに「できれば今後、スマホでも見た目のまま編集できるようになってほしい（Notion のように）」
という希望が足された。§13.2 Q6（見たまま編集は要らない）と §1.2 の「入れないもの」の一部（見たまま編集・ボード・ギャラリー・
インラインのデータベース・テンプレートの画面）を、この節で見直す。

### 22.1 結論

- **データベースとビューは「もう作れる」が、作れる人が狭すぎた。** スキーマとビューの変更はフルアクセスだけで、子ページは親から
  受け継ぐだけなので、共有のページの下に編集者が作ったデータベースは、作った本人も列を足せなかった。**最初にここを直す**
  （§22.2、M144、実装済み §23）。
- **テンプレートは「ページそのもの」**（`wiki_pages.is_template`）。ページのテンプレート（誰でも作れる）、データベースの行の
  テンプレート（「＋ 新規 ▾」と既定のテンプレート）、変数、ページの複製。取り込みの「CSV に無い行のページ」は行のテンプレートにする
  （§22.3、M145〜M146）。
- **ビューの種類を足す**：ボード・リスト・ギャラリー・表の「まとめる（group by）」（§22.4、M147〜M148。M147 は実装済み §25）。
- **本文の方言にコールアウト・トグル・データベースの埋め込みを足す**（`::: callout 💡 …`・`::: toggle 見出し …`、§22.5、M149）。
- **見たまま編集は Markdown を保存の形のまま、TipTap のページエディタで往復させる**。開いて閉じただけで本文が 1 バイトも変わらない
  ことを不変条件にする。Desktop / Web が既定で見たまま、人ごとに Markdown へ切り替えられる（§22.6、M150〜M151）。
- **スマホは M145〜M151 の間は Markdown の編集のまま**（新しいブロックの描画・テンプレートの選択・行の値の編集は入れる）。
  そのあと **M153 でスマホにも見たまま編集を入れる**：アプリに同梱した同じ TipTap のエディタを、編集のときだけ WKWebView /
  Android WebView で出す（読む画面はネイティブのまま）。往復の正しさを 1 つの実装とコーパスのテストで守るため（§22.7）。
- マイルストーンは **M144〜M153**（§22.9）。順番：権限 → テンプレート → ビュー → 方言 → 見たまま編集（Desktop / Web）→ スマホの見たまま編集。

### 22.2 権限：データベースを編集者が育てる（M144）

| 操作 | M144 より前 | M144 から |
| --- | --- | --- |
| 行の追加・値・題名・本文・行のゴミ箱 | 編集 | 編集（変わらない） |
| プロパティの追加（一方向の関係を含む）・名前・並べ替え | フル | **編集** |
| 選択肢の追加・名前・色、数の形（同じ型のままの `retype` も） | フル | **編集** |
| ビューの作成・変更・削除（最後の 1 つは 409 `wiki_last_view` のまま） | フル | **編集** |
| プロパティの削除・**選択肢の削除**・型の変更 | フル | フル（値が消える・変わる。`wiki_props_legacy` に 30 日残るが戻す画面は無い） |
| 双方向の関係の作成（このデータベースと相手のフル）・削除 | フル | フル（相手のデータベースのスキーマも変わる） |
| 共有・移動・データベースのゴミ箱 | フル | フル（変わらない） |

- 403 のコードは今までと同じ（閲覧の人は `page_edit_restricted`、編集の人がフルの操作をすると `page_manage_restricted`）。
  新しいエラーコードは無い。1 回の `PATCH …/schema` の中にフルの操作が 1 つでもあれば、その要求は全部断る（途中まで書かない）。
- **データベースを作った人にフル**：共有のページの下で `kind = database` のページを作ると、作った人の `user: full` を自前の項目と
  して足す（受け継ぎは保つ。絞らないので実効の表の規則は変わらない）。上から既にフルの人には足さない（共有の画面に同じ人が
  2 回並ばないように）。最上位のデータベースは今までどおり作った人の `full` を持つ。
- **ふつうのページを作った人にはフルを付けない**（下書きの §4.1 の（イ）は「データベース（とページ）」だったが、データベースだけに
  した）。理由：自前の `user` の項目はゲストにも効く（§4.4）ので、学生が卒業してゲストになっても、それまでに作ったページがすべて
  見え続ける。卒業生に黙って見え続けないようにした §4.4 の決定と合わない。データベースは数が少なく、利用者が決めたのも
  「作った人がデータベースのフルを持つ」なので、そこだけにした。
- ビューは全員で共有のもの（Notion と同じ）。「自分だけのビュー」は作らない（画面で変えて保存しないことは今も誰でもできる）。
- **監査**：編集者もスキーマを変えるので、`wiki.schema_changed`（`{ops: [{op, id, type}]}`）・`wiki.view_saved`（`{view_id, type}`）・
  `wiki.view_deleted`（`{view_id}`）を監査ログに残す（誰が列を消したかが分かる）。ページの記録の画面（§7.2）ができたらそこにも出す。
- 端末：Desktop / Web は `my_level` から「形を変えられる（編集）」と「消せる・型を変えられる（フル）」を分けて出す（§23.2）。
  ゲストには今までどおりスキーマとビューの操作を出さない（サーバはゲストを区別しない。値の編集は今までどおり）。
  iOS / Android はスキーマとビューを見るだけで、書き込みの経路を持たないので変えない（API の形も変えていない）。

### 22.3 テンプレート（M145 サーバ・Desktop / Web、M146 スマホ）

| 案 | 中身 | 評価 |
| --- | --- | --- |
| （ア）今の `canvas_templates`（管理者が管理画面で作る Markdown の文字列） | API はある（`template_key`） | 管理者しか作れない。画像・プロパティを持てない |
| （イ）**テンプレートはページそのもの**（`wiki_pages.is_template boolean`） ★決定 | テンプレートの編集はふつうのページの編集（エディタ・画像・履歴・権限がそのまま）。行のテンプレートはデータベースの中の `is_template` の行（Notion と同じ形） | 新しいエディタ・表が要らない。見える人の決め方もページの共有と同じ |
| （ウ）新しい表 `wiki_templates` に写しを持つ | — | 本文・画像・権限を二重に持つ |

- **ページのテンプレート**：誰でも作れる（ゲストを除く）。`is_template = true` のページは木・検索・AI・バックリンクに出さず、
  サイドバーの「ドキュメント」の下（ゴミ箱の上）の「テンプレート」に並べる。最上位に置き、共有の既定は作った人の `full` +
  「ワークスペースの全員：閲覧」（「自分だけ」も選べる）。作る：ページの ⋯「テンプレートとして保存」（写しを作る。元は変えない）と
  「＋ 新しいテンプレート」。使う：木の ＋ / 子ページの作成の画面のギャラリー（白紙・組み込み（`canvas_templates`）・みんなのテンプレート）、
  空のページの「テンプレートから始める」。写すもの：題名・アイコン・本文（変数を展開）・画像とファイル（BlobStore の中で複製、
  S3 の CopyObject）。テンプレートの子ページは写さない（後で「部分木を複製」と一緒に）。
- **行のテンプレート**：データベースの中の `is_template = true` の行。問い合わせ・件数・カレンダー・CSV・関係の候補・検索に出さない。
  「＋ 新規」の横の ▾ に並び、既定のテンプレート（`wiki_databases.default_template_id`）を 1 つ選べる。既定があれば「＋ 新規」・カレンダーの
  日の ＋・ボードの列の ＋ はそれから作る（ボード・カレンダーの値は上書き）。プロパティに動的な値（日付の「今日」`{"start": "@today"}`、
  人の「自分」`["@me"]`）を置け、作るときにサーバが展開する。行のテンプレートの作成・変更は**編集**の段階。
- **取り込みとのつなぎ**（決定）：取り込みで行になった「CSV に無い行のページ」（研究室の書き出しでは 4 つ）は**行のテンプレート**にする。
  `notion_import.py` は最初から `is_template` で作り、再実行では、まだ編集されていない行ならテンプレートに変えて報告に出す。違えば
  行の ⋯「テンプレートを解除」で戻せる。
- **変数**：今の `canvases/templates.py` の展開（`{{date}}`・`{{week}}`・`{{me}}`・`{{me_name}}`）に `{{time}}`・`{{parent}}` を足す。
  端末が送るタイムゾーン（`tz`）で作成の API の中で展開し、テンプレートの本文は展開しないまま持つ。
- **API（案）**：`POST /wiki/pages` に `template_page_id`（`template_key` と排他。テンプレートの閲覧と作る先の編集が要る）、
  `POST /wiki/databases/{id}/rows` に `template_id`、`POST /wiki/pages/{id}/duplicate {parent_id?, after_id?, as_template?, client_save_id}`
  （「複製」と「テンプレートとして保存」）、`PATCH /wiki/pages/{id} {is_template}`（編集で可）、`GET /wiki/templates`、
  `GET /wiki/databases/{id}` に `templates: [{id, title, icon}]` と `default_template_id`。冪等は `client_save_id`。
- **ページの複製**：テンプレートと同じ写す手順（変数は展開しない）、元の隣に「題名（コピー）」。共有は置いた場所から受け継ぐ（確認の
  画面で見える人を出す）。データベースの複製は後。

### 22.4 ビューの種類（M147 サーバ・Desktop / Web、M148 スマホ）

| 種類 | 設定 | サーバ | Desktop / Web | スマホ |
| --- | --- | --- | --- | --- |
| `table`（今） | ＋ `group_by`（セレクト・マルチ・人・チェック・日付（日 / 週 / 月）） | 問い合わせに `group_by`。グループの順（選択肢の順、空は最後）→ ビューの並べ替え、グループごとの件数 | 見出しの行で折りたたみ | カードの一覧をグループの見出しで区切る |
| `board`（新） | `group_by_prop_id`（セレクト・人・チェック）、カードに出すプロパティ、隠すグループ | 同じ `group_by`。カードの手での並べ替えは行の `position` で、「グループの値 + 位置」を 1 回で書く `POST /wiki/rows/{id}/move {set, before_id \| after_id}` | 列ごとのカード、ドラッグで列と順、列の下の ＋ | グループごとのセクションのカード、カードの ⋯「◯◯へ移す」 |
| `list`（新） | 出すプロパティ | 表と同じ | 1 行ずつ | 今のカード |
| `gallery`（新） | カードの絵（本文の最初の画像 / `files` / カバー / なし）、大きさ | 保存のときに `wiki_pages.preview_image_id` を覚える | 格子のカード | 2 列の格子 |
| `calendar`（今） | — | — | — | — |

- `type` の値を足すだけで、表と API の形は変えない（§5.8 で用意した形）。古いアプリは知らない種類を表として出す（M147 で確かめた：
  iOS・Android とも `type` を文字のまま持ち、カレンダー以外はカードの一覧。§25.4）。
- `status` は型を増やさず、セレクトの表示の違い（「未着手 / 進行中 / 完了」の組）でよい。`files` 型は M147 の任意。数式・ロールアップは入れない。

### 22.5 方言を広げる：コールアウト・トグル・データベースの埋め込み（M149、3 端末）

| ブロック | 書き方（決定） | 理由 |
| --- | --- | --- |
| コールアウト | `::: callout 💡` の行から `:::` の行まで。中はふつうのブロック（見出し・リスト・画像も入る）。アイコンは絵文字かカスタム絵文字で、省略可 | VuePress / Docusaurus の admonition と同じ囲み。コードの囲みと同じ字句解析で 3 端末とも書ける。古いアプリでは文字の行として見える（壊れない） |
| トグル | `::: toggle 見出し` から `:::` まで。中はふつうのブロック。開閉の状態は端末ごと（本文に書かない） | コールアウトと同じ囲みの仲間にして解析を 1 つにする。`<details>` は HTML を方言に入れることになるので採らない |
| データベースの埋め込み | 1 行だけの `![表示名](page:<データベースの id>#view=<ビューの id>)` | 画像の書き方に `page:` を足すだけ。読めない人には「アクセスできないページ」、古い端末にはリンク |

- 囲みの入れ子は 1 段まで（コールアウトの中のトグルは可、その中は不可）。
- 取り込みは `<aside>` を `::: callout` に書き換えるように直す。すでに取り込んだ本文は管理者のコマンド
  `app.cli wiki-rewrite-callouts --dry-run`（head が取り込みの版で、その後に編集されていないページの `> 絵文字` だけを `import` の版で
  書き換える。編集されたページは報告だけ）。
- 検索の本文と AI の資料からは `:::` の行を外す（索引には中身だけ）。`apps/shared/canvas_markdown.json` に共通のケースを足す。
- 埋め込みの描画：Desktop / Web は今の `DatabaseView` を小さく（最大 10 行 +「すべて表示」）、スマホは題名とビューの名前と最初の 5 行の
  カード +「開く」。`/` の「データベース」は「子のデータベースを作って埋め込む」に変える。

### 22.6 見たまま編集：Desktop / Web（M150〜M151）

| 観点 | （a）既製のブロックエディタ（BlockNote・Lexical・Milkdown）で Markdown に書き出す | （b）Markdown のまま、TipTap でページエディタを作り往復させる ★決定 | （c）ブロック JSON を保存の形にする |
| --- | --- | --- | --- |
| 保存・マージ | 書き出しが製品の Markdown で方言とずれ、**開くだけで本文が書き換わる** | 同じ。変換は自前（`richMarkdown.ts` を広げる）。触っていないブロックは元の文字列のまま | 行のマージ（`merge3`）が使えず、マージ・版・差分の作り直し |
| スマホ・検索・AI・取り込み | 同じ | 同じ | 作り直し |
| 依存 | 大きい（BlockNote は Mantine など） | ほぼ無い（TipTap は入力欄のリッチ入力で既に使っている） | 中 |
| 方針との整合 | △ | ◎（D24・D27 のまま） | × |

- **部品**：`PageEditor.tsx`（遅延読み込み、TipTap）と `pageMarkdown.ts`（純粋な関数。`richMarkdown.ts` をキャンバスの方言に広げたもの）。
  ノードは方言のブロックと 1 対 1（見出し・段落・リスト（3 段）・チェック・引用・コード・区切り線・画像・表（v1 は描画 + 今の表の編集画面、
  マスの直接編集は M151）・数式（KaTeX で描きクリックで TeX）・メンション / ページのリンク / ファイルのチップ・コールアウト・トグル・
  埋め込み）。方言で読めないものは**生の Markdown のブロック**（文字のまま編集）として残し、消さない。
- **往復の不変条件**（いちばん大事。テストで固定する）：
  1. **開いて閉じただけなら本文は 1 バイトも変わらない。** 読み込むときに各ブロックに元の文字列（`src`）を持たせ、保存のときに
     読み込んだときのままのブロックは `src` を書き戻す。手で編集したブロックだけが正規の形で書き出される。
  2. 正規の形は冪等（`md → doc → md → doc → md` が 2 回目以降変わらない）。
  3. 本番の全本文（取り込みの 42 ページ + 374 行とキャンバス。手元のコピーで実行し、リポジトリには入れない）と `canvas_markdown.json`
     のケースで (1)(2) が 100%。
- **保存とマージ**：入力が止まったときに Markdown に書き出して今の保存の状態機械に渡す（毎打鍵では変換しない）。マージで他の人の変更が
  入った本文が返ってきたら、トップレベルのブロックの `src` を比べて**変わったブロックだけ**差し替え、選択位置を写す。
- **モード**（決定）：**見たままを既定**、人ごとに Markdown に切り替えられる（`users.docs_editor_mode`：`wysiwyg` \| `markdown`、入力欄の
  `composer_mode` と同じ考え方。設定とページの見出しの両方から）。Markdown のモードは今の 2 列（エディタ + プレビュー）のまま残す
  （往復できない書き方の逃げ道、Markdown に慣れた人のため）。最初の段では「閲覧 / 編集」の切り替えを残す。
- M150：ノード・往復のテスト・`/` メニュー（どこでも、ブロックの種類の変更）・`[[`・`@`・Markdown の打ち方の変換（`# `・`- `）・画像の
  貼り付け・マージの差し替え・モードの切り替え。M151：ブロックのハンドル（⋮⋮）とドラッグ、⌘⇧↑↓、＋ でブロック、HTML の貼り付け
  （Notion・Word・Google ドキュメント → 方言）、表のマスの直接編集、⌘K のページ。

### 22.7 スマホ（iOS / Android）：M145〜M151 は Markdown、M153 で見たまま編集

**M145〜M151 の間**（今の形を保つ）：

| 機能 | スマホ |
| --- | --- |
| すべてのページ・データベースを読む（コールアウト・トグル・埋め込みを含む） | ○（M149 で描画を足す） |
| 本文の編集 | セクション / 全体の Markdown 編集（今どおり）。キーボードの上のツールバーに「チェック・見出し・コールアウト・トグル」を足す |
| テンプレートから作る（ページ・行）、ページの複製 | ○（M146） |
| 行の追加・値の変更 | ○（今どおり） |
| ボード・ギャラリー・リスト・まとめる | 見る（§22.4 の形）、カードの ⋯ で値を変える（M148） |
| プロパティ・ビューの作成と変更、共有・移動 | 見るだけ（今どおり） |

**M153：スマホの見たまま編集**（利用者の希望 2026-10-08「できれば今後、スマホでも見た目のまま編集できるようになってほしい（Notion のように）」）。
2026-10-08 の下書きの「スマホは見たまま編集をしない・WebView のエディタは方針に合わない」は、この希望を受けて見直した。

| 観点 | （A）端末ごとのネイティブのエディタ（iOS：TextKit 2 の `UITextView` に属性付きのブロックのモデル、Android：Compose の `BasicTextField` と span（または `AndroidView` の `EditText` + `Spannable`）） | （B）**同じ TipTap のエディタをアプリに同梱し、編集のときだけ WKWebView / Android WebView で出す** ★推奨 |
| --- | --- | --- |
| 往復の正しさ（§22.6 の不変条件） | 方言 ↔ 文書の変換と `src` の書き戻しを Swift と Kotlin でもう 2 つ作る。3 つの実装がずれると、開いただけで本文が書き換わる事故が端末ごとに起きうる。コーパスのテストも 3 回 | **変換は 1 つ**（`pageMarkdown.ts`）。同じコーパスのテストがそのまま守る。スマホに送るのは同じビルドの成果物 |
| ブロック（表・数式・画像・コールアウト・トグル・埋め込み） | TextKit 2 は `NSTextElement` / レイアウトの断片で作れるが、表・入れ子・ブロックをまたぐ選択は自前。Compose の `BasicTextField`（`TextFieldState`）は入力中の span の扱いが限られ、ブロックごとの欄に分けると欄をまたぐ選択・削除・IME の移動が難しい | Desktop / Web と同じノード（M150〜M151 の機能がそのまま出る） |
| 日本語の IME | 属性付きの編集と未確定の文字（`markedText`・composing region）の組み合わせは両 OS とも落とし穴が多く、自前で詰める | ブラウザのエンジンと ProseMirror の IME 対応の上（入力欄のリッチ入力で実績）。Android の Gboard の変換中の削除などは既知の課題があり、試作で確かめる |
| 費用 | 大（各 OS で 4〜8 週の見込み、以後も方言を足すたびに 3 か所） | 中（ブリッジ・キーボード・同梱の仕組みで各 OS 1.5〜3 週。方言の追加はエディタ 1 か所） |
| ネイティブらしさ | ◎ | ○（読む画面・一覧・ナビゲーション・保存の状態はネイティブのまま。編集中の本文だけ Web） |
| 依存 | なし | なし（WKWebView と Android WebView は OS の標準。Android の資産の読み込みとメッセージは Jetpack の `androidx.webkit`） |

**推奨は（B）。** 理由：

1. **往復の正しさを 1 か所で守れる。** 見たまま編集でいちばん怖いのは「開いただけで本文が黙って変わる」ことで、変換を 3 つ書くとその
   危険が 3 倍になる。（B）なら §22.6 の不変条件とコーパスのテストが、そのままスマホにも効く。
2. ブロック（表・数式・コールアウト・埋め込み）と `/` メニュー・`[[`・`@` が Desktop / Web と同じに動き、方言を足すときの作業が 1 か所。
3. 費用が数分の 1。浮いた分をキーボード・IME・オフラインの作り込みに回せる。

**CLAUDE.md の方針との関係**：「標準のプラットフォームの API を優先」は守る（WKWebView / WebView は標準）。アプリを Web の包み紙に
するのではなく、**読む画面（`CanvasBodyView`・`BodyTokenizer`）・木・一覧・保存の状態機械・保存待ち・オフラインはネイティブのまま**に
し、編集中の本文の欄だけを Web で出す。ARCHITECTURE.md に判断として残す（M153 の実装と同時）。

**（B）の作り**：

- **同梱**：Desktop の Vite に別の入口（`mobile-editor.html`、`PageEditor` だけ）を作り、成果物を `apps/shared/mobile-editor/`（生成物。
  `npm run build:mobile-editor` で作り、CI でハッシュを照合）に書き出して、iOS のバンドルと Android の `assets` に入れる。**ネットから
  読み込まない**（オフラインで編集でき、版がアプリと必ず揃う）。iOS は `WKURLSchemeHandler`（`taylis-editor://`）、Android は
  `WebViewAssetLoader`（`https://appassets.androidplatform.net/`）で配る。
- **安全**：CSP は `default-src 'self'; connect-src 'none'`（エディタは自分で通信しない）、ほかのページへの移動はすべて止め、リンクは
  ネイティブに渡して開く。**アクセストークンを JS に渡さない**。画像は同じスキームの `/attachment/<id>` をネイティブが認証付きで取って
  返す。
- **ブリッジ**（設計時の下書き。実装した形は §30.3 が正：メッセージの名前は `replace`・`insertImage`・`providePeople` / `providePages` / `provideEmoji`・`needPeople` / `needPages` に、例は `apps/shared/mobile-editor/bridge_messages.json` に。両 OS と JS のテストで同じケースを読む）：
  - ネイティブ → エディタ：`load {body, readOnly, locale, theme}`、`replaceBlocks {body}`（マージの後。変わったブロックだけ差し替え）、
    `insert {markdown}`（写真・ファイル・メンション）、`command {name}`（ツールバーの太字・チェック・見出しなど）、`candidates {kind, items}`。
  - エディタ → ネイティブ：`ready`、`changed {body}`（入力が止まったとき。保存はネイティブの `CanvasSaver` が今と同じ状態機械・
    保存待ち・オフラインの再送で行う）、`query {kind: mention | page, q}`（候補はネイティブが API で取って返す）、`pickImage`、
    `openLink {url}`、`selection {marks, block}`（ツールバーの状態）、`height`。
- **キーボード**：ツールバーはネイティブ（iOS はキーボードの上の欄、Android は IME のインセット（`WindowInsets.ime`）の上）で、押すと
  `command` を送る。WKWebView の既定の入力の補助バーは隠す。選択位置が見えるように、エディタはキーボードの高さ（`visualViewport`）に
  合わせてスクロールする。
- **速さ**：WebView は画面を開いたときに 1 つ温めておき、「編集」で中身だけ入れる（初回の表示 300 ms 以内を目標）。
- **モード**：Desktop と同じ人ごとの `docs_editor_mode`。Markdown を選んだ人・WebView が使えないとき・エディタが読めない書き方を
  含むページで本人が選んだときは、今のセクション / 全体の Markdown 編集。セクション編集は見たままでは「全体を開いて、その見出しへ
  スクロール」にする。

**M153 の段階**：

| 段階 | 中身 | 判定 |
| --- | --- | --- |
| M153a 試作 | iOS と Android で同梱のエディタを出す最小の試作。日本語の IME（かな漢字・ライブ変換・Gboard・ATOK）、選択のハンドル、キーボードの上のツールバー、10 万字のページ、初回の表示時間、画像の挿入 | 端末ごとに「Markdown の編集より明らかに良い・壊れない」を利用者と確かめる。**満たさない OS は Markdown のまま**（例：Android の WebView の IME が基準に届かなければ iOS だけ先に出す） |
| M153b iOS | ブリッジ・保存・マージの差し替え・オフライン・写真・メンション・`[[`・ツールバー・設定 | XCTest（ブリッジの形、保存の要求、マージ後の差し替え）、シミュレータと実機で IME |
| M153c Android | 同じ | 単体テストとエミュレータ（ChikuwaChat_Pixel_9）・実機で IME |

### 22.8 利用者の決定（2026-10-08）

利用者は §22 の推奨をすべてそのまま決めた。

| # | 質問 | 決定 |
| --- | --- | --- |
| R1 | 見たまま編集を既定にするか | **見たままを既定**、人ごとに Markdown へ切り替えられる |
| R2 | データベースの列・ビューを変えられる人 | **編集できる人**が追加・名前・並び・選択肢の追加とビューの作成・変更・削除。プロパティの削除・型の変更・双方向の関係はフル。**データベースを作った人はフル**（§22.2） |
| R3 | テンプレートの持ち方 | **ページそのもの、誰でも作れる**（共有で見える人を決める）。組み込み（`canvas_templates`）も並べる |
| R4 | コールアウト・トグルの書き方 | **`::: callout 💡 …` / `::: toggle 見出し …`** |
| R5 | 順番 | **権限 → テンプレート → ビュー → 方言 → 見たまま編集** |
| R6 | 取り込みの「CSV に無い行のページ」 | **行のテンプレートにする** |
| R7 | スマホの見たまま編集 | M145〜M151 の間は Markdown の編集のまま。**後で入れてほしい**（「できれば今後、スマホでも見た目のまま編集できるようになってほしい（Notion のように）」）→ M153（§22.7） |

### 22.9 マイルストーン（M144〜M153）

| # | 名前 | サーバ | Desktop / Web | iOS / Android | 大きさ |
| --- | --- | --- | --- | --- | --- |
| M144 | データベースを編集者が育てる（**実装済み 2026-10-08、§23**） | §22.2：壊さない変更とビューを編集に、データベースを作った人にフル、監査 | 操作ごとの権限でボタンを出す（`canShape` / `canDestroy`）、表の見出しの右端に ＋ | 変更なし | 小 |
| M145 | テンプレートと複製（サーバ・Desktop / Web）（**実装済み 2026-10-08、§24**） | `is_template`（移行）、`template_page_id`・`template_id`・`duplicate`・`GET /wiki/templates`・`default_template_id`、変数、動的な値、添付の複製、テンプレートを木・検索・AI・問い合わせ・CSV・候補から外す、取り込みの「CSV に無い行」をテンプレートに | ギャラリー、サイドバーの「テンプレート」、「テンプレートとして保存」「複製」、「＋ 新規 ▾」・既定・編集の帯、行の「テンプレートにする」 | — | 中（4〜6 日） |
| M146 | テンプレートと複製（スマホ） | — | — | 作成のシートでテンプレートを選ぶ、行の ＋ の ▾、⋯「複製」 | 小 |
| M147 | ビューの種類（サーバ・Desktop / Web）（**実装済み 2026-10-08、§25**） | `board`・`list`・`gallery`、`group_by`、`POST /wiki/rows/{id}/move`、`preview_image_id`（任意で `files`） | ボード（ドラッグ）、リスト、ギャラリー、表のまとめる | — | 中（4〜6 日） |
| M148 | ビューの種類（スマホ） | — | — | グループの見出しのカード、2 列のギャラリー、リスト、まとめる。知らない種類は表 | 小〜中 |
| M149 | 方言：コールアウト・トグル・データベースの埋め込み（**実装済み 2026-10-08、§26**） | 検索・AI の本文から `:::` を外す、取り込みの `<aside>`、`wiki-rewrite-callouts`、`canvas_markdown.json` | 描画、Markdown のエディタの `/` に 3 つ、埋め込みの表 | 描画（トグルの開閉は端末ごと）、ツールバー | 中（3 端末で 4〜6 日） |
| M150 | 見たまま編集・第 1 段（Desktop / Web）（**実装済み 2026-10-08、§27**） | `users.docs_editor_mode` | `PageEditor.tsx`・`pageMarkdown.ts`、往復の不変条件とコーパスのテスト、`/`・`[[`・`@`、打ち方の変換、画像、マージの差し替え、モードの切り替え（既定は見たまま） | — | 大（1.5〜2 週） |
| M151 | 見たまま編集・第 2 段（Desktop / Web）（**実装済み 2026-10-08、§28**） | — | ブロックのハンドルとドラッグ、⌘⇧↑↓、＋ でブロック、HTML の貼り付け、表のマスの直接編集、⌘K のページ | — | 中 |
| M152 | 仕上げ（任意） | カバー画像、データベースの複製 | カバー、日付のメンション、編集中の表示（presence） | カバーの描画 | 小〜中 |
| M153 | スマホの見たまま編集 | — | 同梱用のエディタの入口（`mobile-editor`）とブリッジの JS、`editor_bridge.json` | §22.7：M153a 試作と判定 → M153b iOS → M153c Android（基準に届かない OS は Markdown のまま） | 中〜大（各 OS 1.5〜3 週） |

完了の条件（どれも）：pytest・サーバの型検査と lint・tsc・vitest・vite build・`cargo check`、iOS の xcodebuild のテスト、Android の Gradle の
ビルドとテスト。M149 は `canvas_markdown.json` の新しいケースが 3 端末で通ること。M150 と M153 は往復のコーパスで 100%（M153 はスマホの
WebView の中の同じ成果物で、ブリッジ越しに同じケースを流す）。

### 22.10 やらないこと

| やらないこと | 理由 |
| --- | --- |
| 本文をブロック JSON で持つ・CRDT（Yjs）にする | マージ・版・検索・AI・スマホ・取り込みを作り直すことになる（D24・D27）。保存とマージの体験で足りないと分かってから |
| BlockNote など既製の Notion 風エディタ | 依存が大きく、Markdown の書き出しが方言とずれて開くたびに本文が書き換わる |
| スマホに端末ごとのネイティブのエディタを作る | 変換が 3 つになり往復の正しさを守れない（§22.7）。WebView で出すのは編集中の本文の欄だけ |
| スマホのエディタをネットから読み込む・トークンを JS に渡す | オフラインで編集でき、版がアプリと揃い、エディタからの漏れが無いように（§22.7） |
| ふつうのページを作った人に自前のフルを付ける | 卒業してゲストになっても見え続ける（§22.2、§4.4） |
| 数式・ロールアップ・タイムライン・チャート・ボタン・自動化 | 3 端末の表示と実装の費用が大きい。具体的な要望が出てから |
| 行ごとの共有 | §1.2 のまま |
| 列のレイアウト・同期ブロック・外部の埋め込み（YouTube など） | 方言とスマホの描画が大きくなる。外部の埋め込みは CSP の扱いも要る |
| 埋め込みごとの独自の絞り込み（リンクされたビューの独自の設定）・「自分だけのビュー」 | データベースにビューを足せば足りる。画面で変えて保存しないことは今もできる |
| 見たまま編集と同時にキャンバスも置き換える | まずドキュメントだけで往復の正しさを確かめる。同じ `PageEditor` を後でキャンバスに使える |

### 22.11 実装と同時に直す docs

WIKI.md（この節と各マイルストーンの実装の節。§1.2・§3.2・§5・§7.3・§7.4 の見直しの記録）、CANVAS.md §4.2（方言のコールアウト・トグル・
埋め込み、M149）、DATA_MODEL.md（`is_template`・`default_template_id`・`preview_image_id`・`cover_attachment_id`・`users.docs_editor_mode`）、
SYNC_PROTOCOL.md（テンプレートの変更、行の移動）、SECURITY.md（テンプレートの見える人、複製で添付の権限が新しいページに移ること、
M153 の WebView の CSP とトークンを渡さないこと）、ARCHITECTURE.md（判断：見たまま編集は Markdown の往復で D24 を変えない、スマホは
同梱のエディタを編集のときだけ WebView で出す）、`apps/shared/canvas_markdown.json`・`editor_bridge.json`、OpenAPI、website の使い方ガイド。

## 23. M144 の実装（データベースを編集者が育てる、2026-10-08）

§22.2 のとおり。移行なし、新しいエラーコードなし。OpenAPI は説明文だけ変わった（`PATCH …/schema`・`PUT / DELETE …/views/{view_id}`）。

### 23.1 サーバ

- `wiki/databases.py`：`change_schema` は**編集**で読み込み、操作ごとに `_needs_full` で確かめる：`delete`、型が変わる `retype`
  （同じ型で数の形だけ変える `retype` は編集）、関係への / 関係からの `retype`、選択肢を外す `update`、`two_way` の関係の `add`。
  どれか 1 つでも足りなければ 403 `page_manage_restricted` で要求全体を断る（トランザクションは書かずに終わる）。一方向の関係の
  `add` は今までどおり相手のデータベースの閲覧が要る。`put_view`・`delete_view` は**編集**。
- 監査ログ：`wiki.schema_changed {ops: [{op, id?, type?}]}`、`wiki.view_saved {view_id, type}`、`wiki.view_deleted {view_id}`（target は
  データベースのページ）。
- `wiki/service.py` の `create`：親の下に `kind = database` を作り、作った人の段階が親でフルより下なら、作った人の `user: full` を
  自前の項目に足して実効の権限を計算し直す（受け継ぎは保つ）。ふつうのページは変えない（§22.2 の理由）。
- 説明文（`db_router.py`・`db_schemas.SchemaChange`）を新しい段階に直した。

### 23.2 Desktop / Web

- `wikiDb.ts` の `databaseRights(my_level, isGuest)` → `{canEdit, canShape, canDestroy}`（編集 / 編集 / フル。ゲストは `canShape`・
  `canDestroy` とも false）。`DbCtx` の `canManage` を `canShape` と `canDestroy` に分けた。
- `canShape`：ビューの ＋・ビューのメニュー（名前・削除）・「ビューを保存」、⋯ と「プロパティ」の棒の「プロパティを追加」と ✎、表の見出しの
  ⋯「プロパティを編集」、**表の見出しの右端の ＋**（新しい）、セレクトのマスでの新しい選択肢。
- `PropertyDialog`：`canDestroy` が無ければ、既存のプロパティの種類の選択を止め、「プロパティを削除」を出さず、保存済みの選択肢の
  「外す」を出さず（新しく足した未保存の選択肢は外せる）、関係の「双方向」を出さない。代わりに「種類の変更・プロパティと選択肢の
  削除・双方向の関係は、フルアクセスの人だけができます。」と出す。
- iOS / Android：スキーマとビューを書く経路が無い（`GET /wiki/databases/{id}` と `query`・行・候補だけ）ので変えていない。API に段階の旗を
  足していない（`my_level` の意味が広がっただけ）。

### 23.3 本番で確かめること（コードの変更は要らない、2026-10-08 の時点で未実施）

研究室の Notion の取り込みは `--actor kano` で実行した。最上位に取り込んだなら根のページに `kano: full`（と `--access` の項目、既定は
`workspace: edit`）が付き、データベースは受け継ぐので、M144 の後は**全員（ゲストを除く）が列とビューを足せ**、削除・型の変更は `kano`
（とフルを持つ人）だけになる。`--parent` の下に取り込んだ場合や、その後に共有を変えた場合は違うので、本番で次を確かめる（読むだけ）：

- 管理 →「ドキュメント」の一覧で、取り込んだデータベースの「見られる人」と「フルアクセスの人なし」の札を見る。
- または本番の PostgreSQL で（`docker compose exec db psql -U <ユーザー> <データベース>`）：

  ```sql
  SELECT p.title, e.principal_type,
         COALESCE(u.username, g.name::text, '(全員)') AS who,
         CASE e.level_rank WHEN 3 THEN 'full' WHEN 2 THEN 'edit' ELSE 'view' END AS level
  FROM import_refs r
  JOIN wiki_pages p ON p.id = r.target_id AND p.kind = 'database' AND p.deleted_at IS NULL
  JOIN wiki_effective_grants e ON e.page_id = p.id
  LEFT JOIN users u ON e.principal_type = 'user' AND u.id = e.principal_id
  LEFT JOIN user_groups g ON e.principal_type = 'group' AND g.id = e.principal_id
  WHERE r.source = 'notion' AND r.kind = 'page'
  ORDER BY p.title, e.level_rank DESC;
  ```

- 教員のアカウント（列を消したり型を変えたりしたい人）にフルが無ければ、フルの人が共有の画面で取り込みの最上位のページに教員を
  `full` で足す（フルの人がいなければ管理者の引き取り、§4.3）。M144 より前に編集者が作ったデータベースには、作った人のフルは
  付いていない（さかのぼって付けない）。必要なら同じく共有の画面で足す。

### 23.4 テスト

サーバ：`tests/test_wiki_db_access.py`（16 の操作 × 閲覧 / 編集 / フルの表：閲覧は 403 `page_edit_restricted`、編集は壊さない操作が通り
フルの操作は 403 `page_manage_restricted` で `schema_version` が変わらない、フルは通る。監査ログの 3 つ。データベースを作った編集者に
自前のフル（受け継ぎは保ち、ほかの人の段階は変わらない）、フルの人のデータベースとふつうのページには何も付かない。毎回
`wiki-acl --verify` と同じ確かめ）、`tests/test_wiki_databases.py` の段階の確かめを新しい規則に直した。pytest 1464。
Desktop：`tests/wikiDb.test.ts`（`databaseRights` の段階とゲスト）、`tests/dbUi.test.tsx`（編集の人にビューの ＋・メニュー・表の見出しの ＋、
閲覧の人とフルのゲストには出ない、編集の人のプロパティの画面（種類を変えられない・削除が無い・保存済みの選択肢を外せない・新しい選択肢は
足して保存できる・双方向が無い・注意の文）、フルの人には全部出る）。vitest 2527。

## 24. M145 の実装（テンプレートと複製：サーバ・Desktop / Web、2026-10-08）

§22.3 のとおり。移行 0108（`wiki_pages.is_template`・`wiki_databases.default_template_id`）。新しいエラーコードは
`wiki_template_invalid`（400）・`wiki_cannot_duplicate`（400）・`wiki_page_not_empty`（409）。新しいイベントは無い。

### 24.1 サーバ

- **テンプレートはページそのもの**（`is_template`、CHECK で `page` と `row` だけ）。ページのテンプレートは最上位の子ページの無い
  ページ（子ページを置けない・ページの下へ移せない：400 `wiki_template_invalid` / `invalid_page_parent`）。木・変更のフィードの
  `pages`（テンプレートになったページは `removed` に出る）・検索（`_page_within`。AI に聞く（M126）も同じ問い合わせを使う予定）・
  `[[` の候補・`in:` の題名・バックリンクから外した。行のテンプレートは問い合わせ・件数・カレンダー・CSV・関係の候補と相手の行
  （`_visibility`：つながりの相手にも出ない）から外した。スキーマの変更（型の変換・削除・選択肢の削除）はテンプレートの値も書き換える。
  テンプレートの本文のメンションは通知しない。
- **`GET /wiki/templates`** → `{pages: [PageItem…]（読めるもの、新しい順）, builtins: [CanvasTemplateOut…]（隠していない組み込み）}`。
- **`POST /wiki/pages`**：`template_page_id`（`template_key` と排他。テンプレートの閲覧が要り、読めない・テンプレートでないものは
  404 `template_not_found`）。題名・アイコン・本文を写し、変数を展開し、本文が参照する元のファイルを複製する（本文を送ったときは
  写さない）。`is_template: true` でテンプレートを作る（最上位だけ、ゲスト不可。`access: workspace` → 全員が閲覧 + 作った人のフル、
  `private` → 自分だけ）。テンプレートからテンプレートを作るときは変数を展開しない。
- **変数**（`canvases/templates.py`）：`{{date}}`・`{{week}}`・`{{me}}`・`{{me_name}}` に `{{time}}`（`HH:MM`、`tz`）と `{{parent}}`
  （置く先の親ページの題名、最上位は空、データベースの行はデータベースの題名）を足した。キャンバスでは `{{time}}`・`{{parent}}` を
  そのまま残す（キャンバスの動きは変えない）。`{{parent}}`（とそれと同じ題名の `{{channel}}`）は、作る人が親を**読めるとき
  だけ**親の題名になる。読めない親（受け継ぎを切った共有で子だけ編集できる場合など）は最上位と同じ空の文字列にし、読めない
  ページの題名を本文・題名・履歴に書かない（REVIEW-v0.1.48 #2。`apply-template` は適用の時点の権限で決める）。
- **`POST /wiki/pages/{id}/apply-template {template_key | template_page_id, tz, client_save_id}`**（§22.3 の「空のページの
  テンプレートから始める」のために足した）：編集の段階で、本文が空のページだけ（409 `wiki_page_not_empty`）。本文（展開・ファイルの
  複製）と、ページに題名・アイコンが無いときだけそれを入れる。`save` の版。
- **行のテンプレート**：`POST /wiki/databases/{id}/rows` に `template_id`（このデータベースの生きている行のテンプレート、違えば 404
  `template_not_found`）・`blank`・`is_template`・`tz`。`template_id` が無く `blank` でも `is_template` でもなければ**既定の
  テンプレートを使う**（古い端末の「＋ 新規」・カレンダーの日の ＋ も既定から作る）。送った `props`・空でない題名・本文が勝つ。
  関係の値はテンプレートのつながりのうち作る人が読めるものを写す。**動的な値**：日付 `{"start": "@today"}`（`"@today"` も可、終わり・
  時刻なし）と人 `["@me", …]` はテンプレートの行にだけ置け（ふつうの行は 422）、作るときに `tz` の今日と作る人に置き換える。
  行の数の上限（5,000）はテンプレートも数える。
- **既定**：`PUT /wiki/databases/{id}/default-template {template_id | null}`（編集）。`GET /wiki/databases/{id}` に
  `templates: [{id, title, icon}]`（古い順）と `default_template_id`（ゴミ箱にあるものは null で返す。完全に消えると FK で null）。
  テンプレートを解除すると既定から外す。テンプレートの変更は `wiki.rows.changed`（`schema_version` は進めない）。
- **`PATCH /wiki/pages/{id} {is_template}`**（編集）：ページ（最上位・子ページなし）と行の両方。データベースは 400。
- **`POST /wiki/pages/{id}/duplicate {parent_id?, before_id?, after_id?, as_template?, title?, access?, client_save_id}`**
  → `{page: PageOut, row: RowWithRefs | null}`。元の閲覧と置く先の編集が要る。`parent_id` を省くと元の隣（同じ親で元のすぐ後。
  その親を編集できなければ 403 `page_edit_restricted`、端末は `parent_id: null` で最上位に置き直せる）。`as_template` を省くと元と
  同じ種類。題名を省くと同じ種類の写しは「〇〇（コピー）」（読み手の言語：`（コピー）` / ` (copy)` / `（副本）`）、種類が変わる
  ときは元の題名。最上位に置くときの共有は `access`、省くと元が自分だけのページなら `private`、ほかは `workspace`。写すもの：題名・
  アイコン・本文（変数は展開しない）・ファイル（複製）、行は値と読める関係（テンプレートの写しをふつうの行にするときは動的な値を
  展開）。写さないもの：子ページ・版・共有の自前の項目。メンションは通知しない。データベースは 400 `wiki_cannot_duplicate`。
- **ファイルの複製**：`BlobStore.copy`（S3 は boto3 の `copy`＝CopyObject、メモリはそのまま）で本体とサムネイル（動画のポスター）を
  写し、新しい添付（`page_id` は新しいページ、`uploader_id` は作る人、`attached`）を作り、本文の `attachment:<id>` を書き換える。
  プレビューは作り直す（`queue_on_upload`）。元のページに付いていない添付（ほかのページ・メッセージ）は写さない。オブジェクトは
  コミットの前に書く（失敗しても参照の無いオブジェクトが残るだけ）。
- **取り込み**：`notion_import.py` は CSV に無い行のページを最初から `is_template` で作り、`import_refs` に `kind = 'template'` を
  残す。再実行では、まだ編集されていない（`same` / `update`）のにテンプレートでない行をテンプレートにし（報告 `row templates: turned`）、
  編集された行は報告だけ（`templates_left`）。`template` の記録があれば二度と変えない（人が「テンプレートを解除」した行は行のまま）。
  変える直前に行をロックし、計画の時点（取り込みと続けて行うときは、この取り込みが書いた時点）から変わっていないかをもう一度
  比べる（§21.2 と同じ状態。REVIEW-v0.1.48 #6）。計画の後に題名・セル・本文の変更、テンプレートにして解除、ゴミ箱への移動が
  あった行は変えずに `templates_left` へ回し（ゴミ箱・削除は載せない）、`import_refs` の `template` も実際に変えた行だけに残す。
  **`python -m app.cli wiki-notion-templates EXPORT --actor ADMIN [--dry-run]`**：同じ書き出しを読み、この手順だけを行う（監査
  `wiki.import_templates`）。何度実行しても同じ。**本番では未実行**（研究室の取り込みの 4 行が対象の見込み。まず `--dry-run`）。

### 24.2 Desktop / Web

- **ギャラリー**（`DocsTemplates.tsx` の `TemplateGallery`）：木の ＋・「子ページを追加」・空の画面のボタンで開く。「白紙のページ」
  （最初に選ばれている。Enter で白紙）・「組み込み」（週報・議事録 …）・「みんなのテンプレート」。空のページの「テンプレートから始める」は
  白紙なしで開き `apply-template`。`/` メニューの「子ページ」はこれまでどおり白紙。
- **サイドバー**：「共有」「プライベート」の下（ゴミ箱の上）に「テンプレート」。＋ で新しいテンプレート（全員が使える、編集で開く）。
  ゲストには ＋ を出さない。`WikiHub.templates` が `GET /wiki/templates` を持ち、`wiki.changed` のたびに読み直す。テンプレートに
  なったページは `upsert` で木から一覧へ移る。
- **ページの ⋯**：「複製」（`DuplicateDialog`：題名、置く先の見える人を親の共有から表示、最上位なら共有 / 自分だけ）、「テンプレートとして
  保存」（ゲスト以外、題名と「全員が使える（閲覧）/ 自分だけ」）、テンプレートでは「このテンプレートでページを作成」「テンプレートを解除」、
  行では「テンプレートにする」。テンプレートのページの上に帯（変数の一覧と操作）、子ページの一覧は出さない。
- **データベース**：「＋ 新規」は既定のテンプレートから（サーバが選ぶ）。横の ▾（`NewRowMenu`）にテンプレートの一覧（押すとその行、
  ✎ で横に開いて編集、☆ で既定の切り替え）・「白紙の行」・「新しいテンプレート」。行のテンプレートは横の画面で帯（「このテンプレートで
  行を作成」「既定にする / 外す」「テンプレートを解除」）と、日付の「今日（行を作る日）」・人の「自分（行を作る人）」を選べるマス。
- i18n：`docs.tpl.*`（ja / en / zh-Hans）。

### 24.3 M146（スマホ）が使うもの

- 作成のシート：`GET /wiki/templates`（`pages` と `builtins`）から選び、`POST /wiki/pages` に `template_page_id` か `template_key` と `tz`。
  空のページは `apply-template`。
- 行の ＋ の ▾：`GET /wiki/databases/{id}` の `templates`・`default_template_id`。`POST …/rows` は何も送らなければ既定から、`template_id`
  か `blank: true`。値の表示で `{"start": "@today"}` を「今日」、`"@me"` を「自分」と出す（テンプレートの行を開いたとき）。
- ⋯「複製」：`POST /wiki/pages/{id}/duplicate {client_save_id}`（題名はサーバが言語に合わせて付ける）。403 `page_edit_restricted` なら
  `parent_id: null` で最上位に。
- ページの `is_template` を見てテンプレートの帯を出す。木（`GET /wiki/tree`・`/changes`）にはテンプレートが来ないので、今のアプリは
  テンプレートを木に出さない（変更なしでも壊れない）。エラー文言は `apps/shared/errors.json` から生成済み（iOS / Android の表も更新済み）。

### 24.4 テスト

サーバ：`tests/test_wiki_templates.py`（12）：ページのテンプレートの作成と見える人（共有・自分だけ・ゲスト不可・閲覧の人は変えられない）、
木・フィード・検索・`[[`・バックリンクに出ない、置き場所の規則（最上位・子ページなし・データベース不可・移動不可・子を置けない・
解除で木に戻る）、テンプレートから作る（変数・`{{unknown}}` は残る・ファイルの複製と読める・メンションは作ったページで通知・
読めない / テンプレートでないものは 404・排他・冪等・組み込み）、`apply-template`（題名とアイコンは無いときだけ・空でなければ 409・
閲覧は 403）、キャンバスの変数は変わらない、行のテンプレート（動的な値・ふつうの行は 422・表 / 件数 / CSV / 候補に出ない・
作る人で展開・送った値が勝つ・既定・`blank`・ほかのデータベースは 404・解除で既定が外れる・「テンプレートにする」）、データベースの
共有に従う（閲覧は 403）、複製（隣・（コピー）・英語・ファイル・子ページなし・通知なし・冪等・テンプレートとして保存・テンプレートを
ページに・自分だけの写しは自分だけ・データベースは 400・置く先を編集できなければ 403 で最上位は可・ゲスト不可）、行の複製（値・関係・
すぐ下・行のテンプレートに・今日の展開・データベースの外は 400）、取り込み（新規でテンプレート・再実行で変えない）と CLI（試し読みは
書かない・編集された行は残す・2 回目は何もしない・解除された行は戻さない・引数）。pytest 1476。
Desktop：`tests/templatesUi.test.tsx`（11）：ギャラリー（3 つの区分・選択・白紙なし・空の案内・作成の要求）、サイドバーの
「テンプレート」とハブの移し替え・読み直し、「テンプレートとして保存」「複製」（見える人・要求）、テンプレートの帯とメニュー、
「新規 ▾」（既定・テンプレートから・白紙・新しいテンプレート・既定の切り替え）、今日 / 自分のマス。vitest 2537。ヘッドレス Chrome
（Vite 1422・CDP 9444・使い捨てのデータベースの自分の uvicorn）でギャラリー・作成・帯・▾・行のテンプレート・複製・
テンプレートから始めるを確かめた。

### 24.5 M146 の Android（2026-10-08）

§24.3 のとおり。本文の編集は Markdown のまま（§22.7）。

- **作成のシート**（`NewPageDialog`）：題名の下に「白紙のページ」（最初に選ばれている）・「組み込み」・「みんなのテンプレート」
  （`GET /wiki/templates`、開くたびに読む。読めなければ白紙だけで作れる）。`template_key` / `template_page_id` と `tz` を送り、題名が
  空なら送らない（テンプレートの題名になる）。空のページ（編集の段階）は「書き始める」の下に「テンプレートから始める」
  （`ApplyTemplateDialog`、白紙なし、`apply-template`。版は保存のループが読み直す）。
- **行の「＋ 新規」**（`NewRowDialog`）：データベースに行のテンプレートがあれば、既定（最初に選ばれている）・ほか・「白紙の行」を選べる。
  既定は何も送らず、ほかは `template_id`、白紙は既定があるときだけ `blank: true`（`WikiTemplates.rowChoice`）。↗ でテンプレートの
  行を開ける。テンプレートの行の値は日付の `@today` を「今日」、人の `@me` を「自分」と出す（`DbCellContext.todayWord` / `meWord`）。
- **⋮「複製」**（データベース以外）：`POST …/duplicate {client_save_id}`（ネットの失敗は同じキーで送り直す）。403
  `page_edit_restricted`（ページだけ）なら「最上位に複製しますか？」で `parent_id: null`。できた写しを開く。
- **帯**：`is_template` のページ / 行の上に §24.2 と同じ文言と「このテンプレートでページを作成」（最上位、ゲストには出さない）/
  「このテンプレートで行を作成」（編集）。「テンプレートとして保存」「テンプレートを解除」・既定の切り替えはパソコンのまま（§24.3 に無い）。
- 文字列は `strings_docs_tpl.xml`（ja / en / zh-Hans）。エラーは生成済みの表（`template_not_found` など）。
- テスト：`WikiTemplatesTest`（13：形の読み取りと古いサーバ、ギャラリー、作成・`apply-template`・複製・行の要求の本文、セッションが
  選択と `tz` を渡す、複製の同じキーと最上位への問い、帯、空のページの条件、行のシートの選択、今日 / 自分、回転で選択が残る）。
  単体テスト 1179・lint は新しい警告なし。エミュレータでは未確認（開発サーバの `:8000` が M145 より前の main のため）。

### 24.6 M146 の iOS（2026-10-08）

§24.3 のとおり。サーバの変更なし。Markdown の編集は今のまま。

- **作成のシート**（`WikiNewPageSheet`）：題名・アイコンの下に `WikiTemplateChoices`（開くたびに `GET /wiki/templates`）。「白紙のページ」
  （最初に選ばれている）・「組み込み」（`builtins`、`hidden` は出さない）・「みんなのテンプレート」（`pages`）。選ぶと `POST /wiki/pages` に
  `template_key` か `template_page_id` と `tz`（端末の IANA のゾーン）。題名・アイコンを空欄にするとテンプレートのものになる。
  選び直すと `client_save_id` を作り直す（同じ選択の再送は同じ key）。
- **テンプレートから始める**：本文が空のページ（種類が `page`、テンプレートでない、編集できる、保存待ちが無い）の「まだ何も書かれて
  いません。」の下にボタン。白紙なしの同じ一覧から選び `apply-template`、答えの後に開いている `CanvasSaver` が読み直す（古い版を
  知っているので 304 にならない）。空でなければ 409 `wiki_page_not_empty` の文言。
- **行の ＋**（`WikiDatabaseScreen`）：テンプレートが無いデータベースは今までどおりのボタン。あれば Menu：「新規（既定の名前）」（何も
  送らない＝サーバが既定を使う）・「テンプレートから」の各テンプレート（`template_id`、既定は ★）・「白紙の行」（`blank: true`）・
  「テンプレートを開く」（行のテンプレートのページを開いて編集）。どれも題名のアラートの後に作る（文言は `WikiDbText.newRowMessage`）。
  カレンダーの日の値は今までどおり送り、テンプレートの値より勝つ。
- **今日 / 自分**：`WikiDb.text` は日付の `{"start": "@today"}`（`"@today"` も）を「今日」、人の `"@me"` を「自分」と出す。行の
  テンプレートを開いたときだけ、日付の編集に「今日（行を作る日）」、人の編集に「自分（行を作る人）」を足した（Desktop のマスと同じ値を書く）。
- **⋯「複製」**：ページと（編集できる）行、ゲストとデータベースには出さない。`POST …/duplicate {client_save_id}`（題名はサーバ）→
  写しを開き「複製しました」。ページで 403 `page_edit_restricted` なら「最上位に複製しますか？」→ 同じ key で `parent_id: null`。
  行の 403 はそのままエラー（行の写しはデータベースの外に置けない）。行の写しは `wiki.rows.changed` と同じ合図で一覧を読み直す。
- **テンプレートの帯**：`is_template`（`WikiPageItem.isTemplate`）で本文の上に帯（`WikiText.templateBanner`：ページ / 行で文言が違う）。
  ページのテンプレートには「このテンプレートでページを作成」（作成のシートを最初からそのテンプレートで開く）。テンプレートでは子ページの
  一覧と「子ページを作成」を出さない。`WikiTree` はテンプレートを持たない（`upsert`・変更のフィードでテンプレートになったページは木から外す）。
- 「テンプレートとして保存」「テンプレートを解除」・既定の切り替えは §24.3 に無いのでスマホには入れていない（パソコンで行う）。
- **テスト**：`WikiTemplateTests.swift`（13）：`GET /wiki/templates` とデータベースの `templates`・`default_template_id` の読み取り
  （古いサーバ・隠した組み込み・消えた既定）、要求の形（テンプレートからの作成・`apply-template`・複製の隣 / 最上位・行の既定 /
  テンプレート / 白紙）、帯と「複製」を出す規則、今日 / 自分の表示、新しい行の文言、木に入らない、ハブ（作成・403 から同じ key で
  最上位・再送で同じ写し・行の 403 はエラー・`apply-template` で本文を読み直す・409）、行の作成の key、ApiClient の経路。
  開発サーバ（:8000）は M145 より前の main なので、画面での確認はしていない。

## 25. M147 の実装（ビューの種類：サーバ・Desktop / Web、2026-10-08）

§22.4 のとおり。**移行なし**（ビューの設定は `wiki_databases.views` の JSON、カードの手での並びは行の `position`、ギャラリーの絵は
問い合わせのときに本文から読む）。新しいエラーコードは `wiki_invalid_move`（400）。`wiki_invalid_view` の文言にグループを足した。
新しいイベントは無い。

### 25.1 ビューの設定（`ViewIn` / `ViewOut`）

| 項目 | 値 | 意味 |
| --- | --- | --- |
| `type` | `table` \| `calendar` \| `board` \| `list` \| `gallery` | 新しい 3 つを足した |
| `group_by` | `{prop_id, date_unit: day \| week \| month \| null, hidden: [グループの鍵], hide_empty}` \| `null` | カレンダー以外のすべての種類で使える。ボードは**セレクト・ユーザー・チェック**だけ（値を書いて動かすため）。表・リスト・ギャラリーはさらにマルチセレクト・日付（作成・更新日時も）・作成者・更新者。`date_unit` は日付だけ（省くと日） |
| `cover` | `body` \| `none` | ギャラリーのカードの絵（本文の最初の画像 / なし） |
| `card_size` | `small` \| `medium` \| `large` | ギャラリーのカードの幅（180 / 240 / 320 px から） |
| `columns` | 今までどおり | **見せるプロパティはすべての種類で `columns`**（ボード・リスト・ギャラリーのカードも、古いスマホのカードもここを読む） |

- **グループの鍵**：セレクト・マルチの選択肢 id、user id、チェックは `"true"` / `"false"`、日付は日 `YYYY-MM-DD`・週は月曜の日付・月
  `YYYY-MM`、値の無い行は `""`（「なし」）。時刻つきの値（作成日時など）は問い合わせの `tz` の日（省くと UTC）。
- **グループの順**：セレクト・マルチは選択肢の順（行が無くても全部出す）、チェックはオフ → オン、人は名前の順（サイドバーと同じ
  日本語の名前順）、日付は古い順。「なし」は最後。`hide_empty` で行の無いグループを外す。
- **検査**（`dbschema.check_group`、400 `wiki_invalid_view`）：無いプロパティ・種類に合わないプロパティ・日付でない `date_unit`・
  カレンダーの `group_by`。プロパティを消すとそのビューの `group_by` は `null`（ボードは「列にするプロパティを選んでください」）。
  型の変更で使えなくなれば `null`、使えるまま型が変われば `hidden` を空にする。選択肢を消すと `hidden` からも外す。
- 権限は M144 のまま：ビューの作成・変更・削除は**編集**。閲覧の人も画面で変えて問い合わせられる（保存はしない）。

### 25.2 問い合わせとカードの移動（すべて `/api/v1`）

| メソッド | パス | 要点 |
| --- | --- | --- |
| POST | `/wiki/databases/{id}/query` | `RowQuery` に `grouped`・`group_by`・`covers`・`tz` を足した。`grouped: true` は `RowQueryOut.groups: [RowGroup {key, count, hidden}]`（すべてのグループ、隠したものも件数つき）と `row_groups`（`rows` と同じ長さの、各行のグループ）。複数の値（マルチ・人）の行はそのグループのすべてに 1 回ずつ。隠したグループの行は返さない（`total` は見せるグループの行の数）。ページ送りもこの並びのまま。`grouped: false` はグループなし。**省いたとき（M147 より前の端末）**は 1 行ずつ、ビューのグループの順に並べ、隠したグループだけの行を外す（重複しない。`groups` は null） |
| POST | `/wiki/rows/{id}/move` | `RowMove {set, before_id \| after_id, client_op_id}`（編集）。`set` は `PATCH …/props` と同じ検査と版（`kind = 'props'`、`client_op_id` で 1 回だけ）、並びは隣の行との間の新しい `position`（1 行だけ書く）。隣がゴミ箱・テンプレート・ほかのデータベースの行なら 400 `wiki_invalid_move`、テンプレートを動かすのも 400。両方 / どちらも無い要求は 422。並べるときはデータベースの行を `FOR UPDATE`（同じすき間に 2 つが落ちても同じ鍵にならない） |

- **カードの並び**は行の `position`（データベースで 1 つ）。並べ替えの無いビュー（表もボードも）はこの順なので、ボードで動かすと表の順も
  変わる（Notion と同じ）。ビューに並べ替えがあるとき、Desktop は列の中の手での並べ替えを止め、値だけ書く。
- **ボードでの値**：セレクトは列の選択肢（「なし」は消す）、チェックは列の状態、人は元の列の人を外して先の列の人を足す（「なし」は消す）。
- **ギャラリーの絵**（`covers: true`）：`RowOut.cover = {attachment_id, thumbnail, width, height}`。本文の最初の
  `![…](attachment:<id>)` が、**その行に付いた**（`attachments.page_id` が行）画像で `attached` のときだけ。PostgreSQL の
  `regexp_match` で返す行の分だけ読む。ほかのページの画像（写して貼ったもの）は出さない（その行のものではないため）。
- 性能（`tests/test_wiki_db_perf.py`、5,000 行、中央値）：ボード（セレクトで 1,000 枚）約 22 ms、週ごとのグループと絵 約 20 ms（目標 50 ms）。

### 25.3 Desktop / Web

- ビューの ＋ に「表・ボード・リスト・ギャラリー・カレンダー」。新しいボードは最初のセレクト（無ければユーザー、チェック）の列で、
  カードには最初の 3 つのプロパティ（列にしたものを除く）。列にできるプロパティが無ければ「ボード」は押せない（理由を出す）。
  新しいリスト・ギャラリーも最初の 3 つ。タブのアイコンは種類ごと。
- **「レイアウト」**（`DbViews.tsx` の `LayoutButton`）：グループ（ボードは「列にするプロパティ」）、日付のまとめ方（日 / 週 / 月）、
  「行のないグループを隠す」、表示するグループ（件数と目のボタン）、ギャラリーのカードの画像と大きさ。「プロパティ」の棒（並び・表示）は
  カレンダー以外のすべての種類に出す。変えたものは画面の下書きで、編集の人が「ビューを保存」。
- **ボード**：列ごとに名前（選択肢の札・人の顔と名前・オン / オフ）・件数・⋯（グループを隠す）・＋（その値で行を作って横に開く）。
  カードは題名と見せるプロパティ（空は省く）。ドラッグで別の列（値）と列の中の位置（並べ替えが無いとき。落とす所に線）。
  **キーボード**：カードの ⋯（Tab で届く、Enter で開く）に「◯◯へ移動」と「上へ」「下へ」。隠した列は右端の「隠したグループ」に
  件数つきで並び、目のボタンで戻す。閲覧の人にはドラッグ・⋯・＋ を出さない。画面はすぐ動かし、答えの後に読み直す。
  幅が足りなければ横にスクロール。
- **リスト**：1 行ずつ、題名と見せるプロパティ。**ギャラリー**：格子のカード、絵は見えたときに読む（`IntersectionObserver`）。
- **グループ**（表・リスト・ギャラリー）：グループごとの見出し（札・件数）を押すと閉じる / 開く（端末だけ、保存しない）。表では見出しの行。
  複数の値の行は各グループに出し、マスの編集はその行で開く。値を変えるとグループが変わりうるので読み直す。
- グループのあるビューは 1,000 行ずつ読む（ボードは列ごとの続きではなく全体の「さらに読み込む」）。研究室の ゼミ（約 200 行）は 1 回。
- i18n：`docs.db.board`・`list`・`gallery`・`layout`・`groupBy`・`unit.*`・`cover.*`・`size.*`・`moveTo`・`cardMenu` など（ja / en / zh-Hans）。

### 25.4 古いスマホと M148（スマホ）が使うもの

- **今のアプリは壊れない**（コードを読んで確かめた）。iOS は `DbView.type` を `String` で持ち（`decodeIfPresent`、知らない鍵は読まない）、
  `isCalendar` 以外はカードの一覧。Android は `DbView.type: String`、`Codec.snake` が `ignoreUnknownKeys`、`type != "calendar"` はカード。
  どちらも `grouped` を送らないので、ボードは「グループの順に 1 行ずつ、隠したグループの行を除いたカード」になる（重複する id が来ないので
  `LazyColumn` / `ForEach` の鍵もぶつからない）。カードのプロパティは `columns` の見せるものの最初の 3 つ（ボード・リスト・ギャラリーも
  `columns` に持つので、パソコンで選んだものが出る）。タブの名前は名前の無いビューで「表」になる（M148 で直す）。
- **M148 で作るもの**：問い合わせに `grouped: true`（と `tz`）を付け、`groups`・`row_groups` でセクションの見出し（名前は選択肢・人・
  チェック・日付から端末で作る、件数）。ボードはグループごとのセクションのカード、カードの ⋯「◯◯へ移動」で
  `POST /wiki/rows/{id}/move {set, client_op_id}`（値は §25.2 の規則、`client_op_id` は再送で同じ）。ギャラリーは `covers: true` と
  2 列の格子（`/attachments/{id}/thumbnail`）。リストは今のカード。名前の無いビューの名前（ボード・リスト・ギャラリー）。
  ビューの設定（`group_by` など）はスマホでは変えない（今どおり読むだけ）。`group_by.hidden` は送り返さないので気にしなくてよい。

### 25.5 設計からの違い（理由）

- §22.4 の `group_by_prop_id`（ボード）と `group_by`（表）は、`group_by {prop_id, date_unit, hidden, hide_empty}` 1 つにした
  （ボードの隠す列と表のグループが同じ形になり、リスト・ギャラリーにもそのまま使える）。
- §22.4 の「保存のときに `wiki_pages.preview_image_id` を覚える」はやめ、問い合わせのときに本文から読む（`covers: true` のときだけ）。
  本文を書く経路（保存・マージ・復元・テンプレート・複製・取り込み）すべてで列を合わせる必要がなく、ずれない。返すページ分の正規表現だけで
  目標の速さに入る。カバー画像（M152）・`files` 型は入れていない（`cover` に値を足せば同じ形で増やせる）。
- グループの開閉は保存しない（Notion は保存するが、共有のビューで人ごとに違うので端末だけにした）。

### 25.6 テスト

サーバ：`tests/test_wiki_db_views.py`（9）：ビューの設定の検査（種類ごとのグループの型・日付の単位・カレンダー・`hidden` の上限・
知らない種類は 422・M147 より前のビューは既定値で読める）、ボードのグループ（選択肢の順・空の列・「なし」・件数・隠す・`hide_empty`・
古い端末の並び・`grouped: false`・絞り込みの後・保存しない `group_by`・ページ送り・ボードのマルチは 400）、表のグループ（マルチは各
グループ・人の名前順・チェック・日 / 週 / 月・作成者・作成日時の `tz`）、純粋な関数（消えた選択肢は「なし」・タイムゾーン）、移動（値と
位置を 1 回で・前 / 後・`client_op_id` の再送で版は 1 つ・「なし」へ・自分の後・不正な値は 422・両方 / どちらも無い要求は 422）、
隣の検査（ほかのデータベース・テンプレート・ゴミ箱・ページ・テンプレートを動かす → 400 `wiki_invalid_move`）、権限（編集はビューを作り
動かせる・閲覧は読めるが 403 `page_edit_restricted`・読めない人は 404）、スキーマの変更の後（選択肢の削除・型の変更・プロパティの削除）、
ギャラリーの絵（最初の画像・ほかの行の画像は出ない・画像でないもの・`covers` が無ければ null）。`tests/test_wiki_db_perf.py` に 2 つ。
pytest 1485。
Desktop：`tests/dbViews.test.tsx`（16）：ボード（問い合わせの形・列と順・「なし」・件数・見せるプロパティ・タブ）、ドラッグで別の列
（値と `before_id`）、列の中（`after_id`）、並べ替えのあるボード（列の中は動かない・別の列は値だけ）、カードの ⋯ をキーボードで（移動・
上へ下へ）、列の ＋ と隠す / 戻す（下書きと問い合わせ）、閲覧の人、プロパティの無いボード、リスト、ギャラリー（`covers`・大きさ・絵を
読む・絵なし）、表のグループ（見出し・重複の行・閉じる）、レイアウトで日付の週にまとめて保存、規則（グループにできる型・ボードの値・
新しい行の値・置く場所・すぐ動かす並び・新しいビュー・差分）。vitest 2553。
ブラウザ（自分の uvicorn 8047 と使い捨てのデータベース、Vite 1422、ヘッドレス Chrome 9444）で、204 行のデータベース（セレクト・人・日付・
マルチ・チェック、16 行に画像）のボード（列・件数・ドラッグで別の列の先頭へ・カードの ⋯ を Enter で開く・レイアウトの表示するグループ）、
リスト、ギャラリー（本文の画像）、表のグループ（マルチで重複・閉じる）、狭い画面のボード（横にスクロール）、ダークのボード・ギャラリー・
グループを確かめた。

### 25.7 M148 の Android（2026-10-08）

§25.4 のとおり。サーバの変更なし。ビューの設定（グループ・隠すグループ・絵・大きさ）は読むだけ。

- **問い合わせ**（`WikiDbViews.queryOptions` / `queryBody`）：カレンダー以外のビューは `grouped: true` と `tz`（端末の IANA のゾーン）、
  ギャラリーは `cover` が `none` でなければ `covers: true`。`group_by` のあるビューは 1,000 行ずつ（無ければ今どおり 100 行）。
  `groups` が空・null（グループの無いビュー、M147 より前のサーバ）や `row_groups` の長さが合わない答えは今までどおりの一覧。
  `RowQuery` は知らない鍵を 422 にするので、M147 より前のサーバには新しいアプリから問い合わせられない（サーバを先に上げる）。
- **セクション**（`WikiDbViews.sections`）：`groups` の順に隠していないグループ（行の無いグループも見出しと「行はありません」）、
  件数は `count`。マルチ・人の行は各グループに出る（LazyColumn の鍵は「グループ + 行」）。見出しの名前（`groupLabel`）は選択肢の名前
  （消えた選択肢・`""` は「なし」）・人の名前・オン / オフ・日付（日・「◯◯ の週」・月）。セレクトは選択肢の色の札。見出しを押すと閉じる /
  開く（`DatabaseSession.collapsed`、ビューごと、端末のメモリだけ）。続きの読み込みは「行 + グループ」で重複を除く。
- **ボード**：グループごとのセクションのカード。編集（M144 の `edit` / `full`）で、列がセレクト・人・チェックのときだけカードの ⋮ に
  ほかの見せるグループへの「「◯◯」へ移動」。`POST /wiki/rows/{id}/move {set, client_op_id}`（位置は送らない＝行の位置のまま）、値は
  §25.2 の規則（`WikiDbViews.moveSet`：セレクトは選択肢 / 「なし」は null、チェックは列の状態、人は元の列の人を外して先の人を足す、
  「なし」へは null）。画面はすぐ動かし（件数も）、ネットワークの失敗は同じ `client_op_id` で送り直し（`CanvasRequests.sameKey`）、
  断られたら元に戻してエラーを出し、答えの後に読み直す。`group_by` の無いボードは「列にするプロパティがありません」。
- **ギャラリー**：2 列の格子のカード（4:3 の絵・題名・見せるプロパティの値）。絵は `RowOut.cover` の `thumbnail` なら
  `/attachments/{id}/thumbnail`、無ければ `…/content?inline=1` を縮めて読む（ほかの画像と同じくセッションで）。`cover: none` は絵なし。
- **リスト**・表：今のカード（グループがあればセクション）。**名前の無いビュー**は種類の名前（ボード・リスト・ギャラリー・表・カレンダー、
  知らない種類は表）。
- 文字列は `strings_docs_views.xml`（ja / en / zh-Hans）。行の作成の後、グループのあるビューは読み直す（新しい行のグループはサーバが決める）。
- **テスト**：`WikiDbViewsTest`（11：ビュー・答え・絵の読み取りと古いサーバ、名前の無いビューの名前、問い合わせの形（ボード・表・ギャラリー・
  絵なし・カレンダー）、セクション（順・隠す・空・マルチの重複・グループでない答え）、見出しの名前（選択肢・消えた選択肢・人・チェック・
  日 / 週 / 月・色）、移動の値と本文、移せる人とプロパティ、移動がすぐ出て同じ op id で送り直し読み直す、断られた移動が戻る・閲覧は送らない、
  人の列で先にもいるカード、閉じるのはビューごと・続きの重複・オフラインの写しのグループ）。単体テスト 1190・lint は新しい警告なし。
  開発サーバ（:8000）が M147 より前の main のため、エミュレータでは確かめていない。

### 25.8 M148 の iOS（2026-10-08）

§25.4 のとおり。サーバの変更なし（Android は §25.7）。

- **問い合わせ**（`WikiDatabaseModel.query`）：カレンダー以外でビューに `group_by` があり、そのプロパティが残っている（ボードはセレクト・
  人・チェックだけ）とき `grouped: true`・`tz`（端末のゾーン）・`limit: 1000`。ギャラリーで `cover` が `none` でなければ `covers: true`。
  グループの無い表は今までどおりの形（M147 より前のサーバにも同じ要求）。続きのページは `row_groups` も足す（グループの答えでは同じ行が
  別のグループにまた来るので、id で重ねない）。オフライン用の写し（`WikiDbKept`）も `groups`・`row_groups` を持つ。
- **見出し**（`WikiDb.groupName`・`WikiDbGroupHeader`）：セレクト・マルチは選択肢の札、人は顔と名前、チェックは「オン / オフ」、日付は日・
  「◯◯ の週」・「2026年10月」、`""` と消えた選択肢は「なし」。横に件数（`groups[].count`）。隠したグループ（`hidden`）は出さない。
  表・リスト・ギャラリーの見出しは押すと閉じる / 開く（端末だけ・保存しない）。ボードの見出しは閉じない。
- **ボード**：グループごとのセクションのカード（空の列は「カードはありません」）。編集できる人（M144 の `my_level` が編集以上）で
  オンラインのとき、カードの ⋯（と長押し）に見えている他の列への「「◯◯」へ移動」。`POST /wiki/rows/{id}/move {set, client_op_id}`
  （並びは送らない＝行の位置のまま）。値は `WikiDb.boardValue`（セレクトは選択肢・「なし」は null、チェックは列の状態、人は元の列の人を
  外し先の人を足す・「なし」は null）。画面はすぐ動かし（件数も）、`DbCellWriter.move` が通信の失敗だけ同じ `client_op_id` で再送、
  答えの後に読み直す。拒否（403 など）は読み直してエラーを出す。列のプロパティが無いボードは理由を出してカードの一覧。
- **ギャラリー**：2 列の格子（`LazyVGrid`）。カードの絵は 4:3 で、`cover.thumbnail` なら `/attachments/{id}/thumbnail`、でなければ
  `…/content?inline=1`（どちらも `fetchData` で認証つき、サムネイルが無ければ本体）。絵の無い行はアイコンか文書の印。題名と最初の
  2 つのプロパティ。グループがあれば見出しごとの格子。**リスト**は今のカード。
- **名前の無いビュー**：「ボード」「リスト」「ギャラリー」（「表」「カレンダー」は今どおり）。切り替えのアイコンも種類ごと。ビューの設定は
  読むだけ（今どおり）。
- **テスト**：`WikiDbViewTests.swift`（14）：ビューの設定・グループの答え・`cover` の読み取り（古いサーバの既定）、名前の無いビュー、
  見出しの名前（選択肢・人・チェック・日 / 週 / 月・なし）、セクション（複数の値・隠したグループ・空のグループ）、グループにする
  プロパティ（ボードのマルチ・消えたプロパティ・カレンダー）、ボードの値、ビューごとの問い合わせ（`grouped`・`tz`・`covers`）、移動
  （すぐ動く・再送で同じ `client_op_id`・「なし」・拒否は再送しない・人の列）、閲覧の人とリストは動かせない、オフラインの写し、
  `POST …/move` の形。開発サーバ（:8000）は M147 より前なので、画面は使い捨てのスナップショット（スタブの ApiClient、ボード・
  閲覧のダーク・ギャラリー・グループのリスト）で確かめた（テストには残していない）。

## 26. M149 の実装（方言：コールアウト・トグル・データベースの埋め込み、3 端末、2026-10-08）

§22.5 のとおり。移行 0109（検索の索引の式だけ）。API・イベント・エラーコードの変更なし（OpenAPI は変わらない）。

### 26.1 書き方の細かい決まり（`apps/shared/canvas_markdown.json` の `containers`、3 端末で同じ）

- 開き：`^:::[ \t]*(callout|toggle)(?:[ \t]+(.*?))?[ \t]*$`（キーワードは小文字だけ。`::: Callout`・`::: callouts`・
  `::: note` は文字）。行の残り（前後の空白を除く）がコールアウトのアイコン / トグルの見出し。空ならアイコンなし / 見出しなし。
  閉じ：`^:::[ \t]*$`。
- 閉じの探し方：開きの次の行から、開きで +1・閉じで −1 し 0 になった行。コードブロック（閉じの ``` がある ```）の中は飛ばす。
  閉じが無い開きは**文字の行**（中身はその行が無いものとして読む）。対になっていない `:::` も文字。
- 中身は上の段と同じ読み方（見出し・リスト・引用・コード・表・数式・タスク・画像・埋め込み）。タスク・画像・埋め込みの
  `line` は**本文全体の行**（チェックがそのまま本文のその行を書き換える）。
- 入れ子は 2 段まで（コールアウトの中のトグルは可）。3 段目の開きとその閉じは文字の行。囲みの開きの行と埋め込みの行は
  段落・リストを終わらせる。
- コールアウトの色（`tones`）：アイコンから U+FE0F を除いて引く。黄 💡 ⚠ ⭐ 🔔 ✨、赤 ❗ ‼ 🚨 ❌ ⛔ 🚫 🔥、緑 ✅ ✔ 🌱 👍 🎉 ⭕、
  青 ℹ 📝 💬 📌 ❓ 🔍 📘、ほか（カスタム絵文字・文字・なし）は灰。§22.5 に「種類の語」は無いので、色はアイコンだけで決める。
- 埋め込み：1 行だけの `![表示名](page:<uuid>#view=<ビューの id>)`。`#view=` は省略可（そのデータベースの最初のビュー）。
  ビューの id は `[A-Za-z0-9_-]{1,40}`、ページの id は大文字も可（小文字にして読む）。行の途中・`#row=` などは埋め込みではない
  （`[表示名](page:…)` はリンク、それ以外は文字）。**表示名は描かない**（読めない人に名前を漏らさないため、題名はいつも
  データベースの今の題名）。バックリンク（`wiki_links`）にはふつうのリンクと同じく入る。
- メッセージ（`canvas: false`）ではすべて文字のまま（§22.5 は方言＝キャンバスとページの本文の話。メッセージの書き方は増やさない）。

### 26.2 サーバ

- **検索**：移行 0109 で `wiki_pages_search_idx` と `canvases_search_idx` を作り直し、本文の式を
  `regexp_replace(body, MARKER_SQL || '|^:::[ \t]*(callout|toggle)(?=[ \t]|$)|^:::[ \t]*$', '', 'gn')` にした
  （`app/core/doctext/blocks.py` の `BODY_SQL`、`search/repository.py` の `page_document()` / `canvas_document()` も同じ式）。
  索引には中身とアイコン・トグルの見出しだけが入り、「callout」「toggle」では当たらない。SQL はコードブロックを区別しない
  （コードの中の `:::` 行も索引から外れるだけ）。グループを `(?:` にしないのは、alembic の `op.execute`（`text()`）が
  `:callout` をパラメータと読むため。
- **抜粋**：`blocks.reading_text(body)`（タスクの印と囲みの行を外す。コードの中は残す）を、ページ・キャンバスの検索の抜粋と
  メンションの抜粋（キャンバスの `_record_activity`、ページの `_excerpt`）に使う。AI はページ・キャンバスの本文を読まない
  （メッセージだけ）ので変更なし。Markdown の書き出し（§4.7）は方言のまま。
- **取り込み**（`importer/notion_export.py`）：`<aside>` → `::: callout <アイコン>`（最初の行がアイコンなら。中身の前後の空行を
  除く）、`<details>`＋`<summary>` → `::: toggle <見出し>`（中身は字下げしない）。3 段目の囲みとその中は前の書き方（引用 /
  箇条書き）で、レポートには「コールアウト（3 段目の入れ子）→ 引用」「トグル（3 段目の入れ子）→ 箇条書き」だけを数える。
  アイコンの判定 `is_icon()`：1〜4 文字、ASCII を含まず、記号（Unicode の So と ‼ ⁉ ℹ 〽）を 1 つ以上含む
  （以前の判定では「注意」のような短い日本語もアイコンになっていた）。取り込みをもう一度実行すると、取り込んだあと誰も
  変えていないページは `_overwrite` で新しい書き方に変わる。
- **`app.cli wiki-rewrite-callouts --actor <管理者> [--dry-run]`**：取り込みが引用で書いたコールアウト（引用の連続で、最初の
  行が `> <アイコン>` か `> <アイコン> 文`）を `::: callout` に書き換える。`> > <アイコン>` は入れ子のコールアウト（2 段まで）。
  コードブロックの中・アイコンで始まらない引用は触らない。対象はページと行（テンプレートも）で、**最新の side でない版が
  `import` で head、題名と本文がその版と同じ**ページだけ。取り込みの後に編集されたページ・ゴミ箱のページ・書き換えると
  長さの上限を超えるページは報告だけ。実行中に保存されたページは木のロックと行のロックの下で確かめ直し、編集されたものと
  して残す。書き換えたページごとに `import` の新しい版（version＋1、親は前の head、作者は `--actor`）とページの更新・
  `wiki.page.updated`。実行ごとに監査 `wiki.callouts_rewritten`（`{pages, edited, trashed}`）。冪等（2 回目は何もしない）。
  `--dry-run` は何も書かない。トグルは取り込みでは箇条書きと区別できないので書き換えない。
  - 本番（**未実行**、利用者が実行する）：
    `docker compose -f docker-compose.yml -f docker-compose.prod.yml exec app python -m app.cli wiki-rewrite-callouts --actor <管理者> --dry-run`
    で一覧を見てから `--dry-run` を外す（`deploy.conf` の `EXTRA_COMPOSE_FILES` があれば `-f` を足す。infra/README.md）。

### 26.3 Desktop / Web

- `markdown.ts`：`parseBlocksWithLines` の中身を `readBlocks(lines, begin, depth, canvas)` に分け、囲みの中は閉じまでの行
  （`lines.slice(0, close)`）を開きの次の行から同じ関数で読む（行番号が本文全体のまま、中から外を読まない）。ブロックに
  `callout {icon, tone, blocks, line}`・`toggle {title, blocks, line}`・`embed {label, pageId, viewId, line}`。スクロールの
  同期では囲み全体が 1 つのブロック。
- `CanvasBody.tsx`：コールアウトは色付きの枠とアイコン（`:name:` はカスタム絵文字の画像）、中は同じ描き方（タスクはその行を
  チェック）。トグルは `<details>`（閉じて始まり、キーボードでも開く。開閉は画面の中だけ）。埋め込みは `DatabaseView` の
  `embed` モード：名前の付いたビューだけ（タブ・ビューの追加は出さない）、**最大 10 行**（`EMBED_ROWS`。カレンダーは月の分）、
  見出しにデータベースの今の題名（`PageLinkChip`、押すと開く）とビューの名前、下に「すべて表示」（データベースを開く）。
  行は横のペインではなく行のページとして開く。セルの編集・行の追加・並べ替えなどはデータベースのページと同じ権限。
  読めない（ツリーの解決が null、404 / 403）・データベースでない場合は「アクセスできないページ」の枠（表示名もデータベースの
  名前も出さない）、読めるふつうのページならそのリンク。メッセージの `BlockView` には色だけの簡単な描き方を足した（ふだんは
  通らない）。色は styles.css の `.callout[data-tone]`（`--warning`・`--danger`・`--success` と青を背景に混ぜる。ダークでも同じ式）。
- `/` メニュー：「コールアウト」（`::: callout 💡` と空の行と `:::`、カーソルは中）、「トグル」（`::: toggle ` の後にカーソル、
  空の行と `:::`）、「データベースを作って埋め込む」（§22.5：今までの「データベース」。子のデータベースを作り、最初のビューの
  埋め込みを `/` の行に入れる）、「データベースを埋め込む」（`![[` を入れ、`[[` の候補をツリーのデータベースだけにし、選ぶと
  最初のビューの埋め込みを 1 行で入れる。`![[` を手で打っても同じ）。閉じの `:::` の後ろに文字が続くときは改行を足す
  （閉じは 1 行でなければ閉じにならないため）。
- エディタは Markdown のまま（見たまま編集は M150）なので、新しいブロックは編集しても文字のまま残る。
- i18n：`docs.slash.callout`・`toggle`・`embedDatabase`・`docs.embed.showAll`・`docs.embed.label`・`canvasBody.toggleUntitled`
  （ja / en / zh-Hans）。`docs.slash.database` は「データベースを作って埋め込む」に。

### 26.4 Android

- `BodyTokenizer.kt` に Desktop と同じ形の `readBlocks`（`lines.subList(0, close)`）と `Callout`・`Toggle`・`Embed`、
  `CalloutTone`。`CanvasContainers.kt`（新規）：`CalloutBox`（色はライト / ダークで別の淡い色、アイコンは本文の行内の
  描き方なのでカスタム絵文字も出る）、`ToggleBox`（シェブロンと見出し、閉じて始まる。`rememberSaveable(line)` で端末の中だけ、
  役割はボタン・状態の説明「展開中 / 折りたたみ中」）、`EmbeddedDatabase`（`wikiDatabase` と `queryRows(id, ビュー, limit 5)`。
  題名は wiki の題名（表示名は使わない）、ビューの名前（名前の無いビューは種類の語）、最初の 5 行（最初の見せるプロパティの値つき）、
  「開く」と行を押すとそのページ。読み込み中は 168dp の枠、401 / 429 以外の 4xx は「アクセスできないページ」だけ、オフライン
  などは「データベースを読み込めませんでした」と「開く」。画面の間だけの小さなキャッシュでちらつかない）。
- `CanvasBody.kt` は囲みの中を同じ描き方で描く（チェック・画像・「タスクにする」も中で動く）。囲みの中の見出しにはセクション
  編集のボタンを出さない（セクションが `:::` をまたぐため）。目次で囲みの中の見出しを選ぶとその囲みへスクロール。
- ツールバー（キャンバス / ページの編集）に「コールアウト」（電球）と「トグル」をチェックの後に足した（チェックと見出しは既にあった）。
  選択があればその行を包み、無ければカーソルの行が空ならそこに、そうでなければその下に入れる（`CanvasText.kt` の
  `insertCallout` / `insertToggle`）。
- 文字列は `strings_docs_blocks.xml`（ja / en / zh-Hans。データベースの画面の文字列とぶつからないよう別のファイル）。

### 26.5 iOS

- `MessageBodyView.swift` の `BodyTokenizer`：`parseLinedBlocks` の中身を `linedBlocks(lines, from:, to:, canvas:, depth:)` に
  分け、囲みの中は開きの次の行から閉じの前の行までを同じ関数で読む（行番号は本文全体のまま。コードブロックの閉じ・数式の
  探索・表・リスト・引用も `to` の手前で止まる）。`BodyBlock` に `callout(icon, tone, blocks)`・`toggle(title, blocks)`・
  `embed(label, pageId, viewId, line)`、中のブロックは行つきの `BodyLinedBlock`。`CalloutTone`（`tones` の表、U+FE0F を除いて
  引く）。行内のリンクは `page:` / `attachment:` の後が 36 文字の id のときだけにした（Desktop と同じ。`[x](page:12345)` や
  `#row=1` 付きは文字。以前は何でもリンクの形になり、押しても開けなかった）。メッセージの `page:` のリンクの扱いは今までどおり。
- `CanvasBodyView.swift`：描き方を `CanvasBlocksView` に分け、囲みの中も同じもので描く（チェック・画像・「タスクにする」も中で
  動く。中の見出しにはセクション編集のボタンを出さない）。コールアウトは色の淡い角丸の枠（`Color.yellow` などの不透明度で、
  ライト / ダークとも同じ式）と左のアイコン（`:name:` はカスタム絵文字の画像）。トグルはシェブロンと見出しのボタン、閉じて
  始まる。開閉は画面の `@State` だけ（本文にも端末の保存にも書かない）、VoiceOver はボタンで値は「展開中 / 折りたたみ中」。
  目次で囲みの中の見出しを選ぶとその囲みへスクロール（`CanvasBodyView.anchorLine`。閉じたトグルの中は描かれないため）。
- 埋め込み（`CanvasEmbedView`）：`wikiDatabase` → ビュー（無ければ最初）→ `queryRows(limit: 5)` のカード。題名は木の題名と
  アイコン（`linkState`。表示名は描かない）、ビューの名前（名前の無いビューは種類の語）、最初の 5 行（行のアイコン・題名・
  最初のカードのプロパティの値）、「開く」でデータベース、行を押すとその行のページ。401 / 429 以外の 4xx（`ApiError.isRefused`）と
  木が読めないと言うページは「アクセスできないページ」だけ。通信の失敗は出ている行をそのまま、無ければ「データベースを
  読み込めませんでした」と「開く」。読み込み中は 132pt の枠。
- ツールバー（`CanvasEditor`）：チェックリストの後に「コールアウト」（電球）と「トグル」。`CanvasText.insertCallout` /
  `insertToggle`（Android と同じ：選択の行を包む。無ければカーソルの行が空ならそこ、そうでなければその下。カーソルはコール
  アウトなら中、トグルなら見出しの位置）。
- 文字列（ja / en / zh-Hans）：「コールアウト」「トグル」「行がありません」「読み込み中」。

### 26.6 テスト

- サーバ：`tests/test_wiki_callouts.py`（17）：取り込み（アイコンあり / なし / 文字・ASCII の最初の行、`<details>` の見出しの
  あり / なし、2 段の入れ子とその先の前の書き方、コードの中と前後、`is_icon`）、書き換え（単純・リスト入り、触らない引用
  （アイコンで始まらない・ASCII の語・「…」・リスト・コード）、入れ子と冪等、新しい取り込みの出力は変わらない、コールアウトの中の
  コード）、CLI（`import` の版・親・行数・監査・outbox、編集されたページは報告だけ、`--dry-run`、2 回目は何もしない、管理者で
  ない人は断る、`--actor` は必須）、検索（ページとキャンバス：題名・トグルの見出し・中の語で当たり、「callout」「toggle」では
  当たらない、抜粋に `:::` が無い）、`reading_text`、移行の式と `BODY_SQL` が同じ。`test_notion_import.py` の 2 つの期待を
  囲みに。pytest 1502、ruff・ruff format・mypy は通る、`export-openapi` の差分なし。
- Desktop：`tests/canvasMarkdown.test.ts` に `containers` の 20 ケースと色・スクロールの同期の範囲、`tests/docBlocks.test.tsx`（12）：
  コールアウト（色・アイコン・中のブロック）、トグル（閉じて始まる・中のタスクが本文の行をチェック）、入れ子と `data-line`、
  メッセージは文字のまま、埋め込み（名前のビュー・`limit: 10`・タブが無い・「さらに読み込む」が無い・「すべて表示」で開く）、
  読めない埋め込み・読み込みに失敗した埋め込みは表示名を出さない、ふつうのページはリンク、`/` の 3 つの項目、`![[` で
  データベースだけを引いて埋め込みを入れる、「データベースを作って埋め込む」。vitest 2587、tsc・vite build は通る、`gen:api` の差分なし。
  ブラウザ（自分の uvicorn 8047 と使い捨てのデータベース、Vite 1422、ヘッドレス Chrome 9444）で、色の 5 種類、コールアウトの中の
  リスト・引用・コード・トグルとタスク、閉じたトグル、12 行のデータベースの埋め込み（10 行と「すべて表示」）、読めない埋め込み、
  閉じていない囲み、ダーク、編集の `/` メニューを確かめた。
- Android：`CanvasMarkdownTest`（`containers` の全ケース・色の表・ツールバーの挿入）。`:app:testDebugUnitTest` 1182、
  `:app:lintDebug` は新しい指摘なし、エミュレータ（ChikuwaChat_Pixel_9）で描画を確かめた。
- iOS：`CanvasTests` の `testContainersAndEmbeds`（`containers` の全ケースを共通の JSON から）・`testCalloutTones`（色の表、
  U+FE0F の有無）・`testTickingInsideContainers`（トグルの中のタスクが本文の行をチェック、目次の行き先）・`testEmbedFailures`
  （拒否と通信の失敗）・`testCalloutAndToggleEdits`（ツールバーの挿入）。全体 1156（6 は skip）が通る。描画はライト / ダークの
  使い捨てのスナップショット（色の 5 種類・入れ子・閉じたトグル・閉じていない囲み・埋め込みのカード / 読めない / 読み込めない）
  で確かめた（テストには残していない）。

## 27. M150 の実装（見たまま編集・第 1 段：Desktop / Web、2026-10-08）

§22.6 のとおり。保存の形は Markdown のまま（D24・D27 は変わらない）。移行 0110（`users.docs_editor_mode`）。API は
`PATCH /users/me` と `UserMe` に `docs_editor_mode`（`wysiwyg` | `markdown` | null）が増えただけ（OpenAPI を再生成）。
イベント・エラーコードの変更なし。キャンバスは §22.10 のとおり Markdown のエディタのまま（同じ部品を後で使える）。

### 27.1 部品

| ファイル | 役目 |
| --- | --- |
| `ui/pageMarkdown.ts` | 純粋な関数。本文 → エディタの文書（`pageToDoc`）、文書 → 本文（`serializePage`）、マージの差分（`changedRange`）、リストの印（`listRun`） |
| `ui/pageEditorSchema.ts` | TipTap のノード・マーク・キー・入力の変換、リストの印のプラグイン、元の文字列の表（`SourceMap`） |
| `ui/pageEditorDoc.ts` | 本文の読み込み、マージの差し替え（`applyMerge`）、カーソルの行（モードの切り替え） |
| `ui/PageEditor.tsx` | React の部品（遅延読み込み、独自のチャンク）。保存の状態機械への受け渡し、`/`・`[[`・`@` のメニュー、画像・表・アイコン・リンク |
| `DocPage.tsx`・`CanvasEditor.tsx`・`Settings.tsx`・`state/app.ts`・`prefs.ts` | 「見たまま / Markdown」の切り替え（ページの見出しと設定）、カーソルの行の受け渡し |

`richMarkdown.ts`（入力欄のリッチ入力）の行内の書き出しをキャンバスの方言（`page:`・`attachment:` のリンク）とインラインの
アトム（メンション・ページのリンク・絵文字）に広げて共有する（§22.6 の「`richMarkdown.ts` を広げる」）。マーク（太字・斜体・
取り消し線・コード・数式・リンク）は `RichEditor.tsx` のものをそのまま使う。

### 27.2 往復の不変条件（保証とテスト）

- **元の文字列**：読み込むとき、すべてのブロックに読んだときの文字列 `src` と、その後の改行 `eol`（`\n`・`\r\n`・`\r`、末尾は空）を
  持たせる。書き出しのとき、読んだときのままのノード（エディタでは ProseMirror の `eq`、まず同一のオブジェクトかどうか）は
  `src` をそのまま書く。**開いて閉じただけなら本文は 1 バイトも変わらない**（改行の種類・字下げ・`*` の箇条書き・`1. 1. 1.`・
  曲がった引用符・U+FE0F・隠れたタスクの印 ` <!--task:…-->` も）。
- **細かさ**：段落は本文の 1 行が 1 ノード（空の段落 = 空行。入力欄のリッチ入力と同じ）。見出し・箇条書き・番号・チェックは
  1 行ずつ（リストの 1 項目を直しても他の行はそのまま）。引用・コード・数式・表・画像・埋め込み・区切り線は 1 ノード。
  コールアウト・トグルは開きの行・閉じの行と中のブロックを 1 つずつ（アイコン / 見出しが変わらなければ開きの行もそのまま）。
- **リストの行**：書き直す行の字下げと番号は、レンダラーの読み方（`listItems`、apps/shared/lists.json）を前の行から
  たどって決める。そのままの行も、そこで同じ段・同じ番号に読まれるときだけ `src` のまま（そうでなければ書き直す）。
- **正規の形**：書き直したブロックは方言の正規の形（`- `、`1. `、`- [ ] `、2 文字ずつの字下げ、`**太字**`・`_斜体_`、
  行内はレンダラーの字句解析で読み戻して同じになる最小の `\` だけ）。ブロックに読まれてしまう段落の行（`# `・`- `・`> `・
  ``` ``` ```・`$$`・`---`・`:::`・`![…](attachment:…)` など）は先頭にゼロ幅スペース。区切り線の前後の空行、表の後の
  `|` を含む行の前の空行、表の区切りに見える行のゼロ幅スペースは、つなぐところで足す。
- **書けないもの**：正規の形で読み戻すと別のものになるブロック（`` ` `` が続くコード、`)` で終わる裸の URL など、
  読み込み時に確かめる）は**生の Markdown のブロック**（点線の枠、文字のまま編集）として残す。消さない。
- **テスト**（`tests/pageMarkdown.test.ts`・`pageEditorSchema.test.ts`）：apps/shared のすべての JSON の文字列（3,140）・
  リポジトリの Markdown 88 ファイル（docs/ と website/、`\r\n`・`\r` に変えたものも）・方言の部品から作った 3,000 の本文で
  バイト単位で一致。エディタのスキーマを通しても（全フィクスチャと docs/）一致。正規の形は 1 回目以降変わらず、元と同じ
  ブロックに読まれる。ブロックの種類ごとの編集（段落・見出しの段・太字・リストの 1 項目・Enter と Tab・番号の追加・チェックと
  隠れた印・項目の途中の Enter で印が前半に残る・引用・コード・数式・表・コールアウトの中・トグルの見出し・メンション / ページの
  リンク / 絵文字の行・削除・元に戻す / やり直し）がその行だけを書き換える。本番の全本文での確認（§22.6 (3)）は未実施（手元の
  コピーで `pageMarkdown.test.ts` の corpus に足して実行する。リポジトリには入れない）。

### 27.3 保存とマージ

- 入力が 300 ms 止まると Markdown に書き出して今の保存の状態機械（`CanvasSaver`）の `edit` に渡す（その先の 2 秒の待ち・
  マージ・版・衝突・再送は Markdown のエディタと同じ）。フォーカスが外れたとき・⌘S・モードの切り替え・閉じるとき・
  ウィンドウが隠れるときはすぐ書き出す。書き出した本文が手元と同じなら何も渡さない。
- 保存の結果やほかの人の版で本文が替わったとき（`textRevision`）は、トップレベルのブロックを前と後ろから `src` で比べ、
  **変わったブロックだけ**差し替える（元に戻す履歴に入れない、選択は差し替えをまたいで写す、触っていないノードとその
  埋め込みの表示は残る）。差し替えた結果が本文と一致しないとき（隣の行で字下げが変わるリストなど）は文書全体を差し替える。
- IME の変換中と、書き出し待ちの編集があるあいだは差し替えない（`canReplace`）。状態機械はその本文を次の保存の基にし、
  サーバがもう一度マージする。変換が終わると読み直しを頼む（`compositionEnded`）。

### 27.4 編集

- `/`（行のどこでも、空白の後）：Markdown のエディタと同じ項目（見出し・リスト・チェック・引用・コールアウト・トグル・表・
  コード・数式・区切り線・画像・ページへのリンク・子ページ・データベースを作って埋め込む・データベースを埋め込む）。囲みが
  2 段のところではコールアウト・トグルを出さない。`[[`：ページを選ぶとページのリンクのチップ（`[題名](page:id)`）。`![[`：
  データベースを選ぶと最初のビューの埋め込み。`@`：人とグループ（`<@id>`・`<@group:id>`）。上下・Enter / Tab・Esc。IME の
  変換中は反応しない。
- 打ち方の変換：`# `〜`### `、`- ` / `* `、`1. `、`[] ` / `[x] `（箇条書きの中でも）、`> `、``` ``` ```、`---`、`$$ `、
  `**x**`・`_x_`・`` `x` ``・`$x$`・`[文字](https://…)`、`:名前:`（知っている絵文字）。
- リストは平らな行（`listLine`：種類と段 0〜2、チェックは 0〜1）。Enter で同じ種類の次の行（チェックは未完了、隠れた印は
  前の行に残る）、空の行で Enter / 行頭で Backspace は段を上げてから段落に、Tab / Shift+Tab は段（前の行の次の段まで）。
  印（• ◦ ▪、1. a. i.）はレンダラーと同じ数え方で、構造が変わったときだけ要素に書く（ノードの装飾にしないのは長いページで
  1 打鍵ごとに数千の装飾を比べることになるため）。
- コールアウトはアイコンのボタン（絵文字のピッカー、カスタム絵文字も）と中のブロック、トグルはシェブロン（開閉は画面の中だけ。
  読んだトグルは閉じて、作ったトグルは開いて始まる）と見出しと中のブロック。中の最後の空行で Enter すると囲みの外へ。
- 埋め込みは閲覧と同じ `DatabaseView`（その中の操作はそのまま効く）、表は描いたまま（「表を編集」で今の表の編集画面、完了で
  その表の行だけ書き換える。マスの直接編集は M151）、画像は貼り付け・ドロップ・ツールバー / `/` で選んでアップロード、
  数式は TeX を文字で編集して下に KaTeX の描画、行内の数式は `$…$` のまま色付き（クリックで TeX の編集は M151 以降）。
- 貼り付け：文字はページの Markdown として読む（ブロック・マーク・リンク）。HTML（Web ページ・Word・Google ドキュメント）は
  見出し・段落・太字など・リンク・コード・引用と、入れ子の `ul` / `ol`（チェックボックスつき）を平らなリストの行にして
  読む（表などはその文字）。ファイルは画像だけ。コピーは選んだ範囲の Markdown を文字として載せる。
- ツールバー：見出し 1〜3、太字・斜体・取り消し線、箇条書き・番号・チェック・引用・コード、リンク（URL の欄、⌘K）、
  メンション・区切り線・表・画像。元に戻す / やり直しは ⌘Z / ⌘⇧Z（差し替えたマージは履歴に入らない）。

### 27.5 モード（§22.8 R1）

- `users.docs_editor_mode`：null（選んでいない）= 見たまま。設定の「ドキュメントの編集」とページの見出しの「見たまま /
  Markdown」で切り替え、別の端末へは `user.updated` で揃う（composer_mode と同じ。古いサーバでは画面の中だけ）。
- 切り替えは書き出し待ちを先に渡し、カーソルの行を持ち越す（見たまま → Markdown はそのブロックの最初の行、Markdown →
  見たままはその行を含むブロックの先頭）。切り替えだけでは保存しない（テストとブラウザで版が変わらないことを確かめた）。
  Markdown のモードは今の 2 列（エディタ + プレビュー）のまま。「閲覧 / 編集」は残す。

### 27.6 性能（M5 Max の開発機、ヘッドレス Chrome、本番のビルド `vite preview`）

- 10 万文字のページ（4,947 ブロック、うち 1,500 行ほどのリスト）：「編集」から描画まで 2 回目以降 0.14 秒（長いタスク 64 ms と
  59 ms）、チャンクを初めて読むときは 0.6 秒（長いタスク 182 ms 1 回）。読み込みと書き出しの関数は 14 ms（vitest で 1.5 秒未満を確かめる）。
- 打鍵：20 文字すべて次のフレームまで 13〜18 ms（60 Hz の 1 フレーム）、書き出しの間も 50 ms を超えるタスクなし。最初の作りでは
  リストの印をノードの装飾にし、既製の Placeholder が毎回文書全体をたどって 1 打鍵 45 ms かかったので、要素への書き込みと
  カーソルの行だけのプレースホルダに替えた。
- チャンク：`PageEditor` 50.9 kB（gzip 16.5 kB）。TipTap 本体は入力欄のリッチ入力と共有の `RichEditor` チャンク（368 kB、gzip 117 kB）。
  メインのバンドルには入らない（読み込み中は閲覧と同じ描画を出す）。

### 27.7 テスト

- `tests/pageMarkdown.test.ts`（20）：§27.2 の往復・正規の形・読み方・1 ブロックの編集・10 万文字。
- `tests/pageEditorSchema.test.ts`（38）：本物の TipTap（jsdom）で、全フィクスチャと docs/ の往復、ブロックの種類ごとの編集、
  打ち方の変換、元に戻す / やり直し、Markdown と HTML の貼り付け、マージの差し替え（触っていないノードがそのまま、選択も）。
- `tests/pageEditor.test.tsx`（12）：ページの画面と偽の wiki サーバ（`wikiFixtures.ts` にマージする版を足した）で、既定が
  見たまま・開いて閉じても保存しない・編集はその行だけ保存・Markdown との往復（バイト・カーソルの行・設定）・サーバの
  マージが入る・IME の変換中は差し替えない・`/`（見出し・コールアウト）・`[[`・`@`・Esc・設定・HTML のリストの平らにし方。
  `docsUi.test.tsx` の Markdown のエディタのテストは Markdown を選んだ人として。
- サーバ：`tests/test_docs_editor_mode.py`（設定と解除、検証、ほかの人には見えない）。
- ブラウザ（自分の uvicorn 8047 と使い捨てのデータベース、Vite 1422、ヘッドレス Chrome 9444）：コールアウト（中のリスト）・
  トグル（中のコールアウト）・チェック・番号の入れ子・引用の中のリスト・表・数式・データベースの埋め込み・コード・メンション・
  ページのリンク・絵文字をライト / ダークで、`/` と `[[` のメニュー、IME の変換（`Input.imeSetComposition`）、アイコンの
  ピッカー、表の編集画面、Markdown との切り替え。保存された本文の差分は編集した行だけ。

### 27.8 制限（M151 以降）

- 行内の数式は `$…$` の文字のまま（KaTeX の描画とクリックでの編集は M151）。表は編集画面だけ（マスの直接編集は M151）。
- ブロックのハンドル・ドラッグ・⌘⇧↑↓・＋ でブロック・⌘K のページは M151（⌘K は今はリンク）。
- 空行は 1 行ぶんの高さ（閲覧では詰めた段落の間）。見出しの直後などで閲覧と高さが少し違う。
- 生の Markdown のブロック・コードの中で ``` ``` ``` の行を打つ・3 段目の囲みを貼る、などは書き出しで文字になる（壊れはしない）。
- 見出し・コード・数式への打ち方の変換と `/` での型の変更は、その行の後の改行を `\n` にする（`\r\n` の本文でだけ違いが出る）。
- 中の行の `src` を持たない引用は、1 行直すと引用全体を正規の形で書く。
- 本番の全本文での往復の確認（§22.6 (3)）は未実施。

M151（§28）で解いたもの：行内の数式（KaTeX の描画とクリックでの編集）、表のマスの直接編集、ブロックのハンドル・ドラッグ・
⌘⇧↑↓・＋ でブロック、⌘K のページ、Notion・Word・Google ドキュメントの HTML の貼り付け（表・コールアウト・トグル・
Word のリスト）。3 段目の囲みの貼り付けは、いちばん内側の枠を外して中のブロックを残すようにした。残りは §28.8。

## 28. M151 の実装（見たまま編集・第 2 段：Desktop / Web、2026-10-08）

§22.6 の M151 の部分。保存の形は Markdown のまま（D24・D27 は変わらない）。サーバ・移行・API・イベント・エラーコード・
スマホの変更なし。新しい依存なし（TipTap の表の拡張は使わず、マスが 1 行の行内だけを持つ自前のノードにした：GFM の
マスは改行を持てず、既製の表はマスにブロックを入れるため）。§27.2 の不変条件（開いて閉じただけなら 1 バイトも変わらない、
触っていないブロックは `src` のまま、正規の形は冪等）は新しい部品でもそのまま守り、それぞれテストで固定した。

### 28.1 部品

| ファイル | 役目 |
| --- | --- |
| `ui/pageEditorBlocks.ts` | ブロックの単位（ブロックと、リストの行ならその下の深い行）、移動・複製・削除・下に行、⌘⇧↑↓ の行き先、置けるところ（囲みは 2 段まで） |
| `ui/pageEditorTable.ts` | 表のマスの位置、Tab / Shift+Tab / Enter / Shift+Enter のマスの移動、行と列の追加・削除・揃え、行の幅を見出しに揃えるプラグイン |
| `ui/pagePaste.ts` | 貼り付けた HTML を、エディタのスキーマが読む形に直す（純粋な DOM の処理、§28.5） |
| `ui/pageMarkdown.ts` | 表をマスから GFM に書く（`tableText`）、動かしたブロックが新しい場所で同じに読まれるかの判定（`readsAsShown`） |
| `ui/pageEditorSchema.ts` | 表・行・マスのノード、行内の数式のアトム（`inlineMath`）、⌘⇧↑↓・表のキー |
| `ui/PageEditor.tsx` | ⋮⋮ と ＋ のハンドル、ドラッグと落とす線、ハンドルのメニュー、表の道具、数式の TeX の箱、⌘K の箱（URL とページの検索） |
| `ui/richMarkdown.ts` | ページのエディタでは `$…$` を行内のアトムとして読み、書く（入力欄のリッチ入力は今のままマーク） |

### 28.2 ブロックの移動

- **ハンドル**：ポインタの下のブロック（ページ・コールアウト・トグルの直下のブロック。引用・表・トグルの見出しはそれを
  持つブロックごと）の左に ＋ と ⋮⋮ を出す。リストの行は印の左。打鍵と文書の変更で消え、ポインタを動かすとまた出る。
- **ドラッグ**：⋮⋮ を押して 4 px 動かすと始まり、落とす先を線で示す（ブロックの上半分なら前、下半分なら後ろ）。コールアウト・
  トグルの中へも外へも動かせる。置けない先（自分の中、囲みが 3 段になるところ、トグルの見出しの前）は、それを持つブロックの
  前後を探す。リストの行はその下の深い行（子）と一緒に動く。
- **メニュー**（⋮⋮ のクリック）：変換（テキスト・見出し 1〜3・箇条書き・番号・チェック・引用・コールアウト・トグル・コード・
  数式。行の種類のブロックだけ、囲みが 2 段のところではコールアウト・トグルを出さない）・複製・上へ移動・下へ移動・削除。
  ↑↓ で選べる。複製は正規の形で書く（チェックの隠れた印は元にだけ残す：同じタスクを 2 つの行が指さないように）。
- **＋**：ブロックの下に空の行を足し、`/` を入れてメニューを開く（空の段落ならその行で）。
- **⌘⇧↑ / ⌘⇧↓**（Windows / Linux は Ctrl+Shift）：カーソルのブロック、または選んだ範囲のブロック（両端を持ついちばん深い
  囲みの中で）を 1 つずつ動かす。隣がリストの項目ならその子ごと飛び越え、囲みの端では外へ出る。カーソルは一緒に動く。
- **元の文字列**：動かしたブロックは同じノードのまま（ProseMirror の `eq`）なので `src` を書く。ただし動かした先の囲み
  （ページ・コールアウト・トグル）の全ブロックを書き出して読み直し、見えているとおりに読まれないとき（`:::` の行が
  上の開きと組になる、`$$` の 2 行に挟まれて数式になる、など）は、動かしたブロック → その中のブロック → 両隣の行 →
  囲み全体、の順に正規の形にしていく。判定は種類・文字・リストの描かれる段と番号で比べる（空行は除く）。
- **リスト**：浅い行の下へ動かしたリストは、最初の行を前の行の 1 段下まで（リストの外なら 0 段）上げ、子も同じだけ上げる。
  番号と字下げは §27.2 の `listRun` / `listItems` のとおり書き直す（印の `1.` のまま読まれる行は `src` のまま）。
- **つなぎ**：区切り線の前後と表の後の空行は §27.2 のとおり。引用が 2 つ隣り合うと 1 つに読まれるので間に空行を入れる。
  見出しが区切りの行に見える表を `|` を含む行の下に置くときは空行を入れる（その行が見出しに読まれないように。M151 で
  `joinEmitted` に足した。読んだままの本文では起きない）。
- **元に戻す**：移動は 1 つの取引で、⌘Z 1 回で元のバイトに戻る（ブラウザでも確かめた）。

### 28.3 表のマスの直接編集

- 表は行とマスのノード（`table` > `tableRow` > `tableCell`）。マスは 1 行の行内（マーク・リンク・メンション・ページの
  リンク・絵文字・行内の数式）。最初の行が見出し（閲覧と同じく太字の背景）。列の揃えは各マスの属性で、見出しのマスの
  揃えを書く（描画はマス自身なので、長い表でも変更で描き直すものが増えない）。
- キー：Tab / Shift+Tab で次 / 前のマス（最後のマスの Tab は行を足す。シートのようにマスの文字を選ぶ）、Enter / Shift+Enter
  で下 / 上のマス（最後の行の Enter は行を足す。GFM のマスは改行を持てないので Enter で改行はしない）。Backspace はマスを
  またいでつながない（`isolating`）。マスへの貼り付けは 1 行（改行は空白）。マスの中では `/` のメニューと `![[` を出さない。
- 道具（カーソルのある表の上）：上 / 下に行、行を削除、左 / 右に列、列を削除、左・中央・右揃え（押すと解除）、「表を編集」
  （今の表の編集画面。完了でその表を作り直す）。最後の 1 行・1 列は消さない。
- 形：マスをまたいだ削除などで行のマスの数が変わったら、見出しの幅に揃える（足りなければ空のマス、多ければ切る。GFM と同じ）。
- 書き出し：触っていない表は `src`。編集した表は正規の GFM（`| a | b |`、区切りは `---`・`:---`・`:---:`・`---:`）。
  マスは行内の正規の形で、`|` を `\|` にする（レンダラーは行をまず `|` で分けてから各マスを読むので、コード・数式・
  リンクの中の `\|` もそこで `|` に戻る）。ふつうの文字だけのマスはそのまま書く（200 行の表を入力が止まるたびに書くため）。
- 読み込み：表もほかのブロックと同じく、正規の形で読み戻して同じでないときは生の Markdown のブロックになる（文字だけの
  マスの表は確かめない）。

### 28.4 行内の数式

- `$…$`（行の中の `$$…$$` も）は行内のアトム（`inlineMath`、属性は TeX と `display`）。ブロックの数式と同じ KaTeX の
  読み込み（`loadKatex`）で描く。KaTeX が読めない TeX は、その文字をエラーの色（`--danger`）で出す（例外にしない）。
- クリック、または矢印でアトムを選んで Enter で、TeX の欄と下に描画の見本が出る小さな箱を開く。Enter・Esc・外のクリックで
  閉じて反映、空にすると数式を消す。`$x$` と打つと今までどおり数式になる（コードの中では文字のまま）。
- 書き出しは TeX をそのまま `$` で挟む（`\$`・`|` もそのまま）。編集した行の中の触っていない数式も同じ文字になる。英数字の
  直前の数式の後のゼロ幅スペースも今までどおり。

### 28.5 HTML の貼り付け（`pagePaste.ts`）

ProseMirror が読む前に HTML を直す（`transformPastedHTML`）。カーソルが囲みの中なら、その段の数も渡す。

| 元 | 形 | 直したもの |
| --- | --- | --- |
| Word | コメント・条件付きコメント（`<!--[if gte mso 9]>`・`<![if !supportLists]>`）、`<o:p>`・`w:`・`m:` の要素、`v:` の図形、`<style>`・`<meta>`・`<xml>` | 消す（名前空間の要素は中の文字を残す）。`&nbsp;` だけの段落は空行 |
| Word | `class="MsoListParagraph…"`・`style="mso-list:l0 level2 lfo1"`、印は `<span style="mso-list:Ignore">` | 平らなリストの行（段は `levelN` − 1）。印が `1.`・`a)`・`(1)`・`①`・`一、` なら番号（数字はその番号から）、記号のフォント（Wingdings・Symbol）や `·`・`o`・`§` は箇条書き、`☐`・`☒` はチェック |
| Word | `MsoTableGrid` の表、マスの中に `<p class=MsoNormal>`、揃えは段落の `text-align` | 1 行のマスの表（段落は空白でつなぐ）、揃えは列に |
| Google ドキュメント | 全体を包む `<b style="font-weight:normal" id="docs-internal-guid-…">` | ほどく（太字にしない） |
| Google ドキュメント | `<span style="font-weight:700">`・`font-style:italic`・`text-decoration:line-through` | 太字・斜体・取り消し線（マークの読み方そのまま。400 は外す） |
| Google ドキュメント | `<ul>` の中にじかに `<ul>`、`aria-level`、`<li role="checkbox" aria-checked>` | 平らなリストの行（段は入れ子か `aria-level`）、チェック |
| Google ドキュメント | 表（`colspan`・`rowspan`、マスに `<p>`） | 結合は空のマスに広げる、見出しは最初の行 |
| Notion（HTML の書き出し） | `<figure class="callout">` と `<span class="icon">`、`<ul class="toggle"><li><details>`、`to-do-list` の `checkbox-on` / `checkbox-off`、`simple-table` の `<thead>` | コールアウト（アイコンつき）、トグル、チェック、表（`thead` の行が見出し） |
| Notion（アプリ・公開ページ） | `<aside>`（先頭の絵文字がアイコン）、`<details><summary>`、`[x]` / `[ ]` で始まる項目、`notion-callout-block` の中の `role="note"`（アイコンは `img` の `alt`） | コールアウト・トグル・チェック・コールアウト（外の枠と中の枠を 1 つに） |
| どこでも | `<table>` | `thead` か `th` だけの行（なければ最初の行）を見出しに、行の幅を揃える、入れ子の表は文字に |
| どこでも | 入れ子の `ul` / `ol`、`<input type=checkbox>` | 平らなリストの行、チェック |
| どこでも | 3 段目のコールアウト・トグル | 枠を外して中のブロックを残す（方言は 2 段まで） |

Notion のアプリがクリップボードに載せる HTML の形は公開の資料で確かめられなかったので、書き出しの形（`figure.callout`）・
`<aside>`・クラス名にコールアウトを含むブロックの 3 つを読む（§28.8）。

### 28.6 ⌘K のページ

- ページのエディタの ⌘K（Ctrl+K）は 1 つの欄の箱：`https://` で始まれば今までどおりのリンク、それ以外は `[[` と同じ
  ページの検索（↑↓ と Enter、クリック）。空で Enter はリンクを外す。
- ページを選ぶと、選んでいた文字があればその文字のページのリンク（`[文字](page:id)`）、なければページの題名のチップ
  （`[[` と同じ）。どちらも読み込むとページのリンクのチップ。
- エディタの中の ⌘K はアプリの「移動」（クイックスイッチャー）に届かない（M150 では両方が開いていた）。エディタの外の ⌘K は
  今までどおり「移動」（ブラウザで確かめた）。

### 28.7 性能とテスト

- 性能（M5 Max の開発機、ヘッドレス Chrome 154、本番のビルド `vite preview`）：200 行 × 8 列の表（各マスに太字と数式）の
  マスで 1 打鍵の取引が 8〜9 ms、次のフレームまで 33 ms（ほとんどが Chrome の表のレイアウト。表の外の段落では 0.2 ms /
  16 ms）、打鍵の間に 50 ms を超えるタスクは最初の 1 回だけ（52 ms）。`table-layout: fixed` と行の `content-visibility` は
  効かなかった。その表のページは「編集」から 0.5 秒で開く（エディタの組み立て 53 ms）。jsdom では 1 打鍵 1.2 ms、表全体の
  書き出し 7 ms（`pageEditorSchema.test.ts` で上限を確かめる）。移動の判定は囲み全体を読み直す（動かしたときだけ。長いページでの時間は
  未計測）。
- チャンク：`PageEditor` 88.0 kB（gzip 27.4 kB。M150 は 50.9 kB）。TipTap 本体の `RichEditor` は 368.5 kB（変わらず）、
  KaTeX は今までどおり別のチャンク。メインのバンドルには入らない。
- `tests/pageMarkdown.test.ts`（23）：表をマスから書く（`|`・`\`・`|` を含むコードとリンク・空のマス・日本語、揃え）と読み戻し、
  乱数の 1,500 のマスの文字が読み戻しで同じ、触っていない表は `src`、1 マスの編集で行を見出しの幅に。
- `tests/pageEditorSchema.test.ts`（63）：⌘⇧↑↓（バイトと改行、カーソル、元に戻す）・リストの子ごと・浅いところへの移動で
  段を上げる・番号・コールアウトの中へと外へ・`:::` の行を囲みへ動かすと正規の形・囲みの最後のブロック・2 段まで・区切り線・
  範囲・複製と削除、**乱数の 1,000 のページで乱数の移動**（本文が見えているとおりに読まれ、元に戻すと元のバイト）、
  Word・Google ドキュメント・Notion（書き出しとアプリ）の貼り付け（`tests/fixtures/paste/` の、それぞれの典型的な形の HTML）と 3 段目、
  行内の数式（打ち方・触っていない数式のバイト・矢印と Enter・コードの中）、表のキー・道具・形・元に戻す・200 × 8 の速さ。
- `tests/pageEditor.test.tsx`（15）：⌘K でページを探して選んだ文字をリンクに、選択なしはチップ、URL、アプリの ⌘K に届かない、
  数式のクリック・変更・空で削除・読めない TeX のエラーの色。
- ブラウザ（自分の uvicorn 8048 と使い捨てのデータベース、Vite 1422、ヘッドレス Chrome 9444）：ハンドルとドラッグ
  （`*   古い書き方の項目` と 4 つ字下げの子が文字のまま下へ）、⌘⇧↑ 2 回（コールアウトと空行を越える）、⌘Z で元の本文、
  表のマスの入力・Tab・揃え、数式の箱、⌘K（選んだ文字・アプリの ⌘K との分け）、ハンドルのメニューで見出し 2、＋ と `/`、
  4 つの元の貼り付け（`ClipboardEvent` に `text/html`）をライト / ダークで。保存された本文の差分は編集した行だけ。

### 28.8 制限

- 貼り付けのフィクスチャは各アプリのクリップボードの HTML の典型的な形から作ったもので、実物のコピーではない。Notion の
  アプリの形は確かめられず（§28.5 の 3 つの形を読む）、Word は Windows の Word の形（Mac の Word・LibreOffice は未確認）、
  Google ドキュメントのチェックリストは `aria-checked` の形を読む。実物で違いが見つかったらフィクスチャを足して直す。
- 貼り付けの画像（`<img>`）は今までどおり読まない（ファイルとして貼られたものだけ）。下線・文字の色は落ちる（方言に無い）。
- 表のマスにブロック（改行・リスト）は入れられない。結合したマスは空のマスに広がる（GFM に結合は無い）。
- 200 行の表の打鍵は 2 フレーム（33 ms）かかる（Chrome の表のレイアウト）。さらに大きな表は「表を編集」か Markdown のモードで。
- 表の道具はカーソルが表にあるあいだ表の上に出て、上の行に重なる。ハンドルは狭い画面ではスクロールの枠の端に寄る。
- ドラッグはマウス（ポインタ）だけ。キーボードでは ⌘⇧↑↓ とメニューの「上へ / 下へ移動」。
- 3 段目の囲みは枠が外れる。ページのエディタの外（Markdown のモード・キャンバス）は M151 の対象外。
- 本番の全本文での往復の確認（§22.6 (3)）は未実施（§27.8 のまま）。

## 29. 表のマスの選択と、ドキュメント内の検索（Desktop / Web、2026-10-09）

### 29.1 表のマスの選択（スプレッドシートのように）

前は、マスを編集しているあいだに別のマスを押すと、すぐそのマスの編集が始まった（Radix のポップオーバーが押した瞬間に閉じ、
同じクリックで次のマスが開いていた）。編集を終えるつもりの 1 回目のクリックで、別のマスの編集が始まってしまっていた。

- **選んだマス**（枠で目立たせる）と、**編集しているマス**（ポップオーバー）を分けた（`TableView` の `selected` と `editing`、
  `ui/dbTableNav.ts`）。行が複数のまとまりに出るとき（マルチセレクト・人でまとめる）は、まとまりごとに別のマス。
- クリック：マスを押すとそのマスを選んで編集を始める（今までどおり）。ただし**別のマスの編集を終わらせたクリックは、編集を確定して
  押したマスを選ぶだけ**（チェックも切り替えない）。2 回目のクリック・Enter・文字の入力で編集が始まる。表の外（何もない所・
  棒）を押すと編集を確定し、選択も外す。
- キー（マスにフォーカスがあり、編集していないとき）：矢印で選択を動かす（端では止まる。閉じたまとまりの行は飛ばす）、
  Enter で編集（チェックは切り替え。Space も）、文字を打つと編集を始めてその文字を値の後ろに足す（数は数字・`.`・`-` だけ、
  セレクトは選択肢の検索の欄に入る）、Esc で選択を外す。⌘ / Ctrl / Alt つきのキーと IME の変換中のキー（`ui/ime.ts`）では
  始めない。Esc は表が使い、画面の Esc（メッセージに戻る・既読）は次の Esc から。
  - キーが効くのは**フォーカスのあるマス**（箱の `data-cell-focus` から読む）で、`selected` の状態には頼らない。Tab で
    入ったマス（クリックなし）もフォーカスが来た時点で選ばれるので（箱の `onFocus`）、そのまま Enter・文字で編集できる。
    Esc → Tab → 文字と打っても、前に選んでいたマスではなくフォーカスのあるマスを編集する。
  - マスの中のボタン・リンク（題名の「開く」、URL、関係の行）にフォーカスがあるときの Enter・Space・文字はそのまま
    （「開く」の Enter は行を開く。表は矢印と Esc だけ受ける）。「開く」はホバー中の行にだけ出るので（`display: none` の間は
    Tab が飛ばす）、Tab で届くのは行にポインタがあるとき。
- 編集中：Enter で確定、Esc で取り消し（保存しない）。どちらも選択はそのマスに残り、フォーカスもマスに戻る（続けて矢印で動ける）。
  別のマスのクリックや表の外の押下で終わった編集は、フォーカスを元のマスに戻さない（戻すとそのマスがまた選ばれるため）。
- 編集中のマスが画面から消えたとき（編集でまとまりが変わった・まとまりを閉じた・行を読み直した・列を隠した）は、
  エディタが閉じたと言う前に行ごと消えるので、表が `editing` と `selected` を外す（残っていると、どのクリックも選ぶだけ・
  キーも効かないまま、開き直すまで続いていた）。
- 「編集を終わらせたクリック」の印（`endedEdit`）は主ボタンの pointerdown だけで立て、クリックが来ない押し方（右クリック・
  押したまま別の場所で離す・タッチのスクロール）のあとに残らないよう、document の pointerup / pointercancel の次の
  ティックで下ろす（クリックが先にその印を読む）。
- 選択の移動は軽い：`Cell` は `React.memo` で、表から渡すコールバックは同じ関数のまま（最新の処理は ref 経由）なので、
  矢印やクリックでは選択が変わった 2 つのマスだけ描き直す（200 行 × 列でも）。フォーカスの移動は属性セレクタ 1 つで探す
  （`cellSelector`。キーは行 ID・プロパティ ID・まとまりの順で、読み戻せる）。`DatabaseView` の `ctx` も `useMemo` で、
  読み込み中の印の切り替えではマスを描き直さない。
- **保存はちょうど 1 回**：文字の編集は、外のクリック（ポップオーバーの `onInteractOutside`。入力欄が消えると blur が来ないことが
  あるので、それに頼らない）・Enter・blur のどれが先に来ても、最初の 1 つだけが保存する（`TextEditor` の `done`）。値が変わって
  いなければ保存しない。セレクト・日付・人は今までどおり選んだときに保存する。
- 行のページのプロパティの編集（`RowProperties`）は変えていない。
- テスト：`tests/dbUi.test.tsx`（外のクリックで 1 回保存して選ぶだけ・2 回目で編集・Esc で保存しない、編集中に押したチェックは
  選ぶだけ、矢印・Enter・入力・⌘ と IME のキー・Esc、Tab で入ったマスの Enter と文字、「開く」の Enter、右クリック・別の場所で
  離した押下のあとのクリック、まとまりから出た行の編集の終わり、DOM キーの読み戻しとセレクタ）、`tests/dbTableRender.test.tsx`
  （200 行の表で矢印・クリックが描き直すマスの数を `CellDisplay` の呼び出しで数える）。待ちはフェイクタイマー
  （`vi.advanceTimersByTimeAsync`。実時間で眠らない）。

### 29.2 サイドバーの検索の欄

**前からあったもの**：サーバの `GET /search/pages`（§8.1・§14.2。PGroonga で題名・本文・行のプロパティの文字を探し、読める
集合で絞る。行（`kind = row`）も返す。読めないページの題名はどこにも出ない）と、検索の画面の「ドキュメント」タブ
（`DocsSearch.tsx`、人・期間・「探す場所」）。⌘K（「移動」）にはページの題名だけ。ドキュメントの画面の中には検索の入口が
無く、検索の画面へ行くしかなかった。サーバの変更は要らない（新しいエンドポイントは作っていない。OpenAPI も変わらない）。

- ドキュメントのサイドバー（広い画面の左の木の上、狭い画面の木の一覧の上）に「ドキュメントを検索」の欄（`DocsSidebarSearch.tsx`）。
- 打つと、木の代わりに結果を出す：`/search/pages` に `limit = 8`。メッセージの検索の欄の「打つとすぐ結果」（`LiveSearch.tsx`）と
  同じく、打つのが 250 ms 止まってから聞き、IME の変換中は聞かない。古い言葉への遅れた答えは捨て、同じ言葉は覚えた答えを出す
  （木が変わったら覚えたものを捨てる：題名・移動・共有で答えが変わるため）。
- 1 件は、アイコン（データベース・行は表の記号）・題名・行なら「（データベース）の行」・抜粋の 2 行。題名と抜粋の当たった語に印。
  抜粋は改行が空白になって届くので、行の途中に残る見出しの `## ` は消す。
- キー：↑↓ で選ぶ、Enter は選んだもの（無ければ最初の結果）を開く。結果が無いときと最後の行「「…」の結果をすべて見る」は、検索の
  画面の「ドキュメント」タブを同じ言葉で開く（人・期間・「探す場所」はそこで）。Esc は欄を空にして木に戻す（画面の Esc は次から）。
  変換を確定する Enter や矢印では何もしない（`ui/ime.ts`）。
- 言葉は DocsView が持つ：結果からページを開いても欄と結果は残る（狭い画面で戻ったときも）。× で消すと木に戻る。
- 見つからない・読み込めないときは結果の場所に 1 行で出す（トーストは出さない）。

### 29.3 ページの中の ⌘F

ブラウザの検索で足りるかを先に確かめた。足りない：macOS のアプリの WKWebView には検索のバーが無く、さらにアプリは ⌘F / Ctrl+F を
メッセージの検索に使っている（`MainScreen` で `preventDefault`）ので、Web でもブラウザの検索は ⌘F では出ない。そこで作った。

- ページ（`DocPage`）を開いているとき、⌘F / Ctrl+F はページの右上に検索のバーを出す（`PageFind.tsx`）。メッセージの検索には
  届かない（document の capture で受けて止める）。データベースの横に開いた行のページは、フォーカスがその中にあるときだけ
  その行のバーを出す。モーダルのダイアログの下（アプリが `aria-hidden` のとき）では何もしない。ページを開いていないときの ⌘F は
  今までどおりメッセージの検索。
- 探す場所：表示のまま（閲覧）、見たままのエディタ、Markdown のモードでは右の見本（`data-find-root`）。大文字・小文字は区別しない。
  太字などで文字のノードが分かれていても当たり、段落・見出し・リストの項目・表のマスをまたいでは当たらない。閉じたトグルの中、
  入力欄（題名の欄・Markdown の入力欄）、スクリプトは探さない。データベースのページでは表のマスの文字も探す。
- 印は CSS Custom Highlight API（`::highlight(doc-find)` と `doc-find-current`）で付ける。ページの DOM を変えない（見たままの
  エディタの DOM は ProseMirror のもので、触ると壊れる）。この API が無いブラウザでは今の一致を選択にする（矢印と Enter で動かした
  ときだけ。編集中のカーソルは動かさない）。
- 「3 / 12」と数を出し（0 件は赤）、Enter / Shift+Enter・↓↑・⌘G / ⇧⌘G・バーの ∧ ∨ で次 / 前（端で回る）。今の一致が見えて
  いなければ、その位置を真ん中までスクロール。Esc か × で閉じて印を消す。
- ページが変わったら（人の編集が届いた・自分で打った・閲覧と編集の切り替え・トグルを開いた）、150 ms 止まってから数え直し、
  今の一致はその場所（か次の一致）のまま。
- 制限：題名は入力欄なので探さない（題名はサイドバーの検索で当たる）。Markdown のモードの入力欄の中は探さない（見本で探す）。
  全角・半角の違いはそのまま（`ａ` と `a` は別）。
- テスト：`tests/docsFind.test.tsx`（印のノードをまたぐ・ブロックをまたがない・飛ばす部分・日本語・重ならない数え方・回る、
  ⌘F がアプリの検索に届かない・数・Enter / Shift+Enter / ⌘G・IME の Enter・0 件・Esc で印が消える・変わったら数え直す・
  横の行のページとフォーカス・モーダルの下、サイドバーの欄：空なら木・打つのが止まってから 1 回・印・見出しの印を消す・Enter で
  最初・矢印・すべて見る・IME の確定・変換中は聞かない・Esc で木・0 件とエラー）。
- ブラウザで確かめた（自分の uvicorn 8049 と使い捨てのデータベース、Vite 1424、ヘッドレス Chrome 9446）：サイドバーで「設計」と
  打つとページと行が出て Enter・矢印で開く、閲覧と見たままの編集の両方で ⌘F が「1 / 5」（太字で分かれた語も 1 件）、Enter で 2 / 5、
  ⌘G、Esc で印が消える、メッセージの検索は開かない。表のマス（§29.1）も同じ画面で、外のクリックで 1 回だけ保存して選ぶだけ、
  2 回目で編集、矢印・Enter・入力・Esc。

## 30. Notion の操作感に近づける（第 3 段、2026-10-09 の監査と M154〜M157）

M144〜M151（§22〜§28）と §29 の後に、Desktop / Web の見たまま編集を Notion と並べて監査した（読んだもの：§22・§27〜§29、
CANVAS.md §4.2・§18.2、`apps/desktop/src/ui/` のエディタ一式、iOS / Android の読む画面と Markdown のツールバー。キーの応答は
本物の TipTap のスキーマを jsdom で組み立てた使い捨てのテストで確かめた）。結果と、そこから切った M154〜M157 をここに置く。
方言（保存の Markdown の書き方。CANVAS.md §4.2、§22.5）を変えるものと変えないものを分けるのがいちばん大事で、変えないものは
エディタだけの仕事、変えるものは 3 端末の字句解析と `canvas_markdown.json` のケースが要る。

**監査の表（ある / 一部 / ない）**

ファイルはすべて `apps/desktop/src/ui/` の下。

**A. ブロックとキーボード**

| Notion の操作 | 評価 | 違い |
| --- | --- | --- |
| Enter でブロックを分ける・作る、行頭の Backspace で前と結合・段落に戻す | ある | `pageEditorSchema.ts` PageKeys。見出しの途中の Enter は見出しが 2 つになる |
| Shift+Enter の改行 | 一部 | 何もしない（方言にブロック内の改行が無い。閲覧では隣り合う行を詰めて描くので、見た目は Enter が Notion の Shift+Enter に近い） |
| `/` メニュー | 一部 | 行のどこでも、日本語・英語・ローマ字で絞り込み、↑↓ Enter Tab Esc。アイコン・説明・グループ・プレビュー・最近使った物は無い |
| Markdown の打ち方の変換 | ある | `# `〜`### `・`- `・`1. `・`[] `・`> `・```` ``` ````・`---`・`$$ `・`**x**`・`_x_`・`` `x` ``・`$x$`・`[文字](url)`・`:emoji:` |
| Tab / Shift+Tab の入れ子 | 一部 | リストの行だけ、段は 0〜2（チェックは 0〜1）。段落・画像を項目の下にぶら下げる入れ子は無い（方言が行ベース） |
| ブロックの選択モード（Esc・Shift+↑↓・↑↓・⌘A 2 回・Delete・⌘D・⌘⇧↑↓） | **ない** | Esc はエディタの blur。⌘A は 1 回で全文。⌘⇧↑↓ はある（`pageEditorBlocks.ts`）。画像・区切り線・埋め込みは NodeSelection で 1 つだけ選べる → **M154** |
| ⌘/ 「変換」 | 一部 | キーは無い。ハンドルのメニューの「変換」と `/` がある |
| 複数ブロックのコピー & ペーストで構造を保つ | ある | コピーは選択範囲の Markdown、貼り付けは Markdown として読む。HTML は `pagePaste.ts` |
| ⌘Z / ⌘⇧Z、空のブロックの案内、ハンドル ⋮⋮ と ＋、落とす位置の線 | ある | 列（横並び）は無い（方言に無い） |

**B. 行内**

| Notion の操作 | 評価 | 違い |
| --- | --- | --- |
| 選択時の浮くツールバー | **ない** | 上に固定のツールバー（`OverflowToolbar`）。下線・色・コメントは無い → M155 |
| @ で人・ページ・日付 | 一部 | `@` は人とグループだけ。ページは `[[`、日付は無い |
| `[[` ページのリンク、行内の数式、⌘B / ⌘I / ⌘E / ⌘K | ある | ⌘U（下線）は無い（方言に無い） |
| リンクのプレビュー / ブックマーク | 一部 | ページはチップ、キャンバスはカード。ふつうの URL はただのリンク |
| 文字の色・背景色、日付とリマインダー | ない | 方言に無い |

**C. ブロックの種類**

| 種類 | 評価 | 違い |
| --- | --- | --- |
| 見出し（トグル見出し） | 一部 | H1〜H3。トグル見出しは無い |
| To-do・箇条書き・番号・トグル・引用・区切り線・数式・データベースの埋め込み | ある | リストは 3 段まで |
| コールアウト | 一部 | 色はアイコンから決まる（`calloutTone`）。自分で選べない |
| コード | 一部 | 言語は属性として持つが、見たままで選ぶ UI・コピーのボタン・折り返し・ハイライトは無い |
| 表 | 一部 | マスの直接編集・行 / 列・揃え（§28.3）。列の幅・見出し列のオフ・マスの改行は無い（GFM に無い） |
| 画像 | 一部 | 貼り付け・ドロップ・選択。キャプション（alt）を書く UI・大きさ・揃えは無い |
| 動画・外部の埋め込み・ブックマーク・目次ブロック・列・同期ブロック・ボタン | ない | 目次は閲覧の右にだけ（見出し 3 つ以上） |

**D. ページの体裁・周り**

| Notion の操作 | 評価 | 違い |
| --- | --- | --- |
| アイコン | 一部 | 絵文字とカスタム絵文字。画像のアップロードは無い |
| カバー、フォント・小さな文字・全幅、ページのロック、お気に入り、コメント | ない | コメントは §13.2 Q7 の決定のまま |
| 題名をその場で編集、Enter で本文へ | 一部 | Enter は入力欄の blur だけ。本文の先頭で ↑ しても題名へ行かない → **M154** |
| プロパティ、パンくず、履歴、複製、削除 / ゴミ箱、テンプレート、ドラッグで並べ替え、⌘K / ⌘F、戻る / 進む | ある | 履歴は Notion の無料枠より多い |
| 最終更新、移動 | 一部 | 最終更新は閲覧だけ。「移動先」を検索して選ぶダイアログは無い |
| サイドバーの「＋ ページ」とその場の名前の変更 | 一部 | 木の中でその場で名前を変えられない（⋯ → 名前の変更） |

**E. 共同作業**：誰が見ている / 編集中のアバターは無い（キャンバスの `canvas_presence` をページに中継していない。§7.3・§22.9）。
ライブカーソルは設計上やらない（§22.10）。メンション・共有の通知はある、コメントは無い。

**F. スマホ**：閲覧は 3 端末で同じ方言の描画。編集は Markdown（§22.7）。M153（同梱した同じ TipTap を編集のときだけ WebView で出す）は
未着手。**この監査で挙げる Desktop の改善は、M153 がエディタを同梱する限りスマホにもそのまま乗る**（方言を足す物だけ、先に
「スマホは描画のみ」の段階が要る）。

**G. 手触り**：打鍵は 1 フレーム（§27.6、Notion と同等以上）。プレースホルダ・空のページの案内はある。ハンドルのフェード・`/` の
プレビューは無い。編集と閲覧で空行の高さと見出しの間隔が少し違う（§27.8）。**ショートカットの一覧にページのエディタのキーが無い**
→ **M154**。

**「Notion らしさ」にいちばん効く差分（順位つき）**

方言の不変条件（§27.2：開いて閉じただけなら 1 バイトも変わらない、触っていないブロックは `src` のまま）はすべて守れる。

| # | 差分 | 一行の設計 | 方言 |
| --- | --- | --- | --- |
| 1 | ブロックの選択モード | ProseMirror の NodeSelection を複数ブロックの範囲に広げた自前の選択（`BlockUnit` を単位に）。選んだブロックは `src` のまま動かす（M151 の移動と同じ判定）。Esc は 1 回目で選択、2 回目で囲み、3 回目で解除 | UI のみ |
| 2 | 選択時の浮くツールバー | 選択が空でなく IME でないとき `coordsAtPos` の上に小さな OverflowToolbar。「変換」はハンドルのメニューの TURN_INTO を再利用 | UI のみ |
| 3 | `/` メニューの仕上げ（アイコン・説明・グループ・最近・プレビュー、⌘/ で変換） | `SLASH_ITEMS` に icon / group / hint、メニューを 2 列に。最近使った物は端末の prefs | UI のみ |
| 4 | 編集の見た目を閲覧に揃える（空行・見出しの間隔・Shift+Enter） | エディタの CSS を `paragraphLayout` と同じ規則に。Shift+Enter は Enter と同じ。見出しの途中の Enter は後半を段落に | UI のみ |
| 5 | 題名と本文の行き来 | `TitleRow` と `PageEditor` の間に小さな handle（focusStart / focusTitle） | UI のみ |
| 6 | コールアウトの色とトグル見出し | `::: callout 💡 tone=blue`（無ければ今までどおりアイコンから）、`::: toggle ## 見出し`。古い端末では文字として見える（壊れない） | **方言** |
| 7 | コードブロックの道具（言語・コピー・折り返し） | 右上に言語のセレクトとコピー。ハイライトは依存を増やさないなら見送り | UI のみ |
| 8 | 画像のキャプション・幅・揃え | キャプションは alt の編集。幅・揃えは `![alt](attachment:<id>#w=60&align=center)` | キャプションは UI、幅・揃えは **方言** |
| 9 | URL のブックマーク（カード） | 1 行に URL だけの段落を `link_previews` のカード（`LinkPreviewCard`）で描く。本文は URL のまま | UI のみ |
| 10 | ページの気配（presence） | `canvas_presence` と同じ揮発フレーム `wiki_presence` を読める接続にだけ中継（§7.3） | サーバ + UI |
| 11 | カバー画像・全幅・小さな文字 | `wiki_pages.cover_attachment_id`・`cover_offset`・`layout`。描画は 3 端末 | サーバ + UI |
| 12 | @ でページも | `mentionCandidates` の下に `links.lookup` の結果を 3 件 | UI のみ |
| 13 | サイドバーのその場の名前の変更と「移動先」 | 木の行をダブルクリック / F2 でインラインの入力欄。「移動先」は `[[` と同じ検索の箱 | UI のみ |
| 14 | ショートカットの一覧にエディタのキー | `SHORTCUT_KEYS` に節を足す | UI のみ |
| 15 | 目次ブロック・ハイライト（任意） | `[[toc]]`、`==文字==` を 1 色のマーカー | **方言**（小） |

**マイルストーン（M154〜M157）**

| # | 名前 | 範囲 | 方言の変更 | スマホへの影響 | 見込み |
| --- | --- | --- | --- | --- | --- |
| **M154** | ブロックの選択とキーボード（Desktop / Web） | 上の 1・5・14：選択モード（Esc・Shift+↑↓・↑↓・⌘A 2 回・Delete・⌘D・⌘⇧↑↓・コピー / 切り取り / 貼り付け）、題名 ⇄ 本文、ショートカットの一覧。テスト：`pageEditorSchema.test.ts` に選択の範囲ごとの操作 | なし | なし（M153 で同梱すれば自動で乗る） | 2〜3 日 |
| **M155** | 浮くツールバーと `/` の仕上げ（**実装済み 2026-10-10、§30.2**） | 上の 2・3・4・12：選択のツールバー、`/` のアイコン・説明・グループ・最近・プレビュー、⌘/、編集の CSS を閲覧に揃える、Shift+Enter、見出しの途中の Enter、`@` にページ。テスト：`pageEditor.test.tsx` | なし | なし | 3 日 |
| **M156** | ブロックの仕上げ（方言の小さな拡張） | 上の 6・7・8・9・15：`tone=`、`::: toggle ## 見出し`、コードの言語 / コピー / 折り返し、画像の alt / `#w=` / `#align=`、URL のカード、（任意）`[[toc]]`・`==…==`。`canvas_markdown.json`・`inline-format` にケース、取り込みも対応。DATA_MODEL.md・CANVAS.md §4.2・WIKI.md を更新 | **あり** | **描画のみ**を iOS / Android に。古いアプリでは文字として見える | Desktop 3〜4 日 + iOS 1〜1.5 日 + Android 1〜1.5 日 |
| **M157** | ページの体裁と気配 | 上の 10・11・13：`wiki_presence`、カバー、全幅・小さな文字、木のその場の名前の変更、「移動先」。サーバ：移行（`cover_attachment_id`・`cover_offset`・`layout`）、presence の中継（読める接続だけ、45 秒で消える）、OpenAPI | なし | カバーの描画と「編集中」の 1 行 | サーバ 1.5 日 + Desktop 2 日 + スマホ 1 日 |
| M153（既定の計画） | スマホの見たまま編集 | §22.7 のまま（M153a 試作 → M153b iOS → M153c Android）。同梱するエディタに M154〜M156 の分が入る。ブリッジの `command` に選択モードとツールバーの状態を含める | なし | 本体 | 各 OS 1.5〜3 週 |
| M158（任意、要望が出てから） | 列・日付のメンション・ハイライトの色 | 列は `::: columns` の中に `::: column`、日付は `<@date:2026-10-12>` | あり | 描画 | 未見積 |

**推奨の順番**：M154 → M155 → **M153a（試作と判定）** → M156 → M153b / M153c → M157。

- M154・M155 は Desktop だけで安く、M153 が同梱するエディタの「中身」なので先に済ませる。
- M153a の試作は方言を変えないうちに（往復のコーパスのテストが安定しているうちに）やる。判定が出れば M156 の「スマホは描画のみ」が
  短く済む。
- M156 は 3 端末の字句解析が揃って初めて意味がある（古い端末に `tone=blue` の文字が見える期間を短くするため、3 端末同時に出す）。
- M157 はサーバの移行を伴うので、取り込み済みの本番データで確かめてから。presence はキャンバスの実装の写しで済む。

完了の条件は §22.9 と同じ。M156 は `canvas_markdown.json` の新しいケースが 3 端末で通ること、往復のコーパスで 100%。

**やらないこと**

| やらないこと | 理由・代わり |
| --- | --- |
| ライブカーソル・同時編集（CRDT / Yjs） | §22.10 のまま。Markdown のままマージする設計と両立しない。presence（M157）で「誰が編集中か」は見える |
| 同期ブロック | 別のページの一部を参照する実体が方言にも DB にも無く、展開・権限・マージの作り直しになる。ページのリンクのチップとデータベースの埋め込みで足りる |
| 列のレイアウト | `::: columns` は囲みの入れ子の上限（2 段）と衝突し、3 端末の描画（狭い画面では縦に戻す）が大きい。画像の幅と揃え（M156）でだいたい足りる。要望が出れば M158 |
| 文字の色・背景色（複数色） | 方言に無く、Markdown の可搬性（書き出し・AI・検索）を損なう。1 色のハイライト `==…==` だけを任意で（M156） |
| 下線（⌘U） | 方言に無い。太字・斜体・取り消し線で足りる |
| ボタン・パンくずのブロック・テンプレートボタン・自動化 | 研究室の用途に無い（操作ボタンは M143 がある）。テンプレートはページそのものがある |
| 外部の埋め込み（YouTube・Google マップ・Figma など） | CSP と追跡の都合（CANVAS.md §4.2 で外部の画像も描かない）。URL のカード（M156）で代える |
| 表の列の幅・見出し列・マスの改行 | GFM に無い（保存できない）。幅を端末ごとに覚えても他の人に伝わらない。大きな表はデータベースに |
| 任意のブロックの下への入れ子 | 方言のリストが行ベースで平ら。3 端末の字句解析と `lists.json` の作り直しになる。トグル・コールアウトの中に置けることで代える |
| ページへのコメント | §13.2 Q7 の決定のまま。要望が出たら範囲でなくページ単位から |
| ページのロック | 権限（閲覧 / 編集 / フル）で代える。「間違って消す」は履歴の復元がある |
| お気に入り・フォント（セリフ / 等幅） | 手間は小さいが寄与も小さい。要望が出たら M157 に足す |
| 画像のアイコン（アップロード） | カスタム絵文字に画像を登録すれば同じことができる |
| Markdown のモードの廃止 | 往復できない書き方の逃げ道として残す（§22.6） |

### 30.1 M154 の実装（ブロックの選択とキーボード：Desktop / Web、2026-10-09）

上の M154 の範囲のうち、選択モード・題名 ⇄ 本文・ショートカットの一覧。方言・サーバ・API・スマホの変更なし、新しい依存なし。
§27.2 の不変条件（触っていないブロックは `src` のまま、動かした / 複製した / 貼ったブロックは M151 の規則）はそのまま守り、
テストで固定した。Shift+Enter = Enter と見出しの途中の Enter は M155（上の 4 と一緒に）。

**部品**

| ファイル | 役目 |
| --- | --- |
| `ui/pageEditorSelection.ts` | `BlockSelection`（ProseMirror の Selection の自前の派生：1 つの入れ物（ページ・コールアウト・トグル）の隣り合うブロックの範囲。アンカーのブロックと先頭のブロック、`content()` / `replace()` / `map` / JSON / 履歴の栞）、Esc・↑↓・Shift・⌘A・Enter・Delete・⌘D・文字キー・Shift+クリックのプラグイン、選んだブロックへの装飾、`pasteAfterBlocks` |
| `ui/pageEditorSchema.ts` | その拡張を組み込む。↑ で本文の最初の行から題名へ、← で先頭から題名へ、ページの先頭の Backspace は何もしない。`sliceMarkdown`（コピーの text/plain） |
| `ui/pageEditorBlocks.ts` | `takeOut` を公開。⌘⇧↑ でリストでないブロックがリストの項目を子ごと飛び越える（前は子だけを越えて項目を割っていた） |
| `ui/PageEditor.tsx` | Esc を拡張に渡す（画面の Esc には届かない）、blur で選択を解除、ブロック選択中の貼り付けは下に、Shift + ⋮⋮ で範囲を広げる、ハンドルのメニューに「選択」（Esc）と「複製」に ⌘D、`focusStart` / `onTitle` |
| `ui/DocPage.tsx` | 題名の Enter → 本文の先頭（閲覧中なら編集を開いて先頭。Markdown のモードは入力欄の先頭）、本文の ↑ → 題名の末尾 |
| `ui/Dialogs.tsx`・`i18n/*` | ショートカットの一覧に「ドキュメントの編集」の節（ja / en / zh） |
| `styles.css` | `.pe-selected`（アクセントの 14% の塗り。囲み・表・画像・区切り線・コードは枠も） |

**キー**（ブロックを選んでいるとき。文字のカーソルは ProseMirror の `ProseMirror-hideselection` で隠す）

- **Esc**：文字を編集中は、カーソルのあるいちばん内側のブロックを選ぶ（リストの行はその下の深い行ごと：ハンドル・⌘⇧↑↓ と同じ単位）。
  コールアウト・トグルの中なら、もう一度で囲み。いちばん外で押すと解除してエディタを離れる（前と同じく、次の Esc は画面のもの）。
- **↑ / ↓**（← / → も）：ページの順に前 / 次のブロック（親の行の次はその子の行）。囲みの最初のブロックで ↑ は囲みそのもの、
  最後のブロックで ↓ は囲みの次のブロック。ページの端では止まる。
- **Shift+↑ / ↓**：先頭だけを動かして広げる / 縮める。囲みの外へは出ない。リストの項目は子ごと 1 歩（子が既に入っているので）。
  **Shift+クリック**（本文・⋮⋮）：そのブロックまで（アンカーの入れ物まで持ち上げる。別の囲みの中なら何もしない）。
- **⌘A**：1 回目はブロックの文字、2 回目（文字が全部選ばれているとき・ブロック選択中）はページの全ブロック。
- **Enter**：先頭のブロックの末尾から編集（トグルは見出しの末尾、コールアウト・引用・表は中の最後の文字。画像・区切り線・
  埋め込みは NodeSelection のまま）。**文字を打つ**（IME の始まりも）と同じ場所から編集してその文字が入る（画像などの後なら
  下に新しい行）。何も置き換えない。
- **Backspace / Delete**：選んだブロックを消す（1 回の取引、⌘Z 1 回で元のバイトと選択が戻る。囲みが空になれば空の行が残る）。
- **⌘D**：下に複製（正規の形、チェックの隠れた印は元にだけ。複製を選んだ状態に）。
- **⌘⇧↑ / ↓**：M151 の移動（`selectedUnit` がブロック選択の範囲をそのまま単位にする）。選択は一緒に動く。
- **⌘C / ⌘X**：ProseMirror のクリップボード。text/html はブロックの HTML、text/plain は Markdown で、**触っていないブロックは
  `src` のバイトのまま**（コピーの text/plain は文字の範囲でも同じ関数：行の一部は正規の形）。⌘X は取り出す。
- **⌘V**：ブロック選択中は選んだブロックの**下に**貼る（置き換えない）。貼ったブロックは新しいノード（正規の形）で、選んだ状態に。
  クリップボードが行の一部の文字なら段落にして貼る。
- **Tab**：何もしない（フォーカスを失わない）。⌘Z・⌘B などはそのまま。
- 編集に戻る：Enter・文字・クリック（ProseMirror が文字の選択にする）・エディタの外のクリックや題名へのフォーカス（blur で
  最初のブロックの先頭のカーソルに）。選択だけでは本文を書き出さない（書き出しは文書が変わったときだけ）。
- **題名 ⇄ 本文**：題名の Enter は保存して本文の先頭（最初の文字の位置。空の本文は空の行）。閲覧中の題名の Enter は編集を開いて
  先頭。本文の最初の行で ↑（`endOfTextblock("up")`：見た目の最初の行）、または先頭で ← は題名の末尾。ページの先頭の Backspace
  は何もしない（見出し・リストの行を段落に戻すのは前のまま）。

**描き方と性能**：選んだブロックだけにノードの装飾（`pe-selected`）を付ける。装飾の計算は選択がブロック選択のときだけ（文字を
打っているあいだは `instanceof` 1 回で終わる。§27.6 の教訓）。⌘A で全部を選ぶと 1 回だけブロックの数ぶん作る。DOM の選択は
ブロックの範囲（`anchor` / `head` はブロックの前後）なので ⌘C がブラウザに届く。

**テスト**

- `tests/pageEditorSchema.test.ts`（74、M154 は 11）：Esc の 3 段と解除・装飾の数・`visible`、↑↓ の順と囲みの出入り、Shift の
  広げ方（項目ごと）と縮め方・囲みの外へ出ない・Shift+クリックの持ち上げ、⌘A の 2 段、Enter / 文字 / 画像 / トグル / コールアウト、
  Backspace と Delete（CRLF の本文で消した行以外のバイト、⌘Z で選択も戻る、空になったコールアウト）、⌘D（`*   ` の元は
  そのまま、隠れた印は複製しない、2 回）、⌘⇧↓↑ と選択の追従、コピー（`src` のバイト）→ 貼り付け（正規の形、下に）→
  切り取り（元のバイトに戻る）→ ⌘Z、行の一部のコピーの貼り付け、コールアウトの中の切り取り、マージをまたぐ選択、JSON と栞。
- `tests/pageEditor.test.tsx`（20、M154 は 5）：題名の Enter → 本文の先頭、↑ / ← → 題名の末尾、閲覧中の題名の Enter、
  Esc・矢印・⌘A で保存しない、blur で解除、Delete は消した行だけ保存、先頭の Backspace、ショートカットの一覧。
- ブラウザ（自分の uvicorn 8047 と使い捨てのデータベース、Vite 1422、ヘッドレス Chrome 9444。CDP の鍵のイベントで）：
  Esc（行・項目と子・コールアウトの中 → コールアウト → 解除）、↑↓、Shift+↓ ×2、⌘A の 2 段（21 ブロック）、Enter、文字の入力、
  ⌘D と Delete、⌘⇧↑、題名の ↑ / Enter（閲覧中の Enter も）、ハンドルのメニューの「選択」、⌘C（OS のクリップボードに `src` の
  バイト）→ ⌘V ×2（下に、選んだ状態）→ ⌘X（正規の形）→ ⌘Z を、ライト / ダークで。保存された本文の差分は、打った 1 行と消した
  2 行だけ（ほかの行は 1 バイトも変わらず）。コピー → 貼り付け → 切り取り → ⌘Z で元に戻したページは版が進まなかった（書き出す
  ものが無い）。ヘッドレス Chrome では ⌘C / ⌘V / ⌘X を編集コマンド（CDP の `commands`）と一緒に送らないと何も起きない
  （macOS の鍵の変換が無いため。ブラウザ本体では不要）。

**制限**

- 選択は 1 つの入れ物の中の連続した範囲だけ（コールアウトの中の行とその外の行を一緒には選べない。Shift+クリックは
  アンカーの入れ物まで持ち上げる）。離れたブロックの複数選択は無い。
- 矢印は囲み（コールアウト・トグル）の中へ入らない（↓ は囲みを飛び越え、↑ は囲みそのものを選ぶ。中へは Enter か クリックから）。
- ⌘V は Markdown / HTML として読み直すので、貼ったブロックは正規の形（M151 の複製と同じ。元の `src` はコピー元にだけ残る）。
  3 段目の囲みを貼ったときの扱いは §27.8 のまま。
- 貼り付け・切り取りを 500 ms 以内に続けると ProseMirror の履歴が 1 つにまとめる（⌘Z で両方戻る。打鍵と同じ規則）。
- Markdown のモードでは題名の Enter で入力欄の先頭へ行くが、入力欄の先頭の ↑ で題名へは戻らない（CanvasEditor はキャンバスと
  共用なので触っていない）。
- ブロック選択中の ⌘B などは選んだ範囲の全文字に効く（ProseMirror の既定）。ドラッグ（選んだブロックを引きずる）は
  ProseMirror の既定のまま（確かめていない）。
- Shift+Enter = Enter、見出しの途中の Enter、`/` のアイコンと説明、浮くツールバーは M155（§30.2）。

### 30.2 M155 の実装（浮くツールバーと `/` の仕上げ：Desktop / Web、2026-10-10）

上の M155 の範囲（2・3・4・12）。方言・サーバ・API・イベント・スマホの変更なし、新しい依存なし。§27.2 の不変条件
（触っていないブロックは `src` のまま、編集した行だけ正規の形）はそのまま守り、それぞれテストで固定した。

**部品**

| ファイル | 役目 |
| --- | --- |
| `ui/pageEditorToolbar.tsx` | 浮くツールバー（`SelectionToolbar`）と出す / 出さないの規則（`toolbarState`、純粋な関数）、「変換」のリスト（`TurnIntoList`）、変換の実行（`turnBlocks`・`setKind`・`turnRange`）、数式にする（`wrapMath`・`mathSelectable`）、`/` と「変換」の項目のアイコン（`slashIcon`、lucide）、ブロックの種類（`kindOf`） |
| `ui/docEditor.ts` | `/` の項目に説明（`hint`）・節（`group`）・英語名と別名（`words`：h1・todo・img・bulleted・formula・hr …）、節に分ける `slashSections`、この端末の「最近使ったもの」（`readSlashRecents` / `rememberSlashKey`：localStorage `taylis.docs.slashRecents`、新しい順に 5 件） |
| `ui/pageEditorSchema.ts` | 見出しの途中の Enter（後半は段落）と先頭の Enter（上に空行）、Shift+Enter = Enter、⌘/（`host.turnMenu`）、リストの印のプラグインが読む側で新しいリストになる行に `data-group-start` |
| `ui/PageEditor.tsx` | ツールバーの状態（選択・IME・ポインタ・Esc・blur）、「変換」のメニュー（⌘/ と「変換 ▾」）、`/` メニューの節と最近、`@` のページ、⌘/ をアプリに渡さない |
| `ui/DocPage.tsx`・`styles.css` | 編集の見た目を閲覧に揃える（下の「見た目」） |
| `ui/Dialogs.tsx`・`i18n/*` | ショートカットの一覧に ⌘/・Shift+Enter・文字の選択（ja / en / zh） |

**浮くツールバー**

- 1 つのテキストブロックの中で文字を選ぶと、選択の最初の行の上に左端を揃えて出る。上の固定の書式の行に重なるところでは
  選択の最後の行の下。エディタの包みの中の絶対配置なので、スクロールしても文字と一緒に動く。ポインタで選んでいるあいだは
  出さず（document の mouseup で出す）、IME の変換中（compositionstart から）・ブロック選択（M154）・アトムの選択（画像
  など）・複数ブロックにまたがる選択・カーソルだけのときは出さない。フォーカスが外れると消える（ツールバー自身やエディタの
  箱へ移るときは残る）。
- ボタン：「変換 ▾」（ハンドルのメニューと同じ `TURN_INTO`：テキスト・見出し 1〜3・箇条書き・番号・チェック・引用・
  コールアウト・トグル・コード・数式。囲みが 2 段のところではコールアウト・トグルを出さない）、太字・斜体・取り消し線・
  コード（押された状態を表示）、数式にする（選んだ文字をそのまま TeX にして `$…$` のアトムに。前後の空白は外に残す。文字だけの
  選択で、`$` も改行も含まないときだけ）、リンク（⌘K の箱をそのまま）。コードブロック・数式のブロック・生の Markdown の中では
  「選択した文字をコピー」だけ（マークが無い）。表のマス・トグルの見出し・引用の中ではマークだけ（それ自身が変換できる
  ブロックでない）。
- Esc は 1 回目でツールバーを隠す（選択を変えるまで出ない）、2 回目で M154 のブロック選択。⌘B / I / E / K はそのまま効く。
  上の固定の書式の行も残す。
- 「変換」は選んでいた文字をそのまま残す（コールアウト・トグルにしたときは 1 つ内側に写す）。

**⌘/ と「変換」のリスト**

- ⌘/（Ctrl+/）はカーソルの行（ページ・コールアウト・トグルの直下の行の種類のブロック。表のマス・引用・トグルの見出しでは
  何もしない）、またはブロック選択（M154）の範囲に「変換」のリストを出す。今の種類にチェックと最初のフォーカス、↑↓ Home End、
  Enter、Esc。
- 複数のブロックを選んで変換すると、行の種類はそれぞれの行に、コールアウト・トグルは全部を 1 つに包む（トグルは最初の行が
  見出し、残りが中身。中身が無ければ空の行）。カーソルだけなら元の位置に戻し、ブロック選択からは最後のブロックの末尾。
- ⌘/ はアプリのショートカットの一覧に届かない（⌘K と同じく止める。ブラウザで確かめた）。

**`/` メニュー**

- 各項目にアイコン（lucide）と 1 行の説明、節（基本・リスト・メディア・埋め込み・高度）。何も打っていないときは「最近使ったもの」
  （この端末の localStorage、新しい順に 5 件、サーバには送らない）が先頭。絞り込みは日本語の表示名・英語名・別名（h1・todo・
  img・bulleted・formula・hr …）。↑↓ Enter Tab Esc は前のまま、長いときは選んだ行を見えるところへ。IME の変換中は反応しない
  （`ime.ts`）。Markdown のエディタの `/`（平らな一覧）は変えていない。

**`@` にページ**

- `@` の候補は人とグループの下に、`[[` と同じ検索（`links.lookup`）の結果を 3 件（「ページ」の見出しつき）。選ぶと `[[` と同じ
  ページのリンクのチップ（`[題名](page:id)`）。`[[` はそのまま。

**見た目を閲覧に揃える**

- 閲覧（`CanvasBody` / `MessageBody`、`paragraphLayout`）と同じ余白をエディタの CSS に書いた：
  - 空行：文字の行のそばの空行は閲覧の段落の間の隙間（`mt-2.5` = 0.625rem）。高さ 0 の段落の上の margin として持たせ、
    ProseMirror が置く `<br>` を隠す（行ボックスを持たないので margin が貫通する）。これで空行が続いても 1 つの隙間、見出しや
    リストの前の空行はそれらの margin と重なる（閲覧の `mt-2.5` / `mb-2.5` と同じ）。文字でないブロック同士の間の空行（見出しと
    リスト、区切り線とコールアウト）・コールアウトやトグルの中だけの空行・最初の行の空行は閲覧と同じ実体のある 0.625rem の箱
    （`h-2.5`）。カーソルのある空行は 1 行ぶん（カーソルとプレースホルダのため）。
  - 見出し：`margin: 1rem 0 0.25rem`、行の高さは閲覧の text-2xl / xl / lg のまま（2rem・1.75rem・1.75rem。Tailwind v4 では
    `leading-tight` より大きさの行の高さが残る。Chrome で測った）。囲みの最初のブロックは margin-top 0。
  - リスト：印は閲覧の `pl-6`（24px）の中。字下げは 1 段 24px、番号は文字の 4px 手前で終わる。まとまり（連続した行）の上下に
    0.125rem、チェックは 0.25rem、箇条書きと番号が上の段で切り替わるところは読む側（`listGroups`）と同じく 0.125rem（リストの
    印のプラグインが `data-group-start`）。チェックボックスは 2px 内・1rem・文字との間 0.5rem。
  - 区切り線は margin 0.75rem（閲覧の `my-3`。前後の空行の margin と重なる。クリックの当たりは擬似要素で広げる）、コールアウトは
    padding 8px 14px・gap 0.625rem、トグルは margin 0.25rem・見出しの上下 2px、表・引用・コードは前のまま（閲覧と同じ）。画像・
    埋め込みの外側の余白は 0（中の部品が閲覧と同じ余白を持つ）。
  - 本文の始まり：編集の書式の行を閲覧の最終更新の行の場所に収める（`mt-[3px]`、エディタの上の padding 0）。
- 測った数（Vite の開発ビルド、ヘッドレス Chrome 155、幅 708px のページ。題名の下端から各ブロックの上端まで、閲覧 / 編集 / 差）：
  - M154 まで：最初の段落 82 / 123 / **+41**、見出し 2 230 / 363 / **+133**、チェック 432 / 588 / +156、コールアウト 648 / 868 /
    **+220**、表 798 / 1038 / +240、最後の行 915 / 1242 / **+327**。文字の x は 24 / 26、リストの文字は 48 / 50。
  - M155：最初の段落 82 / 83 / +1、見出し 2 230 / 231 / +1、リスト 274 / 275 / +1、チェック 432 / 433 / +1、引用 506 / 507 / +1、
    コード 552 / 553 / +1、区切り線 617 / 618 / +1、コールアウト 648 / 649 / +1、トグル 748 / 749 / +1、表 798 / 799 / +1、
    数式 875 / 876 / +1。文字の x は 24 / 24、リストの文字は 48 / 48。数式のブロックの後だけ +48（編集では TeX の欄と描画の
    両方を出すため。下の制限）。
- Shift+Enter は Enter と同じ（方言にブロックの中の改行が無い。ページの Enter で扱わないところはエディタの Enter：コードの中では
  改行）。見出しの途中の Enter は後半を段落に（見出しが 2 つにならない）、末尾の Enter は段落（前から）、先頭の Enter は上に
  空行（見出しの `src` はそのまま、改行の種類も）。

**テスト**

- `tests/pageEditorSchema.test.ts`（82、M155 は 8）：出す / 出さないの規則（1 ブロックの中の文字・カーソルだけ・IME・複数
  ブロック・ブロック選択・画像、コードは「コピー」だけ、マス・トグルの見出し・引用はマークだけ、コールアウトの中は変換も）、
  太字と数式にするが編集した行だけ正規の形で他の行は 1 バイトも変わらない（空白は外、アトムや `$` を含む選択は断る）、⌘/ が
  ホストに届く・`turnRange`・`kindOf`、「変換」（選択を保つ、2 ブロックを 1 つのコールアウトに、トグルの見出し、箇条書き・引用、
  3 段目は断る）、`/` の節（順番・絞り込み・最近 5 件・この端末の壊れた値）、見出しの Enter（途中・末尾・先頭、元に戻す）、
  Shift+Enter（段落・項目・コードの中）。
- `tests/pageEditor.test.tsx`（26、M155 は 6）：文字を選ぶとツールバー、太字の保存はその行だけ、Esc で隠す → ブロック選択、マスでは
  マークだけ、「変換 ▾」→ 見出し 2 で選択が残る、⌘/ → 見出し 3・ブロック選択の 2 行 → 1 つのコールアウト（CRLF の本文で
  それぞれの行の改行はそのまま）、`/` の節と説明・「todo」の絞り込み・最近、`@` のページ（人が先）、閲覧と編集の余白
  （`styles.css` の `.page-editor` の規則を jsdom に入れ、閲覧の Tailwind のクラスの値と比べる：空行の margin / 箱、見出し、
  リスト、チェック、区切り線、コールアウト、引用、表、トグル、行の高さ）、ショートカットの一覧。
- ブラウザ（自分の uvicorn 8047 と使い捨てのデータベース、Vite 1422、ヘッドレス Chrome 9444、CDP）：ドラッグで選ぶとツールバーが
  選択の上に（左端が揃う）、太字、Esc ×2、Shift+→ で選んでリンクの箱 → リンク、「変換 ▾」→ 見出し 3（選択が残る）、コードの中は
  「コピー」だけ、マスはマークだけ、ページの上端近くでは下に出る、IME（`Input.imeSetComposition`）で消える、`/` の節と「todo」と
  最近、⌘/ → 見出し 2 → 入力、見出しの途中の Shift+Enter、`@設計` → ページ → チップ、数式にする、をライト / ダークで。上の
  測った数（閲覧と編集の同じ幅のスクリーンショット）。保存された本文の差分は編集した 4 行と足した 4 行だけ（他の行は 1 バイトも
  変わらず）。
- `npx tsc --noEmit`・vitest 全体・`npm run build`：`PageEditor` のチャンク 109.6 kB（gzip 34.0 kB。M154 は 109.4 kB、M151 は
  88.0 kB）。遅延読み込みのまま、メインのバンドルには入らない。

**制限**

- 「ページにする」（選んだ文字で子ページを作る）は入れていない（子ページの作成はダイアログを通る）。
- ツールバーは 1 つのテキストブロックの中の選択だけ。複数ブロックにまたがる選択では出ない（⌘B などのキーは効く）。
- 数式のブロックは編集では TeX の欄と描画の両方を出すので閲覧より高い（上の +48）。数式のブロックから下は閲覧と編集でその分ずれる。
- 「最近使ったもの」は端末ごと（localStorage）で、何も打っていないときだけ出す。
- 空行はカーソルを置くと 1 行ぶんに伸びる（その下が 18px 動く）。隣り合う空行は margin の貫通で 1 つの隙間になるので、2 行目
  以降の空行はカーソルを置くまで見えない（↑↓ で通ると現れる）。
- ⌘/ はエディタの中ではアプリのショートカットの一覧（⌘/）を奪う。エディタの外では今までどおり。
- ヘッドレス Chrome では背景のタブに描画のフレームが来ず、TipTap の `focus()`（requestAnimationFrame 待ち）が動かない：確認の道具は
  CDP の `Page.bringToFront` を要る（アプリの変更はしていない）。

### 30.3 M153a：同梱エディタと橋（Desktop / Web の成果物、2026-10-10）

§22.7 の（B）の第 1 段（3 つのうちの 1 つ目）。Desktop / Web のページエディタ（`PageEditor.tsx`）を AppController・Store・API から
切り離し、同じエディタを 1 つの HTML + JS + CSS に束ねて `apps/shared/mobile-editor/dist/` に書き出す。iOS（M153b）と Android
（M153c）はこの成果物を WKWebView / WebView に入れ、ここで決めた橋（JSON のメッセージ）で話す。方言・サーバ・API・イベントの
変更なし。§27.2 の不変条件（開いて閉じただけなら 1 バイトも変わらない）は橋を通しても同じテストで守る。判断は ARCHITECTURE.md D28。

**部品**

| ファイル | 役目 |
| --- | --- |
| `ui/pageEditorEnv.tsx` | エディタが周りに求めるもの `PageEditorEnv`（人とグループ・カスタム絵文字・アトムの描画（ページのチップ・絵文字・画像・埋め込み・コールアウトのアイコン・ページのアイコン・絵文字ピッカー）・コピー・エラー・画像のアップロード / ネイティブのピッカー・ツールバーの位置・読み取り専用・自動フォーカス）と、保存の状態機械の見え方 `PageEditorSink`（`text`・`textRevision`・`canReplace`・`subscribe`・`edit`・`flush`・`compositionEnded`）。型だけ（React もアプリも読まない） |
| `ui/pageEditorDesktopEnv.tsx` | Desktop / Web の実装（controller と store）。`PageLinkChip`・`CanvasImage`・`DatabaseEmbed`・`CustomEmojiImage`・`EmojiPicker`・`PageIcon`・`inline()` はここから描く（`PageEditor.tsx` はもう読まない） |
| `ui/PageEditor.tsx` | `controller` / `saver: CanvasSaver` の代わりに `env` / `saver: PageEditorSink`（`CanvasSaver` は構造的に `PageEditorSink`）。ハンドルに `focus`・`blur`・`insertImage`・`command`・`revealCaret`。書式の行を画面の下（`env.toolbar: "bottom"`、キーボードの上）に置ける。`/` の「子ページ」「データベース」「埋め込み」は `links` にその機能があるときだけ出す。メニューと箱の高さは `visualViewport`（キーボードが残した分） |
| `ui/DocPage.tsx`・`CanvasEditor.tsx` | `desktopPageEditorEnv(controller)` を組み立てて渡す。`DocEditorLinks.createChild` は任意に |
| `src/styles.css` → `src/app.css` | Tailwind の読み込み（`@import "tailwindcss"`）だけを styles.css に残し、トークン・テーマ・部品の規則を app.css に移した（Desktop の CSS の出力は 1 バイトも変わらない。`tests/theme.test.ts`・`pageEditor.test.tsx` は app.css を読む）。同梱のエディタの `mobile.css` は `@import "tailwindcss" source(none)` + `@source`（エディタのファイルだけ）+ app.css |
| `apps/shared/mobile-editor/src/bridge.ts` | 橋の契約：メッセージの型、transport の検出（iOS / Android / なし）、受け取りの検証と待ち行列、`window.taylisEditor`、ページのエラーを `log` に。依存なし（Swift / Kotlin が写す仕様そのもの） |
| `apps/shared/mobile-editor/bridge_messages.json` | すべてのメッセージの例と、断る例。`tests/mobileEditorBridge.test.ts` が読み、iOS / Android のテストも同じものを読む |
| `mobile-editor/index.html`・`main.tsx`・`mobile.css`、`vite.mobile-editor.config.ts` | 第 2 のビルド（`npm run build:mobile-editor`。root は `mobile-editor/`、出力は `../shared/mobile-editor/dist`）。1 つの classic script（module でない：`file://`・独自スキームでも読める）、CSP の差し込み、KaTeX の同梱（フォントは woff2 だけ `fonts/`）、辞書の刈り込み（下） |
| `src/mobileEditor/bridgeEnv.tsx` | `BridgeDirectory`（人・ページ・絵文字・画像の URL。`needPages` → `providePages` の待ち合わせ）、`BridgeSink`（`changed` を出す、`replace` を入れる / 保留する）、`bridgePageEditorEnv`（チップ・画像・埋め込みのカード・簡単な絵文字ピッカー） |
| `src/mobileEditor/MobileEditorApp.tsx` | メッセージ → 動作（`load` は新しいエディタ、`requestBody` は同じタスクの中で答える）、`ready`、`height` |
| `src/mobileEditor/devHarness.ts` | `?dev=1`：ネイティブの代わり（見本のページ・人・絵文字・ページの検索・写真）と、計測の入口（`window.__taylis`） |

**成果物**（`apps/shared/mobile-editor/dist/`、生成物。コミットしない。CI の desktop ジョブが作れることを確かめる）

```text
index.html      <meta http-equiv="Content-Security-Policy">、<script defer src="./editor.js">、<link href="./editor.css">
editor.js       1,483 KB（gzip 445 KB、brotli 371 KB）：React・TipTap / ProseMirror・KaTeX・エディタ一式・絵文字の表・刈り込んだ辞書
editor.css      72 KB（gzip 13 KB）：app.css のトークンと規則 + エディタが使う Tailwind のユーティリティ + KaTeX
fonts/          KaTeX の woff2 20 個（296 KB）
```

- 相対パス（`./`）なので、どのスキーム・どのディレクトリからでも読める。`editor.js` の大半は Desktop の `RichEditor` チャンク
  （TipTap、369 KB / gzip 118 KB）・KaTeX（259 KB / gzip 78 KB）・絵文字の表（`emojiData.ts` 333 KB：`:name:` の判定・変換と
  コールアウトのアイコンの検索に使う）・React で、エディタ自身は Desktop の `PageEditor` チャンク（110 KB / gzip 34 KB）と同じ。
  API クライアント・Store・画面・ルーターは入らない（`fetchBlob` などが無いことをテストしていないので、ビルドの後に
  `grep` で確かめた）。
- **辞書の刈り込み**：`src/i18n/{ja,en,zhHans}.ts`（3,200 の文言 × 3 言語 = 550 KB）は、このビルドではチャンクに入った
  モジュールが文字列リテラルで名指すキー（`t("docs.wysiwyg.raw")`・`label: "docs.slash.h1"`）だけに切り詰める
  （`prunedDictionaries`：`transform` で印に置き換え、`renderChunk` で `chunk.moduleIds` の元のファイルを読んで集める）。
  エディタは動的なキーを使わない。使う人は plugin に例外を書く。
- **CSP**（index.html に差し込む）：`default-src 'none'; script-src 'self' taylis-editor:; style-src 'self' taylis-editor: 'unsafe-inline'
  (React と KaTeX の style 属性); img-src 'self' taylis-editor: data:; font-src 'self' taylis-editor:; connect-src 'none'; base-uri 'none';
  form-action 'none'`。エディタは自分では一切通信しない。アクセストークンは JS に渡さない。

**組み込み方**（M153b / M153c の入口。ここで決めたことは橋と同じく契約）

| | iOS | Android |
| --- | --- | --- |
| 置き場所 | `dist/` をそのままアプリのバンドルに（フォルダの参照。`editor/` などの名前で） | `dist/` を `app/src/main/assets/editor/` に |
| 読み込み | `WKURLSchemeHandler` を `taylis-editor` に登録し、`taylis-editor://app/index.html` を `load`。handler は `index.html`・`editor.js`・`editor.css`・`fonts/*` をバンドルから返す（`Content-Type` を正しく）。代わりに `loadFileURL(_:allowingReadAccessTo:)` でも動く（CSP の `taylis-editor:` が余るだけ） | `WebViewAssetLoader` に `AssetsPathHandler("/editor/")` を付け、`https://appassets.androidplatform.net/editor/index.html` を `loadUrl`。`shouldInterceptRequest` で loader に渡す |
| web → native | `WKUserContentController.add(handler, name: "taylis")`。`WKScriptMessage.body` は JSON の文字列（`String`）で、`JSONDecoder` で型に | `addJavascriptInterface(obj, "TaylisBridge")`、`@JavascriptInterface fun post(json: String)`。別スレッドで来るので UI へ post する |
| native → web | `evaluateJavaScript("window.taylisEditor.receive(\(文字列リテラル))")`。JSON を 1 つの JS の文字列リテラルにして渡す（`JSONSerialization` でエスケープした文字列をさらに `"…"` で包む）か、オブジェクトリテラルのまま渡す | `evaluateJavascript("window.taylisEditor.receive(…)", null)`。同じ |
| 画像 | `load.attachmentUrl` に `taylis-editor://app/attachment/{id}`。同じ handler が `/attachment/<id>` を受け、API からセッション付きで取って返す（キャッシュはアプリ側）。カスタム絵文字の `url` も同じ要領（`/emoji/<name>`） | `attachmentUrl` に `https://appassets.androidplatform.net/attachment/{id}`。`shouldInterceptRequest` でそのパスを見て、API から取った `WebResourceResponse` を返す |
| 移動の禁止 | `WKNavigationDelegate.decidePolicyFor`：`taylis-editor://app/` 以外は `.cancel`（リンクは `openLink` で来る） | `shouldOverrideUrlLoading` で bundle 以外は `true`（開かない） |
| キーボード | WebView の下端を `keyboardLayoutGuide` に合わせて縮めるのが簡単（`setViewport {keyboardHeight: 0}`）。縮めないなら高さを `setViewport` で送る（書式の行が上に乗り、本文の下に余白が入り、カーソルを見える所へ） | `WindowInsets.ime` で同じ。`adjustResize` 相当なら 0 |
| 温め | 画面を開いたときに WebView を 1 つ作って `index.html` を読ませ、`ready` を待っておく。「編集」で `load` だけ | 同じ |
| 設定 | `isTextInteractionEnabled` は既定のまま。`scrollView.contentInsetAdjustmentBehavior = .never`。ダークは `setTheme`（`prefers-color-scheme` でも追う） | `javaScriptEnabled = true`。`forceDark` は使わず `setTheme` |

**橋のメッセージ**（`bridge.ts`。JSON の `type` で見分ける。版は `ready.version` = `BRIDGE_VERSION` = 2。1 → 2 は下の「版 2」）

ネイティブ → エディタ（`window.taylisEditor.receive(json)`。JSON の文字列でもオブジェクトでも。エディタが聞く前に来たものは順に待つ）：

| type | 中身 | いつ・何が起きる |
| --- | --- | --- |
| `load` | `body`、`title?`、`theme?`（light / dark / system）、`readOnly?`、`caretLine?`（Markdown のエディタから来た行）、`locale?`（ja / en / zh-Hans）、`attachmentUrl?`（`{id}` を含む画像の URL の型）、`gen?`（この本文の世代。`baseGen` で返る） | 新しいエディタ。`ready` の後、`providePeople` / `provideEmoji` の後に（チップの名前と `:name:` のアトムは読むときに決まる） |
| `replace` | `body`、`gen?` | マージの後の本文。変わったトップレベルのブロックだけ差し替え、履歴に入れない（Desktop の `applyMerge` そのまま）。IME の変換中と書き出し待ちの編集があるあいだは保留（下） |
| `setTheme` | `theme` | `<html data-theme>` |
| `setViewport` | `keyboardHeight`（CSS px）、`safeBottom?` | `--keyboard-height` / `--safe-bottom`。書式の行がその上に、本文の下にその分の余白、カーソルを見える所へ |
| `insertImage` | `attachmentId`、`url?`（その画像だけの URL）、`alt?` | `pickImage` の答え。カーソルの位置に画像のブロック（空の行ならその行に） |
| `providePeople` | `people: [{id, username, display_name, kind?: user / group, ai?, members?, description?}]` | `@` の候補と `<@id>` の名前。全部を送る（変わるたびに全部） |
| `providePages` | `query`（`needPages` のもの。null なら木の全部）、`pages: [{id, title, icon?, kind?}]` | `[[`・`@`・⌘K の候補、チップの題名とアイコン。null で送れば以後の検索はエディタの中で済む |
| `provideEmoji` | `emoji: [{name, url?, label?, kind?, color?, width?, height?}]` | `:name:` をアトムに（画像、または文字のピル） |
| `focus` / `blur` | | キーボードを出す / しまう（エディタは自分からはフォーカスしない） |
| `requestBody` | `id?`（答えに付けて返る） | 今の本文を同じタスクの中で `bodyRequested` で返す（書き出し待ちがあれば今書く。`changed` は出さない） |
| `command` | `name`（`EDITOR_COMMANDS`：bold・italic・strike・code・h1〜h3・bullet・ordered・task・quote・codeBlock・divider・link・mention・slash・image・table・undo・redo・indent・outdent） | ネイティブのツールバー用。エディタの書式の行と同じ動作 |

エディタ → ネイティブ（JSON の文字列 1 つ。iOS は `webkit.messageHandlers.taylis.postMessage`、Android は `TaylisBridge.post`）：

| type | 中身 | いつ |
| --- | --- | --- |
| `ready` | `version` | ページが立ち上がって聞き始めた（`load` はこの後） |
| `changed` | `body`、`dirty`（最後の load / replace から変わったか）、`baseGen?`（取り込んだ最後の load / replace の `gen`） | 打鍵が 300 ms 止まった、フォーカスが外れた。保存はネイティブの `CanvasSaver`（待ち・マージ・再送はそのまま） |
| `bodyRequested` | `body`、`dirty`、`caretLine`、`baseGen?`、`id?`。または `loaded: false`、`id?`（本文なし） | `requestBody` の答え。`load` がまだ無いページ（web プロセスが落ちて読み直したページなど）は `loaded: false` で答え、ネイティブはこれを本文（空の本文）として扱ってはいけない |
| `caret` | `line` | フォーカスが外れたとき（Markdown のエディタに持ち越す行） |
| `height` | `px` | 文書の高さが変わったとき（1 フレームに 1 回）。中身に合わせて WebView を伸ばすなら |
| `needPeople` | `query` | `@` が開いた・絞り込みが変わった（送り直すかは任意） |
| `needPages` | `query` | `[[`・`@`・⌘K がページを探す。同じ `query` の `providePages` で答える（15 秒で諦める） |
| `pickImage` | | 画像のボタン・`/画像`。ネイティブが選んで上げ、`insertImage` |
| `openLink` | `url`（`https://…`・`page:<id>`・`attachment:<id>`） | ページのチップ・画像・埋め込みのカードをタップ |
| `focusTitle` | | 本文の最初の行で ↑（先頭で ←） |
| `log` | `level`、`message`、`detail?` | ページのエラー、読めなかったメッセージ、断った動作（貼り付けの画像など） |

**約束**（テストで固定）

- `load` → `requestBody` は本文をそのままのバイトで返す（apps/shared の全フィクスチャの文字列と docs の Markdown、CRLF も）。
  `changed` は出ない。
- `replace` は Desktop の `canReplace` と同じ規則：IME の変換中、または書き出し待ち（打鍵から 300 ms 以内）のあいだは入れない。
  変換が終わると 50 ms 後に入れる（ProseMirror が自分の compositionend の処理を終えてから。Desktop は読み直しで同じ間が空く）。
  待っている間に編集が書き出されたら保留は捨てる（`changed` をネイティブがマージして、また `replace` を送る）。編集が結局
  何も変えなかったときは、その時点で入れる。捨てたときの `changed` はマージの前の本文を元にしている。その `baseGen` は
  捨てた `replace` の `gen` ではなく、前に取り込んだ本文の `gen` のまま（下の「版 2」）。
- `requestBody` は同じ JS のタスクの中で答える（`load` の直後でもよい：`flushSync` でエディタを先に立てる）。`id` が来たら
  答えに付ける。`load` がまだ無ければ `{type: "bodyRequested", loaded: false}`（本文の欄なし）で答える。
- 人・絵文字は `load` の前に。後から来た `providePeople` は `@` の候補にだけ効く（既にあるチップの名前は変わらない）。
- 子ページ・データベースの作成・データベースの埋め込みはスマホでは出ない（`links` に無い）。既にある埋め込みはカード
  （題名、タップで `openLink page:`）のまま、本文のバイトは変わらない。貼り付け・ドロップの画像は上げられない（`log` に
  warn）。画像のボタンは `pickImage`。
- `?dev=1`：ネイティブの代わり。`?dev=1&quiet=1` は見本を読まずに `window.__taylis.measureLoad(body)` などを待つ。

**版 2**（2026-10-10、レビュー v0.1.49 の #1・#2。iOS は §30.4、Android は §30.5）

- **本文の世代**：ネイティブは `load` と `replace` に `gen`（整数）を付ける。エディタは最後に**取り込んだ** `load` / `replace` の `gen` を
  `baseGen` として `changed` と `bodyRequested` に付けて返す。保留した `replace` が編集で捨てられたら `baseGen` は動かない。
  `replace` の本文が既にエディタの本文と同じなら、その `gen` に進む。
- **ネイティブの規則**：保存の状態機械が本文を自分で入れ替えたら（マージの結果・相手の版・閲覧のチェック）新しい世代にし、前の
  世代の文書を保存する基準の版を覚えておく。保存の答えでマージを取り込んだときは「送った本文そのものの版」（`submittedRevId`）、
  相手の版を読んで取り込んだときは前の基準の版。エディタの `baseGen` が今の世代より前なら、その世代の基準の版の上に保存し直し、
  サーバがもう一度マージする。こうすると、マージを取り込んだかどうかをエディタが確かめるまで、基準の版をマージ済みの版へ進めた
  ことにならない。フォーカス・時間の推測（§30.4 の `editorQuiet`）は、`replace` をいつ送るかの見た目の判断だけになる。
- **読み直したページ**：`load` の無いページの `requestBody` は `loaded: false` で答える（版 1 は `{body: "", dirty: false}` を返し、
  ネイティブが空の本文を保存していた）。ネイティブは web プロセスが落ちたら（iOS の `webViewWebContentProcessDidTerminate`、
  Android の `onRenderProcessGone`）、次の `ready` で `providePeople` / `provideEmoji` / `load`（状態機械の今の本文・世代・カーソルの
  行）を送り直す。読み直しの間の `requestBody` は送らない。`requestBody` の `id` が待っているものと違う答えは捨てる。
- `gen`・`id` の無いメッセージ（版 1 の形）も受け付ける（`baseGen` が無ければ今の世代として扱う）。ネイティブは `ready.version` が
  違う束を断るので、アプリと束は同じ版で出す。

**大きさと速さ**（ヘッドレス Chrome 155、390 × 844 のモバイルのエミュレーション、M5 Max の開発機、`vite preview` の本番ビルド、CDP）

- ページの立ち上がり（移動 → `ready`、1.5 MB のスクリプトの読み込み・解析・React）：94〜111 ms（DOMContentLoaded 67〜84 ms）。
  温めた WebView なら「編集」で `load` だけになる。
- 10 万文字のページ（docs の Markdown を 8,000 字ずつつないだもの、1,175 ブロック）：`load` → エディタが描かれた次のフレームまで
  初回 106〜142 ms（エディタの組み立て 62〜91 ms、長いタスク 1 回 102〜130 ms）、2 回目以降 77〜85 ms（組み立て 44〜50 ms、長い
  タスク 1 回 75〜82 ms）。§22.7 の目標（初回の表示 300 ms 以内）の中。
- 打鍵（CDP の `Input.insertText` で 20 文字、日本語と英数字）：各取引から次のフレームまで 0〜18 ms（60 Hz の 1 フレーム以内。
  Desktop §27.6 の 13〜18 ms と同じ）。止まって 300 ms の書き出し（10 万字の Markdown 化 + JSON）は 1 回 76 ms のタスク
  （Desktop の書き出しと同じ仕事。メインスレッドを塞ぐのは 300 ms に 1 度）。
- 実機（iPhone・Pixel）の数字と IME・選択のハンドル・キーボードの上のツールバーの判定は M153b / M153c で（§22.7 の表の
  「M153a 試作」の判定の残り）。

**テスト**

- `tests/mobileEditorBridge.test.ts`（11）：iOS / Android / なしの transport、フィクスチャの全メッセージ（オブジェクトと JSON の
  文字列）、断る例とその理由の `log`、全コマンド、聞く前の待ち行列と止め方、投げる handler、`installBridge`（`window.taylisEditor`
  とページのエラー）。
- `tests/mobileEditor.test.tsx`（25）：`ready` と `load`（題名・テーマ・言語）、全フィクスチャと docs のコーパスの `load` → `requestBody`
  （CRLF も）、300 ms の `changed`（編集した行だけ、`dirty`）、直後の `requestBody`、`replace`（触っていないノードが同じまま、履歴に
  入らない）、IME の変換中の保留と 50 ms 後の反映、書き出し待ちの保留と破棄 / 反映、`caret`、2 回目の `load`、`providePeople`
  （`needPeople`、候補、`<@id>`）、`providePages`（`needPages` → 候補 → チップ → `openLink`）、木の全部、`provideEmoji`、画像（`attachmentUrl`、
  `pickImage`、`insertImage`）、スマホで出ない `/` の項目、`setTheme` / `setViewport`、下のツールバーと `focus` / `blur`、`command`
  （太字・見出し・元に戻す・知らない名前）、読み取り専用、`focusTitle`、JSON でないメッセージ。版 2：`gen` → `baseGen`（捨てた `replace` では動かない、変換の後に入れたら進む、本文が同じ `replace` でも進む、`gen` が無ければ返さない）、`load` の前の `requestBody` は `loaded: false`、`id` を返す。
- 既存：`pageEditor.test.tsx`・`pageEditorSchema.test.ts`・`theme.test.ts`（app.css）はそのまま緑。`npx tsc --noEmit`、`vite build`
  （Desktop の CSS は分割の前後で同一）、`npm run build:mobile-editor`。

**制限（M153b / M153c へ）**

- ツールバーの状態（`selection`：マークとブロックの種類）は送っていない（`command` はある）。`caret` はフォーカスが外れたときだけ。
- ⋮⋮ のハンドルとドラッグはポインタ専用（`pointer: coarse` では隠す）。浮くツールバー（M155）は OS の選択メニューと同じ場所に出る
  （端末で見て決める）。
- 自動フォーカスしない（ネイティブの `focus`）。iOS の WKWebView は利用者の操作なしに JS からキーボードを出せないことがある
  （M153b で確かめる）。
- 絵文字の表（検索語つき、gzip で 90 KB ほど）は丸ごと入れている。名前と字だけに刈ればおよそ 1/4 になるが、コールアウトの
  アイコンの検索が名前だけになる。実機の読み込み時間を見て決める。
- `editor.js` は 1 つのファイル（1.5 MB）。WebView の JIT は遅延コンパイルなので立ち上がりは 100 ms 前後だが、実機で測る。
- カスタム絵文字の文字のピル（`kind: "text"`）は色の名前を `color` で受けるだけ（Desktop の `TextEmojiPill` を使う）。

### 30.4 M153a：iOS の試作（同梱エディタの組み込みと判定、2026-10-10）

§22.7 の表「M153a 試作」の iOS の分。§30.3 の成果物を iOS アプリに同梱し、ページの編集を WKWebView の同じエディタで行う最小の試作を
作って、シミュレータ（iOS 18.6 と 26.5）で IME・選択・キーボード・10 万字・初回の表示・画像・テーマ・回転・メモリを測った。方言・サーバ・
API・Desktop の成果物の変更なし。端末ごとの設定（既定はオフ）の裏にあり、Markdown のエディタが既定のまま。

**部品**（`apps/ios/ChikuwaChat/UI/MobileEditor/` ほか）

| ファイル | 役目 |
| --- | --- |
| `EditorBridge.swift` | 橋の Swift 側：`EditorNativeMessage`（ネイティブ → エディタ、`Encodable`）と `EditorWebMessage`（エディタ → ネイティブ）、`BridgePerson` / `BridgePage` / `BridgeEmoji`、`EditorCommand`（22）、`EditorTheme`。`receiveScript` は JSON を 1 つの JS の文字列リテラル（`\`・`"`・制御文字・U+2028 / U+2029 をエスケープ）にして `window.taylisEditor.receive(...)` に包む。`decode` は `type` で見分け、知らない型・欠けた欄は `EditorBridgeError` |
| `MobileEditorWebView.swift` | `MobileEditorBundle`（バンドルの `dist/`、Content-Type の表、画像の種類は先頭バイトで）、`EditorSchemeHandler`（`WKURLSchemeHandler`：`taylis-editor://app/` の index.html・editor.js・editor.css・fonts/* をバンドルから、`/attachment/<id>`・`/emoji/<name>` をアプリの認証付きの取得から返し、`NSCache` 48 MB に置く。`..`・隠しファイル・ほかのホストは 404）、`MobileEditorController`（WKWebView、`ready` までの待ち行列、版の照合、`decidePolicyFor` でバンドル以外の移動を止める、web プロセスが落ちたら読み直し、`editorFocused`）、`NoAccessoryWebView`（WebKit がキーボードの上に出す ‹ › 完了 の欄を消す） |
| `MobileEditorSession.swift` | 橋と保存の状態機械（`CanvasSaver`）の間。`attach` は `providePeople` → `provideEmoji` → `load`（本文・テーマ・言語・カーソルの行・`attachmentUrl`）。saver の `textRevision`（マージ・相手の版・閲覧でのチェック）を追って `replace`、`changed` は `saver.edit`、`commit` は `requestBody` → `bodyRequested`（1.5 秒で諦める）→ `saver.edit`、`detach` は commit + `flush`。`canReplace` は `editorQuiet`（下の「直したもの」） |
| `MobileEditorHost.swift` | `AppController` を `MobileEditorHost`（人と AI ボット・グループ、カスタム絵文字、木からのページの候補、言語）と画像の取得元に。`MobileEditorSettings`・`MobileEditorMode`・`MobileEditorTrace`（計測。下） |
| `MobileEditorView.swift` | SwiftUI の画面：WebView（温めた 1 つを使い回す）＋ 書式の行 `MobileEditorToolbar`。外観の変化で `setTheme`、`.inactive` で `commit`、`pickImage` → `PhotosPicker` → `uploadAttachment` → `insertImage`、`openLink`（`attachment:` はプレビュー、https はブラウザ、`page:` は画面へ）。⌘S で commit + flush |
| `WikiViews.swift`（`WikiPageDocument`） | 設定がオンなら画面を開いたときに WebView を 1 つ作って index.html を読ませておく（温め）。編集中は上に 「見たまま | Markdown」（端末に記憶）。完了は `commit` を待ってから閲覧へ。見たまま → Markdown は `commit` の行を `CanvasEditor(initialLine:)` へ、Markdown → 見たままは `onCaretLine` の行を `load.caretLine` へ。「セクションを編集」は見たままでは全体をその見出しの行で開く |
| `YouView.swift` | 「表示」の 「ドキュメント」 に 「ドキュメントの見たまま編集（試作）」（端末だけ、既定オフ、`chikuwa.docs.wysiwyg`）。同梱エディタの無いビルドには出ない |
| `project.yml`・`.github/workflows/ios.yml` | `../shared/mobile-editor/dist` をフォルダ参照で Resources に（アプリの中では `dist/`）。ビルド前のスクリプトが無ければ作り方（`cd apps/desktop && npm ci && npm run build:mobile-editor`）を書いて止める。CI は `xcodegen generate` の前に作る |
| `ChikuwaChatTests/MobileEditorBridgeTests.swift`（13）・`MobileEditorSessionTests.swift`（24） | `bridge_messages.json` の全メッセージ（符号化・復号・断る例）、JS のリテラルを WebKit に評価させて同じ文字列が返る、scheme handler（Content-Type・画像の取得とキャッシュ・止めたタスク・バンドル外の 404）、待ち行列と版。セッションは本物の `CanvasSaver` + `FakeCanvasServer`：送る順、マージ → `replace`、相手の版、閲覧のチェック、`changed` → 保存、`commit` / `detach`、ページ・人・画像・リンク・ログ、**フォーカス中のマージは保留して何も失わない**、**捨てられた `replace` の後の編集はその前の世代の版で保存し直す**・**web プロセスが落ちた後は本文を入れ直し、空の本文を保存しない**（実際の束と WKWebView で。下） |

**キーボードの上のツールバーの選択**：ネイティブの行（`MobileEditorToolbar`、SwiftUI）にし、WebKit の入力補助の欄（‹ › 完了）と
同梱エディタ自身の下の行（`env.toolbar: "bottom"`、アプリ側の `WKUserScript` の style で隠す。束は変えない）は消した。WebView は
SwiftUI のキーボードのセーフエリアで縮むので、行はキーボード（候補の欄）の真上に立ち、キーボードと同じアニメーションで上下し、しまっても
画面の下に残る。取り消し・やり直し・キーボードを閉じる・画像が置け、VoiceOver の名前がアプリの言語になる。Android（§30.5）は Web の行 +
Compose の行の 2 段にしたが、iOS は WebKit の欄を消す仕組みがどのみち要るので 1 段にまとめた。欠点は書式の状態（今太字か）を出せない
こと（橋に `selection` が無い）と、20 個を横スクロールの 1 行に並べたので 402 pt の幅では 「画像」 と 「キーボードを閉じる」 が画面の外に
あること（下の制限）。

**計測**（シミュレータ iPhone 16 Pro / iOS 18.6 と iPhone 17 Pro / iOS 26.5、Debug ビルド、ハードウェアキーボードはオフ、M5 Max。実機では
ない。使い捨ての XCUITest の harness（コミットしない）で操作し、アプリは起動の環境変数 `TAYLIS_EDITOR_TRACE=1` で `MobileEditorTrace` の
ログ（WebView の作成からの ms、`load` をページの中で `receive` → 2 フレーム後まで測った時間、各トランザクションから次のフレームまでの ms）
を書く。開発サーバ :8000、android1 / android2、別の人の保存は devadmin で API から）

| 項目 | iOS 18.6 | iOS 26.5 |
| --- | --- | --- |
| ページの立ち上がり（WebView の作成 → `ready`） | 442〜467 ms（アプリ起動後の最初のページ 803 ms、10 万字の画面 1,617 ms） | 502〜517 ms（起動後の最初 1,214〜1,494 ms） |
| 本文の表示（`load` → 2 フレーム後、見本のページ 223〜346 字） | 75〜126 ms。Markdown から戻るときの読み直し 38 ms | 99〜126 ms。読み直し 37〜40 ms |
| 10 万字（99,238 字、146,482 px）の `load` → 2 フレーム後 | 623 ms | 651〜669 ms（§22.7 の目標 300 ms を超える。下の判定） |
| 打鍵（見本のページ、トランザクション → 次のフレーム） | かなの変換中 0〜11 ms、英字 0〜31 ms | 英字 0〜6 ms、ローマ字の変換中 0〜30 ms、かなの変換中 25〜43 ms |
| 打鍵（10 万字、英字 10 字） | 最初の 1 打 123 ms、以後 2〜21 ms | 最初の 1 打 107 ms、以後 4〜44 ms |
| スクロール（10 万字、4 回のフリック） | 白い抜け・止まりなし（スクリーンショット） | 同じ |
| 日本語の IME（かな 10 キー） | 「にほん」が行内で変換中（下線）、候補の列（日本 / 二本 / 日本語 …）、候補の 「日本」 で確定、続けて 「た」。変換中の 削除 で 「にほ」 が変換中のまま残る（残骸なし）。保存した本文に 「日本た」 が 1 回だけ | 同じ（変換・候補・確定。削除は 18.6 で確認） |
| 日本語の IME（QWERTY ローマ字） | （harness がローマ字のキーボードに切り替えられず未計測） | "nihongo" → 「にほんご」 が行内で変換中、候補で 「日本語」、続けて "abc" → 「あbc」（ローマ字の規則どおり）。重複・欠けなし。ライブ変換（行内の自動変換）はシミュレータでは出ず、未確認 |
| 変換中のマージ（別の人が行を足す） | 直す前：相手の行が消えた（下）。直した後：変換中は出ず、保存はサーバでマージされ、本文に両方が残る。キーボードを閉じた後に相手の行が出る | 同じ |
| 選択のハンドルと OS のメニュー | ダブルタップでハンドル、上に OS のメニュー（カット / コピー / ペースト / ›）、下に浮くツールバー（変換・B・I・S・コード・Σ・リンク）。重ならない | OS のメニューが浮くツールバーの上に重なり、ツールバーは端だけ見える |
| キーボードの出し入れ | 行がキーボードの真上（WebView 143〜493 pt、行 496〜536 pt）。閉じると行は画面の下（798 pt）、WebView が 652 pt に伸びる | 同じ（行 497〜537 pt） |
| 見たまま ↔ Markdown | 「2 段目」 にカーソル → Markdown が同じ行で開く（直した後。下）。Markdown の行 → 見たままの `load.caretLine`、エディタはその行（画像の行なら次の行）にカーソル | 同じ |
| 画像 | 行の 「画像」 → フォトピッカー → アップロード → `insertImage` → `![](attachment:<id>)` が本文に入り、`taylis-editor://app/attachment/<id>` を scheme handler がセッション付きで返して表示。保存した本文にその行 | 同じ |
| テーマ | — | `simctl ui appearance dark` で編集中のエディタがダーク（`setTheme`）、ライトに戻る |
| 回転 | 横向きで WebView の高さ 51 pt（題名の 1 行だけ）。縦に戻すと元どおり | 同じ |
| メモリ（ホストの RSS。シミュレータの Debug ビルドで、共有のマッピングを含むので実機と比べられない） | アプリ 約 400 MB（見本のページ） | アプリ 約 930 MB（10 万字）、WebContent 170〜450 MB |

**試作の途中で直したもの**（コミット 「iOS: …」）

- **変換中のマージで相手の行が消える**（データの消失）。試作は `saver.canReplace = { true }` にしていた（エディタは変換中の `replace` を
  自分で保留するので）。ところが保留した `replace` はエディタの次の編集で捨てられ（§30.3 の約束）、その編集の `changed`（マージの前の本文を
  元にしたもの）を `saver.edit` がマージ済みの版の上に保存するので、相手の行を消す保存になる。シミュレータで再現（版 17・18 で devadmin が
  足した 2 行を、版 19 のアプリの保存が消した）。直し：セッションの `canReplace` を `editorQuiet`（WebView の内容のビューが first
  responder でなく、最後の `changed` / `command` / `insertImage` から 1 秒）にした。フォーカス中は saver がマージ済みの本文を取り込まず、
  保存はいつもエディタの本文の元の版の上に送られてサーバがマージする。フォーカスが外れたら（`caret`）1 秒後に `flush`（書き出し待ちは保存、
  何も無ければマージされた版を読んで `replace`）。テスト `testWhileTheEditorIsFocusedAMergeWaitsAndNothingIsLost`。直した後はかな・ローマ字
  ともに 「相手が足した行」 と自分の 「日本た」 が両方残る（iOS 18.6 / 26.5）。Android（§30.5）にも同じ穴があり、同じ規則で直した
  （§30.5 の「試作の途中で直したもの」）。
- **見たまま → Markdown でカーソルが文末に行く**。`CanvasTextView` は作るときに `initialLine` の位置にカーソルを置いていたが、直後の
  `onAppear` の `attach` が本文を入れ直してカーソルが末尾に動いていた。行の位置を次のランループ（本文が入った後）で計算して置く。
- 計測のログに `load.caretLine` を足した（`MobileEditorTrace`、トレースのときだけ）。
- **レビュー v0.1.49 #1：捨てられたマージの後の保存で相手の行が消える残り**。上の `editorQuiet` の後も、セッションが「静か」と判断して
  `replace` を送った後でエディタがそれを保留して捨てると（フォーカスが取れなかった、`replace` が届く直前に打ち始めた、完了の直前の書き出し
  待ち）、次の `changed` / `bodyRequested` がマージ済みの版の上に保存され、相手の行が戻った。`CanvasSaver` + `MobileEditorSession` +
  `FakeCanvasServer` のテストで再現（元 `a\nb\nc`、自分 `A\nb\nc`、相手 `a\nb\nREMOTE`、答え `A\nb\nREMOTE`、捨てた後の `AA\nb\nc` で
  サーバが `AA\nb\nc`）。フォーカス中の打鍵ではもう起きない（main で通る）。直し：橋の版 2（§30.3）。`CanvasSaver` に本文の世代
  `textLineage`（自分で本文を入れ替えたら進む）と、前の世代の文書を保存する基準の版（マージを取り込んだときは `submittedRevId` と送った
  本文、相手の版を読んだときは前の基準）を持たせ、`edit(_:basedOn:)` が前の世代を名指したらその版に戻して保存する（サーバがもう一度
  マージ）。送信中に戻ったときは、その答えで基準を動かさない。セッションは `load` / `replace` に `gen`、`changed` / `bodyRequested` の
  `baseGen` を `edit` に渡す。テスト：300 ms の書き出し待ち・変換中（捨てる / 終わって入れる）・すぐの `requestBody`（完了）・相手の版を
  読んだ後、それぞれフォーカス中と「静か」の両方でサーバに `AA\nb\nREMOTE` が残る。
- **レビュー v0.1.49 #2：web プロセスが落ちた後の完了で本文を空にする**。コントローラはページを読み直すが、セッションは新しい `ready` を
  無視して `load` を送り直さず、エディタの無いページが `requestBody` に `{body: ""}` で答え、それを保存していた。直し：コントローラが
  `onPageLost` で知らせ、セッションは待っている `requestBody` を諦め（状態機械の本文のまま）、読み直しの間は `requestBody` を送らず、
  次の `ready` で人・絵文字・`load`（状態機械の今の本文・世代・カーソルの行）を送り直す。`requestBody` に `id` を付け、違う `id` の
  答えは捨てる。`loaded: false` の答えは本文として扱わず、`load` を送り直す。テスト：偽の transport で読み直し・待っている要求・
  本文の無い答え・違う `id`、実際の束と WKWebView・`MobileEditorController` で `webViewWebContentProcessDidTerminate` の後に
  エディタが立ち直り、完了しても本文がそのまま（保存も起きない）、`load` の無いページが `loaded: false` で答える。

**判定**（§22.7 の表「M153a 試作」の基準：「Markdown の編集より明らかに良い・壊れない」）

iOS は**基準を満たす**（シミュレータの範囲で、上のデータの消失を直した後）。日本語の IME はかな 10 キーもローマ字も、行内の変換・候補・
変換中の削除・確定が正しく、重複も欠けも無い。変換中に届いたマージは失われず（保存はサーバがマージ）、キーボードを閉じると出る。見本の
ページは 0.1 秒で表示、打鍵はほぼ 1〜2 フレーム、画像・テーマ・カーソルの往復も通る。見たままの編集は Markdown より明らかに良い（表・
コールアウト・画像・チェックがその場で見え、`/`・`[[`・`@` が使える）。保存・衝突・上限・オフラインはネイティブの状態機械のまま。
ただし 10 万字の最初の表示は 0.62〜0.67 秒で §22.7 の目標 300 ms を超える（Debug のシミュレータ。ヘッドレス Chrome 0.08〜0.14 秒、
Android のエミュレータ 0.25 秒）。実機（Release）で測り、超えるなら長いページは見たままを遅らせて開く（読み込み中の表示）か、閲覧の画面の
まま温めた WebView に先に `load` しておく。M153b（iOS の仕上げ）に進んでよい。利用者の実機での確認が残る。

**制限（M153b へ）**

- フォーカス中は相手の編集がエディタに出ない（キーボードを閉じると出る）。橋の版 2（§30.3）で、捨てられた `replace` があっても
  相手の行は消えなくなったので、`canReplace` を `editorQuiet` から外せば Desktop のように打鍵の合間にも出せる（見た目の変更。
  Android と合わせて M153b / M153c で決める）。
- 書式の行が横スクロールの 1 行で、402 pt の幅では 「画像」 と 「キーボードを閉じる」 が画面の外（スクロールしないと押せない）。
  取り消し・やり直し・画像・閉じるを固定し、書式だけをスクロールにする。書式の状態（ON / OFF）は橋の `selection` が来てから。
- iOS 26 では OS の選択メニューが浮くツールバー（M155）に重なる（18.6 は上下に分かれる）。同梱エディタは `pointer: coarse` で浮く
  ツールバーを出さないか、選択の下に離して出す（§30.5 と共通。Desktop の成果物の変更）。
- 横向きでは WebView が 51 pt（題名の 1 行）になる。横向きでは段の切り替えと書式の行を畳む。
- 見たまま ↔ Markdown の後はキーボードが出ない（`focus` を送っていない。Android と同じ扱い）。
- 画像の直後の空の段落に出る案内（「/」でブロック…）が狭い幅で折り返して次のブロックに重なる（Desktop の成果物の CSS）。
- XCUITest は 10 万字のページのアクセシビリティの木を取るのに 1 回 60 秒以上かかる（harness は座標で操作した）。VoiceOver で長いページを
  読むときの重さは未確認。
- QWERTY ローマ字は iOS 26.5 だけ（harness が 18.6 でローマ字のキーボードに切り替えられなかった）。ライブ変換・ATOK などほかの IME、
  ハードウェアキーボード（`editorFocused` は first responder で見るので効くはず）、メモリの実機の数字は未計測。
- 子ページ・データベース・埋め込みの作成は出ない（§30.3 のとおり）。既にある埋め込みはカード。

### 30.5 M153a：Android の試作（同梱エディタの組み込みと判定、2026-10-10）

§22.7 の表「M153a 試作」の Android の分。§30.3 の成果物を Android アプリに同梱し、ページの編集を WebView の同じエディタで行う
最小の試作を作って、エミュレータで IME・選択・キーボード・10 万字・初回の表示・画像・テーマ・回転・メモリを測った。方言・サーバ・API・
Desktop の成果物の変更なし。端末ごとの設定（既定はオフ）の裏にあり、Markdown のエディタが既定のまま。

**部品**

| ファイル | 役目 |
| --- | --- |
| `app/build.gradle.kts`（`copyMobileEditor`） | `apps/shared/mobile-editor/dist` を生成物の assets の根（`build/generated/mobileEditor/editor/`、APK では `assets/editor/`）に写すタスク。variant API の `sources.assets.addGeneratedSourceDirectory` で全 variant の assets に入るので、assets を読む全タスク（merge・lint・package）がこのタスクに依存し、`src/` には何も書かない（コミットのしようがない。`src/main/assets` に写すと Gradle 9 が lint のモデルの暗黙の依存を断る）。dist が無ければ作り方（`cd apps/desktop && npm ci && npm run build:mobile-editor`）を書いて失敗する。依存に `androidx.webkit`（`WebViewAssetLoader`）を足した |
| `editor/EditorBridgeMessages.kt` | §30.3 の全メッセージの kotlinx.serialization のモデル（`NativeMessage` / `WebMessage` の sealed class、`type` で見分ける）、`EditorTheme`・`EditorCommand` の enum、`EditorBridgeCodec`（`providePages.query` の null は書き出す：エディタは「鍵が無い」ではなく `null` を見る。`load.title` などの null の既定は書かない）、`receiveCall`（JSON を JS の文字列リテラル 1 つにして `window.taylisEditor.receive(...)`。`"`・`\`・改行・U+2028 / U+2029・制御文字をエスケープ） |
| `editor/EditorBridge.kt` | 運び役。アプリ → エディタは `EditorPort.evaluate`（`WebView.evaluateJavascript`）、エディタ → アプリは `post(json)`（`TaylisBridge` の JavascriptInterface。WebView の JS スレッドで来るので main looper に順に渡す）。読めないメッセージは `refused` へ（投げない） |
| `editor/EditorSession.kt` | 1 回の編集と `CanvasSaver` の間。`ready` → `setTheme`・`setViewport {0}`・`providePeople`・`provideEmoji`・`providePages {null, 木の全部}`・`load`（人と絵文字は本文の前：チップの名前は読むときに決まる）。`changed` → `saver.edit`。`saver.revision` が動いて `text` が最後に見た / 書いた本文と違えば `replace`（マージ・相手の版・閲覧でのチェック）。`requestBody` → `bodyRequested` で `edit` + `flush`（離れる・背景）/ `edit` だけ（Markdown へ）と `caretLine`。`needPages` は木から、`pickImage`・`openLink`・`log`・版違いはアプリへ。`start`〜`end` の間 saver の `canReplace` は `editorQuiet`（下の「試作の途中で直したもの」）。`caret` とキーボードが隠れたとき `letGo`（1.1 秒後、静かなら `flush`）。答えが来ないときの `giveUp`（下の「レビュー v0.1.49」） |
| `editor/EditorHostLifecycle.kt` | WebView がどのセッションと話すか、閉じかけ（最後の本文はまだ流れる）と破棄済み、離れるセッションの答えの待ち（1 秒）と `giveUp`。`MobileEditorHost` が持つ |
| `ui/MobileEditor.kt` | `MobileEditorHost`：ページの画面が開いたときに 1 つ作って `https://appassets.androidplatform.net/editor/index.html` を読ませておく（温め）。`shouldInterceptRequest` で `/editor/*` は `AssetsPathHandler`（接頭辞を剥がして assets の根から引くので `/` に登録し、`/editor/` だけ通す）、`/attachment/<uuid>` と `/emoji/<uuid>` は `AppController.editorImage` / `editorEmojiImage`（セッション付きで API から取り、画像のときだけ。種類は先頭バイトで判定）、それ以外は 404。`shouldOverrideUrlLoading` は bundle 以外を止める。`onRenderProcessGone` で WebView を捨てて `failed`（画面は Markdown に戻る）。画像は `LruCache`（16 MB、ホストごと）。`MobileEditor` composable：`AndroidView` に WebView、その下にアプリの行（元に戻す・やり直す・`@`・画像・キーボードを閉じる）、`imePadding()`。`WysiwygEditing`（設定と、ページの最後の選択） |
| `ui/DocPage.kt` | 設定がオンで編集できるページなら、画面を開いたときにホストを作る。編集中は 「見たまま | Markdown」 のセグメント（Desktop と同じ）。Markdown へは `requestBody`（flush なし）で本文と行をもらってから、見たままへは Markdown の欄の行（`EditorCaretLink`）を `load.caretLine` に。ホストが壊れたら Markdown に戻して通知。`CanvasEditorField` に `caret`（開く行・今の行） |
| `ui/YouScreens.kt`・`AppController` | 「表示」の 「ドキュメント」 に 「ドキュメントの見たまま編集（試作）」 のスイッチ（端末だけ、既定オフ、`docs_wysiwyg`） |
| `test/EditorBridgeTest.kt`（8）・`test/EditorSessionTest.kt`（16）・`test/EditorMergeRaceTest.kt`（5）・`test/EditorHostLifecycleTest.kt`（7） | `bridge_messages.json` の全メッセージ（ネイティブ → エディタは復号して符号化し直して同じ JSON、エディタ → ネイティブは型まで、断る例は断る、未知の鍵は無視）、enum の名前、JS のリテラル（JSON としても読める）、別スレッドからの順序。セッションは本物の `CanvasSaver` + `FakeCanvasServer`：`ready` の順と中身、`changed` → 2 秒後の保存と「自分の本文は返さない」、マージ → `replace`、閲覧のチェック → `replace`、`load` の前は `replace` しない、`requestBody`（flush あり / なし、`load` の前は即答）、`caret` と WebView の再起動、ページ・人・画像・リンク・ログ・コマンド・テーマ・blur、`EditorCaretLink`、画像の種類、**フォーカス中のマージは保留して何も失わない**、離れるときの最後の本文、何も足していない答えはマージを戻さない |

**設定と切り替え**：「自分」→「表示」→「ドキュメント」→ 「ドキュメントの見たまま編集（試作）」（既定オフ、この端末だけ）。オンにすると、
編集できるページの編集画面に 「見たまま | Markdown」 が出て、既定は見たまま。選んだ方は端末に残る（`docs_wysiwyg_choice`）。オフなら
今までどおり Markdown だけ。WebView が使えない・落ちた・同梱の版が合わないときは Markdown に戻して通知を出す。

**キーボードの上のツールバーの選択**：書式の行は同梱エディタ自身の行（`env.toolbar: "bottom"`、WebView の下端に固定）をそのまま使い、
アプリは Compose の 1 行（元に戻す・やり直す・`@`・画像・キーボードを閉じる）をその下に足した。理由：(1) 書式の行は WebView の中に
あるので、押してもフォーカスが WebView を離れず Gboard が閉じない。マークの ON / OFF の状態を出せる（橋には `selection` が無い）。
Desktop・iOS と同じ道具で、狭い幅は 「…」 に畳む。(2) 元に戻す・やり直す・写真・キーボードを閉じるは Web の行に無く、ネイティブの
機能（フォトピッカー、IME を閉じる）なので Compose。Compose のボタンはタッチでフォーカスを取らないので Gboard は閉じない
（計測：キーボードを出したまま `@` を押す → IME は出たまま、エディタにフォーカスが残り、`@` が入って候補が開く）。縦向きで
2 行は収まるが、横向きではエディタがほぼ消える（下の制限）。

**計測**（エミュレータ ChikuwaChat_Pixel_9、API 36 Play arm64、SwiftShader、Gboard 18.4.1、M5 Max。実機ではない：数字は上限の目安。
Chrome DevTools（デバッグビルドの `setWebContentsDebuggingEnabled`）と `MobileEditor` の logcat で測った）

| 項目 | 結果 |
| --- | --- |
| ページの立ち上がり（WebView の作成 → `ready`） | 冷えたレンダラ 310 ms（アプリ起動後の最初のページ）、温まった後 36〜69 ms。画面を開いたときに作るので、「編集」を押すときには済んでいる |
| 本文の表示（Kotlin の `load` → 最初の `height`、端から端） | 見本のページ（235 字）50〜67 ms。10 万字（1,609 行、100,023 px）711 ms（そのプロセスでの初回）、回転後の読み直し 394〜399 ms |
| 10 万字の `load` → 次のフレーム（ページ内、§30.3 の `measureLoad` と同じ） | 242〜250 ms（ヘッドレス Chrome の M5 Max は 77〜142 ms）。§22.7 の目標 300 ms の中 |
| 打鍵（10 万字のページ、CDP `Input.insertText` で日本語 + 英数 22 字） | 取引から次のフレームまで 中央値 6.4 ms・p90 12.8 ms・最大 16.2 ms（60 Hz の 1 フレーム以内） |
| スクロール（10 万字、フリック 3 回） | 222 フレーム、中央値 17 ms・p90 17 ms・最大 50 ms、50 ms 超なし |
| メモリ（PSS） | アプリ 223 MB（見本を編集中）→ 258 MB（10 万字）。WebView のレンダラ（`sandboxed_process`）106 MB → 174 MB |
| 日本語の IME（12 キー、フリック） | 「にほんご」が行内で変換中（下線）、候補の列（日本語 / 日本語は / ニホンゴ …）がキーボードの上。候補で「日本語」。「あ」2 回 → 「い」の変換中、変換中の Backspace は消えて変換が終わる（残骸なし）、「か」+ Enter で確定。WebView は `CursorAnchorInfo`（変換中の文字と位置）を IME に返している |
| 日本語の IME（QWERTY、ローマ字） | "nihongo" → 「にほんご」、スペースで変換、Enter で「日本語」。重複・欠けなし |
| 変換中の `replace` | 「て」を変換中に別の端末が「> 引用」の行を変える → 保存がマージされ `replace` が来るが、エディタは保留（相手の行は出ない）→ Enter で確定した直後に出る。「て」はそのまま。（直す前の計測。この手順では次の打鍵をしていないので下の消失は出なかった。直した後は下） |
| 変換中のマージ（直した後） | 1 行目の末尾で 「にほん」 を変換中（CDP の `Input.imeSetComposition`、Gboard は出たまま）に android2 が API で 3 行目を変える → 保存はサーバがマージ（版 3）、エディタには何も入らない → 「日本」 で確定して 「た」 を打つ → 保存は版 3 の元の版の上に送られてマージ（版 4：「一行目日本た」 と 「三行目（相手が変えた）」 が両方残る）→ 戻るのジェスチャでキーボードを閉じる（WebView のフォーカスは残る）→ 約 1 秒で相手の行がエディタに出る。保存は増えない |
| 選択のハンドルと OS のメニュー | 長押しで OS のハンドルと操作メニュー（翻訳 / 切り取り / コピー / すべて選択 / ⋮）。**浮くツールバー（M155）はその下に隠れる**（下の制限） |
| キーボードの出し入れ | 2 つの行がキーボードの上に付いて動く（`imePadding`：ページの枠は自分で IME の分を足す。MainScreen は scaffold の inset を消費している）。JS の `focus()` ではキーボードは出ない（Android の WebView は操作のない focus で IME を出さない）：本文をタップで出る |
| テーマ | 「表示」の設定（端末に合わせる / ライト / ダーク）に `setTheme` で追う。ライト `rgb(255,255,255)`、ダーク `rgb(23,24,29)` |
| 回転 | Activity が作り直され、ホストも作り直して本文を読み直す（`ready` 48〜69 ms、10 万字 394〜399 ms）。編集中と 見たまま / Markdown の選択は残る（`rememberSaveable`）。カーソルの位置は失う |
| 画像 | アプリの行の「画像」→ フォトピッカー → `uploadCanvasImage`（pending）→ `insertImage` → `![](attachment:<id>)` が本文に入り、`https://appassets.androidplatform.net/attachment/<id>` を `shouldInterceptRequest` がセッション付きで返して表示（1080 × 2424 の写真）。保存した本文にその行がある |
| 保存の状態機械 | 10 万字に 22 字足すとサーバの 100,000 字の上限で `BLOCKED` → 「保存できませんでした」の帯と「本文をコピー」（Markdown と同じ経路） |
| 見たまま ↔ Markdown | 「2 段目」にカーソル → Markdown は 5 行目で開く → 見たままに戻すと「2 段目」。`load` の後の `focus` を送らないようにして通った（下） |

試作の途中で直したもの：`AssetsPathHandler` は接頭辞を剥がして assets の根から引く（`/editor/` に登録すると `index.html` を根に探して
`ERR_INVALID_RESPONSE`）。ページの枠は IME の分を自分で足す（MainScreen は scaffold の inset を消費する。足さないと 2 つの行が
キーボードの下に隠れる）。`load` の後の `focus` は送らない：Android の WebView ではフォーカスの無いエディタへの `focus()` が
DOM のカーソルを先頭に置き（`load.caretLine` で置いたカーソルが消える）、キーボードも出ない。英語の 「WYSIWYG | Markdown」 が
折り返したので 1 行に。

**変換中のマージで相手の行が消える**（データの消失、§30.4 と同じ穴。コミット 「Android: …」）。`EditorSession` は saver の
`canReplace` を true のままにしていた。保留された `replace` はエディタの次の編集で捨てられ、その `changed`（マージの前の本文）を
`saver.edit` がマージ済みの版の上に保存して相手の行を消す（JVM のテストで再現：直す前は 3 行目が元に戻る）。直し：`start`〜`end` の
間 `canReplace` を `editorQuiet` にした。静かとは、`editorFocused`（WebView にフォーカスがあり、IME が出ているか物理キーボードが
ある）でなく、最後の `changed`・`command`・`insertImage` から 1 秒たち、答えを待つ `requestBody` が無いこと。フォーカス中の保存は
エディタの本文の元の版の上に送られサーバがマージする。`caret`（エディタのフォーカスが外れた）と、キーボードが隠れたとき
（戻るのジェスチャでは WebView にフォーカスが残り `caret` が来ないので、Compose の IME の inset で見る）に `letGo`：1.1 秒後に
静かなら `flush`（書き出し待ちは保存、無ければマージされた版を読んで `replace`）。離れるときは最後の本文の答えまで保留し、
答えた本文が最後に書いた / 渡した本文と同じなら saver に入れない（Markdown のエディタが先に取り込んだマージを戻さない）。
`end` は saver の規則が自分のものなら true に戻す（Markdown のエディタが先に入れた規則は残す）。テスト
`whileTheEditorIsFocusedAMergeWaitsAndNothingIsLost` ほか 2 つ。エミュレータでも上の表のとおり両方残る。

**レビュー v0.1.49 の #1・#3 への対応**（2026-10-10、コミット 「Android: …」）。
- #1（書き出し待ちの間に届いたマージ）：指摘の手順（元 `a\nb\nc`、自分の `A\nb\nc` の保存中に `AA` が WebView の 300 ms 待ちにあり、
  相手が `a\nb\nREMOTE`、応答は `A\nb\nREMOTE`）を `test/EditorMergeRaceTest.kt`（5）で再現した。BridgeSink の規則（300 ms の書き出し・
  変換中と書き出し待ちの保留・書き出しで保留を捨てる・`requestBody` の即答・blur で書き出してから `caret`）を真似る WebView 役と、
  本物の `CanvasSaver`・`EditorSession`・`FakeCanvasServer` を繋ぐ。打鍵中・変換中・直後の `requestBody`（前後どちらも）は、上の
  `editorQuiet` の修正（907c66f3）の後の main で既に `AA\nb\nREMOTE` になり、次の保存の `baseRevId` は自分の `A\nb\nc` の側の版
  （マージ後の head ではない）。**まだ消えた**のは、書き出し待ちのままキーボードを閉じた場合（戻るのジェスチャ、または閉じる IME が
  変換を確定した直後）：`editorFocused` は IME の inset が消えた時点で偽になり、最後の `changed` から 1 秒たっていれば静かと見なされ、
  その間に届いた応答で基準をマージ後へ進め、保留された `replace` が書き出しで捨てられて REMOTE が消えた。直し：(1) `editorFocused` は
  WebView のフォーカスだけで見る（浮くキーボード・物理キーボード・閉じかけの IME は inset に出ない）。(2) キーボードが隠れたら
  画面がエディタを blur（書き出してから `caret`）し、WebView のフォーカスを外す（`MobileEditorHost.letGoOfFocus`）。マージはそれまで
  保留され、外れた後に来る（見え方は前と同じ：キーボードを閉じると約 1 秒で出る）。(3) `letGo` も編集と同じく 1 秒の静けさを
  始める（その後の書き出しはマージの前の本文）。橋の契約（`bridge.ts`）は変えていない（本文の世代は使っていない）。
- #3（閉じるときの最後の入力）：`release()` が先に `released` を立て、送る口も受ける口も閉じたため、WebView の 300 ms 待ちにある
  最後の入力が保存されなかった。ホストの寿命を `editor/EditorHostLifecycle.kt` に分けた：**閉じかけ**（`release` 後。最後の
  `requestBody` を送り、答えを受けて `CanvasSaver` に渡し、すぐ保存）と**破棄済み**（WebView が無い。何も送らず受けない）。
  `detach` と `release` はどちらの順でも同じ終わり方（要求は 1 回）。1 秒以内に答えが無ければ `EditorSession.giveUp`：saver が持つ
  最後の `changed` をそのまま保存し（捨てない）、待っていた側には最後の行を返す。レンダラが落ちたときも同じ。離れたセッションの
  答えは、その後に開いたセッションより先に届くので、そのセッションに渡す（待っている間はマージも保留）。閉じる間はページの
  保存の状態機械を `WikiHub.hold` で持ち続け、終わってから放す（放すと `flush`）。`test/EditorHostLifecycleTest.kt`（7）。
  実機・エミュレータの instrumentation test はしていない（JVM のテストだけ）。

**判定**（§22.7 の表「M153a 試作」の基準：「Markdown の編集より明らかに良い・壊れない」）

Android は**基準を満たす**（エミュレータの範囲で）。日本語の IME は 12 キーも QWERTY も、行内の変換・候補・変換中の削除・確定が
正しく、重複も欠けも無い。変換中のマージは失われず（保存はサーバがマージ）、キーボードを閉じると出る（上のデータの消失を直した後）。10 万字は 0.25 秒で立ち上がり、打鍵は 1 フレーム、スクロールは
60 Hz。見たままの編集は Markdown の編集より明らかに良い（表・コールアウト・画像・チェックがその場で見え、`/`・`[[`・`@` が
使える）。壊れない：保存・マージ・衝突・上限・オフラインはネイティブの状態機械のまま。M153c（Android の仕上げ）に進んでよい。
残るのは実機（Pixel / 低い端末）の数字と、下の制限。

**制限（M153c へ）**

- フォーカス中は相手の編集がエディタに出ない（キーボードを閉じると出る）。iOS と同じ（§30.4 の制限、橋の契約の変更で）。
- OS の選択メニューが浮くツールバー（M155）を隠す。同梱エディタは `pointer: coarse` で浮くツールバーを出さない（書式は下の行にある）か、
  選択の下に出す（Desktop の成果物の変更。iOS と共通）。
- 同梱エディタの `focus` はフォーカスの無いときに選択を保つべき（`editor.commands.focus(selection.from)`）。それまで Android は送らない。
- 横向きでは上の帯 + 2 つの行 + 下のナビでエディタがほぼ消える（10 万字の帯つきで 36 CSS px）。横向きではアプリの行を隠す、または
  書式の行だけにする。
- 回転でカーソルの位置を失う（`caret` をホストに残して `load.caretLine` に渡せば済む）。
- 画像のキャッシュはホストごと（ページを開き直すと取り直す）。`LruCache` 16 MB。
- `height` と `focusTitle` は使っていない。`needPeople` は毎回全部を送り直す。
- 子ページ・データベース・埋め込みの作成は出ない（§30.3 のとおり）。既にある埋め込みはカード。
- CI：`.github/workflows/ci.yml` の android ジョブは bundle を作らないので、`apps/desktop` で `npm ci && npm run build:mobile-editor` を
  先に走らせる 1 手（または desktop ジョブの成果物を渡す）が要る（この試作では ci.yml を触っていない）。
- エミュレータ（SwiftShader）の数字で、実機は未計測。Gboard 以外の IME（ATOK・Samsung）も未計測。
