# 文書のプレビュー (M108)

PDF と Office の文書 (doc / docx、xls / xlsx、ppt / pptx、odt / ods / odp、rtf) を、Slack のように
タイムラインでは 1 ページ目のサムネイル付きのカード、開くとアプリの中の PDF ビューアで全ページ見せる。
ダウンロード・ほかのアプリで開くは今までどおり残す。利用者の了承: 2026-10-05。

関連: DATA_MODEL.md「attachments」(列)、SECURITY.md §4「文書のプレビュー」(閉じ込め)、infra/README.md
「文書のプレビュー (converter)」(運用・資源)、SYNC_PROTOCOL.md §7.3 (`message.updated` の差分)。

## 1. 全体

```
アップロード (POST /attachments)
  └ 型を判定 → プレビューを作る種類なら preview_status = pending (応答はすぐ返す。変換は待たない)
        │ (upload が preview loop を起こす)
        ▼
preview loop (app の中の 1 本のバックグラウンドループ、1 件ずつ)
  1. 期限の来た pending を 1 件 claim (FOR UPDATE SKIP LOCKED、試行回数 +1、claim 番号 n +1、リース)
  2. オブジェクトストアから一時ディレクトリへ落とす
  3. Office なら converter (Gotenberg の LibreOffice) で PDF に。PDF はそのまま
  4. 子プロセス (pypdfium2) で 1 ページ目を WebP (幅 800 px) に、ページ数を数える
  5. attachments/{id}.preview.{n}.pdf (Office のみ) と attachments/{id}.preview.{n}.webp を保存
  6. 行がまだ claim 番号 n のままなら ready に。メッセージに付いていれば message.updated (change = "attachments")
```

- 変換はリクエストの中で決して行わない。アップロードの応答は今までどおりの速さ。
- converter は別のコンテナ (`converter` サービス、Gotenberg 8 の LibreOffice だけのイメージ)。app からだけ届く
  internal ネットワークに置き、外へは出られない (§4)。
- 1 ページ目のサムネイルとページ数は PDF からサーバが作る (pypdfium2、Apache-2.0 / BSD-3-Clause。PyMuPDF は AGPL
  なので使わない)。Office ファイルの変換だけが converter を要る。

## 2. 対象

| 種類 | 判定 (先頭バイトから sniff した `content_type`) | converter |
| --- | --- | --- |
| PDF | `application/pdf` | 不要 |
| Word | `application/msword`、`…wordprocessingml.document` | 要 |
| Excel | `application/vnd.ms-excel`、`…spreadsheetml.sheet` | 要 |
| PowerPoint | `application/vnd.ms-powerpoint`、`…presentationml.presentation` | 要 |
| OpenDocument | `…opendocument.text` / `.spreadsheet` / `.presentation` | 要 |
| RTF | `application/rtf` | 要 |

- `filetype` が ZIP / OLE のまま型を決められなかったもの (`application/zip`、`application/x-ole-storage`、
  `application/octet-stream`) だけ、元のファイル名の拡張子が上の Office の拡張子のときに対象にする
  (`preview_kinds.source_kind`)。ファイル名はそれ以上使わない: converter には `document.<拡張子>` で渡し、
  ストレージキーにも入れない。
- `PREVIEW_MAX_INPUT_BYTES` (既定 50 MB) より大きいファイルは対象外 (`preview` は null)。
- `PREVIEWS_ENABLED=false` なら何も作らない。`PREVIEW_CONVERTER_URL` が空なら Office は対象外で、PDF だけ作る。
  開発 (compose を使わない uvicorn) とテストはこの状態 (テストは converter を差し替える)。
- キャンバスの本文の添付も作る (変換はする) が、イベントは出さない (読むたびに最新を返す)。

## 3. 状態と再試行

`attachments.preview_status`:

| 値 | 意味 | クライアント |
| --- | --- | --- |
| `none` | 対象外、またはプレビュー機能より前・機能が切れていた間のファイル | 今までのファイルの行 (`preview` は null) |
| `pending` | 作成待ち・作成中・再試行待ち | カードに「プレビューを作成中…」 |
| `ready` | できた | 1 ページ目のサムネイル、開くと全ページ |
| `failed` | 作れなかった (`preview_error` に理由) | 今までのファイルの行 |

- claim: `preview_status = 'pending' AND preview_next_at <= now()` の一番古い行を `FOR UPDATE SKIP LOCKED` で取り、
  `preview_attempts` を 1 増やし、`preview_next_at` を「今 + リース」(変換の上限 + 描画の上限 + 5 分) にして
  コミットしてから仕事をする。仕事の間はトランザクションを持たない。途中でサーバが止まっても、リースが切れれば
  もう一度取られる。
- 一時的な失敗 (converter に届かない・混んでいる (429 / 503)・時間切れ・オブジェクトストアの失敗・予期しない例外) は、
  1 分 → 10 分 → 1 時間 待って再試行。`PREVIEW_MAX_ATTEMPTS` (既定 3) 回で `failed`。
- 恒久的な失敗 (converter が 4xx で断った・変換後の PDF が大きすぎる (`PREVIEW_MAX_OUTPUT_BYTES`、既定 100 MB)・
  PDFium が読めない (壊れている、パスワード付き、時間切れ)) はその場で `failed`。
- リースが切れた行の試行回数がもう上限なら、もう一度は変換せず `failed` (「最後の試行が終わらなかった」)。
  同じファイルでサーバを繰り返し落とし続けることはない。
- **試行の持ち主（レビュー v0.1.37 #4、移行 0086）**：claim のたびに `preview_generation`（claim 番号）を 1 増やし、
  試行はその番号を持って仕事をする。結果を書くのは、行をロックしたうえで、まだ `pending`・削除されていない・
  `preview_generation` が自分の番号のときだけ。リースより長くかかった試行の間に別の試行が取り直していれば、
  古い試行は成功でも失敗でも何も書かない（それまでは古い試行の恒久的な失敗が先に届くと、新しい試行の成功が
  書けず `failed` のままになった）。オブジェクトのキーにも番号を入れる（`attachments/{id}.preview.{n}.pdf` /
  `.webp`）ので、古い試行は新しい試行のオブジェクトを上書きも削除もできない。持ち主でなくなった試行・処理中に
  削除・GC された添付では、その試行が保存したオブジェクト（自分の番号のキーだけ）をその場で消す。
- **途中までの保存（レビュー v0.1.37 #9）**：保存するキーは put の前に記録し、失敗・取り消し（停止）のときは
  記録したキーを消す（PDF は保存できてサムネイルの保存に失敗した、など。それまでは PDF が誰のものでもなく
  残り、GC でも消えなかった）。プロセスごと止まって消せなかった分は、キーが番号から決まるので、その行の後の
  試行が `ready` / `failed` で終わったときに番号 1 .. n-1 のキーを消し、GC も添付を消すときに番号 1 ..
  `preview_generation` と番号の無い旧キー（M108）を消す（無いキーの削除は何もしない）。

### イベントとの順序

- メッセージに付いた添付 (`attached`) のプレビューが `ready` / `failed` になったら、そのメッセージの `updated_seq`
  を進めて `message.updated` (`change = "attachments"`) を出す (動画の backfill と同じ)。端末は差分同期でも
  受け取る。再試行待ち (pending のまま) では出さない。
- 送信 (bind) と競るので、ロックの順序をそろえる: 送信は「チャンネル → 添付」の順に取る (bind は自分の
  pending の添付を `FOR UPDATE` で読む)。preview loop も、メッセージに付いた添付なら先にチャンネルの行を
  ロックしてから添付をロックして書く。まだ pending の添付なら添付だけをロックして書く。これで
  「送信が古いプレビューの状態を読んで `message.created` を出し、その後の `ready` が誰にも知らされない」
  ことがない (送信が待つか、loop が bind 後の行を見て `message.updated` を出すかのどちらか)。

## 4. 閉じ込め (SECURITY.md §4 の要約)

- converter は internal ネットワーク (`converter`) だけにいる。ホストにもインターネットにも出られず、ポートも
  公開しない。Gotenberg の外部取得 (`downloadFrom`) と webhook は切り、LibreOffice が文書の中の URL を取りに行くのも
  公開・非公開アドレスとも断る (ネットワークが無いので二重)。
- 上限: 1 リクエスト 90 秒 (`--api-timeout`)、本文 55 MB (`--api-body-limit`)、待ち行列 4、メモリ 1 GB、
  CPU 1、プロセス 512、`no-new-privileges`。LibreOffice は 10 回ごとに起動し直し、10 分使わなければ止める。
  app 側も 1 件ずつしか頼まない (変換は LibreOffice 1 つで順番)。app の HTTP の上限は 100 秒。
- PDF の解析 (PDFium) は app のプロセスでなく子プロセス (`python -m app.modules.attachments.pdf_render`) で行い、
  30 秒で kill する。環境変数は `PATH` と `LC_ALL` だけ。出力は JSON 1 行 (4 KB まで) と WebP。描画は幅 800 px、
  高さは幅の 2 倍まで (とても縦長のページは縮める)。
- 生成物の名前は `attachments/{id}.preview.{n}.pdf` / `.preview.{n}.webp`（n は claim 番号。0086 より前に作ったものは
  番号なし）で、利用者が決められる部分が無い。
- 作るのはアップロードした本人のファイルだけ (アップロードの延長)。配信の権限は元のファイルと同じ
  (`get_for_access`: pending はアップロードした本人、attached はチャンネルを読める人、キャンバスは会話のメンバー)。

## 5. API とクライアント

`AttachmentOut.preview` (null 可):

```json
{"status": "ready", "pages": 12, "width": 800, "height": 1132}
```

`status` は `pending` / `ready` / `failed`。`width` / `height` はサムネイルの画素 (ready のときだけ)。
`none` のファイルは `preview: null`。古いサーバはフィールドごと無い (クライアントは null と同じに扱う)。

| エンドポイント | 中身 |
| --- | --- |
| `GET /attachments/{id}/preview/thumbnail` | 1 ページ目、`image/webp`、`inline`、`nosniff`、`private, max-age=3600` |
| `GET /attachments/{id}/preview/pdf` | 全ページの PDF (Office は変換したもの、PDF は元のファイル)。`application/pdf`、`Content-Disposition: inline; filename="<元の名前>.pdf"`、`Content-Security-Policy: sandbox`、`nosniff` |

ready でなければどちらも `404 preview_not_found`。元のファイルの `/content` は今までどおり常に attachment
(PDF も inline にしない)。

クライアント (4 つとも同じ規則):

- `preview.status` が `pending` か `ready` のときだけ文書のカード、それ以外 (failed、null、フィールドなし) は今までの
  ファイルの行。
- ready のカード: 1 ページ目をカードの幅 (Desktop 256 px、iOS / Android 260) で、高さはサーバの `width` / `height`
  から決めた最終の箱 (200 まで。縦長のページは上の部分、スライドは全体)。画像が来てもその行の高さは変わらない。
  下に名前と「サイズ · N ページ」。pending のカードは名前と「プレビューを作成中…」(箱は無い。ready になると
  `message.updated` でカードが置き換わる)。
- ページを押すと全ページのビューア:
  - Desktop / Web: PDF.js (`pdfjs-dist` の legacy ビルド、Apache-2.0) で canvas に描く。開いたときだけ読み込む
    (`ui/pdfLoader.ts` の動的 import、本体のバンドルに入らない)。ページは見える近くに来たら描く。拡大・縮小
    (50〜300%)、ページの位置（n / N）と前後のページ、キーボード、開く・ダウンロード、閉じる（§11）。ブラウザ内蔵のビューア (`<iframe>` の blob: URL) を使わない理由: Tauri の
    macOS (WKWebView) はフレームの PDF 表示が当てにならず、Linux (WebKitGTK) は表示できず、Tauri と Caddy の CSP に
    `blob:` のフレームを足す必要もある。PDF.js はどこでも同じに描け、今の CSP (`'self'` のワーカー) のまま動く。
    legacy ビルドなのは、新しいビルドが Safari 17.4 以降の API を要り、古い macOS の Mac アプリは古い WebKit で動くため。
    CMap と標準フォントは同梱する (2026-10-19: 和文フォントを埋め込まない PDF (Windows の Word など) は
    UniJIS-UCS2-H などの CMap で文字を指し、無いと日本語がすべて空白になった)。ハッシュ付きの資産として出し、PDF が
    求めたものだけを `fetch` する (`pdfLoader.ts` の BinaryDataFactory。CSP の `connect-src` が `data:` を断るので
    インライン化しない)。wasm のデコーダは読み込まないので、JPEG 2000 の画像は空白になりうる (ダウンロードすれば
    OS のビューアで見られる)。
  - iOS: PDFKit の `PDFView` (連続スクロール、ピンチで拡大)、閉じる、共有 (「<元の名前>.pdf」)。カードの「開く」は
    今までどおり元のファイルの Quick Look / 共有。
  - Android: `PdfRenderer` で 1 ページずつ描いて `LazyColumn` に並べる (見える近くのページだけ、画面の幅で)。
    ツールバーに閉じると「他のアプリで開く」(元のファイル、ACTION_VIEW)。カードにも「他のアプリで開く」。
    ピンチでの拡大は未対応。
  - スマホの両方とも、写真と同じく下へ引いて閉じられる（MOBILE_UI.md §22）。
- 送信前の添付 (入力欄の下のタイル) とファイル一覧は今までどおり (プレビューのカードは出さない)。

## 6. 古いファイル (`generate-previews`)

プレビュー機能より前のファイル (`preview_status = 'none'`) は、運用コマンドで作る:

```sh
docker compose ... exec app python -m app.cli generate-previews --limit 200
# 失敗したものもやり直すとき
docker compose ... exec app python -m app.cli generate-previews --retry-failed
```

- 1 回の実行で最大 `--limit` 件 (既定 200)、1 件ずつ、1 件ごとにコミット。止めても、何度流しても、残りだけを
  する (冪等)。行は preview loop の claim と同じようにリースするので、loop と同じファイルを同時に作ることはない。
- 一時的に失敗したものは pending のまま残り、サーバの loop が再試行する。
- メッセージに付いたファイルは `message.updated` を出すので、端末は差分で受け取る。
- converter が無い (`PREVIEW_CONVERTER_URL` が空) と PDF だけ作る (そう表示する)。

## 7. 資源の目安

- converter のイメージ: `gotenberg/gotenberg:8.37.0-libreoffice` (ダイジェストで固定)。ダウンロード約 440 MB、
  展開後 1.5 GB。メモリは待機中 100 MB ほど、変換中は文書による (上限 1 GB)。LibreOffice は 10 分使わなければ
  止まる。
- app のイメージ: pypdfium2 の wheel で約 30 MB 増える (1.37 → 1.40 GB)。描画の子プロセスは 1 件ごとに起動して終わる
  (常駐しない)。
- 手元での計測 (Apple シリコンの Docker、2 ページの docx、1 ページの xlsx): 変換と描画で 1 件 0.2〜0.6 秒。
  保存されるものは 1 件あたり PDF 20 KB 前後 + WebP 3〜5 KB (文字だけの文書。図の多い文書はその分大きい)。
- オブジェクトストアの使用量は、Office ファイル 1 つにつき変換した PDF の分が増える (画像の多い文書ほど大きい)。

## 8. 作らなかったもの

- 送信前の添付とファイル一覧のサムネイル。
- 会話の添付の文書の中の文字の全文検索 (ドライブのファイルは 2026-10-24 から中身も探せる: DRIVE.md §29。Office は
  プレビューの PDF から読む。将来の RAG の材料にもなる)。
- 画像以外の種類 (テキスト、CSV、Keynote / Pages / Numbers) のプレビュー。
- Android のピンチでの拡大、Desktop のページ内検索。
- Desktop / Web のビューアのページのサムネイル一覧（ページの位置は「n / N」と前後のボタン・キーで示す）。

## 9. ダウンロード（Desktop / Web、2026-10-12）

画像・動画・文書・ファイルのダウンロードと、書き出し（Wiki の Markdown、データベースとアナリティクスの CSV）は
同じ流れで保存し、右下にトーストを出す（`platform/download.ts`、`AppController.downloadAttachment` / `saveFile`、
`ui/Toast.tsx` の `DownloadToasts`）。

- **進み具合**：添付は `fetchBlob` が本文を少しずつ読み、読んだバイト数を知らせる。トーストに「ダウンロード中」と
  バー・「1.2 MB / 12.0 MB · 10%」（全体は Content-Length、無ければ添付の `size_bytes`）。更新は 150 ms ごとにまとめる。
- **終わったら**：「ダウンロードしました」と名前。Desktop は「開く」（既定のアプリで開く）と「フォルダを開く」
  （Finder / エクスプローラーでそのファイルを選んだ状態で開く。opener プラグインの `revealItemInDir`）。8 秒で
  消える（ポインタを載せている間は消えない）。ボタンを押すとトーストは閉じる。同時に出すのは 3 件まで（古い完了分から消す）。
- **保存先（Desktop）**：既定は OS の「ダウンロード」フォルダへ直接保存する（Slack と同じ。以前は毎回保存ダイアログ）。
  同じ名前があれば「名前 (1).pdf」「名前 (2).pdf」…（Finder・エクスプローラー・Chrome と同じ付け方）。同時に同じ名前を
  落としても別の名前になる（決めた名前は書き終わるまで押さえ、書き込みは `createNew` で既存のファイルを決して上書き
  しない）。設定の「入力」→「ダウンロード」の「保存先を毎回選ぶ」（この端末だけ、既定オフ）をオンにすると、
  毎回保存ダイアログ（「ダウンロード」フォルダから始まる）で選ぶ。ダイアログを閉じればトーストは出ない。
- **ファイル名**：アップロードした人が付けた名前なので、パスの区切り・Windows が受け付けない文字・制御文字は `_` に、
  先頭の `.`（隠しファイル）と末尾の `.` / 空白は除き、`CON.txt` などの予約名は前に `_` を付け、200 文字まで（拡張子は残す）。
- **「開く」の制限**：開けるのは「ダウンロード」フォルダの中に保存したファイルだけ（opener の `open_path` の許可を
  `$DOWNLOAD/**` に限る。保存ダイアログで別の場所に保存したものは「フォルダを開く」だけ）。プログラム・スクリプト・
  ショートカット・インストーラ（exe、msi、bat、cmd、ps1、vbs、js、jar、lnk、app、command、sh、pkg、dmg など）は
  「開く」を出さない（`canOpenDownloaded`。capabilities でも主なものを拒否している）。
- **ビューアの「開く」**：写真・動画・文書のビューアの上の行に Desktop だけ「開く」がある。「ダウンロード」フォルダに
  保存してから既定のアプリで開く（保存先を毎回選ぶ設定でもダイアログは出さない）。
- **Web**：ブラウザ自身のダウンロード（`<a download>`）のまま。保存先や名前はブラウザが決め、こちらからは分からないので、
  トーストは「ダウンロードしました」と名前だけ（ボタンなし）。
- **権限（`src-tauri/capabilities/default.json`）**：`fs:allow-exists` と `fs:scope-download-recursive`（名前の空きを調べ、
  「ダウンロード」フォルダに書く）、`opener:allow-reveal-item-in-dir`、`opener:allow-open-path`（`$DOWNLOAD/**` だけ）。
  macOS は初めて「ダウンロード」フォルダに書くときに許可を尋ねる（Info.plist の `NSDownloadsFolderUsageDescription`）。

## 10. ドラッグ＆ドロップでのアップロード（Desktop / Web、2026-10-12）

デスクトップ（Finder・エクスプローラー・ほかのアプリ）からファイルをドラッグすると、会話とスレッドのペインがそれぞれ
落とし先になる（`ui/FileDropZone.tsx`）。以前は入力欄の上に落としたときだけ受け取っていた。

- **見た目**：ペインを薄く覆い、点線の枠・アイコン・「ここにドロップしてアップロード」と行き先（「#general に添付」、
  DM は相手の名前、スレッドは「スレッドに添付」）。スレッドを開いていれば会話とスレッドは別の枠で、ポインタの下の
  ペインだけが光る。落とすとそのペインの入力欄が 📎 と同じようにアップロードする（件数・サイズの上限も同じ）。
- **落とせない所**：灰色の枠と禁止のアイコン、「ここにはアップロードできません」と理由（アーカイブされたチャンネル・
  オーナーだけが投稿できるチャンネル・参加していない会話（プレビュー））。ポインタは「不可」になり、落としても何も
  アップロードしない（ファイルがウェブビューで開いてしまうこともない）。ゲストも参加している会話には添付できるので同じ扱い。
  キャンバス・予定・タスクなどのタブが会話を覆っている間は会話の枠を出さない（キャンバスは自分で画像を受け取る）。
- **ファイルのドラッグだけ**：`dataTransfer.types` に `Files` があり、かつアプリの中で始まったドラッグ（タイムラインの
  画像・リンク・選んだ文字・並べ替え。`dragstart` はページの中で始まったドラッグにしか来ない）でないときだけ。Chromium と
  WebKit はページの画像のドラッグにも `Files` を載せることがあるので、`Files` だけでは決めない（`platform/fileDrops.ts`）。
- **ちらつかない**：`dragenter` / `dragleave` は子の要素をまたぐたびに来るので、入った数から出た数を引いた数で中にいるかを
  決める。落としたとき・窓のどこかで `drop` / `dragend` が来たとき、`dragover` が 1.2 秒来ないとき（窓の外へ速く出ると
  WebKit が最後の `dragleave` を落とすことがある）に枠を消す。
- **デスクトップアプリ**：ウィンドウの `dragDropEnabled: false`（tauri.conf.json、Windows で HTML5 のドラッグ＆ドロップに
  要る）のまま。Tauri のネイティブのドロップイベントは使わず、ブラウザと同じ HTML5 のイベントで File を受け取る。
  落とし先の外に落ちたファイルは `guardFileDrops` が断る（ウェブビューがファイルを開いてアプリを置き換えないように）。

## 11. ビューアの見た目と上の行（Desktop / Web、2026-10-12、2026-10-14 にモーダルの形へ）

写真・動画・文書のビューアは Slack のファイルのビューアと同じくモーダルの形（`ui/ViewerHeader.tsx` の `ViewerFrame`）。
窓全体に黒の 60% を重ねてアプリを暗く見せ、その上に角の丸い暗いカード（`#1a1d21`、影と細い縁）を置く。カードの
上の段（見出し）に名前・サイズ（文書はページ数）と操作のボタン、右端に周りと区別した ×（「閉じる（Esc）」の
ツールチップ）。その下に写真・動画・ページ。周りの余白は 12 px（狭い窓）・32 px・56 px（広い窓）。2026-10-14 まで
は窓いっぱいの黒の 90% で、閉じ方がわかりにくかった。開いたときはビューア自体にフォーカスを置く（最初のボタンに
フォーカスの枠が出ないように。キーはすぐ効く）。

押す場所ごとの働き：

- **窓を動かす**（デスクトップアプリ）：カードの上の帯（上の行と同じ高さ、40pt 以上）とカードの見出し。どちらも
  `data-tauri-drag-region="deep"`：空きと名前・サイズの文字をドラッグで窓を動かし、ダブルクリックで最大化。ボタンは
  Tauri のドラッグのスクリプトがクリックできる要素として除くので、押せばそのボタンが働く。ここを押してもビューアは
  閉じない。macOS の信号機ボタンは上の帯に入る（見出しはその下なので左を空けない）。Windows は上の帯の右端に自前の
  最小化 / 最大化 / 閉じる（暗い背景用の色）。Linux・ブラウザは帯が無く、上の余白も左右と同じ（閉じる側）。
- **閉じる**：カードの周りの暗い余白と、カードの中の写真・ページの周りの暗いところ。押し下げと離すのが両方そこ
  （その要素そのもの）のときだけ閉じる。ページや写真の上で始めて外で離したドラッグ・選択、外で始めてページの上で
  離したもの、右クリック、スクロールバー（スクロールする箱のもので、その下の背景ではない）では閉じない。
  ドラッグで mouseup を落とした WebView が次の押し下げを `pointerdown` 無しの `mousedown` で送ることがあるので
  （`dismissOutside.ts`）、両方のイベントで押し下げを見る。× と Esc でも閉じる。
- **閉じない**：ページ・写真・動画（写真は押すと等倍と画面に合わせるを切り替える）、ページの間、見出しのボタン。

中央に置く：中身（写真・動画・ページの列・読み込み中・失敗の表示）は、カードの中のスクロールする箱の内側の
「箱と同じ大きさ以上で中身に合わせて伸びる」入れ物（`min-h-full min-w-full`、flex）の中で `margin: auto`。箱より
小さいもの（横長の 1 ページ、小さい写真、読み込み中）は上下左右の真ん中、大きいもの（長い PDF、拡大したページ）は
上（左）から並んでスクロールする（`justify-center` を overflow の箱に使うと上が切れるので使わない）。画面に合わせた
写真と動画は入れ物を箱の大きさに固定して、その中に収める。

- 文書のビューア：開いたときは幅に合わせる（100%、最大 900 px）。拡大・縮小は 50〜300%（ボタン、⌘ / Ctrl +「+」「-」、
  ⌘ / Ctrl +「0」で幅に合わせる）。開いている間は文字の大きさのキー（`platform/zoom.ts`）をビューアに貸す
  （`claimZoomKeys`）。拡大・縮小しても見ていた位置（全体に対する割合）を保つ。ページの位置は「n / N」（スクロールに
  ついていく。上から 60 px の線を越えたページ、末尾まで来たら最後のページ）と前後のボタン。← / → で前 / 次のページへ
  滑らかにスクロール（「視差効果を減らす」ならすぐ）。ページ以外にフォーカスがあるときは PageUp / PageDown と
  Home / End も。Esc で閉じる。
- 狭い窓（ブラウザのスマホの幅など）では見出しが折り返す（名前が 1 行目、ボタンが右寄せで次の行）。
- ダウンロードのトーストはビューアの上に出て押せる（押してもビューアは閉じない）。

### PDF の描き方と大きさ

PDF.js（`pdfjs-dist` の legacy ビルド、M108 で入れたもの）を使い続ける。新しい依存はない。開いたときだけ読み込み、
本体のバンドルには入らない：`pdfLoader` のチャンク 487 KB（gzip 148 KB）とワーカー 1.3 MB（どちらもビルドの値、
2026-10-12）。Chromium / WebView2 の内蔵ビューアは WKWebView（macOS）に無く、窓によって見た目も操作も変わるので使わない（§5）。

## 12. 動画が再生できないとき（Desktop / Web、2026-10-27）

報告：デスクトップのアプリで mp4 の添付が「ときどき」再生できない。`ffmpeg` で作った短い動画を、Playwright の WebKit
（macOS の WKWebView と同じエンジン）と Chrome（WebView2 と同じ Chromium）で、アプリと同じ Blob の URL と Web のドライブと同じ
Range の URL で再生して調べた。分かったことと直したこと：

- **メッセージの動画の流し方**：デスクトップと Web は `/attachments/{id}/content` を Bearer つきで全部取って Blob の URL にする
  （`videoSource.ts`）。`<video>` は Authorization を送れないため。ファイルは手元にあるので moov が末尾のファイル（faststart でない）も、
  シークも問題ない（WebKit・Chrome とも、H.264 の faststart / 末尾 moov、HEVC `hvc1`、.mov を再生できた）。Content-Type はアップロードの
  中身から決めたもの（`video/mp4`・`video/quicktime`）で、Blob の型もそれになる。
- **原因 1：この端末で復号できない動画**（再現した）。WebKit は HEVC のタグが `hev1`（`ffmpeg -c:v libx265` の既定。Apple の機器は
  `hvc1` で書く）・Matroska などで `error`（MediaError 4）になる。前の文言は「アプリ内で再生できません」だけだった。Chromium は
  復号できない映像トラックを黙って捨てて**音だけ再生する**（`error` が出ず、`videoWidth` が 0、フレーム数 0）。Chrome で MPEG-4 Part 2
  の mp4 で再現した。Windows の WebView2 で HEVC の復号器が無い PC の iPhone の動画（HEVC）は同じ経路で黒い箱になる（Windows では
  未確認、仕組みからの推定）。
  → 直した：ビューアは `loadeddata` と `timeupdate` で「サーバが映像ありと言う（`width` かポスターがある、または調べていない）のに
  大きさが 0×0、または 1.5 秒再生してフレームが 0」を見て、「この動画はこの端末では再生できません。ダウンロードして開いてください」と
  ダウンロードを出す（`ui/videoPlayback.ts`）。音だけのファイル（サーバが調べて映像が無かった）はそのまま再生する。会話のタイルも同じ判定で
  ポスターに戻す。MediaError は 3・4 を「再生できない」（再試行なし）、1・2 と、一度読めた後のエラーを「読み込めない」（再試行あり）に分けた。
- **原因 2：Web のドライブの動画のチケットの期限**（再現した）。Web のドライブの動画はダウンロードのチケットの URL を `src` にして Range で
  流す（DRIVE.md §7.3）。チケットは 5 分使われないと消える（サーバの再起動でも消える）。一時停止して 5 分以上たってから再生・シークすると
  次の Range が 404 になり、Chrome は MediaError 2（始めからなら 4）で止まり「再生できません」と出ていた。WebKit はエラーも出さず
  `stalled` のまま止まる。→ 直した：一度読めた後のエラーなら新しいチケットを取り、その位置から（止めていたなら止めたまま）続ける。
  チケットを取ってから 4 分を過ぎて 8 秒データが来ないとき（WebKit の場合）も同じ。続けて 2 回までで、その後は「読み込めません」と再試行。
  デスクトップのドライブとメッセージの動画は Blob なのでチケットに関わらない。
- **サーバの Range**：`/attachments/{id}/content`・`/drive/items/{id}/content`・`/drive/download/{token}` は M160 から 1 つの範囲の
  Range（206・`Content-Range`・その範囲の `Content-Length`・`Accept-Ranges: bytes`・`If-Range`・範囲外は 416）に答える。チケットは
  何度でも使える（1 回きりではない）。`Content-Disposition: attachment`・`Content-Security-Policy: sandbox`・`no-store` は `<video>` の
  再生を妨げない（WebKit・Chrome で確かめた）。足したもの：同じ 3 つに **HEAD**（GET と同じ状態とヘッダ、本文なし、ストアを読まない）。
  前は 405 だった。ブラウザの `<video>` は HEAD を使わないので再生の原因ではないが、外部のプレーヤーやダウンロードのツールのため。
- **プロキシ**：`infra/Caddyfile` の `encode zstd gzip` は既定の型の一覧（text/*・JSON など）だけを圧縮し、`video/*` を圧縮しない。
  `infra/nginx-site.conf.example` は `proxy_buffering off`・gzip なし・Range をそのまま通すので、変える必要はない。
- **残るもの**：メッセージの動画は全部を取ってから再生するので、大きい動画（上限 100 MB）は読み込みの表示の間待つ。途中で接続が切れると
  「読み込めません」と再試行になる。デスクトップのドライブの大きな動画も Blob で全部読む。アプリでも Range で流すには添付のチケット
  （`<video>` が Bearer を送れないため）と Tauri の CSP の `media-src` に API の配信元を足すことが要る（今回はしていない）。

## 13. 音声をその場で再生する（Desktop / Web、2026-10-28）

報告：デスクトップで WAV などの音声ファイルを聴けない（クリックするとダウンロードされる）。Slack の音声の添付のように、メッセージの中と
ドライブのビューアで再生できるようにした。

- **何を音声とするか**（`ui/attachmentLayout.ts` の `mediaKind`）：`audio/*`（MIDI は楽譜なので除く。ファイルの行のまま）と、
  サーバが調べて映像が無かった動画（`video/*` で `width` が無く `duration_ms` がある：音だけの mp4・webm。前は黒い動画のタイルだった）。
  サーバはアップロードの中身から型を決める（`filetype`。拡張子とブラウザの申告は使わない）。WAV は `audio/x-wav`、MP3 は `audio/mpeg`、
  M4A は `audio/mp4`、AAC（ADTS）は `audio/aac`、Ogg（Vorbis・Opus）は `audio/ogg`、FLAC は `audio/x-flac`、AIFF は `audio/x-aiff`。
  音だけの WebM（ブラウザの録音）は `video/webm`、ブランドが `isom` の音だけの mp4 は `video/mp4` になり、上の「映像の無い動画」で音声になる。
  添付の型の許可リストは無い（どのファイルも上げられる）ので、API の形は変えていない（`content_type` で分かる）。長さ（`duration_ms`）は
  動画だけがサーバで測られる。音声の長さは読み込んでから出す（作らなかった：音声も ffprobe に通すこと）。
- **メッセージ**（`ui/AudioPlayer.tsx`）：1 行のプレーヤー。再生 / 一時停止、名前（1 行目すべて）、シークバーと「0:12 / 1:05」、
  ダウンロードのボタン。名前を押してもダウンロードしない。読み込む前は時刻の場所に大きさを出す。バイトは最初に再生したときに取る
  （動画と同じ `fetchBlob` で Bearer をつけて Blob の URL にする。`<audio>` も Authorization を送れないため。`ui/useMediaSource.ts`）。
  入力欄で送る前のファイルは押すと音声のビューアで開く（前はダウンロード）。
- **ドライブ**（`ui/DriveViewer.tsx`・`drive/listing.ts` の `viewerKind` が `audio`）：プレビューで音声のビューア（`AudioViewer`）を開き、
  すぐ再生する。Web はダウンロードのチケットの URL を Range で流し、チケットが切れたら動画と同じく取り直してその位置から続ける（§12）。
  ← → で同じフォルダの前後のファイルへ。種類のアイコンは音声（青緑）。
- **同時に 1 つ**（`ui/playbackFocus.ts`）：音声の行・音声のビューア・動画のビューアのどれかが再生を始めると、前に鳴っていたものを止める。
- **キー**：行にフォーカスがあるとき Space で再生 / 一時停止（ボタンの上ではボタンの働き）。ビューアではボタンと入力欄の外ならどこでも。
  シークバーは ← → で動く。
- **再生できないとき**：読み込む前の MediaError 3・4 は「この音声はこの端末では再生できません。ダウンロードして開いてください」
  （再試行なし、ダウンロードのボタンはそのまま）。取得の失敗と、一度読めた後のエラーは「音声を読み込めませんでした」と再試行（§12 と同じ分け方）。
- **どの形式が鳴るか**（2026-10-28 に測った。ffmpeg で作った 3 秒のファイルを Blob の URL にして `loadedmetadata` か `error` を見た）：

  | 形式（サーバの型） | macOS の WKWebView（macOS 26.6、アプリ） | Chrome 156（WebView2 と同じ Chromium） |
  | --- | --- | --- |
  | WAV PCM 16 / 24 bit・96 kHz・float32（`audio/x-wav`） | 鳴る | 鳴る |
  | WAV IMA ADPCM | 鳴る | 鳴らない（MediaError 4） |
  | MP3（ID3 あり・なし）、M4A、AAC（ADTS） | 鳴る | 鳴る |
  | Ogg Vorbis、Ogg Opus（`audio/ogg`）、WebM Opus（`video/webm`） | 鳴る | 鳴る |
  | FLAC（`audio/x-flac`） | **鳴らない**（MediaError 4）。`audio/flac` なら鳴る | 鳴る |
  | AIFF（`audio/x-aiff`） | 鳴る | 鳴らない（MediaError 4） |

  → サーバは FLAC を **`audio/flac` で配る**（`attachments/service.py` の `served_type`。`/attachments/{id}/content`・
  `/drive/items/{id}/content`・`/drive/download/{token}`・共有リンク）。保存した型と API の `content_type` は `audio/x-flac` のまま。
  WKWebView は Playwright の WebKit ではなく、本物の `WKWebView` を Swift で開いて確かめた（Playwright の WebKit は FLAC も鳴らしたので、
  アプリの代わりにならない）。Windows の WebView2 は Edge の Chromium なので Chrome と同じと見ている（Windows では未確認）。
  鳴らない形式（Windows の AIFF・ADPCM の WAV、Ogg を扱えない古い macOS の WebKit など）は上の文言とダウンロードになる。
- **自動再生**：ビューアは開いた操作のあとで Blob を取ってから `play()` する。拒まれた（`NotAllowedError`）ときは止まったままにして、
  もう一度押せばすぐ鳴る（バイトはもうある）。Chrome・WebKit（Playwright）では最初の押下で鳴った。
- **iOS・Android**（今回は変えていない。コードを読んだ結果）：どちらもその場では再生しない。iOS は音声をファイルの行に出し、押すと
  ダウンロードして Quick Look で開く（`AttachmentPreview.allows` にある mp3・wav・aac・m4a・aiff は Quick Look の中で再生、
  ogg・opus・flac は共有シート）。Android はファイルの行で、押すとキャッシュに落として `ACTION_VIEW` で別のアプリに渡す。

## 14. HEIC の写真（AL5、2026-10-29）

文書のプレビューとは別の経路だが、ビューアに関わるので書いておく。サーバは HEIC / HEIF にもサムネイル（`has_thumbnail`）・縦横・
表示サイズ（`has_display`、`/attachments/{id}/display` の WebP）を作るようになった（ALBUMS.md §19。app のイメージを Debian
trixie の ffmpeg 7.1 に上げた）。会話とドライブの格子・一覧では JPEG と同じく写真として出る。

- 元のファイルは HEIC のまま。~~Desktop / Web の写真のビューア（`Lightbox`）は元のファイル（`content`）を読むので、HEIC を
  描けない Chromium / WebView2（Windows・Linux・Chrome）では全画面が「画像を読み込めませんでした」になる~~
  → 2026-10-29（ALBUMS.md §23.2）：`Lightbox` は `has_display`（と HEIC）なら `/display` → 元のファイル → HEIC はサムネイルの順に
  読む（取得の失敗か描けなかった時に次へ）。表示サイズの時は上の行に「元の画像を開く」（HEIC には出さない）。ダウンロードと
  「開く」は元のファイル。
- `heix`（10 bit）などのブランドの HEIF も `image/heic` / `image/heif` と判定する（ALBUMS.md §23.3）。
- 文書のプレビュー（§2 の表）の対象は変わらない。

