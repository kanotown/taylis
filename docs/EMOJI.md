# カスタム絵文字: 文字の絵文字・横長の絵文字・絵文字のセット (M100)

利用者の要望 (2026-10-04) で M12f のカスタム絵文字 (DATA_MODEL.md `custom_emoji`) を広げた。

- **文字の絵文字**: 「ありがとうございます」「確認しました」のようなよく使うリアクションが、小さな正方形に文字を
  詰めた画像で読みにくい → 画像ではなく、短い文字を色付きのラベル (ピル) として描く絵文字の種類 `text`。
- **横長の絵文字**: 横長の画像が正方形に押し込まれて小さい → 高さは他の絵文字と同じ、幅は縦横比どおり (3:1 まで)。
- **絵文字のセット**: 利用者のオリジナルの絵文字 (LINE 絵文字の形式、180×180 の透過 PNG、40 個ずつ) を、
  ピッカーのタブ 1 つにまとめて入れる。日本語の検索語 (「ありがとう」で「おじぎ」が出る) を付ける。

ショートコードは今までどおり ASCII (`^[a-z0-9][a-z0-9_+-]{1,31}$`) のまま。IME なしで打て、Slack と同じで、
URL (`/messages/{id}/reactions/:name:`) にもそのまま入る。日本語は **表示名** (`label`) と **キーワード**
(`keywords`) に持つ。

## 1. 文字の絵文字 (`kind = "text"`)

- `POST /emoji/text {name, label, color?, keywords?}` (ゲスト以外の誰でも、画像の絵文字と同じ)。`label` は前後の
  空白を除き、改行などの空白は 1 つの空白にして 1〜12 文字 (制御文字は不可、`400 emoji_label_invalid`)。
- `color` は固定のパレットのキー: `gray` `red` `orange` `yellow` `green` `blue` `purple` `pink` (null = gray)。
  ライト / ダークそれぞれの背景と文字の色は `apps/shared/text-emoji.json` にあり、各クライアントはその写しを持つ
  (各クライアントのテストが共有ファイルと比べる)。
- 行の `content_type` は `""`、`width` / `height` は 0、`storage_key` は `""`。`GET /emoji/{id}/image` は 404。
- 描き方 (4 クライアント共通): 高さは同じ場所の画像の絵文字と同じ、幅は文字に合わせる (最小は正方形)。文字は
  高さの 0.68、左右の余白は高さの 0.28、角の丸みは高さの 0.3、太字。本文の中・リアクション・ピッカー・`:` の補完・
  ステータスのどこでも同じ。
  - Desktop / Web: `TextEmojiPill` (span、CSS 変数で色、ダークはテーマに従う)。
  - iOS / Android: ピルを画像に描いて (`CustomEmoji.textPill` / `TextEmojiPill.draw`) 画像の絵文字と同じキャッシュ
    (`emojiImages`) に入れる。画像を表示する既存の経路がそのままピルを表示する。ライト / ダークが変わったら
    描き直す (iOS: RootView の colorScheme、Android: MainActivity)。
- 古いクライアント (M100 より前) は `kind` を知らず画像を取りに行き 404 になる。そのときは `:name:` の文字で出る。

## 2. 横長の絵文字

- 画像の絵文字は最初 (M12f) から `width` / `height` をアップロード時に保存している (取り込みで縮めたものも縮めた
  後の大きさ)。**縦横比はそこから求める**ので、移行での埋め戻しも CLI (`backfill-emoji-sizes`) も要らない。
- 描く箱: 高さ = その場所の絵文字の高さ (本文 1.375em / 16pt、リアクション 16px など)、幅 = 高さ × 縦横比。
  縦横比は 1〜3 に丸める (縦長は正方形の箱に収め、4:1 より横長は 3:1 の箱に収める)。画像が来る前から同じ箱を
  取る (2026-10-04 のガタつきの修正と同じ規則: 置き場所の大きさは最初から決まっている)。
- ピッカーのマスは正方形のまま、画像を縮めて収める (`square`)。

## 3. 絵文字のセット (`emoji_packs`)

- 表 `emoji_packs (id, name 一意 64 文字まで, position, tab_content_type, tab_storage_key, created_by, created_at,
  updated_at)`。`custom_emoji.pack_id` (null = セットなし) と `custom_emoji.position` (セットの中の順)。
- タブのアイコンはオブジェクトストアの `emoji-packs/<pack id>/tab-<uuid>`。差し替えると鍵が変わり、
  `EmojiPackOut.tab_version` (鍵の最後の部分) も変わる。クライアントは `(id, tab_version)` でキャッシュする。
  `GET /emoji/packs/{id}/tab` (要ログイン)。アイコンがないセットはタブに最初の絵文字を出す。
- API (作成・変更・削除・取り込みは管理者だけ、監査ログ `emoji_pack.create / update / delete / import`):
  - `GET /emoji/packs` (bootstrap の `emoji_packs` にも)
  - `POST /emoji/packs {name}` (空のセット)、`PATCH /emoji/packs/{id} {name?, position?}`
  - `DELETE /emoji/packs/{id}`: **セットだけを消し、絵文字は残す** (セットなし = 「カスタム」のタブに移る)。
    本文やリアクションで使われている絵文字が消えないように。絵文字ごと消したいときは絵文字を個別に削除する。
  - `PATCH /emoji/{id} {label?, color?, keywords?, pack_id?, position?}`: 表示名・色・キーワードは作成者か管理者、
    セットと順番は管理者。
- イベント `emoji_pack.updated {pack, deleted}` (audience all)。セットを消したときは、そのセットの絵文字それぞれに
  `emoji.updated` (`pack_id: null`) も出る。
- ピッカー (4 クライアント): 「カスタム」のタブはセットなしの絵文字だけ。その後ろにセットごとのタブ (アイコン)。
  セットのタブは絵が大きいので 1 マスを 2 倍にする (Desktop 4 列 56px、iOS 4 列 64pt、Android 2 マス分 64dp)。
  検索はすべての絵文字が対象。

## 4. セットの取り込み (`POST /emoji/packs/import`)

管理者が Desktop / Web の「管理」→「カスタム絵文字」→「セットを追加」で、フォルダか ZIP を選ぶ。

- フォルダ: フォルダの中の画像と `pack.json` を `files` (複数) で送る (ほかのファイル、例えば `タグ案.md` は送らない、
  送られても読まない)。ZIP: `archive` で送る。ZIP の中は直下でも 1 つのフォルダの中でもよく、ファイルは名前
  (パスの最後) で探す。`__MACOSX` とドットファイルは無視。
- `pack.json`:

  ```json
  {
    "name": "ドットはんぺん",
    "tab": "tab.png",
    "items": [
      {"file": "032_おじぎ.png", "shortcode": "hpd-bow", "label": "おじぎ", "keywords": ["ぺこり", "ありがとう"]}
    ]
  }
  ```

  ファイル名は NFC にそろえて比べる (macOS は日本語のファイル名を分解形 (NFD) で渡す)。
- 検査はアップロードと同じ: 画像は PNG / GIF / JPEG / WebP、`EMOJI_MAX_BYTES` (256 KB) 以下、512px 以下。
  `pack.json` は 1 MB まで、items は 300 個まで、ZIP は 1000 項目・展開後 64 MB まで、送信全体 64 MB まで。
- **全部か何もしないか**: 先に全部を検査し、どれか 1 つでも駄目なら何も書かない。
  - `400 emoji_pack_manifest_invalid` (pack.json がない・JSON でない・形が違う・ショートコードかファイルの重複)、
    `400 emoji_name_invalid` (ショートコードの形)、`400 emoji_pack_file_missing` (pack.json にあるファイルがない)、
    `400 emoji_not_image` / `emoji_too_big`、`413 emoji_too_large`、`400 emoji_pack_archive_invalid` (ZIP が読めない、
    同じ名前のファイルが 2 つ)。`details.file` に問題のファイル。
  - `409 emoji_name_taken`: ショートコードが **ほかの絵文字** (別のセットかセットなし) に使われている。
    `details.shortcodes` にその一覧。
- **やり直しても重複しない**: セットは名前で、絵文字はショートコードで探す。
  - セットがなければ作る (順番は最後)。あればそれを使う。
  - そのセットにすでにあるショートコードは表示名・キーワード・順番を pack.json に合わせる (**画像は差し替えない**)。
    ないものは追加する。pack.json から外れた絵文字は消さない (消すのは個別に)。
  - `tab` があればタブのアイコンを差し替える。
  - 結果 `{pack, created, updated, unchanged}` (ショートコードの一覧)。
- 取り込みの `emoji.updated` は追加・更新した絵文字ごとに 1 つ、`emoji_pack.updated` は 1 つ。

## 5. 検索と `:` の補完

- カスタム絵文字は名前・表示名・キーワードで探す。順位: 名前の前方一致 → 名前の部分一致 → 表示名 / キーワードの
  前方一致 → 部分一致 (同順位は名前順)。比べる前に NFKC・小文字にし、カタカナはひらがなにする
  (「アリガトウ」でも「ありがとう」が当たる)。標準の絵文字も日本語のキーワード (apps/shared/emoji.json) で当たる。
- `:` の補完は ASCII の 2 文字以上 (今まで) に加えて、`:` か `：` の後の日本語 1 文字以上 (`:ありがとう`、`：了解`)。
  `:` の前は行頭・空白・`(`・`（`・`「` のときだけ (「例：説明」では出ない)。
- サーバは検索をしない (表は bootstrap で全部クライアントにある)。キーワードは保存時に NFC・小文字・重複なしにし、
  20 個・1 つ 32 文字まで (`400 emoji_keywords_invalid`)。

## 6. 利用者の 3 つのセット

利用者のオリジナルの絵 (`emoji/Chikuwa`、`emoji/Hanpen`、`emoji/Hanpen_dot`) はリポジトリに入れない
(ローカルで git から除外)。下書きの `pack.json` は各フォルダの中、確認表は `emoji/REVIEW.md`。ショートコードの
接頭辞はちくわ `ckw-`、はんぺん `hp-`、ドットはんぺん `hpd-`。ドットはんぺんの 041 / 042 (`_没`) は入れない。
