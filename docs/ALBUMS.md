# ALBUMS（写真のアルバム）

2026-10-28 の設計。**AL1（M180、サーバ）を実装（2026-10-29、移行 0127、§18）**。**AL5（M184、HEIC）を実装（2026-10-29、§22）**：
app のイメージを Debian trixie（ffmpeg 7.1）に上げ、HEIC にもサムネイル・表示サイズ・撮影日時が付く。§17 の質問はすべて推めのとおりに決まった
（2026-10-28、§18.1）。次は AL2〜AL4（Desktop / Web・iOS・Android、§18.4 に端末が使うもの）。マイルストーンは AL1〜AL5（§15、M180〜M184）。

**AL2（M181、Desktop / Web と公開ページ）を実装（2026-10-29、§19）**。**AL の手直し（2026-10-29、移行 0128、§23）**：「アルバム」フォルダに
`system_role = 'albums'`（端末の言語の名前）、Desktop / Web のビューアは表示サイズを読む、`heix` などの HEIF のブランドも HEIC に。

利用者（研究室の教員）の要望（2026-10-28）：学会・合宿・研究室の行事などの写真を 1 つのアルバムに集めて、みんなで眺めたい。

関連：DRIVE.md（§3 場所と権限、§6 アップロード、§7.2 ZIP、§8 プレビュー、§9 外部共有リンク、§13・§25 会話との連携と `/d/` のカード、
§17 画面、§29 検索、§30 スマホのアップロード）、CHANNEL_FILES.md（チャンネルに投稿したファイルがチャンネルのドライブに入る。§9 で
つながる）、SECURITY.md §4（画像のサムネイルと EXIF、動画）、DATA_MODEL.md「attachments」「drive_*」、PREVIEWS.md §11（ビューア）、
MOBILE_UI.md §25（スマホのドライブ）。

画面の名前は「アルバム」（英語 Albums、中国語 相册）、コード上の名前は `album`（表 `drive_albums`、API `/drive/albums*`。モジュールは
`drive` の中の `albums.py`。新しいモジュールは作らない）。

## 0. 結論

- **アルバム = ドライブのフォルダ + 少しのメタデータ**（説明・表紙・日付・並べ方）。別の「アルバム」の実体（写真への参照の集まり）は
  作らない（§2）。見える人・書ける人は場所で決まる（DRIVE.md §3：研究室ドライブ・チャンネルのドライブ・マイドライブ）。
  アップロード・再開・ゴミ箱・容量・ZIP・外部共有リンク・検索・バックアップはドライブのものをそのまま使う。
- **どのフォルダでも「アルバムにする」ことができ**、「新しいアルバム」は既定で今の場所の「アルバム」フォルダの下に作る（ふつうの
  フォルダ。特別扱いしない）。外せばふつうのフォルダに戻る（写真はそのまま）。
- **見る**：撮影日の順の格子（512 px のサムネイルを見える分だけ読む）、全画面のビューア（← → とスワイプ）、スライドショー、
  選んだもの・全部を ZIP で（今の ZIP、DRIVE.md §7.2）。全画面とスライドショーは**新しい「表示サイズ」の画像**（長い辺 2048 px の
  WebP、メタデータなし）で、元の写真（数 MB〜数十 MB）は「元の画像」を押した時だけ読む（§6）。
- **写真の情報**：撮影日時（EXIF の `DateTimeOriginal`、動画は `creation_time`）を読んで並べる。向き（EXIF の Orientation）は今の
  サムネイルと同じく当てる。**位置情報（GPS）は研究室の中では元の写真に残し**、「位置情報あり」と出す。**学外への共有リンクでは、
  既定で元の写真を渡さず表示サイズ（位置情報なし）だけ**にする（§7）。
- **HEIC**：iOS は今までどおり送る前に JPEG にする（DRIVE.md §30.2）。Desktop / Web から来た HEIC は、Pillow が読めないので
  app のイメージの ffmpeg で読む。AL1 では Debian bookworm の ffmpeg 5.1 が読めずアイコンのままだった（§18.3）。**AL5 で app の
  イメージを Debian trixie（ffmpeg 7.1）に上げ、HEIC にもサムネイル・表示サイズ・撮影日時・位置情報の印が付く**（§6.3、§22。
  新しい Python の依存なし）。
- **動画**もアルバムに入れられる（ポスターと長さ、ビューアで再生、スライドショーでは音を消して最後まで流す）。
- **チャンネルへ**：アルバムの `/d/<フォルダの id>` のリンクは、写真 4 枚の並び・題名・枚数・日付のカードになる（DRIVE.md §25 の
  カードの形を広げる）。「チャンネルに知らせる」で入力欄にリンクを入れる。自動では投稿しない。
- **会話の写真から**：「この投稿の写真をアルバムに」。CHANNEL_FILES.md があれば投稿の写真はもうチャンネルのドライブの項目なので、
  同じ場所のアルバムへは**写さずに移すだけ**（メッセージの表示は変わらない）。別の場所のアルバムへは写す（§9）。
- **1 枚の写真を 2 つのアルバムに**入れたいときは写す（領域は 2 倍）。参照（ショートカット）は作らない（§2・§17 Q1）。
- コメント・リアクションは作らない（v1）。アルバムのカードをチャンネルに投稿し、そのスレッドで話す（§11）。
- スマホ：カメラロールから何十枚もまとめて上げる（DRIVE.md §30 のバックグラウンドのアップロードのまま）、格子、スワイプのビューア、
  スライドショー、写真アプリへの保存（§12）。

## 1. 目標と非目標

### 1.1 目標

- 行事の写真を何人もが 1 か所に上げ、撮影の順に眺め、気に入ったものを落とせる。
- 学外の人（共同研究者・家族・ほかの大学の参加者）にもリンクで見せられる。位置情報をうっかり渡さない。
- 数百枚・数 GB のアルバムでも、スマホで軽く見られる（元の写真を読まない）。
- 新しいサービス・依存を足さない（ドライブ・プレビューの仕組みに乗せる）。

### 1.2 非目標（v1 では作らない）

| 作らないもの | 理由・代わり |
| --- | --- |
| 写真への参照の集まりとしてのアルバム（1 枚が写さずに複数のアルバムに入る） | §2。写して入れる |
| コメント・リアクション（写真ごと） | v1 はチャンネルのスレッドで話す。要望が出たら §16 |
| 顔の認識・人物での絞り込み・地図 | 研究室の規模では要らず、個人情報の扱いが重い |
| 写真の編集（切り抜き・回転・補正） | 手元のアプリで。回転だけは要望が出たら（表示の回転を持つ） |
| 手で並べ替える（ドラッグ） | v1 は撮影日・名前・追加の順。§17 Q11 |
| RAW（CR2・NEF・ARW など）のサムネイル | Pillow・ffmpeg で読めないものが多い。ファイルとして置け、アイコンで出す |
| 端末の写真の自動の取り込み（Google フォトのバックアップのような） | ドライブはバックアップの先ではない（DRIVE.md §1.3 の同期クライアントを作らないのと同じ） |

## 2. フォルダに乗せるか、別の実体にするか（決めたこと）

| | **A. フォルダ + メタデータ（採る）** | B. 別の実体（写真への参照の集まり） |
| --- | --- | --- |
| 見える人 | フォルダの場所で決まる（今の規則のまま） | アルバムの権限を新しく決める必要がある。参照した写真が別々の場所にあると、見る人ごとに見える枚数が違う（読めない写真を抜くか「表示できない写真」を並べるか） |
| 外部共有リンク | フォルダのリンクがそのまま効く（部分木の確かめ、DRIVE.md §9） | 参照の集まりを外へ出す新しい確かめが要り、参照した写真の場所の「外部リンクを許すか」の設定と食い違う |
| アップロード・再開・容量・ゴミ箱・ZIP・検索・バックアップ | そのまま | アップロード先のフォルダを別に決め、アルバムからの追加・外すの扱い、写真を消した時の参照の扱いが要る |
| 1 枚を 2 つのアルバムに | 写す（領域が増える） | 写さずに済む |
| 会話の写真から（CHANNEL_FILES.md） | 同じ場所なら移すだけ | 参照を足すだけ |

研究室の使い方（行事ごとに 1 つ、数百枚）では、1 枚を何冊にも入れることは少なく、見える人・外部リンクの規則を 1 つに保つ方が
ずっと大事。**A にする。** 後で「1 枚を複数に」の要望が強ければ、同じ場所の中だけで効く参照（ショートカットの項目、`kind = 'link'`）を
ドライブに足す道がある（§16）。

## 3. 見える人・書ける人

- **場所のまま**（DRIVE.md §3.2）：一覧・見る・落とす・スライドショーは場所を読める人、写真を足す・外す・メタデータ（説明・表紙・
  並べ方・日付）の変更・アルバムにする・外すは場所に書ける人。ゴミ箱・完全削除も今のまま。
- どこに作るか（目安を画面に出す）：
  - 研究室の行事 → **研究室ドライブ**（ゲスト以外の全員）。
  - 共同研究者（ゲスト）も一緒の学会 → その人たちのいる**チャンネルのドライブ**。
  - 学外の人に見せる → どちらかに作り、**外部共有リンク**（§7）。
  - 自分だけ → マイドライブ。
- 管理者も、メンバーでない非公開チャンネル・他人のマイドライブのアルバムは見えない（DRIVE.md §3.3 のまま）。

## 4. データモデル

### 4.1 表

```sql
CREATE TABLE drive_albums (
  folder_id      uuid PRIMARY KEY REFERENCES drive_items(id) ON DELETE CASCADE,   -- kind = 'folder' だけ
  description    text NOT NULL DEFAULT '',          -- 2,000 文字まで（NFC）
  cover_item_id  uuid REFERENCES drive_items(id) ON DELETE SET NULL,  -- 表紙（そのフォルダの直下の写真・動画）。NULL = 並びの最初
  sort           varchar(8) NOT NULL DEFAULT 'taken',                 -- 'taken'（撮影日）| 'name' | 'added'（足した順）
  sort_order     varchar(4) NOT NULL DEFAULT 'asc',
  starts_on      date,                               -- 任意：行事の日付（無ければ写真の撮影日の範囲を出す）
  ends_on        date,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES users(id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (sort IN ('taken', 'name', 'added')),
  CHECK (sort_order IN ('asc', 'desc')),
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX drive_albums_description_pgroonga_idx ON drive_albums USING pgroonga (description);

-- 写真の情報と表示サイズ（バイト列の派生物なので attachments に置く。サムネイル・ポスターと同じ考え方）
ALTER TABLE attachments
  ADD COLUMN display_key     text,          -- 'attachments/{id}.display.webp'（長い辺 2048 px、メタデータなし）
  ADD COLUMN display_width   integer,
  ADD COLUMN display_height  integer,
  ADD COLUMN display_bytes   integer,       -- AL1 で足した：表示サイズの ZIP の長さを先に決めるため（§18.2）
  ADD COLUMN taken_at        timestamptz,   -- EXIF の DateTimeOriginal（+ OffsetTimeOriginal）、動画の creation_time
  ADD COLUMN taken_at_local  boolean,       -- true = ゾーンが分からずワークスペースのゾーンで読んだ
  ADD COLUMN has_location    boolean,       -- 元のファイルに GPS がある（表示だけ。値は持たない）
  ADD COLUMN photo_probed_at timestamptz;   -- 読んだ時刻（結果によらず）。NULL = まだ

-- 並べるための写し（今のバージョンの値。一覧の索引とカーソルのため）
ALTER TABLE drive_items ADD COLUMN taken_at timestamptz;
CREATE INDEX drive_items_taken_idx ON drive_items (parent_id, taken_at, id) WHERE trashed_at IS NULL AND kind = 'file';

-- 外部共有リンク：元の写真を渡すか（§7）
ALTER TABLE drive_share_links ADD COLUMN originals boolean NOT NULL DEFAULT true;
```

- アルバムの題名は**フォルダの名前**（別に持たない。名前の変更・重複の規則は DRIVE.md §4.3 のまま）。
- アルバムの中身は**フォルダの直下**の画像と動画。子のフォルダは上に「フォルダ」として並べる（開けばそのフォルダ。アルバムなら
  アルバムの形で）。ほかのファイル（PDF など）は下に「ほかのファイル」としてたたむ。
- `drive_items.taken_at` は今のバージョンの `attachments.taken_at`（無ければ NULL）。新しいバージョン・バージョンを戻す・
  写真の情報を読んだ時に同じトランザクションで書く。撮影日の並びは `COALESCE(taken_at, content_modified_at, created_at)`。
  カーソルはその値と id。
- フォルダをゴミ箱に入れるとアルバムも一緒（行は残る）、戻せば戻る、完全削除で CASCADE。アルバムのフォルダを別の場所へ移せば
  アルバムごと移る（見える人も変わる）。
- 枚数・撮影日の範囲・表紙は問い合わせで求める（直下は 10,000 件まで、DRIVE.md §4.3。`drive_items_taken_idx` で足りる）。
  遅ければ `drive_albums` に数を持つ（後で）。

### 4.2 写真の情報を読む（drive の media loop に足す）

- DRIVE.md §6.4 の media loop の手順の 2（画像のサムネイル）の後に：
  1. EXIF を読む（Pillow の `getexif()`。ヘッダだけで、画素は展開しない）：`DateTimeOriginal`（無ければ `DateTimeDigitized`・
     `DateTime`）、`OffsetTimeOriginal`（あればそのゾーン、無ければワークスペースのゾーンで読み `taken_at_local = true`）、GPS の
     IFD が空でないか（`has_location`）。1970 年より前・今 + 1 日より後は捨てる（DRIVE.md §6.2 の更新日時と同じ守り）。
  2. 表示サイズ：`ImageOps.exif_transpose` の後に長い辺を 2048 px まで縮めた WebP（品質 80、メタデータなし。今の `make_thumbnail` と
     同じ守り：50 Mpx の上限、新しい画像に描き直す）。**AL1 では小さな画像にも作る**（§18.2：公開側で元のバイト列を渡さずに済み、
     表示サイズの ZIP の長さも先に決まる）。動く画像（GIF・WebP のアニメーション）には作らない。表示サイズの無い画像では、
     `/attachments/{id}/display` は元の画像を返す（ラスター画像だけ、今の `?inline=1` と同じ型）。
  3. 動画：今の ffprobe の結果から `creation_time`（QuickTime の `com.apple.quicktime.creationdate` があればそれ）を `taken_at` に。
     位置（`location` の tag）があれば `has_location`。
- 読むのは**ドライブのバージョン**（投稿のファイルを含む、CHANNEL_FILES.md）。チャットの添付（DM など）は読まない（アルバムに入らない）。
- 今あるドライブの写真は `app.cli drive-photos --limit N`（`photo_probed_at IS NULL` を 1 件ずつ、何度流してもよい。§14）。
- 撮影日時は**写真の中の値で、端末の時刻と同じく信用しない**：並びと表示だけに使い、権限・同期・順序の保証には使わない
  （CLAUDE.md）。

## 5. API

すべて `/api/v1`、認証は今までどおり。OpenAPI と `ws-events.json` を再生成し、エラーの文言を `apps/shared/errors.json` に足す。

| メソッド | パス | 中身 |
| --- | --- | --- |
| POST | `/drive/albums` | `{parent_id \| location_id, name, description?, starts_on?, ends_on?, sort?, sort_order?, client_op_id}` → 201 `{folder: DriveItemOut, album: AlbumOut}`（同じ `client_op_id` は 200）。フォルダとアルバムを 1 トランザクションで（`POST /drive/folders` と同じ冪等）。`location_id` ならその場所の根の「アルバム」フォルダ（無ければ作る）の下に（§17 Q2、§18.2） |
| GET | `/drive/albums/{folder_id}?sort=&order=&cursor=&limit=` | AL1 で足した：アルバムと、その写真・動画の 1 ページ（アルバムの並び、`sort`・`order` で上書き）：`{folder, album, path, location_kind, can_write, items, next_cursor, folder_count, other_count, shared_above}`。アルバムでないフォルダは 404 `drive_album_not_found` |
| PUT | `/drive/folders/{id}/album` | `{description?, cover_item_id?, sort?, sort_order?, starts_on?, ends_on?}` → `AlbumOut`（ふつうのフォルダをアルバムにする・変える。書ける人） |
| DELETE | `/drive/folders/{id}/album` | 204。ふつうのフォルダに戻す（中身はそのまま） |
| GET | `/drive/albums?location_id=&cursor=&limit=` | 読める場所のアルバムの一覧（新しい日付の順）：`{items: [{folder, album, path, location_kind}], next_cursor}` |
| GET | `/drive/folders/{id}/children?sort=taken&order=asc` | 今の一覧に `sort=taken`（と `added`）を足す。各ファイルの `file` に `taken_at`・`has_location`・`has_display`・`display_width`/`height` |
| GET | `/attachments/{id}/display` | 表示サイズの画像（`image/webp`、`inline`、`nosniff`、`Cache-Control: private, max-age=86400`）。無ければ元のラスター画像（`?inline=1` と同じ型だけ。まだ読んでいないドライブの画像はその版を media loop に戻す）、ほかは 404 `display_not_found`。権限は `get_for_access`。`AttachmentOut.has_display` も足した |
| POST | `/drive/albums/{folder_id}/add` | `{attachment_ids?: [..≤100], item_ids?: [..≤500], mode: "auto" \| "move" \| "copy", client_op_id}` → `{results: [{source_id, ok, error?, item_id, action: "moved" \| "copied"}]}`（§9） |
| GET | `/search/drive?kind=album` | 名前（フォルダ）と説明でアルバムを探す |
| GET | `/shares/{token}` | 根がアルバムなら `album: SharedAlbumOut`（人と添付の id を持たない形）と `originals`（§7）。`/shares/{token}/folders/{id}/children` もアルバムなら `album` と、`sort`・`order` を省けばアルバムの並び。`SharedItemOut` に `has_display`・`display_width`/`height`・`taken_at`・`has_poster`・`duration_ms`（位置情報の印は出さない） |
| GET | `/shares/{token}/items/{id}/display` | 公開側の表示サイズ（`no-store`、ほかのヘッダは DRIVE.md §9 の公開側と同じ。回数に数えない） |
| GET | `/shares/{token}/zip?folder_id=&size=display` | 表示サイズの ZIP（`originals = false` のリンクではこれだけ） |
| POST / PATCH | `/drive/items/{id}/links` / `/drive/links/{id}` | `originals`（既定：アルバムのフォルダなら false、ほかは true） |

```json
AlbumOut = {
  "folder_id": "…", "description": "2026 年秋の応用物理学会（名古屋）",
  "cover": {"item_id": "…", "attachment_id": "…"},          // 表紙（無ければ並びの最初の写真・動画、空なら null）
  "sort": "taken", "sort_order": "asc",
  "starts_on": "2026-09-16", "ends_on": "2026-09-19",
  "taken_from": "2026-09-16T09:12:00+09:00", "taken_to": "2026-09-19T17:40:00+09:00",
  "photo_count": 312, "video_count": 8, "size_bytes": 1834000000,
  "preview_attachment_ids": ["…", "…", "…", "…"],           // カード・一覧の 4 枚
  "updated_at": "…"
}
```

- `DriveItemOut` のフォルダに `album: AlbumOut | null` を足す（`GET /drive/items/{id}` と一覧の子のフォルダ）。古い端末はふつうの
  フォルダとして出す。
- 同期：新しいイベントは無い。アルバムの変更は `drive.changed`（`folder_ids` にそのフォルダとその親）で読み直す。
- エラー：422 `drive_album_invalid`（フォルダでない・根・「投稿のファイル」・説明が長すぎる・表紙がそのフォルダの直下の写真でない・
  終わりの日が始まりの日より前）、403 `share_originals_disabled`（元の写真を渡さないリンクで元のファイル・元の ZIP を頼んだ）。
  AL1 で足した：404 `drive_album_not_found`（アルバムでないフォルダの `GET /drive/albums/{id}`・`add`）、404 `display_not_found`
  （表示サイズも元のラスター画像も無いファイルの `display`）。

## 6. 画像の大きさと形式

### 6.1 3 つの大きさ

| 大きさ | 作る時 | 使う所 |
| --- | --- | --- |
| サムネイル（512 px、JPEG、今の `thumbnail_key`） | アップロード・media loop（今まで） | 格子、カード、一覧 |
| 表示サイズ（長い辺 2048 px、WebP、新しい `display_key`） | media loop（§4.2） | 全画面のビューア、スライドショー、公開側の写真 |
| 元の写真 | — | 「元の画像」・ダウンロード・ZIP |

- 表示サイズは 1 枚 200〜500 KB の見込み（元の 5〜20 MB の数 %）。300 枚のアルバムで約 100 MB 増える。容量には数えない（サムネイル・
  プレビューと同じ派生物）。GC・`verify-attachments` は派生物の鍵として扱う（`_derived_keys` に足す）。
- 格子は 512 px のサムネイルを `object-fit: cover` で正方形に見せる（サーバで正方形を作らない）。高い画素密度の画面で 3 列なら
  1 枡 300〜400 px で足りる。
- 端末は見えた枡だけを読み（Desktop / Web は `IntersectionObserver` と行の仮想化、iOS は `LazyVGrid`、Android は `LazyVerticalGrid`）、
  ビューアでは前後 2 枚の表示サイズを先に読む。

### 6.2 向き・大きさの上限

- 向きは今のサムネイルと同じく EXIF の Orientation を当てる（`exif_transpose`）。`display_width` / `height` は当てた後の値。
- 50 Mpx を超える画像はサムネイルも表示サイズも作らない（今の上限）。ドライブの画像のサムネイルの上限 100 MB（`DRIVE_IMAGE_THUMB_MAX_BYTES`）も同じ。
  パノラマなどはアイコンで出し、ダウンロードで見る。

### 6.3 HEIC・HEIF

- 今：iOS のアプリは入力欄とドライブのアップロードで HEIC を JPEG にしてから送る（DRIVE.md §30.2）。Mac の写真アプリから書き出した
  HEIC・Android の一部の端末の HEIF を Desktop / Web から上げると、サーバはサムネイルを作れない（Pillow の標準では読めない）。
- AL1 の最初に、app のイメージの ffmpeg（動画のポスターと同じ閉じ込め、SECURITY.md §4「動画」）で HEIC の静止画を 1 枚の PNG に
  できるかを実物（iPhone の HEIC・グリッドの HEIC・10 bit）で確かめる。できればサムネイルと表示サイズをそれで作る（形式の許可の
  一覧に `heif` を足すだけ。新しい依存なし）。できなければ v1 はアイコンで出し、`pillow-heif`（libheif）を足すかは §17 Q4。
- **AL1 の結果（2026-10-29）**：app のイメージ（`server/Dockerfile`、Debian bookworm の `ffmpeg 5.1.9`）は macOS の `sips` で作った
  HEIC（4032 × 3024、グリッド）を `moov atom not found` で読めない（ffmpeg 5.1 の mov の demuxer には HEIF の静止画の項目の扱いが
  無い。HEIF の静止画は ffmpeg 7 系で入った。手元の Mac の ffmpeg 9.0 は同じファイルを読めた）。**v1 の HEIC はアイコンのまま**（撮影日時も読まない。
  並びはファイルの時刻）。サーバは何も変えていない（新しい依存なし）。AL5 で `pillow-heif` を足すか、Desktop / Web で送る前に
  JPEG にするかを決める（§18.3）。
- **AL5 の結果（2026-10-29、§22）**：利用者は §18.3 の 2 を選んだ。app のイメージを Debian trixie（`ffmpeg 7.1.5`）に上げ、
  iPhone 形のグリッドの HEIC（4032 × 3024、48 枚のタイル、irot）・10 bit（Main 10、Display P3）・タイルの無い HEIC・macOS の壁紙
  （6016 × 6016）を、正しい向きのサムネイルと表示サイズにできた。ffmpeg 7.1 のコマンドはタイルを自分ではつながず、irot / imir も
  当てないので、サーバがファイルの箱を読んで `xstack`・`crop`・`transpose` を組み立てる（`attachments/heif.py`）。撮影日時と位置情報の
  印は HEIC の中の EXIF の項目から読む。
- 元のファイル（HEIC）はそのまま残し、ダウンロードも HEIC（変えない）。

## 7. 位置情報と外部共有リンク

- **研究室の中**（ドライブを読める人）：元の写真をそのまま渡す（EXIF も GPS も残る）。詳細に「位置情報あり」（`has_location`）。
  サムネイルと表示サイズはメタデータを持たない（描き直した新しい画像）。
- **外部共有リンク**（DRIVE.md §9）：`originals` を足す。
  - アルバムのフォルダに作るリンクは**既定で `originals = false`**：公開側の格子・ビューア・スライドショーは表示サイズで、
    「この写真を保存」は表示サイズの WebP（名前は元の名前の拡張子を `.webp` に）、「すべて保存」は表示サイズの ZIP。元のファイル
    （`/content`、PDF などほかのファイルも）と元の ZIP は 403 `share_originals_disabled`。AL1 では小さな画像にも表示サイズを作るので
    （§6.1）、再エンコードの経路は要らなかった。表示サイズの無いもの：動く GIF はそのまま（GIF は EXIF を持てない）、ほかの画像
    （HEIC・まだ読んでいない古い画像）は公開側では出さない（`display` は 404、ZIP に入らない）。文書のプレビュー（1 ページ目・PDF）は
    今までどおり見られる。
  - リンクの作成のダイアログに「元の写真のダウンロードを許す（撮影場所などの情報が含まれることがあります）」の印。オンにすれば
    今までどおり元のファイルと元の ZIP。
  - アルバムでないフォルダ・ファイルのリンクは今までどおり（既定 `originals = true`）。
  - 動画は表示サイズを作らないので、`originals = false` でも再生（Range）とダウンロードは元のファイル（動画の位置の tag は残る。
    画面の印の説明に書く）。§17 Q3。
- 元の写真の EXIF を書き換えて GPS だけを除く（無劣化）案は採らない：JPEG・HEIC・PNG ごとのメタデータの書き手を自前で持つことになり、
  Orientation などを壊しやすい。表示サイズで足りる。

## 8. 動画

- アルバムに入る（直下の `video/*`）。格子はポスター（今の `has_poster`）と左下の長さ。ビューアは今のプレーヤー（Range でシーク、
  DRIVE.md §7.1）。
- スライドショーでは音を消して最後まで流してから次へ（長い動画は 60 秒で次へ）。設定で「動画を飛ばす」。
- 撮影日時は §4.2 の 3。

## 9. 写真を足す

| 足し方 | 流れ |
| --- | --- |
| アップロード（Desktop / Web） | アルバムの画面の「写真を追加」・ドラッグ＆ドロップ。そのフォルダへのドライブのアップロード（DRIVE.md §6・§17.3）。同じ名前は「名前を変えて両方残す」を既定に（写真の「IMG_1234.jpg」は人ごとに重なる） |
| アップロード（スマホ） | §12 |
| ドライブから | 「ドライブから追加」：ほかのフォルダのファイルを選ぶ → 同じ場所なら移す、ほかの場所なら写す（`POST /drive/albums/{id}/add`、`mode: auto`。画面で「移す / 写す」を変えられる） |
| 会話の投稿から | メッセージの ⋯ と写真のビューアの「アルバムに追加」→ アルバムを選ぶ（最近のアルバム・そのチャンネルのドライブのアルバム・「新しいアルバム」） |

**会話の投稿から**（`attachment_ids` を渡す）：

- その添付が CHANNEL_FILES.md の**投稿のファイル**（`AttachmentOut.drive` があり、`state = available`）で、アルバムが**同じチャンネルの
  ドライブ**にあれば、項目を「投稿のファイル › 2026-10」からアルバムへ**移す**（写さない。メッセージは同じバージョンを指したままで、
  `drive_state` は `available` のまま、メッセージの表示は何も変わらない）。
- 投稿のファイルでアルバムが別の場所（研究室ドライブなど）なら、既定は**写す**（移すと、チャンネルのメンバーのうち移した先を
  読めない人（ゲストなど）がメッセージで見られなくなる、CHANNEL_FILES.md §6.4）。画面で「移す」を選べば `impact` の確かめを出す。
- ふつうの添付（DM・CHANNEL_FILES.md の前の投稿・切り替えがオフのチャンネル）は写す（今の `POST /drive/save-attachment` と同じ手順）。
- 権限：添付を読めること（`get_for_access`）、アルバムの場所に書けること。移すときは元の場所にも書けること（DRIVE.md §5.2 の移動と同じ）。
- 冪等：`client_op_id` から元ごとに `uuid5`（DRIVE.md §22.2 のコピーと同じ）。
- 「この投稿の写真でアルバムを作る」：1 つのメッセージ（とスレッド）の写真が多いとき、メッセージの ⋯ に出す。名前の既定は
  チャンネルと日付（「#学会 2026-09-16」）、場所はそのチャンネルのドライブ。

## 10. 見る（Desktop / Web）

### 10.1 置き場所

- ドライブの場所の列のいちばん上に「アルバム」（読めるすべての場所のアルバムを新しい順に並べる。`GET /drive/albums`）。
- アルバムのフォルダを開くと、ふつうの一覧の代わりにアルバムの画面（上の切り替えで「ファイルの一覧で見る」にもできる。端末ごとに覚える）。
- チャンネルの「ドライブ」のタブでも、アルバムのフォルダはアルバムの画面で開く。

### 10.2 アルバムの画面

- 上：題名（フォルダの名前）、日付（`starts_on`〜`ends_on`、無ければ撮影日の範囲）、枚数、説明（3 行まで、続きは「もっと見る」）、
  場所のパンくず。ボタン：「スライドショー」「写真を追加」「共有」（外部共有リンク、DRIVE.md §17.4）「チャンネルに知らせる」
  「すべてダウンロード」（ZIP）「⋯」（アルバムの設定：説明・日付・並べ方・表紙・アルバムをやめる）。
- 格子：3〜8 列（窓の幅で）、正方形のサムネイル、日付ごとの見出し（撮影日の並びのとき「9 月 16 日（火）」）。動画は ▶ と長さ。
  位置情報の印は格子には出さない（詳細だけ）。
- 選ぶ：チェックボックス（DRIVE.md §27.1 と同じ）・Shift / ⌘ のクリック → 上に「n 枚を選択中 · ダウンロード（ZIP）· 移動 · 写す ·
  ゴミ箱 · 表紙にする（1 枚のとき）」。
- 表紙：表紙にした写真がゴミ箱・別のフォルダへ行けば、並びの最初に戻る（`ON DELETE SET NULL` と、直下でなければ使わない）。

### 10.3 ビューア

- 今のビューア（`ViewerFrame`、PREVIEWS.md §11）を写真の全画面で開く：表示サイズ、← → とスワイプで前後、Esc で閉じる、
  ズーム（表示サイズを超えて拡大したら元の画像を読む）、上の行に名前・撮影日時・上げた人・「元の画像」「ダウンロード」「⋯」
  （詳細：大きさ・形式・縦横・位置情報あり・ドライブのパス）。
- スライドショー：全画面（Fullscreen API、Tauri は窓の全画面）、3 / 5 / 10 秒、順番 / ランダム、Space で止める、← → で送る、
  動画は §8。次の 2 枚を先に読む。

### 10.4 アルバムのカード

- メッセージの `/d/<フォルダの id>` がアルバムなら（`DriveItemOut.album`）、DRIVE.md §25 のカードの代わりに：4 枚の並び（2 × 2、
  `preview_attachment_ids` のサムネイル）、題名、「312 枚 · 2026/9/16〜9/19」、場所の 1 行。押すとアルバムの画面。読めない人には
  今と同じ「表示できないファイル」（名前も枚数も出さない）。
- 「チャンネルに知らせる」：会話を選ぶと、その入力欄にリンクと「写真を追加しました（12 枚）」の下書きを入れて開く（足した枚数は
  その画面で足した分。送るのは人）。読めない人がいれば今の注意（DRIVE.md §25「下書きの注意」）。

## 11. コメント・リアクション

- v1 は作らない。アルバムのカードをチャンネルに投稿し、そのスレッドで話す（通知・既読・検索が今の仕組みで効く）。
- 写真 1 枚について話すときは、ビューアの「⋯ → 会話に送る」で `/d/<写真の id>` のリンクを送る（今の機能）。
- 要望が出たら §16 の形（写真ごとのリアクションだけ、または写真ごとの短いコメント）。

## 12. スマホ（iOS / Android）

- **置き場所**：ドライブの場所の一覧のいちばん上に「アルバム」（横に流れる表紙のカード、押すとアルバム）。会話のタブのドライブでも
  アルバムのフォルダはアルバムの画面。
- **格子**：3 列（iPad・タブレットは 5〜6 列）、正方形のサムネイル、日付の見出し、下まで見えたら続き（カーソル）。
- **ビューア**：今の写真のビューア（iOS は同じフォルダの写真を左右に、DRIVE.md §26）を表示サイズで。Android も左右の移動を足す。
  ピンチで拡大（表示サイズを超えたら元の画像）。上の ⋯：元の画像・写真アプリに保存・共有・詳細。
- **スライドショー**：全画面、間隔、動画は §8。iOS は表示の間だけ画面を消さない（`isIdleTimerDisabled`）、Android は `FLAG_KEEP_SCREEN_ON`。
- **写真アプリに保存**：iOS は `PHPhotoLibrary` の追加だけの許可（`NSPhotoLibraryAddUsageDescription`、まだ無ければ足す）、Android は
  MediaStore の `Pictures/Taylis`（API 29 以上は許可なし）。複数を選んで保存できる。元の写真を流して保存（メモリに全体を持たない、
  DRIVE.md §26 のダウンロードと同じ）。
- **まとめて上げる**：アルバムの ＋「写真を選ぶ」→ 端末の写真の選択（iOS の `PHPickerViewController` は枚数の制限なし、Android の
  写真の選択は端末の上限まで（ふつう 100 枚））→ DRIVE.md §30 のアップロード（端末の中へ写してから、バックグラウンドで送る、再開、
  同じ名前の質問）。iOS は HEIC を JPEG にする（今まで）。同じ名前は既定で「名前を変えて両方残す」（§9）。帯に「312 枚中 120 枚」。
  Wi-Fi の時だけ送る設定は作らない（端末の設定に任せる）。
- 共有シートの「ドライブに保存」（DRIVE.md §30.5）で、保存先にアルバムを選べる（アルバムはフォルダなので今のまま出る。印を付ける）。

## 13. 容量

- アルバムの写真はふつうのドライブのファイルとして場所の容量に数える（DRIVE.md §11）。写すと 2 回数える（§2）。
- 表示サイズ・サムネイルは数えない（派生物）。
- 目安：学会 1 回 300 枚 × 4 MB ≈ 1.2 GB、表示サイズ +約 100 MB。年に 10 行事で十数 GB。ワークスペースの上限（150 GB の推め、
  DRIVE.md §11.1）の中で足りる。足りなくなれば admin の使用量の画面で場所ごとに見る。

## 14. 検索・バックアップ・移行

- 検索：アルバムの名前（フォルダの名前）は今のドライブの検索で見つかる。説明も `drive_albums_description_pgroonga_idx` で探し、
  `kind=album` で絞れる。写真の中の文字・写っているものの検索はしない（OCR・画像の意味検索は後、DRIVE.md §29.5）。
- 撮影日での絞り込み（「2026 年 9 月の写真」）は後で（`taken_at` の索引はある）。
- バックアップ：表示サイズは `attachments/{id}.display.webp` のオブジェクトとして今のバックアップに入る（作り直せるので、失っても
  `drive-photos --rebuild` で戻せる）。
- 今あるドライブの写真：`app.cli drive-photos --limit 500` を夜に（撮影日・位置情報の印・表示サイズ）。本番のドライブの画像の数を
  `--dry-run` で数えてから。1 枚 0.2〜0.5 秒の見込み（CPU 1 個）、数千枚で 1 時間ほど。

## 15. 段階（マイルストーン）

各段階の終わりに IMPLEMENTATION_PLAN.md §0 の確認。

| 段階 | M（仮） | 中身 | 完了条件 |
| --- | --- | --- | --- |
| **AL1** サーバ | M180 | 移行（`drive_albums`・attachments の 7 列・`drive_items.taken_at`・`drive_share_links.originals`）、`drive/albums.py`、§5 の API、media loop の写真の情報と表示サイズ（§4.2）、`/attachments/{id}/display`、`sort=taken`、`DriveItemOut.album`、`add`（移す / 写す / 投稿のファイル）、公開側の `display`・`size=display` の ZIP・`originals` の守り、`drive-photos`、`kind=album` の検索、GC・`verify-attachments` の派生物、HEIC を ffmpeg で読めるかの確かめ（§6.3） | pytest：権限（3 つの場所 × 読む・書く）、EXIF（日時・ゾーンあり / なし・向き 8 通り・GPS の印・壊れた EXIF・未来の日時）、表示サイズ（縦横・メタデータなし・50 Mpx・小さな画像は作らない）、撮影日の並びとカーソル、表紙の付け外し、`add` の 3 通り（同じ場所の投稿のファイルは移してメッセージの `drive_state` が変わらない、別の場所は写す、ふつうの添付は写す）と冪等、`originals = false` のリンクで元のファイルと元の ZIP が 403・表示サイズの ZIP の中身にメタデータが無い、ゴミ箱・移動でアルバムがついてくる |
| **AL2** Desktop / Web | M181 | 場所の列の「アルバム」、アルバムの画面（格子・日付の見出し・選ぶ・表紙・設定）、ビューアの表示サイズと元の画像、スライドショー、「写真を追加」・「ドライブから追加」・「アルバムに追加」（メッセージ）・「この投稿の写真でアルバムを作る」、アルバムのカード、「チャンネルに知らせる」、共有リンクの `originals` の印、公開ページ（`share.html`）のアルバムの形 | vitest（格子の仮想化・日付の見出し・選ぶ・カード・読めないカード・スライドショーの順番と動画）と tsc。使い捨ての compose で 500 枚のアルバムを Chrome で開き、スクロールで読まれるのが見えた枡だけであること、ログインしないブラウザで公開リンクのアルバムを見て、元の写真が落とせないこと |
| **AL3** iOS | M182 | アルバムの一覧・格子・ビューア（表示サイズ）・スライドショー・写真アプリに保存・まとめて上げる・「アルバムに追加」（メッセージ）・アルバムのカード | xcodebuild・XCTest、シミュレータで 300 枚のアップロード（途中でアプリを終わらせて続き）と格子・ビューア・保存 |
| **AL4** Android | M183 | 同上（ビューアの左右の移動を含む） | `compileDebugKotlin`・`testDebugUnitTest`・`lintDebug`、ChikuwaChat_Pixel_9 で同じ通し（ヒープが増えないこと） |
| **AL5** HEIC | M184 | §6.3 の結果で：ffmpeg で読めなかった場合に `pillow-heif` を足すか、Desktop / Web で送る前に変換するか（§17 Q4 の答え）。**2026-10-29：app のイメージを Debian trixie（ffmpeg 7.1）に上げて実装（§22）** | 実物の HEIC（iPhone・グリッド・10 bit）でサムネイルと表示サイズ |

- AL1 は CHANNEL_FILES.md の CF1 の後が望ましい（「この投稿の写真をアルバムに」が移すだけで済む）。CF1 の前に作るなら `add` は
  投稿の写真をいつも写す（後で CF1 が入れば自然に移す方へ変わる）。
- 見積もりの目安：AL1 1 週、AL2 1 週、AL3・AL4 各 1 週、AL5 2 日。

## 16. 将来

- 写真ごとのリアクション（`drive_item_reactions (item_id, user_id, emoji)`、場所を読める人）と短いコメント。
- 同じ場所の中の参照（ショートカットの項目）で 1 枚を複数のアルバムに（§2）。
- 撮影日での絞り込み・「去年の今日」。
- 同じ写真の重複の印（`drive_file_versions.sha256` が同じもの。AirDrop で同じ写真を 2 人が上げたとき「同じ写真があります」）。
- 手で並べ替え（`drive_albums` に順番の表）。
- 意味検索（写っているもの）。DRIVE.md §29.5 の `drive_text_embeddings` と同じ置き場所の考え方。

## 17. 利用者に確かめること

2026-10-28：すべて推めのとおり（§18.1）。

| # | 質問 | 推め（決まらなければこれで作る） |
| --- | --- | --- |
| Q1 | アルバムはドライブのフォルダでよいか（見える人は場所で決まる。1 枚を 2 つのアルバムに入れるには写す） | よい（§2） |
| Q2 | 「新しいアルバム」の既定の置き場所 | 今開いている場所の「アルバム」フォルダの下（研究室ドライブから作れば研究室ドライブ › アルバム）。チャンネルのタブからならそのチャンネルのドライブ |
| Q3 | 学外への共有リンクで、元の写真（位置情報を含みうる）を落とせるようにするか | アルバムのリンクは既定で表示サイズだけ（2048 px、位置情報なし）。作る時の印で元の写真も許せる。動画は元のまま |
| Q4 | Mac・Android から来る HEIC のサムネイルをサーバで作るか | まず今の ffmpeg で試す（新しい依存なし）。だめなら当面アイコンのまま、要望があれば `pillow-heif` を足す |
| Q5 | 研究室の中では元の写真の位置情報を残してよいか | 残す（詳細に「位置情報あり」と出す）。上げる時に消す設定は作らない |
| Q6 | スライドショーの動画 | 音を消して最後まで（60 秒で次へ）、「動画を飛ばす」の設定 |
| Q7 | 写真ごとのコメント・リアクションは要るか | v1 は作らない。アルバムのカードをチャンネルに投稿してスレッドで話す |
| Q8 | 写真を足したらチャンネルに自動で知らせるか | 知らせない。「チャンネルに知らせる」のボタンで下書きを作る |
| Q9 | スマホから上げる写真を縮めるか | 縮めない（元のまま。iOS の HEIC は JPEG にする）。表示はサーバの表示サイズで軽くする |
| Q10 | 表示サイズをドライブのすべての画像（アルバムでないものも）に作るか | 作る（全画面のビューアがどこでも軽くなる。領域は元の数 %、容量に数えない） |
| Q11 | 並べ方の既定と、手での並べ替え | 撮影日の古い順。手での並べ替えは要望が出たら |
| Q12 | 会話の写真を別の場所のアルバムへ足すとき、移すか写すか | 同じチャンネルのドライブのアルバムなら移す、別の場所なら写す（移すとゲストなどがメッセージで見られなくなるため） |

## 18. 段階 AL1 の実装（M180、サーバ、2026-10-29）

### 18.1 利用者が決めたこと（2026-10-28、§17 の推めをすべて採用）

| # | 決まったこと |
| --- | --- |
| Q1 | アルバム = ドライブのフォルダ。1 枚を 2 つのアルバムに入れるには写す |
| Q2 | 「新しいアルバム」は今の場所の「アルバム」フォルダの下（チャンネルから始めればそのチャンネルのドライブ） |
| Q3 | 学外への共有リンクは表示サイズだけが既定（`originals = false`）、リンクごとに元の写真を許せる。動画は元のまま |
| Q4 | HEIC はまず今の ffmpeg で試し、だめならアイコン（新しい依存は利用者の同意があれば） |
| Q5 | 研究室の中では元の写真の位置情報を残し、「位置情報あり」の印を出す |
| Q6 | スライドショーの動画は音を消して最長 60 秒、「動画を飛ばす」の設定 |
| Q7 | 写真ごとのコメント・リアクションは v1 では作らない |
| Q8 | チャンネルへは自動で投稿しない（「チャンネルに知らせる」のボタンだけ） |
| Q9 | スマホで縮めない |
| Q10 | 表示サイズはドライブのすべての画像に作る（容量に数えない） |
| Q11 | 並びは撮影日の古い順。手での並べ替えは要望が出たら |
| Q12 | 投稿の写真をアルバムへ：同じチャンネルのドライブなら移す、ほかの場所なら写す |

### 18.2 作ったもの・本書と違うところ（本文は直した）

- **移行 0127**：`drive_albums`（§4.1 のとおり、`drive_albums_cover_idx` を足した）、`attachments` の 8 列（§4.1 の 7 列に
  `display_bytes`。公開側の表示サイズの ZIP は長さを先に決めて流すので（DRIVE.md §7.2）、表示サイズのバイト数を持つ）、
  `drive_items.taken_at` と `drive_items_taken_idx`、`drive_share_links.originals`。
- **写真の情報**（`attachments/photos.py`、`drive/photos.py`）：§4.2 のとおり。EXIF の日時は `DateTimeOriginal` → `DateTimeDigitized` →
  `DateTime`、ゾーンは `OffsetTimeOriginal`（`OffsetTimeDigitized`・`OffsetTime`）、無ければ `CHANNEL_FILES_TZ`（ワークスペースのゾーン）で
  読み `taken_at_local = true`。1970-01-01 以前（時計の無いカメラの 0 も）と「今 + 1 日」より後は捨てる。位置情報の印は GPS の
  緯度・経度の tag があるとき（版の番号だけの GPS の IFD は数えない）。動画は ffprobe の `com.apple.quicktime.creationdate`（ゾーン付き）→
  `creation_time`（`;` で重なった値は最初）、`location`・`com.apple.quicktime.location.ISO6709` の形の tag。壊れた EXIF は「何も無い」。
- **表示サイズ**：本書 §6.1 は「2048 px 以下で 1.5 MB 以下の画像には作らない」だったが、**読めるすべての静止画に作る**（Q10 とも合う）。
  小さな画像は元の大きさのまま WebP にする。理由：公開側（`originals = false`）で元のバイト列を渡さず再エンコードもせずに済み、
  表示サイズの ZIP の長さが先に決まる。増える領域は小さい画像の分だけ。色のプロファイル（ICC）は残す（広色域の写真の色を保つ。
  個人の情報ではない）。EXIF・XMP は持ち越さない（新しい画像に描き直す）。動く画像には作らない。
- **media loop**（DRIVE.md §6.4）：画像はサムネイルの後に写真の情報と表示サイズ、動画は ffprobe の結果から。`drive_items.taken_at` は
  添付の行のトランザクションの後の短いトランザクションで書く（本書 §4.1 は「同じトランザクション」：media loop が添付の行を持ったまま
  木の操作が持つ項目の行を待つ形を避けた。新しい版は完了の時に NULL にし、間に別の版ができれば書かない）。**投稿の写真・動画も
  loop が読む**（CF1 は投稿のファイルを「読み済み」で入れていた。写真と動画だけ読み直す。`channel-files-backfill` で入れる前の添付は
  読み直さず `drive-photos` に任せる）。
- **今あるファイル**：`app.cli drive-photos --limit 500`（既定 500、`--dry-run` は数とバイト数だけ、`--rebuild` は表示サイズが store に
  無い画像も読み直す）。今のバージョンだけ、1 件ずつ確定、何度流してもよい。ffmpeg の無いサーバでは動画を残して数を出す。
  デプロイで全部を読む仕事は無く、ビューアが古い画像の `display` を開いたときはその版を media loop に戻す（遅延の経路）。
- **API**：§5 に足したもの：`POST /drive/albums` の `location_id`（その場所の「アルバム」フォルダ。Q2 をサーバで持つ）、
  `GET /drive/albums/{folder_id}`（アルバムの画面の 1 回の読み込み：アルバム・パス・写真のページ・子のフォルダとほかのファイルの数）、
  `sort=added`、`AlbumOut.cover_item_id`（選んだ表紙。`cover` は実際に使う表紙）、`created_by`、`AttachmentOut.has_display`、
  公開側の `SharedAlbumOut` と `SharedItemOut` の写真の列。新しいエラー：`drive_album_not_found`・`display_not_found`。
- **`add`**（§9）：添付ごと・項目ごとに既存の手順（移動は `service.move`、写しは `copying.copy` と `conversation.save_attachment`）。
  同じ名前は「名前 (1)」で両方残す。投稿のファイルで項目がアルバムと同じ場所なら移す（メッセージは同じ版を指したまま、`drive_state`
  は `available`、`message.updated` も出ない）。`mode: move` はほかの場所の投稿のファイルも移す（`impact` の確かめは端末が先に）。
  ふつうの添付（DM など）はいつも写す。ドライブの版そのもの（`drive_item_id` があり `drive_state` が無い添付）は `item_ids` で渡す
  （`attachment_ids` では `attachment_not_found`）。冪等：写しは `client_op_id` と元の id からの `uuid5`、移動はもう一度でも同じ。
  アルバムでないフォルダには 404 `drive_album_not_found`。
- **公開側**（§7）：`originals = false` で `/content` は動画以外 403、`/zip` は `size=display` だけ。表示サイズの ZIP は画像の表示サイズ
  （「名前.webp」）と動画・動く GIF（元のまま）だけで、ほかのファイルは入らない。`display` は数えない、ZIP は 1 回に数える。
- **監査**：`drive.link_created`・`drive.link_updated` の詳細に `originals`（元の写真を学外に出すかは記録に残す）。アルバムの作成・変更は
  ふつうのフォルダの操作と同じく監査しない。
- **同期**：新しいイベントは無い（SYNC_PROTOCOL.md §18）。
- **検索**：`GET /search/drive?kind=album`（名前と説明、`content` は見ない）。
- フォルダのコピーはアルバムの行を写さない（ふつうのフォルダになる）。要れば後で。

### 18.3 HEIC

§6.3 のとおり、app のイメージの ffmpeg 5.1 は HEIC を読めない（2026-10-29、`docker run … chikuwachat-app ffmpeg -i test.heic` →
`moov atom not found`）。v1 の HEIC（`image/heic`・`image/heif`）は**アイコンのまま**：サムネイル・表示サイズ・撮影日時なし、
アルバムでは写真として数え（`image/*`）、並びはファイルの時刻。直すには AL5 で次のどれか（利用者に聞く）：

1. `pillow-heif`（libheif を含む wheel）を足す。サーバのサムネイル・表示サイズ・EXIF がそのまま効く。
2. app のイメージを新しい ffmpeg（7 系以上）のある Debian trixie に上げ、`heif` を許可の一覧に足す（グリッドの HEIC を実物で確かめてから）。
3. Desktop / Web で送る前に JPEG にする（iOS と同じ。ただしブラウザが HEIC を描けるとは限らない）。

**2026-10-29：利用者は 2 を選んだ（AL5、§22）。**

### 18.4 AL2〜AL4 の端末が使うもの

- **一覧**：`GET /drive/albums?location_id=&cursor=&limit=`（`items[].folder`・`album`・`path`・`location_kind`、新しい順）。場所の列の
  「アルバム」とスマホの横に流れるカード。
- **`path` の長さ**（2026-10-29 に書き足した。API は変えない）：`GET /drive/albums` の `items[].path` と `GET /drive/albums/{folder_id}` の
  `path` は `GET /drive/items/{id}` と同じく**根から親まで**（アルバムのフォルダ自身を含まない。名前は `folder.name`）。
  `GET /drive/folders/{id}/children` の `path` は**そのフォルダ自身まで**含む。アルバムの画面のパンくずは `path` + アルバムの名前、
  アップロードの先と「ここ」の表示はアルバムのフォルダ自身（Desktop の `AlbumView` は `path` の後に `folder.name` を足し、
  `parentId` はアルバムの id）。
- **「アルバム」フォルダ**（§23）：`DriveItemOut.system_role`・`DriveCrumb.system_role` が `albums`。名前がまだ「アルバム」なら
  端末の言語の名前（Albums / 相册）、変えられていれば保存された名前。名前の変更・移動・ゴミ箱はふつうのフォルダと同じに出す。
- **アルバムの画面**：`GET /drive/albums/{folder_id}`（並びは `album.sort`・`sort_order`、`sort=taken|name|added`・`order` で切り替え、
  `next_cursor` で続き）。子のフォルダとほかのファイルは `folder_count`・`other_count` が 0 でなければ `GET /drive/folders/{id}/children`
  で（`sort=name`）。日付の見出しは `file.taken_at`（null ならファイルの時刻 `content_modified_at`、それも無ければ `created_at`。
  サーバの並びと同じ）。`can_write` で「写真を追加」・設定を出す。
- **作る・変える・やめる**：`POST /drive/albums {location_id, name, …, client_op_id}`（「新しいアルバム」：今の場所。チャンネルの画面からは
  `POST /drive/locations/resolve {kind: channel}` の id）、`{parent_id, …}`（今開いているフォルダ）。`PUT /drive/folders/{id}/album`
  （説明・表紙 `cover_item_id`（null で最初に戻す）・並び・日付）、`DELETE …/album`。エラーは `drive_album_invalid`・`drive_name_taken`。
- **格子**：`/attachments/{file.attachment_id}/thumbnail`（512 px、`has_thumbnail`・動画は `has_poster`）、動画の長さ `duration_ms`。
- **ビューア・スライドショー**：`/attachments/{attachment_id}/display`（`file.has_display`、縦横は `display_width`/`height`。無くても
  元のラスター画像が返る）。「元の画像」は今の `/drive/items/{id}/content?inline=1`（Web は download-ticket）。詳細に「位置情報あり」
  （`file.has_location`）と撮影日時。メッセージの写真も `AttachmentOut.has_display` があれば同じ `display`。
- **カード**（`/d/<フォルダの id>`）：`GET /drive/items/{id}` の `item.album`（`preview_attachment_ids` の最大 4 枚のサムネイル、
  `photo_count`・`video_count`、日付は `starts_on`〜`ends_on`、無ければ `taken_from`〜`taken_to`）。`album` が null ならふつうのフォルダの
  カード（古いサーバも）。
- **写真を足す**：アップロードは今のドライブのアップロード（`on_conflict: "rename"` を既定に）。会話・ドライブからは
  `POST /drive/albums/{folder_id}/add {attachment_ids | item_ids, mode, client_op_id}`（結果ごとに `action: moved | copied`。
  `mode: move` を選ぶときは先に `POST /drive/items/impact`）。「この投稿の写真でアルバムを作る」は `POST /drive/albums` → `add`。
  `attachment_ids` は**投稿した添付（`status = attached`）だけ**：送る前の添付（`pending`）や、ドライブの版そのもの（投稿の
  ファイルでない `drive_item_id` 付きの行。`item_ids` で足す）は、その結果が `ok: false`・`error: attachment_not_found`。
- **共有リンク**：作るダイアログの「元の写真のダウンロードを許す」= `POST /drive/items/{id}/links {originals: true}`（省けばアルバムは
  false）、`PATCH /drive/links/{id} {originals}`、一覧の `DriveShareLinkOut.originals`。
- **公開ページ**（AL2 の `share.html`）：`GET /shares/{token}` の `album`・`originals`、子の一覧（アルバムの並び）、
  `/shares/{token}/items/{id}/display`（表示）、`originals = false` なら保存は `display`（「名前.webp」）と `/zip?size=display`、
  元のファイルのボタンは出さない（押せば 403 `share_originals_disabled`）。動画は今の `/content`。
- **同期**：`drive.changed` の `folder_ids` にアルバムのフォルダ（中身）かその親（カード）があれば読み直す。
- **検索**：`GET /search/drive?q=&kind=album`。
- エラーの文言は `apps/shared/errors.json`（生成済み）：`drive_album_invalid`・`drive_album_not_found`・`share_originals_disabled`・
  `display_not_found`。

### 18.5 確かめたこと

- `tests/test_albums.py`（44 件）：EXIF の日時（ゾーンあり・マイナス・`+0900`・なし・ほかのゾーン・壊れたゾーン）、捨てる値（空・0・13 月・
  1970 年以前・エポック・未来）、`DateTime` への後戻り、GPS の印（版だけの IFD は数えない）、壊れた EXIF、向き 8 通りの縦横、2048 px への
  縮小とメタデータなし、小さな画像・透明・動く GIF、50 Mpx の上限でも日時は読む、動画の tag、media loop（`taken_at`・印・表示サイズ・
  ヘッダ・容量に数えない・GC と verify の派生物）、遅延の経路、動画の撮影日時、`drive-photos`（`--dry-run`・上限・続き・`--rebuild`）、
  作る（「アルバム」フォルダ・冪等・名前の重複・日付・説明の長さ）、変える・表紙・やめる・イベント、3 つの場所 × 読む・書く（ゲスト・
  メンバーでない人・マイドライブ・アーカイブ）、撮影日の並び（日付なし・逆順・名前・カーソル・`children?sort=taken`）、カード（4 枚・
  表紙・ゴミ箱）、`add`（同じチャンネルのドライブは移してメッセージは変わらない・冪等・`mode: copy`・ほかの場所は写して冪等・DM は写す・
  項目の移動・読めないもの・アルバムでないフォルダ）、公開側（既定 false・403・表示・動く GIF・表示サイズの ZIP にメタデータが無い・
  PATCH と監査・ほかのリンクは true・動画は再生）、ゴミ箱・戻す・移動・完全削除、一覧の並びとカーソル、検索、コピーが写真の情報と
  表示サイズを写す。
- `uv run pytest -q -n 4`（全体）、`ruff check`・`ruff format --check`・`mypy`（引数なし）。OpenAPI・`ws-events.json`・
  `apps/desktop/src/api/schema.d.ts` を再生成。

## 19. 段階 AL2 の実装（M181、Desktop / Web と公開ページ、2026-10-29）

サーバは変えていない（§18.4 の API だけを使う）。規則は `apps/desktop/src/drive/albums.ts`（DOM なしで試せる形）、画面は
`ui/AlbumView.tsx`（アルバムの画面）・`ui/AlbumViewer.tsx`（ビューアとスライドショー）・`ui/AlbumsHome.tsx`（一覧）・
`ui/AlbumDialogs.tsx`（作る・設定・ドライブから追加・アルバムに追加）、公開ページは `share/ShareAlbum.tsx`。

### 19.1 AL2 で決めたこと

- **置き場所**（§10.1）：ドライブの場所の列のいちばん上に「アルバム」（`GET /drive/albums` の新しい順、50 件ずつ、表紙・題名・
  「312 枚 · 2026/9/16〜9/19」・場所）。戻る・進むの 1 つの場所（`DrivePlace.albums`）。上の検索欄は `GET /search/drive?kind=album`。
  「新しいアルバム」は書ける場所から選ぶ（既定は研究室ドライブ、その場所の「アルバム」フォルダ）。
- **アルバムのフォルダを開くとアルバムの画面**（ドライブでもチャンネルの「ドライブ」タブでも `DriveBrowser` が切り替える）。⋯ の
  「ファイルの一覧で見る」は端末ごとに覚え（`taylis.albums.asFiles`）、一覧の上の「アルバムで見る」で戻る。一覧の行の ⋯ に
  「アルバムにする」「アルバムをやめる」、上の行に「新しいアルバム」（今の場所の「アルバム」フォルダ。フォルダの中にいれば
  「このフォルダの中」も選べる：`parent_id`）。アルバムのフォルダのアイコンは写真の印。
- **格子**：自前の行の仮想化（3〜8 列、枡 132 px 以上、日付の見出しは撮影日の並びのときだけ）。見えている行と上下 600 px の行だけを
  描き、サムネイルは行を描いたときに読む（枡ごとの `IntersectionObserver` は使わない）。続きは下から 900 px で 100 件ずつ。
  `drive.changed`（そのフォルダ）と再接続で読み直し、読み直しは持っていた件数まで（200 件ずつ）。⋯ の並べ方はこの画面だけの上書き、
  アルバムの既定は設定のダイアログで変える。
- **選ぶ**：枡のチェックボックス、⌘ / Ctrl / Shift のクリック、⌘A、Esc。何か選んでいる間はクリックも選ぶ（開かない）。選択の行は
  ダウンロード（1 枚はそのまま、2 枚以上は ZIP）・移動・写す・表紙にする（写真 1 枚のとき）・ゴミ箱（投稿のファイルは `impact` の確かめ）。
- **ビューア**：Lightbox ではなく専用（`AlbumViewer`）。表示サイズを読み、古いサーバの 404 では `/attachments/{id}/content` に戻る。
  前後 2 枚を先に読み、画像は 8 枚までをオブジェクト URL で持つ（`BlobCache`、閉じれば捨てる）。「元の画像を開く」とクリックでの拡大は
  `/drive/items/{id}/content?inline=1`（届くまで表示サイズのまま）。「位置情報あり」は上の行の印と詳細だけ（格子には出さない）。
  表紙にする・スライドショーもビューアから。HEIC など絵の無いものはアイコンと「ダウンロード」。
- **スライドショー**：窓いっぱいの重ね（デスクトップのアプリは窓の全画面：capabilities に `core:window:allow-set-fullscreen`・
  `allow-is-fullscreen` を足した。ブラウザは Fullscreen API、断られても窓いっぱいで動く）。3 / 5 / 10 秒・ランダム・「動画を飛ばす」は
  端末ごとに覚える（`taylis.albums.slideshow`）。動画は音を消して `ended` で次へ、止まったときのために長さ + 5 秒（最長 60 秒）の
  タイマー。終わりまで行けば最初に戻る。Space で止める、← → で送る、Esc で終わる。絵の無い写真（HEIC）は飛ばす。
- **写真を追加**：「ファイルを選ぶ」とドラッグ＆ドロップは今のドライブのアップロードを `on_conflict: "rename"` で（`UploadQueue.add` に
  第 3 引数を足した。名前の質問は出ない）。フォルダごとのドロップは直下のファイルだけ。「ドライブから追加」は読めるすべての場所の
  写真・動画を選び、`mode`（自動・写す・移す）を選べる。移る項目（「移す」、自動で同じ場所）は先に `POST /drive/items/impact`。
- **会話から**：メッセージの ⋯・スマホの幅の長押しのシート・写真のビューアに「アルバムに追加」（保存済みの写真・動画があるとき）。
  そのチャンネルのドライブのアルバムを先に、続けてほかのアルバム、いちばん上に「新しいアルバム」（そのチャンネルのドライブ、DM は
  マイドライブ。名前の既定「#学会 2026-09-16」）。§9 の「この投稿の写真でアルバムを作る」は別の項目にせず、この「新しいアルバム」で
  兼ねる。既定は `mode: auto`、「移す」で投稿のファイルがあれば `impact` の確かめ。終われば「アルバムを開く」の通知。ビューアから
  開いたときは会話が分からないので、新しいアルバムはマイドライブ。
- **カード**（§10.4）：`/d/<フォルダ>` の `item.album` があれば 2 × 2 の写真・題名・「312 枚 · 動画 8 本 · 2026/9/16〜9/19」・場所。
  押すとドライブのアルバム。そのフォルダか親の `drive.changed` で読み直す（カードは消さずに差し替える）。読めない人には今の
  「表示できないファイル」。
- **「チャンネルに知らせる」**：今の「会話に送る」のダイアログで、下書きにリンクと「写真を追加しました（n 枚）」（n はこの画面で
  上げ終えた数とドライブから足した数。0 ならリンクだけ）。
- **共有リンク**：アルバムのフォルダのダイアログだけに「元の写真のダウンロードを許す」（既定オフ、`originals` を送る）。`originals`
  が false のリンクには「縮小した写真のみ」の印（自分のリンクの一覧にも）、アルバムのリンクには切り替えのボタン
  （`PATCH /drive/links/{id} {originals}`）。
- **公開ページ**は Web のバンドルの `share.html`（`src/share/`、DRIVE.md §23）。子の一覧に `album` があれば（リンクの項目でも、その下の
  フォルダでも）アルバムの形：題名・日付・枚数・説明、サムネイルの格子（ブラウザの `loading="lazy"`、続きも見えたら読む）、全画面は
  `/display`、← → とスワイプ、動画は `/content`。`originals = false` なら保存は表示サイズ（「名前.webp」）、ZIP は `size=display`、PDF など
  ほかのファイルと元の画像の保存のボタンは出さない（アルバムでないフォルダ・ファイル 1 つのリンクでも同じ規則）。画像のプレビューは
  どこでも表示サイズがあればそれを使う（数えない）。公開ページにスライドショーは作っていない。
- **AL1 の再生成の後始末**：`schema.d.ts` で `AttachmentOut.has_display`・`DriveFileOut.has_display`・`has_location`・
  `DriveShareLinkOut.originals`・`SharedItemOut.has_display`/`has_poster` が必須になっていて、`drive/listing.ts` の `asAttachment` と
  テストのデータが型で通らなかった（AL1 の時点で Desktop の `tsc` は落ちていた）。両方を直した。

### 19.2 確かめたこと・確かめていないこと

- vitest：`tests/albums.test.ts`（日付の見出し・日付の範囲・枚数・格子の行と見えている行・ビューアの読み先・先読み・スワイプ・
  スライドショーの順番と時間・下書き・名前・公開ページの保存・`BlobCache`）、`tests/albumsUi.test.tsx`（アルバムの画面：見出し・
  描く枡は 100 枚より少なくサムネイルもその分だけ・子のフォルダとほかのファイル・`drive.changed`・選ぶと表紙と ZIP・ビューアの
  表示サイズと先読みと → と元の画像、スライドショー：間隔・動画を飛ばす・Space・Esc、カード：4 枚と読めないもの、共有リンクの
  `originals` の既定と切り替え、公開ページ：表示サイズ・`.webp`・`size=display`・元の画像の URL が出ないこと／許したリンク、
  会話から：並び・`mode`・`impact`・新しいアルバムの名前と場所、メニュー、一覧と `kind=album` の検索）。
  `npm run typecheck`・`npm test -- --run`（全体）・`npx vite build`。
- **確かめていない**：本物のサーバとブラウザ・Tauri の窓での見た目と操作（§15 の完了条件の 500 枚のアルバムを Chrome で開いて
  スクロールで読まれるのが見えた枡だけであること、ログインしないブラウザで公開リンクのアルバムを見ること）、Tauri の全画面、
  WKWebView / WebView2 でのスワイプ。

## 20. 段階 AL3 の実装（M182、iOS、2026-10-29）

### 20.1 AL3 で決めたこと

- **置き場所**：「ドライブ」の画面のいちばん上に「アルバム」の節（`GET /drive/albums`、新しい順の表紙のタイル 116 pt を横に流す。
  右端まで行けば続きを読む）。先頭のタイルは「新しいアルバム」（書ける場所があるときだけ）。サーバがアルバムを持たない（404）と
  節ごと出さない。アルバムのフォルダは、ドライブの積み重ね・会話の「ドライブ」タブ・`/d/` のリンクのシートのどこで開いても
  アルバムの画面（`DriveFolderView` が `folder.album` を見て `AlbumScreen` に替える。新しい画面の経路は足していないので、iPad の
  分割と iPhone Duo の形の切り替え（MOBILE_UI.md §26）はフォルダと同じに動く）。
- **ファイルの一覧で見る**：アルバムの ⋯ と、下の「フォルダ n 件 · ほかのファイル n 件」の行から。アルバムごとに端末に覚える
  （`album.listView`、最大 200 件）。一覧からは右上の格子のアイコン（「アルバムで見る」）で戻る。
- **アルバムの画面**：上に場所（「研究室ドライブ › アルバム」。会話のタブではパンくずと題名）、「312 枚 · 動画 8 本 · 2026/9/16〜9/18」
  （日付は `starts_on`〜`ends_on`、無ければ撮影日の範囲）、説明（3 行、長ければ「もっと見る」）、「スライドショー」「写真を追加」
  （`can_write` のとき）。右上は ＋（写真を選ぶ・写真を撮る・ファイルを選ぶ。「新しいフォルダ」は出さない）と ⋯（選択・並べ替え・
  ファイルの一覧で見る・リンクをコピー）。
- **格子**：正方形のサムネイル（512 px を枡の画素まで縮めて端末で 48 MB までのキャッシュ（`AlbumThumbnails`）。スクロールで戻っても
  読み直さず、何百枚でもヒープが増え続けない）、間 2 pt。列は幅で：560 pt 未満は 3 列、それ以上は 150 pt ごとに 5〜8 列（iPad、
  iPhone Duo の内側）。撮影日の並びのときだけ日付の見出し（「9月16日（水）」、今年でなければ年から。端末のゾーンの日。上に
  貼り付く）。時刻はサーバの並びと同じく `taken_at` → `content_modified_at` → `created_at`。動画は左下に ▶ と長さ。位置情報の印は
  格子に出さない。下まで見えたら次のページ（120 件ずつ）。
- **並べ替え**：撮影日・名前・追加した順と古い順 / 新しい順（名前は昇順 / 降順）。この画面の間だけで、アルバムの既定（`sort`）は
  変えない（変えるのは Desktop / Web）。
- **ビューア**：今の写真のビューア（`ImageViewer`、MOBILE_UI.md §22.6 のタップでバーを隠す・横の送り・下へ引いて閉じるのまま）に
  `extras` を足した：表示サイズ（`/attachments/{id}/display`、読めなければ元の画像）を Caches/drive/display に添付ごとに置く、上の行の
  2 行目に撮影日時（「2026/9/16 9:12」）と「位置情報あり」（細い枠の印、色の帯なし）、共有ボタンの代わりに ⋯（元の画像を開く・
  写真アプリに保存・共有・詳細）。**元の画像**は、⋯ からと、拡大して表示サイズの画素を 1.1 倍より大きく見せたとき（ズームしたまま
  同じ位置で差し替える）に読む（`DriveFiles.viewFile`、版ごとに端末に置く）。共有も元のファイル。詳細は名前・撮影日時・大きさ・
  縦横・種類・位置情報・追加した人・日時・場所と、位置情報がある写真には学外のリンクでの扱いの 1 行。送れるのは読み込み済みの
  ページの写真（全部ではない）。動画は今の動画のビューア、サムネイルの無いもの（Desktop から来た HEIC など）は詳細のシート。
- **写真アプリに保存**：`PHPhotoLibrary` の追加だけの許可（`.addOnly`）。元を `DriveFiles.viewFile` でファイルへ流してから
  `PHAssetCreationRequest.addResource(fileURL:)`（メモリに全体を持たない）。ビューアの ⋯、格子の長押し（1 枚）、⋯ の「選択」
  （複数、下の帯の「写真アプリに保存」）。結果は「3 件を写真アプリに保存しました（1 件は保存できませんでした）」、許可が無ければ
  設定への案内。`NSPhotoLibraryAddUsageDescription` はもとからあり（メッセージの保存）、文言にアルバムを足した（project.yml・
  Info.plist・InfoPlist.xcstrings）。
- **スライドショー**：全画面の黒、3 / 5 / 10 秒、順番どおり / ランダム（ランダムは全ページを読んでから混ぜる）、「動画を飛ばす」
  （どれも端末に覚える）。動画は音を消して最後まで、60 秒で次へ（再生の終わりと 60 秒の早い方。ドライブのチケットの URL を
  `AVPlayer` で流す）。次の 2 枚の表示サイズを先に読み、デコードしておくのは今と次の 2 枚だけ。表示の間は
  `UIApplication.isIdleTimerDisabled`（閉じれば戻す）。タップで上の帯（閉じる・「12 / 312」・設定）と下の ◀◀ ❚❚ ▶▶ を出し入れ
  （始めて 2 秒で消える）。格子の長押しの「スライドショー（ここから）」でその写真から。
- **まとめて上げる**：「写真を追加」と ＋。写真の選択は**枚数の制限なし**（ふつうのフォルダは今までどおり 50 枚）、同じ名前は
  `on_conflict: rename`（聞かずに両方残す、§9）。選んだものを **20 枚ずつ**端末の中（App Group）へ写してそれぞれ 1 つのバッチにし、
  すぐ送り始める（DRIVE.md §30 のバックグラウンドの `URLSession`・再開・取りやめのまま）。前は選んだ写真をすべて `Data` でメモリに
  読んでから写していた（数百枚で数 GB）。写真も動画と同じくファイルで扱う。アルバムの下の帯は「312 枚中 120 枚をアップロード
  しました」（まだ写していない枚数も数える）。写し終える前にアプリを終わらせると、まだ写していない残りは送られない（写した
  バッチは続く）。
- **HEIC**：今までどおり JPEG にして送るが、ドライブへのアップロード（アルバムもふつうのフォルダも）では `UIImage` を通さず
  ImageIO（`CGImageDestinationAddImageFromSource`、品質 0.9）で写し、**EXIF・GPS・向きの tag を残す**（`PhotoTranscode`）。前は
  `UIImage` を通して撮影日時が落ち、アルバムがファイルの時刻で並んでいた。位置情報は §7・Q5 のとおり研究室の中では残す。
  JPEG・PNG・GIF・WebP はそのまま。会話の入力欄の添付は変えていない。
- **会話の写真から**：長押しのシートの「ドライブで表示」の下に「この投稿の写真をアルバムに」（写真・動画があるとき。ゴミ箱・
  完全削除の投稿のファイルは除く。種類で見る：PDF の 1 ページ目のサムネイルは数えない）。シートは「新しいアルバム」、このチャンネルの
  ドライブのアルバム、ほかのアルバム（書ける場所のものだけ、新しい順）。`mode: auto`（同じチャンネルのドライブなら移す、
  ほかは写す。決めるのはサーバ）。「移す / 写す」の切り替えと `impact` の確かめはスマホに作らない。結果はトースト「3 枚をアルバム
  「学会」に追加しました（1 枚は追加できませんでした）」。`client_op_id` はシートごと。
- **新しいアルバム**：ドライブの画面の先頭のタイル、ふつうのフォルダの ＋（「新しいアルバム」）、会話の写真のシート。名前・場所
  （書ける場所、既定は今のフォルダの場所 / 会話のチャンネルのドライブ（まだ無ければ作る）/ DM は研究室ドライブ）・説明・日付（任意）。
  `location_id` で送り、場所の「アルバム」フォルダの下にできる（Q2）。会話からの既定の名前は「#学会 2026-09-16」（DM は日付）。
  作れば開く（会話からはそのまま写真を足す）。
- **カード**：`/d/` がアルバム（`item.album`）なら、`preview_attachment_ids` の 2 × 2（64 pt、1 枚ならその 1 枚）、題名、「312 枚 ·
  2026/9/16〜9/18」、場所の 1 行。今のカードと同じ薄い面と細い枠。押すとアルバムの画面のシート。読めない人には今の
  「表示できないファイル」。
- **同期**：アルバムの画面は `drive.changed`（そのフォルダ）・再接続・そのフォルダへのアップロードの完了で 300 ms 後に読み直す
  （見ていたページ数まで読むので、下の方を見ていても先頭に戻らない）。404 `drive_album_not_found` ならふつうのフォルダの一覧へ、
  ほかの 404 は場所の根へ。ドライブの画面のアルバムの節は再接続と引っ張って更新で。
- **共有拡張**：「ドライブに保存」の保存先のフォルダの一覧で、アルバムに写真のアイコン（`album` があるかだけ読む）。
- **作らなかったもの**（Desktop / Web で）：アルバムの設定（説明・表紙・日付の変更・アルバムをやめる）と「アルバムにする」、
  「チャンネルに知らせる」（リンクをコピーで代える）、共有リンクの `originals` の印（スマホは共有リンクを作らない）。メッセージの
  写真のビューアとふつうのフォルダの写真のビューアは今までどおり元を読む（共有の中身が元のファイルのままで済む）。

### 20.2 サーバについて気づいたこと（変えていない）

- `GET /drive/albums/{id}`・`GET /drive/albums` の `path` は**親まで**（`GET /drive/items/{id}` と同じ）で、`children` の `path`
  （自分まで）と違う。§18.4 には書いていない。iOS はパンくず・アップロードの行き先ではアルバム自身を足している。
- `add` の `attachment_ids` は投稿された（`status = attached`）添付だけ。上げただけの添付は `attachment_not_found`（会話からの
  追加では問題にならない）。

### 20.3 確かめたこと

- XCTest `AlbumTests.swift`（25 件）：日付の見出し（端末のゾーン、`taken_at` が無いときの後戻り、年またぎ、ほかの並びは見出し
  なし、同じ日が 2 度でも別の id）、日付の範囲と枚数の行、列の数（iPhone・Duo の外側と内側・iPad）、会話の写真の選び方、
  新しいアルバムの名前、選べるアルバムの順、トースト、一覧の選択、保存の文言、スライドショー（順番・ここから・動画を飛ばす・
  ランダム・HEIC を除く・長さと 60 秒・前後と先読み）、`AlbumModel`（ページ・読み直しで見ていた分まで・並びの上書き・
  アルバムでなくなった / 消えた・失敗・続けての合図は 1 回）、`AlbumListModel`（ページ・古いサーバ）、アップロードの帯の数、
  デコード（AL1 の形・古いサーバの形）、`PhotoTranscode`（JPEG はそのまま、HEIC は JPEG にして撮影日時・GPS・向きが残る、
  画像でないもの）、拡大で元の画像を読む判定と差し替え。`LocalizationTests`（ja / en / zh-Hans）。
- 使い捨てのサーバ（このブランチの `server/`、メモリの blob、`chikuwa_al3ios` の DB、:18790）と使い捨ての XCUITest（リポジトリの外）、
  iPhone 17 Pro（iOS 26.5）の新しいシミュレータで：60 枚（EXIF の日時・一部 GPS）のアルバムをドライブの画面の節から開く、格子と
  日付の見出し、ビューア（撮影日時・位置情報あり・「1 / 60」）、⋯ の詳細、元の画像を開く、写真アプリに保存（許可のダイアログ）、
  タップでバーを隠す、横に送る、スライドショー（6 秒で 2 枚目、操作の帯）、会話の `/d/` のアルバムのカード（2 × 2）、長押しの
  「この投稿の写真をアルバムに」→ 選ぶ → サーバで 63 枚、「写真を追加」で写真の選択（制限なし）から 9 枚 → バックグラウンドで送り
  格子が読み直され（72 枚、サンプル写真の EXIF の日付で並ぶ）。
- **確かめていないこと**：300 枚のアップロードと途中でアプリを終わらせての続き（送る仕組みは DRIVE.md §30 のまま。20 枚ずつ写す
  部分は単体の試験と 9 枚だけ）、動画の入ったスライドショー（サーバに ffmpeg が無く、動画を置かなかった）、iPad と iPhone Duo の
  実際の画面（列の数は試験だけ）、写真アプリに実際に入ったことの確認（許可のダイアログまで）、実機。

## 21. 段階 AL4 の実装（M183、Android、2026-10-29）

### 21.1 AL4 で決めたこと

- **置き場所**：ドライブの場所の一覧のいちばん上に「アルバム」の横に流れる表紙のカード（`GET /drive/albums`、無ければ何も出さない）。
  アルバムのフォルダはふつうの一覧の代わりにアルバムの画面で開く（ホームのドライブ・チャンネルの「ドライブ」のタブ・`/d/` のカード）。
  ⋯ の「ファイルの一覧で見る」で一覧に、一覧のバーの写真のアイコンでアルバムに戻る（画面ごと、`rememberSaveable`。端末には覚えない）。
  新しい画面の種類（Route）は作らず、今の `Route.Drive` のフォルダの中で切り替える。
- **アルバムの画面**（`ui/AlbumPane.kt`）：題名・「312 枚 · 動画 8 本 · 2026/9/16〜9/19」・場所・説明（3 行、「もっと見る」）、
  「スライドショー」「写真を追加」（書ける人）・⋯（アルバムの設定・ファイルの一覧で見る・すべてダウンロード（ZIP））。格子は
  `LazyVerticalGrid` の 3 列（幅 600 dp 以上は 5 列、840 dp 以上は 6 列）、撮影日の並びのときだけ日付の見出し（「9 月 16 日（水）」、
  今年でなければ年も）。サムネイルは RGB_565 で 40 MB までの LRU（スクロールでヒープが増え続けない）。子のフォルダ・ほかのファイルは
  「ほかに フォルダ 1 件 · ほかのファイル 2 件」の 1 行で、押すと一覧。100 枚ずつ、下から 12 枡で続き。
- **選ぶ**：長押しで選び始め、上の帯に「n 件を選択中」「表紙にする」（1 枚・書ける人）「写真に保存」。移動・ゴミ箱はスマホのドライブに
  無いので出さない。
- **ビューア**：今の `ImageViewer` を `PhotoViewer`（`HorizontalPager`）に広げた（MOBILE_UI.md §22.8）。会話の写真も
  `AttachmentOut.has_display` があれば表示サイズで開く。「元の画像を開く」（⋯）と、表示サイズの幅の 1.2 倍より大きい元の写真を
  1.5 倍より拡大したときに元の画像を読み、読めるまで表示サイズを出したまま（拡大と位置はそのまま）。`display` が 404 なら元の画像。
  前後 2 枚の表示サイズを先に読む（24 MB までのバイト列の LRU）。上の帯の 2 行目に「3 / 120 · 撮影日時 · 位置情報あり」。
  動画はポスターと ▶ のページで、押すと今の `VideoViewer`（ダウンロードチケットで流す）。⋯ に「写真に保存」「表紙にする」
  「ここからスライドショー」。
- **スライドショー**（`ui/AlbumSlideshow.kt`）：黒の全画面、ダイアログの window に `FLAG_KEEP_SCREEN_ON`（閉じれば外す）、システムの
  バーを隠す。タップで操作（閉じる・前へ・一時停止・次へ・設定）。3 / 5 / 10 秒・ランダム（同じ種で、続きのページを読んでも見た分の
  順は変わらない）・動画を飛ばす、を端末に覚える（`album.slideshow`）。写真は表示された時から数え、次の 2 枚を先に読む。動画は
  音を消して最後まで（終われば次へ）、長さ + 2 秒・最長 60 秒で次へ。読めない写真は 1.5 秒で飛ばす。読んだ分の終わりで次のページを読む。
- **写真に保存**：Android 10 以上は MediaStore（写真は `Pictures/Taylis`、動画は `Movies/Taylis`、`IS_PENDING`、許可なし）に元のファイルを
  流して保存（メモリに全体を持たない）。1 件ずつ、画面に「写真に保存中：3 / 20」、終われば「n 件を写真に保存しました」。Android 8〜9 は
  1 件なら今の「ダウンロードに保存」（システムのダイアログ）、複数は断る（許可を足さないため）。
- **作る**：ドライブの ＋ に「新しいアルバム」。場所の根では `location_id`（その場所の「アルバム」フォルダ）、ほかのフォルダでは
  `parent_id`（今のフォルダ）。作ればそのアルバムを開く。フォルダの詳細のシートに「アルバムにする」（書ける場所の、根と「投稿のファイル」
  以外のフォルダ、`PUT` を空で）。アルバムの設定は説明・並べ方（撮影日 / 名前 / 追加した順、昇順 / 降順）・日付（Material の日付の選択）・
  「表紙を最初の写真に戻す」・「アルバムをやめる」（確かめてから `DELETE`）。
- **まとめて上げる**：「写真を追加」は `PickMultipleVisualMedia`（端末の上限まで）→ 今のドライブのアップロード（DRIVE.md §30：端末の中へ
  写してから WorkManager で送る、再開できる）。同じ名前は聞かずに `on_conflict: rename`（`DriveUploadCenter.Target.onConflict`）。
  進み具合は今のアップロードの帯（「n / m 件」）。
- **この投稿の写真をアルバムに**：写真・動画のあるメッセージの長押しのシートに出す（ゴミ箱・削除済みの添付は数えない）。シートは
  「新しいアルバム」とアルバムの一覧（そのチャンネルのドライブのものが先、書けない場所のものは出さない）。「新しいアルバム」は
  公開・非公開チャンネルならそのチャンネルのドライブの、DM ならマイドライブの「アルバム」フォルダに、名前の既定は「#チャンネル 日付」
  （DM は日付だけ）。`add` は `mode: auto` だけ（移す / 写すをサーバに任せる。スマホでは `impact` の確かめを出さない）。結果は
  「n 件をアルバムに追加しました。」と追加できなかった数。
- **カード**：`/d/` の項目に `album` があれば 2 × 2 の写真・題名・「10 枚 · 2026/9/16〜9/18」・場所の行のカード（細い枠、色の帯なし）。
  押すとアルバム。読めなければ今の「表示できないファイル」のまま。ドライブの一覧の行もアルバムは表紙のサムネイル（無ければ写真の
  アイコン）と枚数の行。
- **同期**：アルバムの画面は `drive.changed` がそのフォルダを名指したとき（と再接続）に読み直す。場所の一覧の上のアルバムの列は
  どの `drive.changed` でも読み直す（`DriveHub.anyEpoch`、300 ms でまとめたもの）。

### 21.2 確かめたこと

- JUnit `AlbumsTest`（21 件）：時刻のゾーン、日付の見出し（ゾーンをまたぐ・年・重ならない鍵・名前の並びでは無し）、日付の行
  （行事の日・年をまたぐ・1 日・撮影日の範囲）、枚数とカードの行、カードの 4 枚、作る場所、選ぶ一覧の並び、投稿の写真と既定の名前、
  追加の結果の文、スライドショーの順（順番・飛ばす・ランダムの種）と時間と設定の保存、元の画像を読む時、ビューアのページ、
  横の払いがページ送りになる条件（`ImageDismiss.decide`）、アルバムのフォルダの表紙とアイコン、API の形の読み、ページの読み・読み直し・
  アルバムでない / 見えない、一覧の重ならない続き、`anyEpoch`。`ImageViewerTest`・`DriveTest` はそのまま通る。
- `./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug`。
- 使い捨ての compose（`-p al4test`、ポート 8044、終わって `down -v`）に EXIF の日時と GPS を入れた 12 枚の写真を投稿し、10 枚を研究室
  ドライブのアルバムへ `add`（写す）して、エミュレータ（ChikuwaChat_Pixel_9）で：会話の `/d/` のアルバムのカード → アルバムの画面
  （見出し 9/16・9/17、日付の行、説明）、写真を開いて左右に払う（1 / 10 → 2 / 10 → 1 / 10）、上の帯の「位置情報あり」、タップで帯を
  隠す、⋯ の「写真に保存」で `Pictures/Taylis/IMG_1000.jpg`（元のファイル）、「ここからスライドショー」が 5 秒ごとに進み
  `FLAG_KEEP_SCREEN_ON` が付き、閉じると外れる、ドライブの上のアルバムの列、長押しの「この投稿の写真をアルバムに」→「新しいアルバム」
  （「#gakkai 2026-10-29」、チャンネルのドライブ、6 枚が入った）。Java ヒープは操作の後 28 MB。
- 確かめていないこと：300 枚のアップロードの途中でアプリを終わらせての続き（今のドライブのアップロードの仕組みのまま）、
  長いアルバムでのヒープの推移の計測、動画のスライドショー（再生・60 秒）、元の画像への拡大での差し替え、タブレットの列の数、
  Android 8〜9、TalkBack。
- 気づいたこと（サーバ）：パンくずの「アルバム」フォルダの名前はサーバが日本語で付けるので、英語・中国語の画面でも「アルバム」と出る
  （「投稿のファイル」のように端末の言語で出すなら `system_role` 相当の印が要る）。

## 22. 段階 AL5 の実装（M184、HEIC、2026-10-29）

利用者は §18.3 の 2（app のイメージを Debian trixie に上げる）を選んだ（2026-10-29）。`pillow-heif` は足していない（新しい
Python の依存なし）。

### 22.1 イメージ

- `server/Dockerfile` の土台を `ghcr.io/astral-sh/uv:python3.13-bookworm-slim` から **`ghcr.io/astral-sh/uv:python3.13-trixie-slim`** に
  （Python は同じ 3.13、Debian 12 → 13）。apt で入れるのは今までどおり `ffmpeg` だけで、trixie でも同じ名前（`7.1.5-0+deb13u1`）。
  Python の依存は wheel のまま（`uv sync --frozen` が通る）。
- 大きさ：展開後 1.39 GB → 1.40 GB、取得する量（content size）343 MB → 348 MB（arm64 で測った値）。
- converter（Gotenberg）・web（Caddy）・db・objectstore のイメージは土台が別なので変えていない。

### 22.2 ffmpeg 7.1 で読む（`attachments/heif.py`）

確かめたこと（`docker run … ffprobe -show_stream_groups` と `ffmpeg … -map 0:g:0`）：ffmpeg 7.1 の mov の demuxer は HEIF の
グリッドを「Tile Grid」のストリームグループ（タイル 1 枚が 1 本のストリーム、オフセットと出力の縦横つき）として読むが、
**コマンドはタイルをつながない**（既定では 512 × 512 の 1 枚目だけが出る。つなぐのは新しい ffmpeg）。irot / imir（HEIF の向き）も
当てない。そこで：

1. **箱を読む**（Python、画素は展開しない）：`meta` の主の項目（`pitm`）の型（`hvc1` か `grid`。AVIF などは対象外）、縦横（`ispe`）、
   irot / imir（ファイルに並ぶ順）、ICC（`colr` の `prof`）、EXIF の項目（`iinf` の `Exif`、`iloc` で場所。主の項目を `cdsc` で指すもの
   を先に）。読むのはファイルの先頭 4 MB まで、EXIF と ICC はそれぞれ 1 MB まで。縦 × 横が 50 Mpx（`images.MAX_PIXELS`）を超えれば
   展開せず、撮影日時と位置情報の印だけ読む。
2. **向き**：HEIF では EXIF の Orientation は参考の値で、向きは irot / imir が決める（libheif・Apple と同じ）。irot は反時計回り、
   imir の axis 0 は上下、1 は左右を入れ替える（`sips` と ffmpeg 9 の結果に合わせた）。ファイルに並ぶ順に `transpose`・`hflip`・
   `vflip` を当て、`-noautorotate` で ffmpeg 自身には回させない（新しい ffmpeg が irot を読むようになっても二重に回らない）。
3. **タイル**：`ffprobe -show_stream_groups` のタイルのストリームとオフセットを `xstack` でつなぎ、出力の縦横に `crop`。タイルの無い
   HEIC は既定（default）のストリーム 1 本。タイルは 1024 枚まで。
4. **出力**：長い辺 2048 px 以下に縮めた RGB の PNG（上限 64 MB）を Pillow が開き、ICC を付けて、ほかの写真と同じ
   `make_display`（WebP、メタデータなし）と `thumbnail_jpeg`（512 px の JPEG）。記録する `width` / `height` は元の大きさを立てた値。
5. **閉じ込め**：動画と同じ `videos.run_bounded`（引数の配列・`PATH` と `LC_ALL` だけの環境・`VIDEO_PROBE_TIMEOUT_SECONDS`・
   `VIDEO_PROBE_MAX_CONCURRENT` の枠を共有）、入力は `-protocol_whitelist file` と `-format_whitelist mov,mp4,m4a,3gp,3g2,mj2`。
   ffmpeg が無い・`VIDEO_PROBE_ENABLED=false` なら何もしない。

### 22.3 どこで作るか

- **投稿の添付**（`POST /attachments`）：アップロードの応答の前にサムネイルと縦横（動画のポスターと同じ場所、SECURITY.md §4）。
  読めない HEIC・50 Mpx を超える HEIC はふつうのファイルのまま（画像のように 422 にしない：AL5 の前から受け付けていたもの）。
- **ドライブ**（media loop、投稿のファイルも）：サムネイル・表示サイズ・撮影日時・位置情報の印を 1 回の展開で。
  ffmpeg の無いサーバでは動画と同じく読まずに残す（`photo_probed_at` は NULL のまま）。
- **今ある HEIC**（AL5 の前にドライブに入ったもの）：`app.cli drive-photos --limit 500` が読む（HEIC はまだ一度も写真として
  読まれていないので `photo_probed_at IS NULL`。サムネイルもここで作る）。ビューアが `/attachments/{id}/display` を開けば、その版を
  media loop に戻す（HEIC は元のファイルをブラウザが描けないので、その回は 404 `display_not_found`）。
- `content_type` は今までどおり先頭バイトの判定（`filetype`）：ブランドが `heic`（`mif1` / `msf1` で互換に `heic` を含むものも）は
  `image/heic`。~~`heix`（Core Image の 10 bit の書き出しなど）は判定できず `application/octet-stream` のまま~~ → §23.3 で
  `heix` ほかの HEIF のブランドも判定するようにした。
- 写真の一覧（`photo_kinds.PHOTO_TYPES`）には HEIC / HEIF が入るが、`images.IMAGE_TYPES`（プロフィール画像・絵文字・取り込み）は
  変えていない。`INLINE_TYPES` も変えない（HEIC の元のファイルは `inline` で返さない）。

### 22.4 端末への注意（AL2〜AL4）

- HEIC の添付・ドライブのファイルにも `has_thumbnail`・`width` / `height`・`has_display` が付く。今の Desktop / Web の写真の
  ビューア（`Lightbox`）は元のファイル（`content`）を読むので、Chromium / WebView2（Windows・Linux・Chrome）では HEIC の全画面が
  「画像を読み込めませんでした」になる（macOS の WebKit は描ける）。**AL2 のビューアは `has_display` なら `/display` を使う**
  （§18.4）。iOS・Android は OS が HEIC を描ける。

### 22.5 確かめたこと

- 実物：macOS の `sips -s format heic` で 4032 × 3024 の JPEG（EXIF の Orientation 6・`DateTimeOriginal`・GPS）から作った
  iPhone 形の HEIC（512 px のタイル 48 枚、irot 270）、Core Image で書いた 10 bit（Main 10、Display P3 の ICC）と 8 bit の
  Display P3、タイルの無い 400 × 300、macOS の壁紙（`Sonoma.heic` ほか、6016 × 6016）。trixie のイメージの中で
  `heif.read` を流し、どれも正しい向きのサムネイルと表示サイズ（1536 × 2048 など）になった。12 Mpx で 0.4〜0.7 秒（arm64、
  2 スレッド）。bookworm のイメージ（ffmpeg 5.1）では読めず、何も作らない（ファイルのまま）ことも確かめた。
- `tests/test_heif.py`（19 件）：箱（グリッド・回転・EXIF の日時と GPS、回転と鏡の順、切れた・ほかの形式のファイル、大きすぎる箱）、
  `ffprobe` の結果の読み方、ffmpeg のコマンド（`xstack`・`crop`・順・`-noautorotate`・whitelist）、ffmpeg の無いとき、50 Mpx を
  超えるとき（展開しない、日時は読む）。ffmpeg が HEIF のグリッドを読めるとき（7.1 以上。CI の runner の古い ffmpeg や無いときは
  skip）：グリッドと鏡の付いた HEIC の向き（四隅の色）、切れた HEIC、投稿のサムネイル、ドライブのサムネイル・表示サイズ・撮影日時・
  位置情報の印、古い HEIC の `drive-photos` と遅延の経路、ffmpeg の無いサーバでは残す。テストの HEIC（`tests/fixtures/heic/`、
  2 KB と 0.7 KB）は `sips` で作った。
- `uv run pytest -q -n 4`（全体、Mac の ffmpeg 9）、trixie のイメージの中で全体（ffmpeg 7.1、HEIC のテストも skip なし）、
  bookworm のイメージの中で `test_heif.py`（6 件 skip）。`ruff check`・`ruff format --check`・`mypy`。OpenAPI と
  `apps/desktop/src/api/schema.d.ts` を再生成（`/display` の説明だけ）。

## 23. AL の手直し（2026-10-29、サーバと Desktop / Web、移行 0128）

AL1〜AL5 の後の手直し 4 つ。スマホ（iOS・Android）は変えていない（§23.5 に要るもの）。

### 23.1 「アルバム」フォルダの名前を端末の言語に

`POST /drive/albums {location_id}` が作る・使う「アルバム」フォルダは日本語の名前で保存されるので、英語・中国語の画面でも
「アルバム」と出ていた。「投稿のファイル」（CHANNEL_FILES.md §3.3・§19）と同じ仕組みで印を付ける。

- **移行 0128**：`drive_items.system_role` の CHECK を `NULL | 'channel_posts' | 'albums'`（フォルダだけ）に。部分一意索引
  `drive_items_system_role_uniq`（場所 × 役、ゴミ箱の外）はそのまま：場所ごとに生きた「アルバム」フォルダは 1 つ。
- **API**：`DriveItemOut.system_role` と `DriveCrumb.system_role`（パンくず、公開リンクの `path` も）が `"channel_posts" | "albums" | null`。
- **決めたこと：守らない**。「投稿のファイル」と違い、名前の変更・移動・ゴミ箱はふつうのフォルダと同じにできる（409
  `drive_folder_system` は `channel_posts` だけ）。人が整理のために動かしたいフォルダで、サーバが中身を入れ続けるものでもない。
  - **名前を変えたら**：役は残る（新しいアルバムはまだそこに入る）。端末は**保存された名前がまだ「アルバム」のときだけ**自分の
    言語の名前（アルバム / Albums / 相册）にし、変えられていればその名前を出す（人が付けた名前を言語で書き換えない）。
  - **場所の中で移したら**：役は残る（`POST /drive/albums {location_id}` は今の場所のどこにあってもそのフォルダを使う）。
  - **ゴミ箱に入れたら**（上のフォルダごとでも）、**ほかの場所に移したら**：役を外す（`service.release_albums_role_in_tx`）。
    一意索引とぶつからないように：戻した時・移した先にはもう別の「アルバム」フォルダがあるかもしれない。次の
    `POST /drive/albums {location_id}` が新しく作るか、根の直下に「アルバム」という名前のフォルダがあればそれに役を付ける
    （戻したフォルダが根の直下に戻ればそれ。移した先の根の直下に置けばそこのもの）。
  - アルバムのフォルダにはできない（`PUT /drive/folders/{id}/album` は 422 `drive_album_invalid`、今までどおり）。中に
    `parent_id` でアルバムを作るのはできる（前は `system_role` のあるフォルダの中を断っていたのを `channel_posts` だけに）。
- **探し方**（`albums._albums_folder_in_tx`、根の行を持ったまま）：(1) その場所の `system_role = 'albums'` の生きたフォルダ、
  (2) 無ければ根の直下の「アルバム」という名前のフォルダに役を付ける（`drive.changed` は根）、(3) 無ければ作る（役付き）。
  同じ名前のファイルがあれば今までどおり 409 `drive_name_taken`。
- **今あるフォルダ**（移行 0128 の backfill）：AL1 はどのフォルダを作ったかを記録していない（監査もしない）。ただし AL1 は
  「根の直下の『アルバム』という名前のフォルダ」を探して使っていた（人が作ったものも使った）ので、**根の直下の生きた
  「アルバム」フォルダ**はどれも「アルバム」フォルダとして扱われていたもの。それに `albums` を付ける（名前は親ごとに一意なので
  場所ごとに高々 1 つ）。`change_seq` を進める。downgrade は役を外して CHECK を戻す。
- **古い端末**：iOS・Android の出荷版は `system_role` を文字列で読み `channel_posts` と比べるだけなので、`albums` はふつうの
  フォルダ（「アルバム」のまま）。前の Desktop / Web は `system_role` があれば「投稿のファイル」のように名前の変更・移動・ゴミ箱を
  隠すが、Web は配備で、デスクトップは更新で直る。
- **Desktop / Web**：`drive/channelFiles.ts` の `itemName`・`crumbName`（→ `localizedPath`）が `albums` で名前が「アルバム」なら
  `albums.folder`（アルバム / Albums / 相册）。`isSystemFolder`・`canRearrange`・`rememberSystemFolders` は `channel_posts` だけ
  （「アルバム」フォルダは名前の変更・移動・ゴミ箱を出し、アイコンはふつうのフォルダ）。名前の変更のダイアログの初めの値は
  保存された名前。公開リンクのページ（`share/`）は名前を訳さない（今までどおり保存された名前）。
- 試験：`test_albums.py`（役・パンくず・一覧、アルバムにできない・中に作れる、名前の変更と場所の中の移動で役が残り新しいアルバムが
  そこに入る、ゴミ箱で外れて次のアルバムが新しいフォルダを作る、戻しても役は無い、ほかの場所へ移すと外れ、そこの根の直下なら
  次のアルバムが役を付ける、人が作った「アルバム」に役を付けて項目の数は 1 つだけ増える）。移行は私用の DB で
  0127 → 0128（根の直下の「アルバム」だけに付き、ほかのフォルダの下の「アルバム」には付かない）→ 0127 → 0128 を確かめた。

### 23.2 Desktop / Web のビューアは表示サイズを読む

AL5 の後、HEIC の投稿とドライブのファイルは写真の格子に出るが、全画面の `Lightbox`（メッセージの写真・ドライブのビューア・
キャンバスの画像・入力欄の送る前の写真）は元のファイルを読み、Chromium / WebView2 では HEIC を描けなかった（§22.4）。

- **読む順**（`ui/attachmentLayout.ts` の `viewerPictures`、`Lightbox` の `useViewerPicture`）：`has_display` なら
  `/attachments/{id}/display` → 元のファイル（`/content`）。HEIC / HEIF は `has_display` が無くても `/display` を先に頼む（ドライブの
  まだ読んでいない HEIC はこれで media loop に戻る。会話だけの HEIC は 404 `display_not_found`）→ 元のファイル → `has_thumbnail`
  ならサムネイル（512 px）。次へ進むのは取得の失敗（404・古いサーバ）か、ブラウザが描けなかった時（`<img>` の `onError`：
  Chromium の HEIC）。全部だめなら「画像を読み込めませんでした」と「再試行」（初めから）。GIF はいつも元のファイル（動くかも
  しれない。表示サイズは動かない 1 枚）。
- **「元の画像を開く」**：表示サイズを出している時、ビューアの上の行のボタン（`attach.openOriginal`）で元のファイルに切り替える
  （HEIC には出さない：描けないことが多い）。ダウンロードと「開く」（デスクトップ）は今までどおり元のファイル。
- **アルバムのビューア**（`AlbumViewer`、`drive/albums.ts` の `viewerSources`）：`/display` が読めない時の代わり（`fallback`）は
  元のファイル、HEIC はサムネイル。HEIC には「元の画像」を出さない（`original: null`）。
- **メッセージの格子と入力欄**は前から `/thumbnail`（HEIC も `has_thumbnail` で写真のタイル）。入力欄の送る前の HEIC は、アップロードの
  応答の前にサムネイルができるのでタイルに出て、押すと上の順（会話の HEIC は表示サイズが無いので、Chromium ではサムネイル）。
- 試験：`tests/albumsFollowups.test.tsx`（読む順、HEIC の表示サイズ、元のファイル → 描けなければサムネイル、全部失敗して再試行、
  JPEG の「元の画像を開く」、表示サイズの無い写真、アルバムのビューアの `viewerSources`）、`tests/albums.test.ts`。

### 23.3 HEIF のほかのブランド

`filetype` はブランドが `heic`（と `mif1` / `msf1` で互換に `heic`）のものしか HEIC と言わず、`heix`（10 bit、Core Image の書き出し）
などは `application/octet-stream`（サムネイルなし）だった。

- `attachments/heif.py` の `sniff`（先頭の `ftyp` の箱だけを読む。長さは 16〜1024 バイトで 4 の倍数、先頭のバイト列に収まること）：
  主のブランドが HEVC のブランド（ISO/IEC 23008-12 付属 B：`heic`・`heix`・`heim`・`heis`、画像の列の `hevc`・`hevx`・`hevm`・`hevs`）
  なら `image/heic`。主のブランドが汎用（`mif1`・`mif2`・`msf1`）で、互換に AVIF（`avif`・`avis`・`avio`）が無く、互換に HEVC の
  ブランドがあれば `image/heic`、無ければ先頭のバイト列の `meta` の箱を今の箱の読み手（`heif.parse`）で読み、主の項目が `hvc1` か
  `grid` なら `image/heif`。それ以外は `None`（`filetype` に任せる。MP4 の動画は主のブランドが `isom` / `mp42` などなので変わらない）。
- `attachments/sniff.py` の `content_type(head)`：`heif.sniff` → `filetype`。投稿の添付（`POST /attachments`）、ドライブのアップロード
  （`_sniff`・`sniffed_type`）、取り込み（Mattermost・Slack・Notion・Nextcloud）が使う。プロフィール画像・絵文字・ワークスペースの画像は
  今までどおり `filetype` だけ（HEIC を受け付けない）。
- 箱の読み手はブランドを見ないので、`heix` などもサムネイル・表示サイズ・撮影日時が付く（ffmpeg が読めれば）。`image/heif` は前から
  `HEIF_TYPES` に入っている。
- 今あるファイルの `content_type` は直さない（`heix` の古いファイルは `application/octet-stream` のまま。上げ直せば HEIC）。
- 試験：`test_heif.py`（テストの HEIC の `ftyp` を書き換えて：6 つの HEVC のブランド × 2 つのファイルで `sniff` と `sniffed_type`、
  汎用のブランド（互換の HEVC・`meta` の主の項目・`av01` にした項目・AVIF）、ほかのファイル（MP4・HEVC の MP4・切れた `ftyp`・
  4 の倍数でない・大きすぎる・PNG）、`filetype` の判定が変わらないこと、`heix` の投稿が `image/heic`、ffmpeg があればサムネイル）。

### 23.4 そのほか

- `server/.dockerignore`：`**/__pycache__/` と `**/*.pyc`（前は上の階だけで、`app/` の下の `__pycache__` がイメージに入っていた）。
- OpenAPI と `apps/desktop/src/api/schema.d.ts` を再生成（`system_role` の値）。

### 23.5 スマホ（iOS・Android）に要るもの

- **`system_role = "albums"`**：ドライブの一覧・詳細・パンくず（`DriveCrumb.system_role`）で、名前が「アルバム」のままなら端末の
  言語の名前（アルバム / Albums / 相册）。名前が変えられていればその名前。**守らない**：名前の変更・移動・ゴミ箱のメニューは
  ふつうのフォルダと同じに出す（`isChannelPosts` の判定は `channel_posts` のままでよい。`systemRole != nil` で守っている所があれば
  `channel_posts` だけに）。「アルバムにする」は出さない（サーバは 422）。アイコンはふつうのフォルダでよい。
- 出荷版はそのままでも壊れない（`albums` はふつうのフォルダとして「アルバム」と出る）。デコーダの試験に `system_role: "albums"` の
  実物の JSON を足すとよい。
- ビューアはもう `has_display` なら `/display`（AL3・AL4）。会話だけの HEIC は表示サイズが無いが、iOS・Android は元のファイルを描ける。
