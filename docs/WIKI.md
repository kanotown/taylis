# WIKI（ドキュメント：研究室のマニュアルとノート、Notion の置き換え）

2026-10-07 の設計。**M120（サーバ：木と権限）・M121（Desktop / Web）・M122（iOS / Android）・M123（データベース：サーバと Desktop / Web）・M124（スマホのデータベース）・M125（Notion の取り込み）は実装済み**（2026-10-07、§14〜§21）。残りは M126（任意）。
2026-10-08 に「Notion の使い心地に近づける」（データベースとビューを利用者が育てる・テンプレート・見たまま編集、スマホの見たまま編集も後で）を設計して利用者が決めた（§22、M144〜M153）。**M144（データベースを編集者が育てる）は実装済み**（2026-10-08、§23）。
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
  行のペイン（行のページ。⤢ で全体）。狭い画面では横にスクロールし、行はページとして開く。
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
- **ブリッジ**（メッセージの形は `apps/shared/editor_bridge.json` に書き、両 OS と JS のテストで同じケースを読む）：
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
| M149 | 方言：コールアウト・トグル・データベースの埋め込み | 検索・AI の本文から `:::` を外す、取り込みの `<aside>`、`wiki-rewrite-callouts`、`canvas_markdown.json` | 描画、Markdown のエディタの `/` に 3 つ、埋め込みの表 | 描画（トグルの開閉は端末ごと）、ツールバー | 中（3 端末で 4〜6 日） |
| M150 | 見たまま編集・第 1 段（Desktop / Web） | `users.docs_editor_mode` | `PageEditor.tsx`・`pageMarkdown.ts`、往復の不変条件とコーパスのテスト、`/`・`[[`・`@`、打ち方の変換、画像、マージの差し替え、モードの切り替え（既定は見たまま） | — | 大（1.5〜2 週） |
| M151 | 見たまま編集・第 2 段（Desktop / Web） | — | ブロックのハンドルとドラッグ、⌘⇧↑↓、＋ でブロック、HTML の貼り付け、表のマスの直接編集、⌘K のページ | — | 中 |
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
  そのまま残す（キャンバスの動きは変えない）。
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
