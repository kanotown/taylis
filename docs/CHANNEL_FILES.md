# CHANNEL_FILES（チャンネルに投稿したファイルをチャンネルのドライブに置く）

2026-10-28 の設計。**CF1（M174、サーバ）は実装済み（2026-10-28、移行 0126）**：§19 に作ったものと本書と違うところ。
CF2〜CF4（端末）・CF5（大きなファイル）はまだ。CF6 のうち CLI（`channel-files-backfill`）は CF1 で作った（本番で流すのと
infra/README.md の手順が残り）。マイルストーンは CF1〜CF6（§15。M 番号は仮に M174〜M179）。§18 の質問はすべて推めの答えで決まった
（利用者、2026-10-28）。

利用者（研究室の教員）の要望（2026-10-28）：チャンネルに投稿したファイルが、そのチャンネルのドライブにも入っているようにしたい。
Microsoft Teams でチャンネルのファイルが SharePoint のフォルダにあるのと同じように、会話で渡したファイルを後からドライブで
探し・整理し・まとめて落とせるようにする。

関連：DRIVE.md（§3 場所と権限、§4.1 バイト列を `attachments` の行に任せる理由、§10 ゴミ箱とバージョン、§11 容量、§13 会話との連携、
§25 `/d/` のカード、§29 中身の全文検索、§30 スマホのアップロード）、DATA_MODEL.md「attachments」「drive_*」、SECURITY.md §4
（添付・ドライブ・外部共有リンク）、PREVIEWS.md、SYNC_PROTOCOL.md §6（`message.updated` の `change = "attachments"`）、MOBILE_UI.md §24・§25、
ALBUMS.md（写真のアルバム。§13 でつながる）。

画面の名前は「投稿のファイル」（英語 Posted files、中国語 帖子中的文件）、コード上の名前は `channel_files`（モジュール `app/modules/drive/` の中の
`channel_files.py`、設定 `channel_files_to_drive`）。

## 0. 結論

- **公開・非公開チャンネルのメッセージに付けたファイルは、送った時にそのチャンネルのドライブの「投稿のファイル › 2026-10」に
  入る**（年月のフォルダ、ワークスペースのタイムゾーン）。スレッドの返信も同じフォルダ。DM・グループ DM は今までどおりの添付
  （ドライブが無い、DRIVE.md §3.1）。
- **バイト列は 1 つ、行も 1 つ。** 添付の行（`attachments`）がそのままドライブの新しい項目のバージョン 1 になる（`message_id` と
  `drive_item_id` の両方を持つ）。写さないので領域も容量も 1 回分。ドライブはもともと「バージョン 1 つ = `attachments` の行 1 つ」
  （DRIVE.md §4.1）なので、新しい仕組みの参照の数え方は要らない。
- **メッセージは投稿した時のバージョンを指し続ける**（Slack と同じ。Teams の「いつも最新」は採らない）。ドライブで新しいバージョンを
  上げても、メッセージの中身・サムネイル・名前は変わらない。新しい端末はビューアに「新しいバージョンがあります」と出す。「今の版を
  指したい」ときは今までどおり `/d/` のリンク（DRIVE.md §13.1）。**添付は投稿した時の写し、リンクは今のもの**、と 1 行で言える形に
  する（§4）。
- **ドライブの項目が正本。** 名前の変更・チャンネルのドライブの中での移動では、メッセージの表示は何も変わらない。ゴミ箱に入れると
  メッセージは「削除されたファイル」（戻せば戻る）、完全に消すと「削除されたファイル」のまま。別の場所（研究室ドライブ・別の
  チャンネル・マイドライブ）へ移すと、移した先を読める人だけが見られ、ほかの人には「表示できないファイル」（DRIVE.md §13.1 の
  リンクと同じ）。移す・ゴミ箱に入れる前に、端末は「このファイルは #ch の 2 件のメッセージに付いています」と出す（§6）。
- **読める人**：（ドライブの項目を読める人）∪（そのメッセージを読める人。ただし項目がまだそのチャンネルのドライブにあり、ゴミ箱に
  無いときだけ）。これで、公開チャンネルの参加前のプレビュー（M27）・ゲストのメンバー・抜けた人の扱いが今の添付と同じになる（§5）。
- **メッセージを消しても、ふつうはドライブのファイルは残る**（ファイルはもうチャンネルのもの）。ただし「送った本人（かモデレーター）が
  消し、ファイルが投稿の後に変わっていない」ときは一緒にゴミ箱へ入れる（間違えて送ったファイルを消すため。30 日は戻せる）。新しい
  端末は削除の確認に「ドライブのファイルもゴミ箱に移す」の印を出す（§7.3）。
- **容量は 1 回だけ数える**（チャンネルのドライブの `used_bytes`）。ただし**投稿は容量で断らない**：上限を超えていても入れる
  （上限はドライブへのアップロードだけを止める）。投稿の信頼性をドライブの都合で下げない（§8）。
- **古い端末もそのまま添付を表示する。** `MessageOut.attachments` の形と `id` は変わらず、`AttachmentOut` に任意の欄 `drive` が
  増えるだけ。ゴミ箱・移動で読めなくなったファイルは、古い端末では今の「読み込めませんでした」になる（§11）。
- **切り替え**：ワークスペースの設定（admin、既定オン）と、チャンネルごとの上書き（オーナー、既定は「ワークスペースに従う」）。
  変えて効くのはそれからの投稿だけ（§9）。
- **今までの添付は自動では移さない。** チャンネルを選んで流す CLI（`app.cli channel-files-backfill`、写さずに行を足すだけ）を
  用意し、流すかは admin が決める（§10。CLI は CF1 で作った）。

## 1. 目標と非目標

### 1.1 目標

- チャンネルで渡したファイルが、何もしなくても後からそのチャンネルのドライブで見つかる（月ごとのフォルダ、名前と中身の検索 §29、
  ZIP でまとめて落とす、外部共有リンク）。
- ドライブで整理（名前の変更・フォルダへの移動）しても、会話の中の添付が壊れない。
- バイト列と容量は 1 回分。バックアップも 1 回分。
- 会話の記録としての信頼性を下げない：投稿は容量・ドライブの失敗で断らない、投稿した中身は後のバージョンで変わらない。
- 古い端末（iOS・Android・Desktop の出荷版）がそのまま添付を表示できる。

### 1.2 非目標（この設計では作らない）

| 作らないもの | 理由・代わり |
| --- | --- |
| DM・グループ DM のファイルをドライブに置く | DM にはドライブが無い（DRIVE.md §3.1、メンバーが固定でオーナーがいない）。今までどおりの添付。「ドライブに保存」で写せる |
| キャンバス・ドキュメントのページの添付 | メッセージではない（本文の一部）。今までどおり |
| メッセージの添付を「いつも最新のバージョン」にする | §4。今のものを指したいときは `/d/` のリンク |
| 1 つのオブジェクトを複数の行で共有する（参照の数え方） | DRIVE.md §1.3 の「重複排除をしない」を守る。1 行が 2 つの役（添付とバージョン）を持つ形で足りる（§3.1） |
| メッセージを送った後に添付を足す・外す | 今もできない（`MessageEdit` は本文だけ）。足すときは「外す = ドライブのファイルは残す」（§7.3 の keep と同じ）にする |
| 100 MB を超えるファイルを添付として送る | 添付の上限（`ATTACHMENT_MAX_BYTES`）は変えない。大きなファイルはドライブに上げて `/d/` のリンクで投稿する流れを入力欄に足す（CF5、§12.4） |

## 2. 今の作りとの関係、ぶつかる所

| 今の作り | ぶつかる所 | 対応 |
| --- | --- | --- |
| 添付は `POST /attachments`（100 MB まで、1 リクエスト）で pending になり、送るときに `bind_in_tx` が `message_id`・`channel_id` を入れる | 上げる時にはどのチャンネルか分からない | ドライブへ入れるのは **bind の時**（同じトランザクション、§6.1）。アップロードの経路は変えない |
| `get_for_access`：`drive_item_id` があればドライブの権限だけで決める（DRIVE.md §4.1） | 投稿のファイルは「メッセージを読める人」にも見せたい（公開チャンネルの参加前のプレビュー M27 は、チャンネルのドライブ（メンバーだけ）より広い） | 投稿のファイルの枝を足す（§5.2）。ドライブで読めなくても、メッセージで読めることがある |
| メッセージの削除：`mark_deleted_in_tx` が添付を `deleted` にし、GC がバイト列と行を消す | ドライブのバージョンが消えてしまう | 投稿のファイルはメッセージから外すだけ（§7.3）。ドライブに残すかゴミ箱に入れるかは決まりで |
| ドライブの名前の変更は今のバージョンの添付の `filename` も変える（DRIVE.md §20.1、プレビューの PDF の名前のため） | メッセージの添付の名前が、イベントも `updated_seq` も無しに変わる（端末ごとに食い違う）。マイドライブへ移した後の名前の変更が会話に漏れる | メッセージに付いた行の `filename` は投稿の時のまま変えない（§4.3）。ドライブの経路は名前を項目から取る（今も `/drive/items/{id}/content` はそう） |
| バージョンの整理（今の版でないものは 10 版・30 日、DRIVE.md §10.2） | メッセージが指すバージョンが消える | メッセージが指すバージョンは整理しない・数に入れない（§4.2） |
| ゴミ箱の 30 日の完全削除・手での完全削除：バージョンの添付を `deleted`、GC が行ごと消す | メッセージの添付が黙って消える（端末に何も届かない） | 投稿のファイルは「削除済み」の印だけ残し（墓石）、メッセージに `message.updated` を出す（§7.5） |
| 古いバージョンの手での削除（`DELETE /drive/items/{id}/versions/{vid}`） | メッセージが指すバージョンを消せる | 409 `drive_version_posted`（§7.4） |
| 動画の backfill（`probe-videos`）・`generate-previews` はドライブの行を取らない（DRIVE.md §20.2） | 投稿のファイルが両方から漏れる | `message_id` のある行はチャットの行として扱う（条件を「`drive_item_id IS NULL OR message_id IS NOT NULL`」に） |
| ドライブの media loop（§6.4）は `processed_at IS NULL` のバージョンを処理する | 添付はアップロードの時に SHA-256・サムネイル・ポスターを作り済み | 入れる時に `sha256` を写し、`processed_at = now()` で入れる（やり直さない）。中身の全文（§29）は loop がいつもどおり読む |
| `GET /files`（「ファイル」のタブ）とメッセージ検索のファイル名の枝は `messages` と結合する | 投稿のファイルはそのまま出る（よい）。ゴミ箱・別の場所へ移したもの・墓石が出ると困る | `drive_state` が `available`（か NULL）のものだけ（§3.2・§12.6） |
| 管理画面の「チャットの添付の合計」= `drive_item_id IS NULL` の合計（DRIVE.md §11.2） | 投稿のファイルはドライブで数えるので、ここから外れる（二重に数えない、よい） | 画面の説明に「チャンネルのドライブに入った投稿のファイルはドライブの側で数える」と書く |
| 外部共有リンクを作れるのはドライブのファイルだけ | 会話のファイルが、ドライブに書ける人なら学外へリンクで渡せるようになる（新しい経路） | 今の守り（ワークスペース・場所のスイッチ、作った人が読める間だけ）のまま許す。§18 Q8 で確かめる |
| `posting_policy = owners`（「他の人はスレッドだけ」）のチャンネルでは、ドライブに書けるのはオーナーだけ | メンバーがスレッドで送ったファイルも入るか | 入れる（入れるのは投稿の結果で、サーバが送った人の名前で置く。ドライブに書く権利は見ない）。そのメンバーはドライブでは読むだけ |

## 3. データモデル

移行は 0126 から（今の最新は 0125）。

### 3.1 1 つの行が添付とバージョンを兼ねる（決めたこと）

3 つの案を比べた：

| 案 | 中身 | 良い点 | 困る点 |
| --- | --- | --- | --- |
| **A. 1 行が兼ねる（採る）** | 添付の行に `drive_item_id` も入れ、その行を新しい項目のバージョン 1 にする（`drive_file_versions.attachment_id` = 添付の id） | 写さない・数え方が要らない。サムネイル・ポスター・プレビュー・GC・`verify-attachments` は今の 1 行のまま。メッセージの添付の `id` が変わらない（古い端末・端末のキャッシュがそのまま） | `get_for_access`・削除・GC・整理に「投稿のファイル」の枝が要る（§2 の表。どれも 1 か所ずつ） |
| B. 2 行が 1 つのオブジェクトを指す | メッセージの添付の行とバージョンの行を別にし、同じ `storage_key` を指す | 行ごとの役がはっきり | GC に「同じキーを指す生きた行が無いか」の確かめが要り、サムネイル・プレビューの生成物を 2 行に写し続けなければならない（プレビューが後からできる）。DRIVE.md §10.2 で避けた「1 つのオブジェクトを 2 つが指す」をここで作る |
| C. 写す | 今の「ドライブに保存」（§13.2）を送る時に自動で行う | 今のコードのまま | 領域と容量が 2 倍。ドライブで名前を変えてもメッセージと別物。要望（「メッセージの参照がドライブの整理で壊れない」）に合わない |

### 3.2 表の変更

```sql
-- attachments：投稿のファイルの、チャンネルから見た状態（見る人によらない）
ALTER TABLE attachments
  ADD COLUMN drive_state varchar(12);
  -- NULL        : ふつうの添付、またはメッセージに付いていないドライブのバージョン
  -- 'available' : 項目がそのチャンネルのドライブにあり、ゴミ箱に無い（メッセージを読める人は読める）
  -- 'moved'     : 項目が別の場所にある（その場所を読める人だけが読める）
  -- 'trashed'   : 項目（か上のフォルダ）がゴミ箱にある
  -- 'deleted'   : 項目が完全に消えた（バイト列は GC が消す。行は墓石として残る）
ALTER TABLE attachments
  ADD CONSTRAINT attachments_drive_state_check
  CHECK (drive_state IS NULL OR (drive_state IN ('available', 'moved', 'trashed', 'deleted') AND message_id IS NOT NULL));
CREATE INDEX attachments_drive_state_idx ON attachments (drive_item_id) WHERE drive_state IS NOT NULL;

-- drive_items：特別なフォルダの印
ALTER TABLE drive_items ADD COLUMN system_role varchar(16);   -- NULL | 'channel_posts'（「投稿のファイル」）
CREATE UNIQUE INDEX drive_items_system_role_uniq ON drive_items (location_id, system_role)
  WHERE system_role IS NOT NULL AND trashed_at IS NULL;

-- drive_file_versions.source に 'message' を足す（CHECK は無いので値だけ。DATA_MODEL.md の注に書く）

-- 切り替え（§9）
ALTER TABLE workspace_settings ADD COLUMN channel_files_to_drive boolean NOT NULL DEFAULT true;
ALTER TABLE channels ADD COLUMN files_to_drive boolean;        -- NULL = ワークスペースに従う
```

- `drive_state` は**表示のための値**（見る人によらず、メッセージの payload に載せられる）。権限の判定はこの列を信じず、毎回項目の
  場所・ゴミ箱・メッセージから求める（§5.2）。
- `drive_state` が変わるのは：送る（`available`）、項目かその上のフォルダの場所をまたぐ移動（`available` ⇄ `moved`）、ゴミ箱に入れる
  （`trashed`）・戻す（`available` か `moved`）、完全削除（`deleted`）、メッセージの削除（NULL に戻す、§7.3）。どれも**同じ
  トランザクション**でメッセージの `updated_seq` を進め、outbox に `message.updated`（`change = "attachments"`）を入れる。
- `status` は今のまま（`attached`）。墓石は `status = 'purged'`（新しい値）：GC がバイト列と派生物を消した後、行を消さずに
  この値にする（§7.5）。`verify-attachments` と `/files`・検索は `purged` を見ない。
- 項目の行が消えると `drive_item_id` は NULL になる（今の `ON DELETE SET NULL`）。墓石は `drive_state = 'deleted'` で見分ける。
- `drive_file_versions` は今のまま（`attachment_id` が投稿の添付を指す、`source = 'message'`、`uploaded_by` = 送った人、
  `content_modified_at` は NULL）。

### 3.3 フォルダ

- **「投稿のファイル」**：チャンネルのドライブの根に 1 つ（`system_role = 'channel_posts'`）。初めてファイルが入る時に作る。
  保存する名前は「投稿のファイル」、端末は `system_role` を見て自分の言語の名前（Posted files / 帖子中的文件）とアイコンで出す
  （場所の名前と同じ扱い、DRIVE.md §20.1）。**名前の変更・移動・ゴミ箱は断る**（409 `drive_folder_system`）。中のものは自由に
  動かせる。
- **年月のフォルダ**「2026-10」：送った時刻をワークスペースのタイムゾーンで（CF1：`workspace_settings` にゾーンの列は無かったので、
  サーバの設定 `CHANNEL_FILES_TZ`（既定 `Asia/Tokyo`）。§19.2）。
  ふつうのフォルダで、名前の変更・移動・ゴミ箱もできる。次に入れる時に同じ名前の生きたフォルダが無ければ作り直す。
  - 年月にした理由：平らにすると活発なチャンネルで 1 フォルダの子の上限 10,000（DRIVE.md §4.3）に届き、一覧も重い。年だけでも
    数千件になる。「2026-10」は名前順がそのまま時刻順で、パンくずも短い。年の下に月（2 段）は 10 年で 120 フォルダの量なら要らない。
- **スレッド**：返信のファイルも同じ年月のフォルダ（スレッドごとのフォルダは作らない：スレッドに題名が無く、フォルダが増えすぎる）。
  どのメッセージから来たかはドライブの詳細の「投稿」（§12.2）で分かる。
- **名前**：添付の名前（`sanitize_filename` 済み）を DRIVE.md §4.3 の規則に通す（NFC・255 文字）。断られる名前（空・`.`・`..`）は
  「ファイル」+ 拡張子。同じ名前があれば「名前 (1).pdf」（**新しいバージョンにはしない**：別の投稿の別のファイル）。

## 4. バージョン：投稿した時のものを指す（決めたこと）

### 4.1 比べたこと

| | 投稿した時のバージョン（採る） | いつも最新（Teams） |
| --- | --- | --- |
| 会話の記録 | 「この版を見てください」の後に誰かが上書きしても、会話は当時の中身のまま読める（研究室の議論・レビューの記録として大事） | 過去の発言が指す中身が後から変わる |
| 古い端末・キャッシュ | 添付の `id`・バイト列・サムネイルが変わらない。Desktop の SQLite・スマホのキャッシュ（id ごと）がそのまま正しい | 新しいバージョンのたびにメッセージの添付が替わり、そのファイルを指すすべてのメッセージに `message.updated` を出し、id ごとのキャッシュを捨てさせる要がある |
| 権限 | バージョンは変わらないので、判定は「どの行か」で済む | 同じ |
| 最新を見たい | ビューアの「新しいバージョンがあります」と「ドライブで開く」、または `/d/` のリンクで投稿 | そのまま |
| 領域 | 指されたバージョンは整理で消えない（少し増える） | 古いバージョンは整理で消える |

**投稿した時のバージョン**にする。最新を指したい人のための道はもうある（`/d/` のリンクとカード、DRIVE.md §13.1）。入力欄の
「ドライブから」で、「リンク（今のもの）」と「添付（この版）」の違いを 1 行で説明する。

### 4.2 指されたバージョンの守り

- バージョンの整理のジョブ（DRIVE.md §10.2）は、`drive_state IN ('available', 'moved', 'trashed')` の行を持つバージョンを消さず、
  「新しい順に 10 版」の数にも入れない。
- 古いバージョンの手での削除は 409 `drive_version_posted`（`details.message_id`）。消したいときはメッセージを先に消す。
- 「バージョンを戻す」（DRIVE.md §10.2）は今までどおり写して新しいバージョンを作るので、メッセージには関わらない。
- 項目のゴミ箱・完全削除は止めない（§7）。

### 4.3 名前

- メッセージの添付の `filename` は**投稿した時の名前のまま**（ドライブで名前を変えても書き換えない。§2 の表）。
- 新しい端末は、項目を読めるとき今の名前を小さく添えてよい（「ドライブでは：修論_最終.pdf」）。読み込むのはビューア・詳細を開いた
  時だけ（一覧の行ごとには問い合わせない）。

## 5. 権限

### 5.1 誰が読めるか

| 人 | ドライブで（DRIVE.md §3） | メッセージで（今の添付） | 投稿のファイル（この設計） |
| --- | --- | --- | --- |
| チャンネルのメンバー（ゲストも） | 読める | 読める | 読める |
| 公開チャンネルの、メンバーでない人（ゲストを除く、M27） | 読めない | 読める | **項目がそのチャンネルのドライブにある間は読める**（メッセージから。ドライブの一覧は開けない） |
| 非公開チャンネルを抜けた人 | 読めない | 読めない | 読めない |
| 公開チャンネルを抜けた人（ゲストを除く） | 読めない | 読める（M27） | 項目がそのチャンネルのドライブにある間は読める |
| 項目を研究室ドライブへ移した後のゲストのメンバー | 読めない | — | 読めない（「表示できないファイル」） |
| 項目をマイドライブへ移した後のほかのメンバー | 読めない | — | 読めない |

- **規則**：投稿のファイル（`drive_state IS NOT NULL` の行）を読めるのは、
  1. 項目を今ドライブで読める人（`drive.can_read_item`。ゴミ箱は誰も読めない）、または
  2. メッセージが消されておらず、そのメッセージを今読めて（`channels.require_readable`、今の添付と同じ）、項目が今
     **そのメッセージのチャンネルのドライブ**にあり、項目もその上もゴミ箱に無い人。
- 2 があるので、送った直後の見え方は今の添付と同じ（公開チャンネルのプレビュー・抜けた人）。ドライブを広げているのではなく、
  「チャンネルに投稿した」という今の許しをそのまま残しているだけ。チャンネルのドライブの一覧・ほかのファイルはこれまでどおり
  メンバーだけ。
- 2 は**投稿したバージョンだけ**に効く（同じ項目の後のバージョンや、ほかのファイルには効かない）。
- 項目が別の場所にある間は 1 だけ：移した先を読める人だけ。

### 5.2 判定の場所

- `attachments.get_for_access` の `drive_item_id` の枝の前に、投稿のファイルの枝を足す：

```python
if attachment.drive_state is not None:
    if attachment.drive_item_id is None or attachment.status != "attached":
        raise not_found(...)                       # 墓石・削除済み
    if await _drive_readable(db, actor, attachment.drive_item_id):
        return attachment                          # 1
    if await _posted_readable(db, actor, attachment):   # 2：main.py が注入（drive.channel_files.posted_readable）
        return attachment
    raise not_found(...)
```

- `_posted_readable`：メッセージの行（`deleted_at IS NULL`）→ `channels.require_readable`、項目の `location_id` がそのチャンネルの場所、
  項目の `trashed_at IS NULL`（ゴミ箱は部分木のすべてに入るので項目だけ見れば足りる、DRIVE.md §10.1）。`drive_state` は見ない。
- 読めないときは 404 `attachment_not_found`（存在を明かさない）。ただし項目がまだそのチャンネルのドライブにあってメッセージが
  生きているときは、チャンネルの断り（403 `not_a_member`・`preview_disabled`）を今の添付と同じに返す（CF1、§19.2：古い端末の
  見え方を変えない）。移した・ゴミ箱・墓石は 404。
- ドライブの経路（`/drive/items/{id}`・一覧・`/content`・ZIP・外部リンク）は今までどおり 1 だけ（2 ではドライブを開けない）。

## 6. 流れ

### 6.1 送る（bind の時に入れる）

`messages.service.create_message` の中（同じトランザクション）。CF1 では**ドライブのロックをチャンネルの seq より先に**取る
（§13・§19.2。ドライブの操作は「フォルダ → 場所 → チャンネル → 添付の行」の順なので、送信も同じ順にする）：

```
channel_files.prepare_in_tx(channel, attachment_ids)     -- SAVEPOINT。チャンネルが public / private で切り替え（§9）がオンなら
  1. 場所を resolve（無ければ作る。DRIVE.md §5.1 と同じ関数）
  2. 「投稿のファイル」が無ければ根を FOR UPDATE（作るのは 5 で）
  3. 「投稿のファイル」を FOR UPDATE → 「2026-10」を探し、あれば FOR UPDATE
  4. 場所の行を FOR UPDATE
  （失敗したら SAVEPOINT に戻し、ふつうの添付として送る）
allocate_seq（チャンネルの行）→ messages の INSERT
bind_in_tx（自分の pending の添付を FOR UPDATE、message_id・channel_id・attached を入れる）
channel_files.file_in_tx(plan, sender, attachments)      -- SAVEPOINT の中
  5. 無ければ「投稿のファイル」（system_role）と「2026-10」を作る。添付ごとに：名前を決め（衝突は (1)）、drive_items と
     drive_file_versions（source='message'、sha256 は添付から、processed_at = 送った時刻）を INSERT、
     attachment.drive_item_id・drive_state='available'
  6. 場所の used_bytes・item_count を加える（上限は見ない、§8）
  7. outbox：drive.changed {location_id, folder_ids: [2026-10（と作ったフォルダの親）], seq}
  （失敗したら SAVEPOINT に戻し、ふつうの添付として送る。ログに warning。メトリクスの仕組みは無いのでログだけ）
message.created（attachments に drive が入った形）
```

- **ドライブの都合で投稿を失敗させない。** 4 の名前・10,000 件の上限・予期しない失敗はすべて SAVEPOINT に戻してふつうの添付にする。
  そのメッセージの添付は `drive` が null（端末はふつうの添付として出す）。
- 予約送信（`scheduled_messages`）・定期投稿は、実際に送った時の bind で入る（予約した時ではない）。
- Webhook・bot・移行（`import-*`）が作る添付は bind を通らないので入らない（§10 の CLI で後から入れられる）。
- メッセージの送り直し（`client_msg_id` の冪等）は既にあるメッセージを返すので、2 回入ることはない。
- 1 メッセージ 10 ファイルまで（今の上限）なので、1 回の送信で足す項目は 10 まで。

### 6.2 ドライブで直接上げる・リンクを貼る

- 今の機能のまま：チャンネルのドライブ（「投稿のファイル」の中でもほかのフォルダでも）にアップロードし（DRIVE.md §6・§30）、
  `/d/<id>` のリンクを会話に貼る・「会話に送る」（§25）。リンクのカードは今のバージョンを指す。
- 足すこと（CF2）：アップロードの欄が終わったとき、チャンネルのドライブなら「#ch に知らせる」を出す（押すと入力欄の文の最後に
  上げたファイルの `/d/` のリンクを入れて開く。自動では投稿しない、DRIVE.md §19 Q9 のまま）。

### 6.3 ドライブで名前を変える・チャンネルのドライブの中で移す

- メッセージには何も起きない（`drive_state` は `available` のまま、イベントも出さない）。メッセージの名前は投稿の時のまま（§4.3）。

### 6.4 場所をまたいで移す

- DRIVE.md §5.2 の `POST /drive/items/move` の中で、動かす部分木の投稿のファイルの行（`attachments_drive_state_idx`）を引き、
  新しい場所がメッセージのチャンネルの場所なら `available`、ほかなら `moved` にする（変わった行だけ）。変わったメッセージの
  `updated_seq` を進めて `message.updated`。
- 端末は移す前に `POST /drive/items/impact`（§11.2）を呼び、投稿のファイルを含むなら「このファイルは #ch の 2 件のメッセージに
  付いています。移すと、#ch のメンバーのうち 3 人（ゲスト 2 人を含む）がメッセージの中でこのファイルを見られなくなります。」と
  確かめる。研究室ドライブの中の場所どうし（例：チャンネルのドライブ → 研究室ドライブ）でも同じ。
- 「投稿のファイル」そのものは動かせない（§3.3）。年月のフォルダは動かせる（中の投稿のファイルが一緒に `moved` になる）。

### 6.5 ゴミ箱・戻す

- ゴミ箱に入れる（項目かその上のフォルダ）：部分木の投稿のファイルを `trashed` に、メッセージに `message.updated`。端末はメッセージに
  「削除されたファイル」を出す。チャンネルのドライブに書ける人には「ゴミ箱にあります」と「戻す」も（押すと `POST /drive/items/{id}/restore`）。
- 戻す：戻った場所で `available` か `moved` にし、`message.updated`。
- 誰がゴミ箱に入れられるかは DRIVE.md §3.2 のまま（チャンネルのドライブに書ける人）。今は「メッセージの添付を消せるのは送った人と
  モデレーターだけ」なので、これは広がる。ただしゴミ箱は 30 日戻せ、監査ログに残る（DRIVE.md §3.2 の考え方）。確かめのダイアログで
  「2 件のメッセージから見えなくなります（30 日は戻せます）」と出す。§18 Q5。

## 7. 消す

### 7.1 まとめ

| 操作 | ドライブ | メッセージ | 容量 |
| --- | --- | --- | --- |
| メッセージを消す（既定 `auto`） | 送った本人かモデレーターが消し、ファイルが投稿の後に変わっていなければゴミ箱へ。ほかは残す | トゥームストーン（今まで） | ゴミ箱なら 30 日後に減る。残せば数えたまま |
| メッセージを消す（`keep`） | 残す（ふつうのドライブのファイルになる） | 同上 | 数えたまま |
| メッセージを消す（`trash`） | ゴミ箱へ（送った本人かモデレーターで、変わっていないものだけ。ほかは keep。**CF1 では `auto` と同じ決まり**。端末の印が「入れる」を選んだことを送る値として残す） | 同上 | 30 日後に減る |
| ドライブでゴミ箱へ | ゴミ箱（30 日） | 「削除されたファイル」 | 30 日後に減る |
| ドライブで完全削除・30 日の完全削除 | 消える | 「削除されたファイル」のまま（墓石） | 減る |
| 古いバージョンの削除 | 投稿が指すものは 409 | — | — |
| 匿名化（M104） | 送った人のファイルもチャンネルのものなので残る（DRIVE.md §3.3） | 今までどおり | — |

### 7.2 「投稿の後に変わっていない」

次のすべて：項目のバージョンが 1 つだけ（投稿したもの）、項目がそのチャンネルのドライブにありゴミ箱に無い、ほかのメッセージの添付でない
（今は 1 項目 1 メッセージだが、CF5 の後のために書く）。名前の変更とチャンネルのドライブの中の移動は「変わった」に入れない。

### 7.3 メッセージの削除

- `DELETE /messages/{id}?drive_files=auto|keep|trash`（既定 `auto`。古い端末は送らないので `auto`）。応答は今のまま 200 と墓石の
  `MessageOut`（本書の前の版の「204」は誤り）。確認の画面のために `GET /messages/{id}/drive-files`（CF1 で足した）がファイルごとに
  `auto` で入れるか（`trash`）と、入れない理由（`in_trash`・`moved`・`not_permitted`・`changed`）を返す。
- サーバ：投稿のファイルの行を引き（ロックしない）、ゴミ箱に入れる項目があれば DRIVE.md のゴミ箱の手順（フォルダ → 場所のロック）を先に行い、
  その後で行を `FOR UPDATE` で取り、`message_id`・`channel_id`・`drive_state` を NULL にする（ふつうのドライブのバージョンになる。
  ドライブの詳細の「投稿」からも消える）。ゴミ箱に入れたものは監査 `drive.trash`（`via: "message_delete"`）。
- ゴミ箱に入れるのは、メッセージを消せる人（送った本人・モデレーター）がそのファイルを送った本人か、モデレーターのとき。ドライブに
  書く権利は見ない（自分が置いたものを取り下げるだけ。モデレーターは不適切なファイルを消すため）。
- 新しい端末の確認：「このメッセージを削除しますか？」の下に「ドライブの 2 件のファイルもゴミ箱に移す」（既定は `auto` の答えと同じ。
  変わったファイルがあれば「1 件は投稿の後に変更されたため、ドライブに残ります」）。

### 7.4 バージョンの削除

- `DELETE /drive/items/{id}/versions/{version_id}`：投稿が指すバージョンは 409 `drive_version_posted`（`details.message_id`、読めれば
  `details.channel_id`）。

### 7.5 完全削除と墓石

- DRIVE.md §10.1 の完全削除の中で：投稿のファイルの行は `status = 'deleted'`・`drive_state = 'deleted'` にし、メッセージに
  `message.updated`。項目の行が消えると `drive_item_id` は NULL。
- GC：`deleted` の行のうち `drive_state = 'deleted'` でメッセージが生きているものは、バイト列と派生物を消した後に行を消さず
  `status = 'purged'` にする（墓石。名前・大きさは残るが、端末には「削除されたファイル」だけを出す）。メッセージが後で消されたら
  ふつうに消える。
- 墓石を残すのは、メッセージの中に「ここにファイルがあった」を出すため（黙って消えると、返信の「このファイル」が何か分からない）。

## 8. 容量

- 投稿のファイルはチャンネルのドライブの `used_bytes` と `item_count` に数える（ワークスペース全体の上限にも）。**1 回だけ**：
  チャットの添付の合計（`drive_item_id IS NULL`）からは外れる。
- **投稿は上限で断らない。** 上限を超えていても入れ、`used_bytes` は上限を超えうる。超えている間、その場所へのドライブの
  アップロード・コピー・バージョンを戻すは今までどおり 409 `drive_quota_exceeded`。
  - 理由：投稿はチャットの最も大事な操作で、今まで添付は容量で断られなかった。断るとチャットが急に使えなくなる。ふつうの添付に
    逃がす案（入れない）は「ドライブに無いファイル」が混ざり、利用者に説明しにくい。チャットの添付で全体の上限を超える危うさは
    今と同じ（今も数えていない）。
  - 管理画面（DRIVE.md §11.2）の場所ごとの行に「うち投稿のファイル」を出し、上限を超えた場所には印を付ける。
- 墓石・メッセージだけの行は数えない（バイト列が無い・ドライブの外）。

## 9. 切り替え

- `workspace_settings.channel_files_to_drive`（admin、既定 true）と `channels.files_to_drive`（オーナー、NULL = ワークスペースに従う、
  true / false で上書き）。実効の値 = チャンネルの値 ?? ワークスペースの値。
- 変えて効くのは**それからの投稿だけ**（入れたファイルを出すことも、前のファイルを入れることもしない。前のものは §10）。
- オフのチャンネルの例：雑談・スクリーンショットばかりのチャンネル（ドライブを散らかしたくない）。
- アーカイブしたチャンネルは投稿できないので関係しない。
- API：`PATCH /admin/workspace-settings {channel_files_to_drive}`、`PATCH /channels/{id} {files_to_drive: true | false | null}`（オーナー・
  admin。監査 `channel.updated`）。`ChannelOut` に `files_to_drive`（上書きの値）と `files_to_drive_effective`。

## 10. 今までの添付（移行）

- **自動では移さない。** 新しい投稿からだけ（切り替えをオンにした時から）。
- `app.cli channel-files-backfill --channel <名前> | --all [--since 2025-04-01] [--dry-run] [--limit N]`：
  - そのチャンネルの `attached` のメッセージの添付（`drive_item_id IS NULL`、キャンバス・ページを除く）を、`attached_at` の年月の
    フォルダに §6.1 と同じ関数で入れる（**写さない**。行に `drive_item_id`・`drive_state` を入れ、項目とバージョンを足すだけ）。
  - メッセージの `updated_seq` は進めない（payload の `drive` が増えるだけで、端末は次に読み直した時に知れば足りる。何十万件の
    `message.updated` を出さない）。端末の表示は `drive` が無くても正しい。
  - `--dry-run`：チャンネルごとの件数・合計の大きさ・容量の上限との比較。
  - 冪等（入れたものは飛ばす）、1 件ずつコミット、止めても続きから。
  - 入れた後、ドライブの中身の全文（§29）の loop が古い PDF を読み始める（空き時間に 1 件ずつ、チャットのプレビューが先）。
- 本番（2,500 件のドライブ、メッセージ 46 万件）で流すかは §18 Q7。

## 11. API と OpenAPI

### 11.1 変わるもの

| 対象 | 変更 |
| --- | --- |
| `AttachmentOut` | 任意の欄 `drive: {item_id, version_id, version_number, state} \| null`。`state` は `available` / `moved` / `trashed` / `deleted`。投稿のファイルにだけ入る（ふつうの添付・DM は null）。`item_id` は墓石では null |
| `DELETE /messages/{id}` | クエリ `drive_files=auto\|keep\|trash`（既定 auto）。応答は今のまま（200 と墓石の `MessageOut`）。ゴミ箱に入れた項目は `drive.changed` で分かる |
| `GET /messages/{id}/drive-files`（CF1 で足した） | `{files: [{attachment_id, item_id, state, trash, reason}]}`：削除の確認の印のため（§7.3） |
| `DriveItemOut` | `system_role`（null か `channel_posts`）、`posted`（CF1 で足した：一覧の吹き出しの印）、`posts: [{message_id, channel_id, parent_id, sender_id, version_number, posted_at}]`（その項目のバージョンを添付に持つメッセージのうち、見る人が読めるもの。5 件まで。`sender_id` は CF1 で足した）。`posts` は `GET /drive/items/{id}` だけ（ほかは null） |
| `POST /drive/items/impact`（新） | `{item_ids, target_folder_id?}` → `{posted_messages, channels: [{channel_id, messages, unreadable_after, unreadable_guests}]}`。移動・ゴミ箱の前の確かめ（§6.4）。`target_folder_id` が無ければゴミ箱。読める項目だけ（読めなければ 404）。`channels` は見る人が読めるチャンネルだけ（`posted_messages` はすべて） |
| `DriveLocationUsageOut`（CF1 で足した） | `posted_bytes`（§8 の「うち投稿のファイル」） |
| `ChannelOut` / `PATCH /channels/{id}` | `files_to_drive`・`files_to_drive_effective`（§9。`effective` は `GET /channels/{id}` と PATCH の応答だけ。ほかは null で、端末は `files_to_drive ?? WorkspaceSettingsOut.channel_files_to_drive`） |
| `GET/PATCH /admin/workspace-settings` | `channel_files_to_drive`（`WorkspaceSettingsOut` にも：bootstrap と `workspace.settings_updated`） |
| `GET /search/drive` | `origin=all\|uploads\|posts`（既定 all。§12.6。`posts` = `source = 'message'` のバージョンを持つファイル、`uploads` = それ以外（フォルダを含む）） |
| `GET /files` | 変えない（`drive_state` が NULL か `available` のものだけ。項目が別の場所・ゴミ箱のものは出さない）。`FileItem.attachment.drive` で「ドライブで表示」 |
| エラー（`apps/shared/errors.json`） | 409 `drive_folder_system`（特別なフォルダは名前の変更・移動・ゴミ箱ができない）、409 `drive_version_posted`（メッセージが指すバージョン） |
| WS | 新しいイベントは無い。`message.updated`（`change = "attachments"`、今の値）と `drive.changed` |

### 11.2 古い端末

- **表示**：`attachments` の配列・`id`・`filename`・サムネイル・プレビューの経路は変わらない。3 つの端末とも知らない欄を無視する
  （iOS の Codable、Android の org.json の手での読み、TypeScript）。CF1 で「`drive` 付きの `MessageOut` を古い形として読める」試験を
  各端末に足して固定する。
- **読めなくなったファイル**：ゴミ箱・別の場所・墓石では、古い端末はいつもの添付の行（名前・大きさ）を出し、開くと 404 で今の
  「読み込めませんでした」。名前は投稿の時のもの（新しい情報は漏れない）。
- **削除**：古い端末の削除は `auto`。
- **「ドライブに保存」**：古い端末は投稿のファイルでもコピーを作る（今の `save-attachment`。領域は 2 倍になるが壊れない）。
  新しい端末はメニューを「ドライブで表示」にし、「ほかの場所に保存」をその下に置く。
- **ドライブ**：古い端末は「投稿のファイル」をふつうのフォルダとして出し、名前の変更・移動・ゴミ箱は 409（古い端末は一般の
  エラーの文）。

## 12. 画面

### 12.1 メッセージの添付（Desktop / Web・iOS・Android）

- `drive` が null か `available`：今までどおりの見た目。⋯ に「ドライブで表示」（そのフォルダを開いてその項目を選ぶ）。
- `trashed` / `deleted`：ファイルのタイルの代わりに薄い 1 行「🗑 削除されたファイル」（名前・サムネイルは出さない）。`trashed` で
  チャンネルのドライブに書ける人には「ゴミ箱にあります · 戻す」。
- `moved`：その人が項目を読めるか（`GET /drive/items/{id}`、1 項目 1 分覚える。DRIVE.md §25 のカードと同じキャッシュ）で、読めれば
  ふつうのタイル + 「研究室ドライブ › 論文」の 1 行、読めなければ「🔒 表示できないファイル」と「このファイルは別の場所へ移されました。」
  （名前は出さない。DRIVE.md §25 と同じ文の考え方）。
- ビューア（写真・動画・PDF・Office）の上の行：「ドライブ：#ch › 投稿のファイル › 2026-10」（押すとそこを開く）。項目を読めて
  新しいバージョンがあれば「新しいバージョンがあります（v3、10/30 三井）」と「最新を開く」（ドライブのビューア）。
- 写真のアルバム（ALBUMS.md）が使えるとき、⋯ と写真のビューアに「アルバムに追加」（ALBUMS.md §9）。
- 色の帯は使わない（状態はアイコンと文字の色だけ）。

### 12.2 ドライブ

- 「投稿のファイル」は専用のアイコン（吹き出し + フォルダ）と端末の言語の名前。右クリック・⋯ の名前の変更・移動・ゴミ箱を出さない。
- 投稿から来たファイルの詳細のペインに「投稿」：「三井 · 10/28 15:02 · #m2-seminar（スレッド）」と「メッセージを表示」（`posts`）。
  一覧の行には小さな吹き出しの印（投稿に付いている）。
- 移動・ゴミ箱の確かめ（§6.4・§6.5）：投稿のファイルを含むときだけ出す。

### 12.3 入力欄

- 公開・非公開チャンネルで、切り替えがオンなら、添付のチップの下に小さく「#ch のドライブの「投稿のファイル」に保存されます」
  （1 回目だけ、または ⓘ）。
- 「ドライブから」（DRIVE.md §25）の選択の説明を「リンク：今のファイルを指します（後の変更も見えます）」「コピーを添付：この時点の
  ファイルを送ります」にする。

### 12.4 大きなファイル（CF5）

- 100 MB を超えるファイルを入力欄に入れたら、今の「大きすぎます」の代わりに「ドライブにアップロードしてリンクを投稿」を出す：
  チャンネルのドライブの「投稿のファイル › 2026-10」へドライブのアップロード（分けて送る・再開、DRIVE.md §6）、終われば入力欄に
  `/d/` のリンクを入れる。チャンネルのドライブに書けないとき（オーナーだけのチャンネルのメンバー）はマイドライブ。DM は
  マイドライブ（リンクの読めない人の注意が出る）。
- スマホは §30 のアップロードの仕組みを使う（バックグラウンド）。

### 12.5 チャンネルの「ファイル」と「ドライブ」のタブ

- どちらも残す。「ファイル」はメッセージの添付の時刻順（今まで）、「ドライブ」はフォルダ。投稿のファイルは両方に出る（「ファイル」の
  行に「ドライブで表示」）。1 つにまとめるかは使ってから（§18 Q11）。

### 12.6 検索

- メッセージの検索（ファイル名の枝）は投稿したメッセージを返す（今まで）。`drive_state` が `trashed` / `moved` / `deleted` のものは
  ファイル名の枝から外す（メッセージの本文の一致は今までどおり）。
- ドライブの検索（§12・§29）は投稿のファイルも項目として返す（名前と中身。PDF の本文で見つかるようになる、新しくできること）。
  結果のパスで「投稿のファイル」と分かる。検索の画面の「ドライブ」のタブに「投稿のファイルを含む」の切り替え（`origin`、既定は含む）。
- メッセージのタブとドライブのタブは別の一覧なので、1 つの一覧の中で同じファイルが 2 回出ることは無い。

### 12.7 チャンネルの設定・管理画面

- チャンネルの設定（オーナー）：「投稿したファイルをチャンネルのドライブに保存する」（ワークスペースに従う / する / しない）。
- 管理 → ドライブ：「チャンネルに投稿したファイルをチャンネルのドライブに保存する」のスイッチと、場所の使用量の「うち投稿のファイル」。

## 13. 並行と冪等

- **ロックの順**（CF1 で決めた形）：ドライブの木（親のフォルダ → 場所の行）→ チャンネルの行（`allocate_seq`）→ `attachments` の行。
  送る時（§6.1）はドライブを seq の前に取る（`prepare_in_tx`）。ドライブの移動・ゴミ箱・戻す・完全削除は、木と場所を取った後に
  変わるメッセージのチャンネルの行を id の順に取り、それから添付の行を取る（`drive/posted.py`）。完全削除は場所の行を先に取るよう
  並べ替えた。メッセージの削除（§7.3）は行を読むだけで先にドライブのゴミ箱を行い、その後でチャンネル、添付の行を取る。
  プレビューの loop の「チャンネル → 添付」とも同じ向き。
- **同時に 2 つの投稿が「2026-10」を作る**：「投稿のファイル」の行を `FOR UPDATE` で取ってから探す・作るので、2 つ目は 1 つ目の
  コミットを待ってそれを使う。「投稿のファイル」も根の行のロックで 1 つ（部分一意索引 `drive_items_system_role_uniq` が最後の守り）。
- **同じチャンネルの送信が場所の行で直列になる**：`used_bytes` の加算は場所の行のロックの中。研究室の規模（1 チャンネルの毎秒の
  ファイル付きの投稿は数件まで）では困らない。困れば `used_bytes` の加算だけ outbox の後の処理にする。
- **移動・ゴミ箱と送信が同時**：送信は「投稿のファイル」→「2026-10」の順にロックする。年月のフォルダのゴミ箱・移動はその親（「投稿のファイル」）の
  行を取るので、どちらかが待つ。待った側が終わった状態を見て正しく決める（ゴミ箱に入った「2026-10」には入れず、新しく作る）。
- **メッセージの削除とドライブの移動が同時**：どちらも添付の行を `FOR UPDATE` で取ってから `drive_state` を書く。後の方が前の結果を
  見て書く（削除の後なら `drive_state` は NULL で、移動は何もしない）。
- **イベントの順**：`drive_state` を変えるトランザクションがメッセージの `updated_seq` を取るので、端末は今の規則（新しい `updated_seq`
  が勝つ）で正しい状態になる。WS を取りこぼしても、差分（`updated_seq > since`）で戻る。

## 14. セキュリティ

- 判定は毎回、項目の場所・ゴミ箱・メッセージ・メンバーシップから求める（§5.2）。`drive_state` を権限に使わない。
- 読めない人には 404（存在を明かさない）。名前は投稿の時のものだけが payload に載る（後の名前の変更・移動先は載らない）。
  `moved` の行の `item_id` は乱数の id で、読めない人には 404。
- 公開チャンネルの参加前のプレビュー（M27）は投稿したバージョンだけ。ドライブの一覧・ほかのバージョン・同じフォルダのファイルには
  届かない。
- 外部共有リンク（DRIVE.md §9）は投稿のファイルにも作れる（ドライブのファイルなので）。会話の添付を学外へ渡す新しい経路になる。
  今の守り（作った人が読める間だけ、場所とワークスペースのスイッチ、admin の一覧と取り消し）で足りると考える。チャンネルのオーナーが
  場所の「外部リンク」を切れば、そのチャンネルでは作れない（§18 Q8）。
- メッセージの削除からのゴミ箱は、送った本人かモデレーターだけ（§7.3）。ドライブでのゴミ箱は DRIVE.md §3.2 のまま。
- 監査：完全削除は今の `drive.delete`・`drive.purge`（投稿のファイルを含めば `posted_messages`）。**ゴミ箱の監査は今まで無かった**
  （本書の前の版の「今の `drive.trash`」は誤り）。CF1 で `drive.trash` を足した：メッセージの削除から（`via: "message_delete"`）と、
  ドライブのゴミ箱で投稿のファイルがメッセージから見えなくなるとき（`via: "drive"`、まとまりごと、`messages` の数）。入れる操作
  （投稿）は監査に載せない（ふつうの投稿）。
- SECURITY.md §4 の「ドライブ」に「投稿のファイル」の段落を足す（§5 の規則、墓石、外部リンクの経路）。

## 15. 段階（マイルストーン）

各段階の終わりに IMPLEMENTATION_PLAN.md §0 の確認（pytest・mypy・ruff、tsc とテスト、OpenAPI と ws-events.json、移行の downgrade）。

| 段階 | M（仮） | 中身 | 完了条件 |
| --- | --- | --- | --- |
| **CF1** サーバ | M174 | 移行 0126（§3.2）、`drive/channel_files.py`（bind の後に入れる・SAVEPOINT の逃げ道・年月のフォルダ・名前）、`get_for_access` の枝と注入、`drive_state` の移り変わり（移動・ゴミ箱・戻す・完全削除・匿名化）と `message.updated`、墓石と GC の `purged`、メッセージの削除の `drive_files`、バージョンの整理と削除の守り、`system_role` の守り、`impact`、`DriveItemOut.posts`・`system_role`、`AttachmentOut.drive`、切り替え（ワークスペース・チャンネル）、`/files`・検索のファイル名の枝・`probe-videos`・`generate-previews`・`verify-attachments` の条件、`origin`、エラーの文言（ja / en / zh-Hans）、DATA_MODEL.md・SECURITY.md・SYNC_PROTOCOL.md・DRIVE.md の注 | pytest：権限の表（§5.1 の 6 行 × 状態 4 つ）、送信の並行（同じ年月のフォルダを 2 本の送信が同時に作る）、SAVEPOINT の逃げ道（フォルダが満杯・名前の失敗でも送れる）、送り直しで 1 回、移動・ゴミ箱・戻す・完全削除で `drive_state` と `updated_seq`、削除の `auto` の 3 通り（本人で未変更・本人で変更済み・他人）とモデレーター、バージョンの整理が投稿の版を残す、容量を超えても送れる、DM は入らない、`posting_policy = owners` のスレッドの返信、古い形の `MessageOut` として読めること（スキーマの試験） |
| **CF2** Desktop / Web | M175 | 添付の状態（削除されたファイル・表示できないファイル・ゴミ箱から戻す）、「ドライブで表示」、ビューアの上の行と「新しいバージョンがあります」、削除の確認の印、ドライブの特別なフォルダ・「投稿」の印と詳細・「メッセージを表示」、移動・ゴミ箱の確かめ（`impact`）、入力欄の 1 行と「ドライブから」の説明、アップロードの後の「#ch に知らせる」、チャンネルの設定と管理画面のスイッチ、検索の `origin`、Desktop の SQLite に `drive` を持つ | vitest（状態ごとの描き分け・名前を出さないこと・削除の確認の既定・確かめのダイアログの数）と tsc。使い捨ての compose とヘッドレスの Chrome で：投稿 → ドライブに出る → 名前を変える（メッセージは変わらない）→ 研究室ドライブへ移す（ゲストには表示できない）→ ゴミ箱（削除されたファイル）→ 戻す |
| **CF3** iOS | M176 | 添付の状態・「ドライブで表示」・ビューアの上の行・削除の確認の印、ドライブの特別なフォルダと「投稿」、`drive` の端末の保存 | xcodebuild・XCTest（デコード：古い形と新しい形、状態の描き分け）、シミュレータで CF2 と同じ通し |
| **CF4** Android | M177 | 同上 | `compileDebugKotlin`・`testDebugUnitTest`・`lintDebug`、ChikuwaChat_Pixel_9 で同じ通し |
| **CF5** 大きなファイル | M178 | 入力欄の「ドライブにアップロードしてリンクを投稿」（Desktop / Web・iOS・Android、ドライブのアップロードの仕組みのまま） | 2 GB の動画をチャンネルに投稿してカードから再生できる（3 端末） |
| **CF6** 今までの添付 | M179 | `channel-files-backfill`（§10、**CF1 で作った**）、infra/README.md の手順 | pytest：冪等・`--dry-run`・キャンバスとページの添付を入れない・年月（CF1 で済み）。本番は利用者と `--dry-run` の表を見てから |

- CF1 の後は CF2〜CF4 を並べて進められる。CF5・CF6 はいつでも。
- 見積もりの目安：CF1 1 週、CF2 0.5〜1 週、CF3・CF4 各 0.5 週、CF5 0.5 週、CF6 2 日。

## 16. 確かめること（実装の前に）

- `messages.service.create` のトランザクションの中で、チャンネルの seq の行のロックと、ドライブのフォルダ・場所の行のロックの順が
  ほかの経路（ドライブの操作はチャンネルの行を取らない）と輪にならないこと（CF1 の最初に、送信とドライブのゴミ箱を 2 つの
  セッションで同時に流す試験を書く）。
- Desktop の SQLite の添付の表に `drive` を足す移行（端末の側）。
- iOS / Android の出荷版が `AttachmentOut` の知らない欄で落ちないこと（出荷版のデコーダの試験に実物の JSON を足す）。

## 17. 将来

- 「この投稿の写真をアルバムに」（ALBUMS.md §9）：投稿の写真はもうチャンネルのドライブの項目なので、写さずに移すだけで済む。
- 1 つのドライブのファイルを、写さずに「添付として」投稿する（`MessageCreate.drive_version_ids`。同じチャンネルのドライブの、まだ
  どのメッセージにも付いていないバージョンだけ）。要望が出たら。
- 意味検索（DRIVE.md §29.5）：投稿のファイルの本文はもう `drive_texts` に入るので、メッセージと同じ埋め込みの仕組みに乗る。

## 18. 利用者に確かめること

**2026-10-28、すべて推めの答えで決まった**（利用者）。下の「推め」がそのまま決定。

| # | 質問 | 推め（決まらなければこれで作る） → 決定 |
| --- | --- | --- |
| Q1 | 既定でオンにするか（ワークスペース）。チャンネルごとに切れるようにするか | ワークスペースは既定オン、チャンネルのオーナーが「しない」にできる |
| Q2 | フォルダの名前と分け方 | 「投稿のファイル」の下に「2026-10」（年月、ワークスペースのタイムゾーン）。スレッドの返信も同じ。案：「チャンネルのファイル」（ドライブ自体がチャンネルのものなので重なる）、平ら（活発なチャンネルで 10,000 件の上限に届く） |
| Q3 | メッセージは投稿した時のバージョンを出すか、いつも最新か | 投稿した時（§4）。最新を指したいときは `/d/` のリンク |
| Q4 | メッセージを消したらドライブのファイルはどうするか | 既定 `auto`：送った本人（かモデレーター）が消し、投稿の後に変わっていなければゴミ箱（30 日戻せる）、ほかは残す。確認の印で変えられる |
| Q5 | ドライブでゴミ箱に入れた・別の場所へ移したら、メッセージから見えなくしてよいか（チャンネルのドライブに書けるメンバーなら誰でも、他人が投稿したファイルをゴミ箱に入れられる） | よい（「削除されたファイル」・「表示できないファイル」、30 日は戻せる、監査に残る、前に確かめのダイアログ）。困れば「投稿のファイルのゴミ箱は送った人・チャンネルのオーナー・admin だけ」に絞る |
| Q6 | チャンネルのドライブの容量の上限を超えていても投稿のファイルは入れてよいか | 入れる（投稿は断らない）。上限はドライブへのアップロードだけを止める |
| Q7 | 今までの添付（本番のメッセージの添付）もチャンネルのドライブに入れるか | 自動では入れない。CLI で、`--dry-run` の表を見てチャンネルを選んで流す |
| Q8 | 投稿のファイルにも外部共有リンクを作れてよいか | よい（今の守りのまま）。嫌なチャンネルはオーナーが場所の外部リンクを切る |
| Q9 | ドライブの検索に投稿のファイルを出すか | 出す（中身の検索も効く）。検索の画面に「投稿のファイルを含む」の切り替え |
| Q10 | 100 MB を超えるファイルを入力欄に入れたら、ドライブに上げてリンクで投稿するか | する（CF5） |
| Q11 | チャンネルの「ファイル」のタブと「ドライブ」のタブを 1 つにまとめるか | しばらく両方残す。使ってみて決める |

## 19. 段階 CF1 の実装（M174、2026-10-28）

### 19.1 作ったもの

- **移行 0126**：`attachments.drive_state`（CHECK・部分索引 `attachments_drive_state_idx`）、`drive_items.system_role`（CHECK：
  `channel_posts` はフォルダだけ、部分一意索引 `drive_items_system_role_uniq`）、`workspace_settings.channel_files_to_drive`（既定 true）、
  `channels.files_to_drive`（NULL = ワークスペースに従う）。`attachments.status` に `purged`（墓石。CHECK は無い）。downgrade は
  墓石を `deleted` に戻してから列を消す。0118 が延期の外部キーで行を入れるので、移行の初めに `SET CONSTRAINTS ALL IMMEDIATE`。
- **`app/modules/drive/channel_files.py`**：切り替え（`enabled_for`）、送る時の `prepare_in_tx`・`file_in_tx`（どちらも SAVEPOINT。
  失敗はふつうの添付と warning）、名前（`file_name`：断られる名前は「ファイル」+ 拡張子）、年月（`month_name`、`CHANNEL_FILES_TZ`）、
  メッセージの削除の決まり（`delete_rules`・`on_message_delete_in_tx`）、`impact`、`backfill`。
- **`app/modules/drive/posted.py`**：ドライブがメッセージを import せずに要るもの。2 つ目の読む経路（`posted_readable`、main.py が
  `attachments.set_posted_access_check` で注入）、`drive_state` の移り変わり（`restate_in_tx`：場所をまたぐ移動・ゴミ箱・戻す、
  `purge_posted_in_tx`：完全削除で墓石）と `message.updated`（main.py が `messages.announce_change_by_id_in_tx` を注入）、
  `posts_of`・`posted_items`・`posted_versions`、エラー `drive_folder_system`・`drive_version_posted`。
- **送信**（`messages.service.create_message`）：`prepare_in_tx` を seq の前に、`file_in_tx` を bind の直後に。`message.created` の
  添付に `drive` が入る。
- **読む人**（`attachments.get_for_access`）：`drive_state` のある行は (1) ドライブで読める、または (2) `posted_readable`（§5.2）。
- **ドライブの操作**：`system_role` のフォルダの名前の変更・移動・ゴミ箱は 409 `drive_folder_system`（移動・ゴミ箱は `results` の
  `error`）。名前の変更は投稿のファイルの添付の `filename` を変えない。場所をまたぐ移動・ゴミ箱・戻す・完全削除で `drive_state` と
  `message.updated`（`change = "attachments"`、新しい `updated_seq`）。完全削除は墓石（`drive_state = 'deleted'`）にし、GC は
  バイト列と派生物を消して `status = 'purged'` で行を残す（メッセージが消えれば行も消す）。
- **バージョン**：整理（`versions.prune`）は投稿の版を消さず、新しい 10 版の数にも入れない。手での削除は 409
  `drive_version_posted`（`details.message_id`、読めれば `channel_id`）。
- **メッセージの削除**：`DELETE /messages/{id}?drive_files=auto|keep|trash`、`GET /messages/{id}/drive-files`。ゴミ箱に入れる項目は
  `drive.service.trash_posted_in_tx`（ドライブの権利を見ない、監査 `drive.trash` via `message_delete`）、残りの行は
  `attachments.mark_deleted_in_tx` がメッセージから外す（`message_id`・`channel_id`・`drive_state` を NULL、ふつうのバージョンに）。
- **容量**：入れる時に場所の `used_bytes`・`item_count` に足す（上限は見ない）。管理の `chat_attachments_bytes` は `drive_item_id IS NULL`
  で墓石を除く。場所ごとの `posted_bytes`。
- **API**：`AttachmentOut.drive`（`AttachmentDriveOut {item_id, version_id, version_number, state}`、墓石は 3 つとも null）、
  `FileItem.attachment.drive`、`GET /attachments/{id}` も `drive` 付き、`DriveItemOut.system_role`・`posted`・`posts`、
  `POST /drive/items/impact`、`ChannelOut.files_to_drive`・`files_to_drive_effective`、`ChannelUpdate.files_to_drive`、
  `WorkspaceSettingsOut.channel_files_to_drive`・`WorkspaceSettingsUpdate.channel_files_to_drive`、`GET /search/drive?origin=`、
  `DriveLocationUsageOut.posted_bytes`。新しい WS のイベントは無い（`message.updated` と `drive.changed`）。
- **検索と一覧**：メッセージの検索のファイル名の枝と `GET /files` は `drive_state` が NULL か `available` の行だけ。
- **ほかの loop**：プレビューの loop（チャットの待ちの数・`generate-previews` の候補）と `probe-videos` は投稿のファイルを
  チャットの行として扱う。プレビューができたら `message.updated` に加えて `drive.changed`。
- **古い端末の「ドライブに保存」**：投稿のファイルも写せる（§11.2）。
- **CLI**：`app.cli channel-files-backfill --channel <名前> … | --all [--since 2025-04-01] [--dry-run] [--limit N]`（§10。オフの
  チャンネルは飛ばす、1 件ずつコミット、`message.updated` は出さない）。
- **エラーの文言**：`drive_folder_system`・`drive_version_posted`（ja / en / zh-Hans、`apps/shared/errors.json` → 生成）。
- **Desktop の型**：`schema.d.ts` を作り直し、`types.ts` の `WorkspaceSettingsOut` で `channel_files_to_drive` を任意に（CF1 より前の
  サーバは送らない）、試験の固定値に `posted`・`posted_bytes`。画面は CF2。
- 試験：`tests/test_channel_files.py`（入れる・フォルダと名前・送り直しで 1 回・同時の 2 送信・送信とゴミ箱の同時・失敗の逃げ道 3 通り・
  DM とグループ DM・切り替え・オーナーだけのチャンネルの返信・容量・§5.1 の表 × 状態・削除したメッセージ・版と名前・特別なフォルダ・
  移動 / ゴミ箱 / 戻す / 完全削除のイベントと `updated_seq`・墓石と GC・削除の決まりとモデレーター・impact・検索・
  backfill（dry run・冪等・`--limit`・キャンバスの添付と消したメッセージを入れない・年月）・古い形として読めること）。

### 19.2 本書と違うところ・決めたこと（本文は直した）

- **ロックの順**：本書は「bind の直後に入れる」だけだったが、それではチャンネルの行 → ドライブの順になり、ドライブの操作
  （ドライブ → チャンネル）と輪になる。送信はドライブを seq の前に取る（§6.1・§13）。完全削除は場所の行を先に取るよう並べ替えた。
- **ゾーン**：`workspace_settings` にゾーンが無かったので設定 `CHANNEL_FILES_TZ`（既定 `Asia/Tokyo`）。
- **403 は残す**：項目がチャンネルのドライブにありメッセージが生きている間は、チャンネルの断り（403）を今の添付と同じに返す
  （§5.2。本書は「どの経路でも 404」）。移した・ゴミ箱・墓石は 404。
- **`DELETE /messages/{id}` の応答**は 200 と墓石（本書の「204」は誤り）。`trash` は `auto` と同じ決まり（§7.1 の表のとおりで違いが
  無い）。確認のために `GET /messages/{id}/drive-files` を足した。
- **監査 `drive.trash`** は無かったので足した（§14）。
- **墓石の `AttachmentOut`**：`status` は `"attached"` のまま（メッセージに付いている。古い端末はふつうの行を出し、開くと 404）、
  サムネイル・ポスター・プレビューは出さない、`drive` は `{item_id: null, version_id: null, version_number: null, state: "deleted"}`。
- **足したもの**：`DriveItemOut.posted`、`DrivePostOut.sender_id`、`DriveImpactChannelOut.unreadable_guests`、
  `DriveLocationUsageOut.posted_bytes`。`ChannelOut.files_to_drive_effective` は 1 つのチャンネルの応答だけで埋める。
- **`origin`**：`posts` = `source = 'message'` のバージョンを持つファイル（メッセージを消した後も投稿から来たもの）。
- **backfill** は本書では CF6 だったが CF1 で作った（CF6 は本番で流すのと手順書）。
- **メトリクス**の仕組みが無いので、逃げ道はログの warning だけ。

### 19.3 CF2〜CF4 の端末に要るもの

- **メッセージ**：`AttachmentOut.drive`（null ならふつうの添付）。`state` で描き分け（§12.1）：`available` はふつう +「ドライブで表示」
  （`GET /drive/items/{item_id}` の `path` でフォルダを開く）、`moved` は `GET /drive/items/{item_id}` が 200 ならふつう + 場所の
  1 行・404 なら「表示できないファイル」、`trashed` / `deleted` は「削除されたファイル」（名前・サムネイルを出さない）、`trashed` で
  チャンネルのドライブに書ける人には「戻す」（`POST /drive/items/{item_id}/restore`）。ビューアの「新しいバージョンがあります」は
  `GET /drive/items/{item_id}` の `item.file.version_id` を `drive.version_id` と比べる。状態が変わると `message.updated`
  （`change = "attachments"`）が届く。Desktop の SQLite の添付に `drive` を持つ。
- **削除の確認**：`GET /messages/{id}/drive-files` の `trash` の数を「ドライブの n 件のファイルもゴミ箱に移す」の既定に、`reason =
  changed` を「投稿の後に変更されたため、ドライブに残ります」に。外せば `DELETE …?drive_files=keep`、そのままなら `auto`。
- **ドライブ**：`system_role = channel_posts` のフォルダは端末の言語の名前（投稿のファイル / Posted files / 帖子中的文件）と専用の
  アイコン、名前の変更・移動・ゴミ箱を出さない（送れば 409 `drive_folder_system`）。`posted` の行に吹き出しの印、詳細の
  `posts`（「メッセージを表示」は `channel_id`・`parent_id`・`message_id`）。版の削除の 409 `drive_version_posted`。
- **移動・ゴミ箱の確かめ**：`POST /drive/items/impact` が `posted_messages > 0` のときだけダイアログ（`channels` の
  `messages`・`unreadable_after`・`unreadable_guests`）。
- **入力欄**：公開・非公開チャンネルで `files_to_drive ?? channel_files_to_drive` が真なら「#ch のドライブの「投稿のファイル」に
  保存されます」。
- **設定**：チャンネルの設定（オーナー）で `PATCH /channels/{id} {files_to_drive: true | false | null}`、管理画面で
  `PATCH /admin/workspace-settings {channel_files_to_drive}`、使用量の `posted_bytes`。
- **検索**：ドライブのタブに `origin`（「投稿のファイルを含む」= `all`、外す = `uploads`）。
- **古い形**：iOS・Android の出荷版のデコーダの試験に `drive` 付きの実物の JSON を足す（§16）。

### 19.4 CF4 から頼まれたサーバの後追い（2026-10-28）

- **`DriveCrumb.system_role`**：パンくず（`GET /drive/items/{id}` と `GET /drive/folders/{id}/children` の `path`、公開リンクの
  `path` も）の各項目に `DriveItemOut.system_role` と同じ値（「投稿のファイル」は `channel_posts`、ほかは null）。任意の欄で、
  前のサーバは送らない。端末は名前で見分けずにこれで端末の言語の名前にする（無ければ今までの見分けに戻る）。
- **フォルダごとゴミ箱にあるファイルの「戻す」**：`POST /drive/items/{id}/restore` を、ゴミ箱のまとまりの頭でない項目に送ると、
  その項目のまとまり（例：月のフォルダ「2026-10」）ごと戻す（DRIVE.md §10.1）。前は 409 `drive_not_in_trash` で、メッセージから
  戻せなかった。
  - **決めたこと**：まとまりごと戻す。項目と上のフォルダだけを戻すと、まとまりが分かれ（§10.1「一部だけは戻さない」に反する）、
    フォルダは戻ったのに中の残りはゴミ箱、という形になる。まとまりごとなら、ゴミ箱の画面で同じフォルダを戻すのと同じで、戻せる人
    （その場所に書ける人）も同じ。`trash_root_id` を端末に出して頭を戻させる案は、端末ごとに同じ手順を持つことになり、
    古い端末は直らないので取らなかった。
  - 名前の重なり（`on_conflict`）は頭が戻る先で決まる（「投稿のファイル」の下の月のフォルダは、次の投稿が同じ月のフォルダを
    作り直していれば「2026-10 (1)」）。応答は頼まれた項目（`trashed_at = null`）。まとまりの中の投稿のファイルはすべて
    `drive_state` が変わり、それぞれのメッセージに `message.updated`（`change = "attachments"`）、場所に `drive.changed`。
  - 監査 `drive.restore`（頭の id、`location_id`・`name`・`items`・`messages`・頼まれた項目なら `asked_item_id`）。
    ゴミ箱と同じく、投稿のファイルが戻るか、まとまりの中の項目から戻した時だけ。
  - ゴミ箱に無い項目は今までどおり 409 `drive_not_in_trash`。完全削除は今までどおり頭だけ。
- **端末**：「戻す」の 409 `drive_not_in_trash` の特別な文（CF4 の「フォルダごとゴミ箱にあります」）はこのサーバでは出なくなる
  （前のサーバのために残してよい）。戻した後は `message.updated` で `available` になる。
- 試験：`test_channel_files.py`（パンくずの印、月のフォルダごとゴミ箱にある 2 件を別のメンバーが 1 件から戻す・イベント・監査）、
  `test_drive.py`（まとまりの中の項目から戻す・`fail` の 409・残りのまとまり・2 回目の 409・完全削除は頭だけ）。

## 22. 段階 CF4 の実装（Android、M177、2026-10-28）

### 22.1 作ったもの

- **型**：`AttachmentOut.drive`（`AttachmentDriveOut`、無ければ null）、`DriveItemOut.system_role`・`posted`・`posts`（`DrivePostOut`）、
  `ChannelOut.files_to_drive`・`files_to_drive_effective`、`WorkspaceSettingsOut.channel_files_to_drive`（無ければ false）、
  `DriveMessageFilesOut`。メッセージは JSON で Room に入るので、端末の保存の移行は要らない（`drive` はそのまま残る）。
- **規則**（`sync/ChannelFiles.kt`）：添付の見え方（`look`：ふつう・移動・削除）、「ドライブで表示」の項目、「戻す」を出すか、
  削除の確認（`DeletePlan`）、入力欄の 1 行（`filesGoToDrive`）、チャンネルの 3 つの選択、検索の `origin`、詳細の「投稿」の 1 行。
- **メッセージ**（`ui/Attachments.kt`）：`trashed` / `deleted` は薄い枠の 1 行「削除されたファイル」（名前・サムネイルを出さない）、
  `trashed` でチャンネルのドライブに書ける人には「· ゴミ箱にあります」と「戻す」（`POST /drive/items/{id}/restore`、
  `on_conflict = rename`）。`moved` は `GET /drive/items/{id}`（`/d/` のカードと同じ 1 分のキャッシュ）で、読めればふつうの
  タイル + 下に今の場所の 1 行、404 なら鍵のアイコンの「表示できないファイル」と「このファイルは別の場所へ移されました。」、
  読み込みの失敗は「タップでもう一度」。
- **「ドライブで表示」**：Android の添付には ⋯ が無いので、メッセージの長押しのシート（「テキストをコピー」の次）に置いた。
  1 件なら「ドライブで表示」、複数なら「ドライブで表示：名前」をファイルごとに。読めない `moved` のものは出さない（名前が出るため）。
  開き方は `/d/` のリンクと同じ（`openDriveLink`：そのフォルダを開いて詳細）。「ファイル」の一覧（と検索のファイルのタブ）の行にも
  同じアイコンのボタン。
- **`message.updated`**：新しい `attachments` は Store の今の規則（`updated_seq` が新しいほうが勝つ）でそのまま入る。そのうえで
  届いたメッセージの添付の項目を `DriveHub` のキャッシュから消し（`forget`）、移動の確かめと詳細を読み直させる。
- **削除の確認**：投稿のファイル（`deleted` 以外の `drive`）を持つメッセージだけ、ダイアログを開いた時に
  `GET /messages/{id}/drive-files` を読む（その間は「ドライブのファイルを確認しています…」で「削除」を押せない）。`trash` が
  1 件以上なら「ドライブの n 件のファイルもゴミ箱に移す」のチェック（既定は入り、外すと `drive_files=keep`、入りなら `auto`）と
  「ゴミ箱からは 30 日のあいだ戻せます。」、`changed` があれば「n 件は投稿の後に変更されたため、ドライブに残ります。」。
  ゴミ箱に入れるものが無ければ「ドライブのファイルは残ります。」だけで、`drive_files` は送らない。読めなければ（オフライン・
  CF1 より前のサーバ）何も聞かず、サーバの `auto`（古い端末と同じ）。
- **ドライブの画面**：`system_role = channel_posts` は端末の言語の名前（行・題名・詳細・パンくず）と吹き出しのアイコン
  （`Forum`）。`posted` の行は 2 行目の頭に小さな吹き出し。詳細のシートに「投稿」（「三井 · 10/28 15:02 · #m2-seminar（スレッド）」と
  「メッセージを表示」= メッセージのリンクと同じ `openPermalink`）。検索の間は欄の下に「投稿のファイルを含む」のチップ
  （外すと `origin=uploads`。既定の `all` は送らない）。
- **入力欄**：添付のチップ（か上げている途中のもの）がある間、その下に小さく「#ch のドライブの「投稿のファイル」に保存されます」
  （公開・非公開チャンネル、アーカイブでない、`files_to_drive ?? channel_files_to_drive` が真。DM には出さない）。
- **チャンネルの設定**：チャンネルの詳細の「管理」（オーナーと admin、アーカイブでない、サーバにドライブがあるとき）に
  「投稿したファイルをチャンネルのドライブに保存する」と、押すとメニューが開くボタン（「ワークスペースに従う（する）」・
  「する」・「しない」→ `PATCH /channels/{id} {files_to_drive: null | true | false}`）。
- **文言**：`res/values*/strings_channel_files.xml`（ja / en / zh-Hans）。色の帯は使わない（状態はアイコンと文字の色、細い枠だけ）。
- **試験**：`ChannelFilesTest`（`drive` 付きと無しの実物の形の `MessageOut`・墓石・Room の JSON の往復、状態ごとの見え方と
  知らない状態、「ドライブで表示」と「戻す」の条件、`drive-files` の読みと `auto` / `keep` / 送らない、入力欄の条件と
  CF1 より前のサーバ、チャンネルの選択、特別なフォルダの名前・アイコン・パンくず、`posts` と「投稿」の 1 行、移動の確かめが
  キャッシュされ `forget` で読み直すこと、`canWriteChannelDrive`、検索の `origin`）。`DriveTest` の偽物に `origin`。

### 22.2 CF4 で決めたこと

- **スマホのドライブは移動・ゴミ箱・名前の変更・版の削除を持たない**（MOBILE_UI.md §25、DRIVE.md §17.6）。なので移動・ゴミ箱の前の
  確かめ（`POST /drive/items/impact`）、409 `drive_folder_system`・`drive_version_posted` を受ける画面は Android には無い（文言は
  CF1 の errors.json から生成済みで、ほかの経路で返っても一般の文にはならない）。スマホにそれらの操作を足す時に一緒に作る。
- **管理画面のスイッチ・使用量の `posted_bytes`** はスマホに管理画面が無いので作らない（Desktop / Web の CF2）。
- **ビューアの上の行（「ドライブ：#ch › 投稿のファイル › 2026-10」）と「新しいバージョンがあります」は CF4 では作らなかった**。
  ビューアを開くたびに `GET /drive/items/{id}` を読むことになり、Android のビューア（写真・動画・PDF）の上の帯に場所が無い。
  ドライブで最新を見る道は「ドライブで表示」で足りると考え、要望が出たら足す。
- **入力欄の 1 行は「1 回目だけ」にしなかった**：添付がある間いつも出す（短い 1 行で、保存先を毎回知らせるほうが分かりやすい）。
- **パンくずの「投稿のファイル」**：`DriveCrumb` に `system_role` が無いので、一覧で見た `system_role` の id（`DriveHub.systemFolders`）か、
  チャンネルのドライブの根のすぐ下にあるサーバの名前「投稿のファイル」で見分ける（同じフォルダに同じ名前は 1 つだけで、特別な
  フォルダは名前を変えられないので、根の直下ではこれで決まる）。
- **「戻す」が `drive_not_in_trash`（409）**：ファイルがフォルダ（例：「2026-10」）ごとゴミ箱にあると、項目だけは戻せない
  （ゴミ箱のまとまりの頭だけが戻せる）。スマホにはゴミ箱の画面が無いので、「このファイルはフォルダごとゴミ箱にあります。
  ドライブのゴミ箱からフォルダを戻してください。」と出す。
- **「戻す」を出す人**：`GET /drive/locations` のそのチャンネルの場所の `can_write`。場所をまだ読んでいなければ、ゴミ箱のファイルを
  描く時に 1 度読む（読むまでは出さない）。

### 22.3 確かめていないこと

- ChikuwaChat_Pixel_9 での通し（投稿 → ドライブに出る → 名前を変える → 研究室ドライブへ移す → ゴミ箱 → 戻す）は流していない。
  ドライブで移す・ゴミ箱に入れるのはスマホではできないので、Desktop / Web か API で状態を作って確かめる必要がある。
- サーバに頼むこと：`DriveCrumb` に `system_role` があると、パンくずの見分けが名前に頼らずに済む。項目がフォルダごとゴミ箱にある時の
  「戻す」に、ゴミ箱のまとまりの頭（`trash_root_id`）が分かる経路があると、メッセージから直接戻せる。（どちらもサーバで済ませた：
  §19.4。戻すはまとまりごと戻す形にした）
