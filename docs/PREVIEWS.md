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
  1. 期限の来た pending を 1 件 claim (FOR UPDATE SKIP LOCKED、試行回数 +1、リース)
  2. オブジェクトストアから一時ディレクトリへ落とす
  3. Office なら converter (Gotenberg の LibreOffice) で PDF に。PDF はそのまま
  4. 子プロセス (pypdfium2) で 1 ページ目を WebP (幅 800 px) に、ページ数を数える
  5. attachments/{id}.preview.pdf (Office のみ) と attachments/{id}.preview.webp を保存
  6. 行を ready に。メッセージに付いていれば message.updated (change = "attachments")
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
- 結果を書くのは、行がまだ `pending` で削除されていないときだけ。保存するキーは添付の id から決まるので、
  同じ行を 2 回処理しても同じオブジェクトを上書きするだけ (冪等)。処理中に削除・GC された添付は、保存した
  オブジェクトをその場で消す。

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
- 生成物の名前は `attachments/{id}.preview.pdf` / `.preview.webp` (利用者が決められる部分が無い)。
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
    (50〜300%)、ダウンロード、閉じる。ブラウザ内蔵のビューア (`<iframe>` の blob: URL) を使わない理由: Tauri の
    macOS (WKWebView) はフレームの PDF 表示が当てにならず、Linux (WebKitGTK) は表示できず、Tauri と Caddy の CSP に
    `blob:` のフレームを足す必要もある。PDF.js はどこでも同じに描け、今の CSP (`'self'` のワーカー) のまま動く。
    legacy ビルドなのは、新しいビルドが Safari 17.4 以降の API を要り、古い macOS の Mac アプリは古い WebKit で動くため。
    CMap・標準フォント・wasm のデコーダは読み込まない (converter の PDF はフォントを埋め込み、JPEG / Flate の画像
    だけなので要らない。埋め込みの無い和文フォントや JPEG 2000 の画像を含むアップロードの PDF は、その部分が
    空白になりうる。ダウンロードすれば OS のビューアで見られる)。
  - iOS: PDFKit の `PDFView` (連続スクロール、ピンチで拡大)、閉じる、共有 (「<元の名前>.pdf」)。カードの「開く」は
    今までどおり元のファイルの Quick Look / 共有。
  - Android: `PdfRenderer` で 1 ページずつ描いて `LazyColumn` に並べる (見える近くのページだけ、画面の幅で)。
    ツールバーに閉じると「他のアプリで開く」(元のファイル、ACTION_VIEW)。カードにも「他のアプリで開く」。
    ピンチでの拡大は未対応。
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
- 文書の中の文字の全文検索 (PDF のテキストは取り出せるが、今回は使わない。将来の RAG の材料になる)。
- 画像以外の種類 (テキスト、CSV、Keynote / Pages / Numbers) のプレビュー。
- Android のピンチでの拡大、Desktop のページ内検索。
