# ALBUMS（写真のアルバム）

2026-10-28 の設計。**AL1（M180、サーバ）を実装（2026-10-29、移行 0127、§18）**。§17 の質問はすべて推めのとおりに決まった
（2026-10-28、§18.1）。次は AL2〜AL4（Desktop / Web・iOS・Android、§18.4 に端末が使うもの）。マイルストーンは AL1〜AL5（§15、M180〜M184）。

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
- **HEIC**：iOS は今までどおり送る前に JPEG にする（DRIVE.md §30.2）。Desktop / Web から来た HEIC はサーバでサムネイル・表示サイズを
  作れない（Pillow が読めない）。AL1 で確かめた結果、**app のイメージの ffmpeg（Debian bookworm の 5.1）も HEIC を読めない**ので、
  v1 はアイコンのまま（§6.3、§18.3）。
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
| **AL5** HEIC（必要なら） | M184 | §6.3 の結果で：ffmpeg で読めなかった場合に `pillow-heif` を足すか、Desktop / Web で送る前に変換するか（§17 Q4 の答え） | 実物の HEIC（iPhone・グリッド・10 bit）でサムネイルと表示サイズ |

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

### 18.4 AL2〜AL4 の端末が使うもの

- **一覧**：`GET /drive/albums?location_id=&cursor=&limit=`（`items[].folder`・`album`・`path`・`location_kind`、新しい順）。場所の列の
  「アルバム」とスマホの横に流れるカード。
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
