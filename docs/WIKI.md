# WIKI（ドキュメント：研究室のマニュアルとノート、Notion の置き換え）

2026-10-07 の設計。**M120（サーバ：木と権限）・M121（Desktop / Web）・M122（iOS / Android）・M123（データベース：サーバと Desktop / Web）は実装済み**（2026-10-07、§14〜§18）。M124 以降（スマホのデータベース・取り込み）はまだ。
利用者（研究室の教員）の要望：研究室の Notion を Taylis の中の GitBook / Notion のような知識ベースに置き換えたい。
§13.2 の質問は 2026-10-07 に利用者が推奨どおりに決めた。Q8（データベース）は同じ日に答えがあった：**関係（relation）とカレンダーのビューを使っている、行数は数百**。これで M123 の範囲を広げた（§5.7・§5.8・§12）。Q9 だけ未決。

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
| 見たまま編集（WYSIWYG） | v1 はキャンバスと同じ Markdown + プレビュー。Desktop / Web のリッチ入力（TipTap、2026-10-06 のリッチな入力欄）の流用は後（§7.3、§13 Q6） |
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
| `full`（フルアクセス） | 上に加えて、共有設定、移動、ゴミ箱・復元、版の本文の消去、データベースのプロパティ（列）とビューの設定 |

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
  （画面は読み直して出し直す）。

### 5.4 ビュー（表とカレンダー）

- ビューはデータベースに保存して全員で共有する（`full` の人が作る・直す）。端末ごとの一時的な並べ替え・絞り込みもできる（保存しない）。
- 表：見せる列と順番・幅、並べ替え（複数のキー）、絞り込み（条件の AND。型ごとの演算：含む / 等しい / 空 / 範囲 / 自分）。
  まとめる（group by）は v1.1。
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

**利用者に、実際の書き出し（小さな部分でよい）をもらって確かめる。** 以下は Notion の書き出しについて分かっていることからの推測で、
M125 の最初にサンプルで確かめて直す。

### 6.1 書き出しの形（推測）

- 「書き出し」→ 形式「Markdown & CSV」、「サブページを含める」、「サブページのフォルダを作る」→ zip。大きいワークスペースは
  zip の中に zip（`Export-…-Part-1.zip` など）に分かれることがある。
- ページは `題名 <32 桁の 16 進の id>.md`。サブページは同じ名前（id 付き）のフォルダの中。
- ページの先頭は `# 題名`。データベースの行のページは題名の後にプロパティの行（`プロパティ名: 値`）。
- データベースは `題名 <id>.csv`（ビューに出ている列）と `題名 <id>_all.csv`（すべての列。新しい書き出し）、行のページは
  同じ名前のフォルダの中の `.md`。
- 画像・ファイルはページのフォルダの中。本文からは URL エンコードした相対パス（`![](題名%20<id>/image.png)`）。
- ページ間のリンクは相対パスの `.md`（`[題名](題名%20<id>.md)`）か `https://www.notion.so/…<id>`。
- コールアウトは `<aside>`、トグルは箇条書きか `<details>`、数式は `$$…$$`、人のメンションは `@名前` の文字、同期ブロックは中身の写し、
  埋め込み・ブックマークはリンク、列のレイアウトは縦に並べたもの。
- 入っていないもの（たぶん）：アイコン・カバー、共有設定、コメント、ページの履歴、ビューの設定（絞り込み・並べ替え・ボード）、
  作成者（CSV の「作成者」列があれば別）、作成・更新の日時（同上）。
- CSV の値：チェックは `Yes` / `No`、マルチセレクトは `, ` 区切り、日付は Notion の表示の形（`2026年10月7日`、`October 7, 2026`、
  `2026/10/07`、時刻やタイムゾーン付き、範囲は `→`）、関係は `題名 (題名%20<id>.md)` の並び、人は名前。

### 6.2 対応

| Notion | Taylis |
| --- | --- |
| ページ（`.md`） | ページ。題名は先頭の `# ` の行（無ければファイル名から id を除いたもの）。本文は残り |
| サブページのフォルダ | 子ページ（並びは親の本文に出てくる順、無ければ名前順） |
| データベース（`_all.csv` を優先、無ければ `.csv`） | `kind = 'database'` のページ。列 → プロパティ（型を推測、§6.3）、行 → 行（`kind = 'row'`） |
| 行のページ（`.md`） | 行の本文（先頭のプロパティの行は CSV と一致すれば外す） |
| 画像・ファイル | 添付（BlobStore、`page_id`）。`![](attachment:<id>)` / `[名前](attachment:<id>)` に書き換え。大きさ・形式は今の添付と同じ検査 |
| ページ間のリンク（相対パス・notion.so の URL） | 取り込んだページなら `[題名](page:<uuid>)`。取り込んでいないものは元のまま（Notion の URL） |
| `<aside>` | 引用（`> 💡 …`） |
| `<details>` | 見出しの無い箇条書き（中身は 1 段下げる） |
| `@名前` | 名前が 1 人のユーザーの表示名・ユーザー名と一致すれば `<@uuid>`（`--user-map` で指定もできる）。それ以外は文字のまま。取り込みではメンションの通知を出さない |
| 数式・コード・表 | そのまま（キャンバスの方言と同じ書き方） |
| 本文が 100,000 字を超えるページ | 前から分けて「（続き 2）」の子ページにする（報告に出す） |

### 6.3 CSV の型の推測

列ごとに空でない値を全部見て、最初に当てはまるもの：

1. すべて `Yes` / `No`（大小を問わない）→ `checkbox`
2. すべて数（`,` の位取り・`%`・`¥` を許す）→ `number`
3. すべて日付として読める（上の形、範囲の `→`、時刻）→ `date`
4. すべて `http(s)://` → `url`
5. すべて「Taylis のユーザーの名前」の並び（`--user-map` と表示名の一致）→ `person`
6. `, ` で区切ると値が繰り返し出る（異なる値が 50 個以下、行数の半分以下）→ `multi_select`
7. 異なる値が 50 個以下で繰り返しがある → `select`
8. 関係（`… (….md)` の並び）→ `text`（題名の並び。行の本文の末尾にリンクとしても入れる）
9. それ以外 → `text`

`--dry-run` は列ごとに推測した型を出す。`--column-types file` で列の型を指定し直せる。数式・ロールアップの列は「取り込んだ時の値」
（テキストか数）として入れ、プロパティの説明に「Notion の数式（取り込み時の値）」と書く。

### 6.4 誰が・どう動かすか

- **管理者がサーバで実行するコマンド**（v1）：

  ```text
  python -m app.cli import-notion /import/notion-export.zip --actor admin \
    --parent <page_id> | --top-level --access workspace-edit | workspace-view | private \
    [--user-map users.txt] [--column-types types.txt] [--dry-run]
  ```

  Slack・Mattermost の取り込み（infra/README.md）と同じ流れ：試し読み（`--dry-run`：ページ数・データベースと列の型・
  取れないファイル・壊れたリンク・長すぎるページ）→ 本番。zip はサーバの `/import` に置く（数 GB でも Caddy を通さない）。
- Web から zip を上げて進み具合を出す画面は、要望があれば後（ジョブの表と進み具合のイベントが要る。§13 Q9）。
- **何度でも実行できる**：`import_refs (source = 'notion', source_id = Notion の id)` で対応を覚える。もう一度実行すると：
  - まだ無いページ・行・添付を足す。
  - 取り込んだ後に Taylis で編集されていないページ（head が取り込みの版）は新しい書き出しで上書きする（新しい版 `kind = 'import'`）。
  - 編集されたページは触らず、報告に出す。
- 共有設定は移らないので、取り込んだ根に `--access` の権限を付け、残りは受け継ぐ。教員だけのページなどは取り込み後に管理者が設定する
  （報告に「Notion で共有が限られていたかもしれないページ」は出せない。書き出しに情報が無いため）。**全員に見えてはいけない
  ページがある場合は `--access private` で取り込み、確かめてから共有を広げる**手順を infra/README.md に書く。
- 上限：zip の展開後 20 GB、ファイル 1 つは添付の上限（`attachment_max_bytes`）まで（超えたものは報告して飛ばす）、
  ページ 20,000、パスの長さ・文字コード（Windows で作られた zip の名前）は Python の `zipfile` で両方を試す。
- 取り込みの監査ログ：`wiki.imported`（ページ数・行数・添付の数・実行した人）。

### 6.5 取り込めないもの（利用者に伝える）

コメント、共有設定、ページの履歴、ビュー（絞り込み・並べ替え・ボード・カレンダー）、関係・ロールアップ・数式の「生きた」計算
（値だけ）、アイコンとカバー（書き出しに無ければ）、同期ブロックの同期（写しになる）、ボタン・AI ブロック、埋め込み（リンクになる）、
文字の色と背景色、列のレイアウト（縦に並ぶ）、リンクされたデータベース（別のデータベースのビュー）。

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
  - アクティビティの項目（`include=page_mention,page_shared`。知らない端末には出ない）。
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
| GET / PATCH | /wiki/databases/{id}、/wiki/databases/{id}/schema | スキーマとビュー／スキーマの変更 `{ops, base_schema_version}` | view／full |
| PUT / DELETE | /wiki/databases/{id}/views/{view_id} | ビューの保存・削除 | full |
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
| M125 | Notion からの取り込み | §6：`app.cli import-notion`（試し読み・本番・再実行）、infra/README.md の手順 | 利用者からもらった書き出しのサンプルで、ページ・木・データベース・画像・リンクが移り、報告（取れないもの）が出る。もう一度実行しても増えない。編集したページを上書きしない |
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
| Q6 | 編集の形 | **キャンバスと同じ Markdown + プレビュー + 行頭の `/` メニュー**（キャンバスのエディタ）。見たまま編集は要らない（後で検討） |
| Q7 | ページへのコメント | **v1 は作らない** |
| Q8 | データベースの使い方 | **関係（relation）とカレンダーのビューを使っている、行は数百**（2026-10-07）。M123 に関係（§5.7）とカレンダー（§5.8）を入れ、M124 のスマホは表をカード・カレンダーを予定の一覧で出す。ロールアップ・数式・ボードは v1 の後 |
| Q10 | キャンバスとの関係 | 推奨どおり：会話の議事録・週報はキャンバス、長く残すものはドキュメント。「ドキュメントへ移す」は M126（任意） |
| Q11 | スマホでどこまで | **閲覧・軽い編集（セクション / 全体）・データベースの行の値の変更**。共有の設定と移動はパソコン（Desktop / Web）だけ |
| Q12 | 画面の名前 | **「ドキュメント」**（英語 Docs、中国語 文档） |
| Q13 | ページのフォロー（変更の通知） | **後で**。v1 はメンションと共有の通知だけ |
| Q14 | 公開ページ | **後で**（§4.9 の形を残す） |

### 13.3 まだ利用者に確かめること

8. ~~**データベース**~~：答えがあった（2026-10-07、§13.2 Q8：関係とカレンダー、数百行）。
9. **Notion の書き出しのサンプル**（データベース 1 つと、画像のあるページ・サブページのあるページを含む小さな部分）。全体の大きさ（GB）と
   ページ数の目安（M125 の前に）。取り込みはサーバでのコマンドで始める（Web から zip を上げる画面は要望があれば後）。

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
  自分のゴミ箱の一覧に編集できる行も出す）。スキーマとビューは**フル**。
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
| PATCH | `/wiki/databases/{id}/schema` | `{base_schema_version, ops: [add \| update \| retype \| delete \| reorder]}`（フル）。409 `wiki_schema_conflict` |
| PUT / DELETE | `/wiki/databases/{id}/views/{view_id}` | ビューの保存（id は端末が作る）・削除（フル。最後の 1 つは 409 `wiki_last_view`） |
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
