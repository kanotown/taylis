# WIKI（ドキュメント：研究室のマニュアルとノート、Notion の置き換え）

2026-10-07 の設計提案。**まだ実装していない**（状態は「設計」）。利用者（研究室の教員）の要望：研究室の Notion を Taylis の中の
GitBook / Notion のような知識ベースに置き換えたい。

利用者の回答（2026-10-07）：

| 質問 | 回答 |
| --- | --- |
| Notion で使っているもの | ふつうのページ（見出し・リスト・画像・表）、**データベース**（論文リスト・備品台帳・学生の進捗などの表）、**入れ子のページ**（ページの木） |
| 見える人の決め方 | Notion のような**ページごとの共有設定**（チャンネルのメンバーだけでは足りない） |
| ログインしていない人への公開 | 今は要らない（後で足せるようにしておく） |
| Notion からの取り込み | ほぼ確実に要る（Notion の書き出し「Markdown & CSV」、サブページを含む zip） |

画面の名前は仮に「ドキュメント」、コード上の名前は `wiki`（モジュール `app/modules/wiki/`、表 `wiki_*`、API `/wiki/*`）。

## 0. 結論

- **新しい実体「ページ」（`wiki_pages`）を作り、キャンバスの本文・版・保存・マージ・描画・エディタを部品として使い回す。**
  キャンバスに「持ち主 = 会話 | ウィキ」を足す一般化は採らない（§2）。
- **木は 1 つ**（ワークスペースの「ドキュメント」）。最上位のページが Notion のチームスペースの代わりになる。スペースの表は作らない。
- **権限は Notion と同じ「親から受け継ぐ + ページごとに足す / 絞る」。** 相手は「ワークスペースの全員（ゲストを除く）」「グループ」
  「人」、段階は「閲覧 / 編集 / フルアクセス」。受け継いだ結果（実効の権限）を表 `wiki_effective_grants` に持ち、権限・移動の
  たびに同じトランザクションで部分木を計算し直す。読めないページは存在ごと隠す（404）。管理者も黙っては読めない（§4）。
- **データベースは「行がページ」の最小形**：型付きのプロパティ（テキスト・数値・セレクト・マルチセレクト・日付・人・チェック・URL）と
  表のビュー（並べ替え・絞り込み）。関係（relation）・ロールアップ・数式・ボード・カレンダーは v1 に入れない（§5）。
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
| データベースの関係（relation）・ロールアップ・数式 | 実装と 3 端末の表示の費用が大きい。取り込みでは「取り込んだ時の値」をテキストとして残す（§6.4） |
| ボード・カレンダー・ギャラリーのビュー | まず表。ボード（セレクトでまとめる）は次の段（§5.6） |
| 行ごとの共有設定 | 行はデータベースの権限をそのまま使う（表を見る人ごとに行を絞らずに済む） |
| ページへのコメント（範囲・ページ全体） | 未決（§13 Q7）。当面はページのリンクを会話に貼り、そのスレッドで話す |
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
| `channel`（v1 では作らない） | 会話のメンバー | 未決（§13 Q4）。列はこのまま値を足せる |

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
  作った人の `user: full` だけ（§13 Q2）。子ページは何も付けずに受け継ぐ。

### 4.3 管理者

- **管理者でも、共有されていないページは読めない**（自分との DM のキャンバスを管理者が読めないのと同じ。学生の個人のメモを守る）。
- その代わり、管理画面の「ドキュメント」で**題名と共有の要約**（実効の相手と段階、最終更新）を一覧でき、次ができる：
  - **引き取り**（`POST /admin/wiki/pages/{id}/takeover`）：自分に `full` を付ける。監査ログ `wiki.access_takeover` に必ず残る。
    卒業でフルアクセスの人がいなくなったページ、間違えて全員から外したページを戻すため。
  - 完全削除（ゴミ箱）。
- 一覧に題名を出すことは許す（管理者は運用者であり、SECURITY.md §1 のとおり技術的にはすべて読める。題名まで隠すと引き取りが
  できない）。§13 Q5 で利用者に確かめる。

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

### 5.4 ビュー（表）

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
| 上の型、表のビュー、並べ替え・絞り込み、行の本文、CSV の書き出し、行の追加・削除（ゴミ箱）、行の履歴 | ボード（セレクトでまとめる）、まとめる（group by）、カレンダーのビュー、`files` の型、CSV の読み込み（既存のデータベースへ）、関係・ロールアップ、ページの中に埋めるデータベース（インライン）、数式 |

CSV の書き出し：ビューの今の並べ替え・絞り込み・列で、UTF-8（BOM 付き、Excel のため）。人は表示名、セレクトは名前、日付は ISO 8601。

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
| M120 | ドキュメントのサーバ：木と権限 | `core/doctext` の切り出し（キャンバスの振る舞いは変えない）、`wiki_pages`・版・自前 / 実効の権限・リンク・ゴミ箱・画像（`attachments.page_id`）・変更のフィード・`wiki.*` イベントと audience `page`・メンションと共有の通知・`/search/pages`・`/p/`・管理者の引き取り・`wiki-acl --verify`。移行 0095〜 | pytest：権限の表（受け継ぎ・足す・絞る・移動・`keep_access`・復元・ゲスト・グループ・管理者・最後の full）を全部の経路（ページ・画像・検索・バックリンク・解決・イベント・通知・書き出し）で確かめ、読めない人に題名が 1 か所も出ないこと。実効の表と全部の計算し直しが常に一致。キャンバスのテストがすべて通る。1 万ページの判定・読める集合・1,000 ページの移動を測って §4.6 の目標に入る。OpenAPI・ws-events を再生成 |
| M121 | ドキュメント：Desktop / Web | §9.1（データベースを除く）：木・ページ・編集（`[[`、`/` のメニュー、子ページを作る）・共有の画面・移動（確認）・ゴミ箱・履歴・バックリンク・検索のタブ・`/p/` のカード・アクティビティ・管理の一覧 | tsc・vitest（共有の画面の受け継ぎの表示、変更のフィードの取り込み、`page:` の字句解析のケース）・vite build・`cargo check`。ブラウザで 2 人（片方はゲスト）で、共有の追加・絞り込み・移動で見えたり消えたりすることを確認 |
| M122 | ドキュメント：iOS / Android | §9.2（データベースを除く）：木・閲覧・セクション / 全体の編集・オフライン閲覧・パーマリンク・プッシュ（`page_mention`・`page_shared`） | xcodebuild のテストと Gradle のビルド・テスト。`canvas_markdown.json` の追加のケースが 3 端末で通る。実機 / シミュレータで通知から開ける |
| M123 | データベース：サーバと Desktop / Web | §5：スキーマ・行・プロパティの変更（マスごとの後勝ち）・ビュー（表、並べ替え・絞り込み）・行の履歴・CSV の書き出し | pytest（型ごとの値の検査と変換、並べ替え・絞り込みの共通のケース `apps/shared/wiki_db_query.json`、5,000 行で 50 ms 以下）、Desktop の表の編集とサイドピーク |
| M124 | データベース：iOS / Android | §5.5：ビューを選んでカードの一覧・行のフォーム・本文 | 3 端末で同じデータベースを開き、同じ並びと値になる。ビルドとテスト |
| M125 | Notion からの取り込み | §6：`app.cli import-notion`（試し読み・本番・再実行）、infra/README.md の手順 | 利用者からもらった書き出しのサンプルで、ページ・木・データベース・画像・リンクが移り、報告（取れないもの）が出る。もう一度実行しても増えない。編集したページを上書きしない |
| M126 | AI と仕上げ（任意） | §8.2 の「AI に聞く」をページへ、キャンバスの「ドキュメントへ移す」（§2.4）、編集中の表示 | AI：読めないページ・`allow_private` の無いボットへの非公開ページが資料に入らないことをテスト。移す：画像の複製と元のキャンバスの案内の行 |

v1 の後の候補：見たまま編集（Desktop / Web）、ボードのビューとまとめる、ページのコメント、ページのフォロー、関係（relation）、
ページの中のデータベース、CSV の読み込み、Web からの取り込み、公開ページ。

### 12.1 実装と同時に直す docs

ARCHITECTURE.md（§5 のモジュールと依存、判断 D26「ドキュメントは別の実体、本文の部品はキャンバスと共有、権限は受け継ぎ +
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

### 13.2 利用者への質問

1. **木は 1 つでよいか**（研究室全体の「ドキュメント」に最上位のページを並べる。チームスペースのような区分を別に作らない）。今の Notion の
   最上位はどんな区分か。
2. **新しい最上位のページの既定**：「全員が編集できる」でよいか（「全員が閲覧、作った人だけ編集」にもできる）。
3. **ゲスト（卒業生など）**：ページを見せる必要があるか。見せるなら「名前を挙げた人だけ」でよいか（グループ `alumni` で一括に見せたいか）。
4. **会話（チャンネル）のメンバーを共有の相手にしたいか**（例：「#プロジェクトA のメンバー」）。グループで足りるか。
5. **管理者（先生）は学生のプライベートなページを読めなくてよいか**（提案：読めない。題名と共有の一覧と、記録に残る「引き取り」だけ）。
6. **編集の形**：キャンバスと同じ Markdown + プレビュー（`/` のメニュー付き）で始めてよいか。Notion のような見たまま編集が最初から要るか。
7. **ページへのコメント**は要るか（要るなら、ページ全体へのコメント欄か、範囲に付けるコメントか）。
8. **データベース**：今使っているプロパティの型、関係（relation）・ロールアップ・数式を実際に使っているか、ボードやカレンダーのビューを
   使っているか。いちばん大きいデータベースの行数。
9. **Notion の書き出しのサンプル**（データベース 1 つと、画像のあるページ・サブページのあるページを含む小さな部分）。全体の大きさ（GB）と
   ページ数の目安。取り込みはサーバでのコマンドでよいか（Web から zip を上げる画面が要るか）。
10. **キャンバスとの関係**：会話の議事録・週報はキャンバスのまま、長く残すものをドキュメントに、という分け方でよいか。キャンバスを
    ドキュメントへ移す機能は要るか。
11. **スマホでどこまで**：閲覧と軽い編集（セクション）、データベースの行の値の変更でよいか。共有の設定・移動はパソコンだけでよいか。
12. **画面の名前**：「ドキュメント」「Wiki」「ナレッジ」「ノート」のどれがよいか（「ドキュメント」は添付の「文書」と紛れるかもしれない）。
13. **変更の通知**：ページの「フォロー」（誰かが変えたら知らせる）は要るか。今の案はメンションと共有だけ。
14. **公開ページ**：後で要りそうか（例：研究室のホームページ代わり）。今は作らないが、作る時期の目安。
