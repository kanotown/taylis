# apps/desktop

Desktop クライアント (Windows / macOS)。Tauri 2 + React + TypeScript (Vite)。

## 開発

```
npm ci
npm run gen:api        # ../../openapi/openapi.json から src/api/schema.d.ts を生成 (コミット対象)
npm run typecheck      # tsc --noEmit
npm test               # vitest: エンジン、API クライアント、本文トークナイザ、共有の契約フィクスチャ
npm run dev            # ブラウザで UI だけ動かす (資格情報は localStorage、通知は Notification API)
npm run tauri dev      # Tauri で起動 (Keychain / SQLite / OS 通知が本物になる)
npm run tauri:build    # バンドル作成 (macOS: .app / .dmg、Windows: .msi / .exe)。更新用のファイルは作らない
npm run build:mobile-editor    # スマホに同梱するページエディタ → ../shared/mobile-editor/dist (M153a、下の節)
npm run preview:mobile-editor  # それを http://localhost:1422/?dev=1 で試す (ネイティブの代わりの harness つき)
```

`npm run tauri build` は更新用のファイル (`.app.tar.gz` と `.sig`) も作り、その署名に更新の秘密鍵
(`TAURI_SIGNING_PRIVATE_KEY`) を求める。リリース (kanotown/taylis の GitHub Release、アプリ内の「更新して再起動」) は
`scripts/release-desktop.sh vX.Y.Z` で作る: docs/DEVELOPMENT.md §6「デスクトップ版のリリース」。

同じ Mac で 2 人分のクライアントを動かすには、2 つ目をビルド済みアプリ
(`open -n src-tauri/target/release/bundle/macos/Taylis.app`) で起動するか、ポート 1421 で
`npm run tauri:dev:2` を使う (開発サーバは 1 ポートに 1 つなので、`tauri dev` を 2 回は起動できない)。

実サーバに対するエンジンの検証: `LIVE_URL=http://127.0.0.1:8000 LIVE_PASS=... npm test -- tests/live.test.ts`
(`dtuser1` / `dtuser2` を CLI で作っておく)。

## 構成

```
src/
  api/        client.ts (bearer 認証、token_expired で 1 回だけ refresh、エラー分類)、schema.d.ts (生成)、types.ts
  sync/       engine.ts (SYNC_PROTOCOL.md §5/§7/§8/§9 の実装)、store.ts (表示の唯一のソース、SQLite へ write-through)、ws.ts
  platform/   secrets.ts (Keychain / Credential Manager)、sqlite.ts (tauri-plugin-sql)、notify.ts (OS 通知。macOS のアプリは UNUserNotificationCenter、PUSH_NOTIFICATIONS.md §9.1)、deviceName.ts (端末名「Mac (コンピュータ名)」/「Mac (Safari)」)、deepLink.ts (`chikuwachat://`、Google でログインの戻り)
  state/      app.ts (起動時のセッション復元、ログイン、強制パスワード変更、エンジンのライフサイクル)
  ui/         LoginScreen、ChangePasswordScreen、MainScreen (左: チャンネル / DM、中央: タイムラインと入力欄、右: スレッド用の余白)
  mobileEditor/  スマホに同梱するページエディタの包み (M153a): 橋の環境 bridgeEnv.tsx、MobileEditorApp.tsx、?dev=1 の harness
  styles.css / app.css  Tailwind の読み込み (styles.css) と、トークン・テーマ・部品の規則 (app.css。同梱のエディタも読む)
mobile-editor/  同梱のエディタの入口 (index.html・main.tsx・mobile.css)。vite.mobile-editor.config.ts で ../shared/mobile-editor/dist に書き出す
src-tauri/    Rust 側: secret_get / secret_set / secret_delete (keyring)、SQL と通知プラグイン (Windows / Linux / `tauri dev`)、macOS のアプリの通知 native_notification_* (mac_notify.rs、前面でもバナー・本当の許可の状態・クリック)、computer_name (端末名)、deep link (+ Windows は single-instance)、アプリ内の更新 (updater / process、画面側は state/updates.ts)
tests/        fakeServer.ts (プロトコルの模擬サーバ)、engine / apiClient / markdown のテスト、contract.test.ts (server/tests/contract/*.json)、live.test.ts
```

## ウィンドウのタイトルバー

- macOS: `titleBarStyle: "Overlay"` (tauri.conf.json)。信号機ボタンは上の行に重なり、上の行
  (`data-tauri-drag-region`) でウィンドウを動かす。信号機ボタンの位置は `trafficLightPosition` (x 16・y 20) で
  固定 (上から 40pt の中央、右端は x 76)。上の行の高さは `TITLE_ROW_HEIGHT` (40px、ただし 40pt 未満にしない:
  80・90% でもボタンが収まる)。ワークスペースのレールがある時も Slack と同じく信号機ボタンは上の行に置き、
  レールは 68px のまま上の行の下から始まる (レールの上のマスはメイン画面では上の行と同じ色で 1 本の行に見え、
  上の行の最初のマスは信号機ボタンの残り `TITLE_ROW_INSET_AFTER_RAIL` = 84pt − レールの幅 (8px 以上) を空ける)。
  レールがない時は上の行の左を 84pt 空ける。以前はレールを信号機ボタンが横に並ぶ幅 (84pt) まで広げていた。
  - 上の行がない画面 (起動中・ログイン・「ワークスペースを追加」・招待・パスワード変更) でレールがある時は、
    レールの横に同じ色・同じ高さの行 (`ScreenTitleRow`) を出し、上の行が窓の幅いっぱいに続く (レールの上のマスも
    どの画面でも上の行の色・右の線なし)。緑のボタンは x 76pt まででレール (68px) より右に出るため、レールの色の
    マスだけだと端からはみ出していた。レールがない時はボタンの下に色の境目がないので、従来どおり透明な帯 (32px) だけ。
  - 全画面でも上の行の高さ・レールの上のマス・左の余白はそのまま (全画面に合わせて変えない)。Tauri には
    「全画面を抜け始めた」イベントがなく、抜けるアニメーションの間 macOS は既にボタンを出すので、終わってから
    マスを出すとその間ボタンが最初のワークスペースのアイコンに重なっていた (`isFullscreen()` をリサイズのたびに
    聞く方式 `platform/windowState.ts` は削除)。入るときもレイアウトが変わらないので隙間がちらつかない。代わりに
    全画面ではボタンのない場所が空く: レールがある時はレールの上の 40px (上の行の続きに見える) と左の 16px
    (100% の時)、レールがない時は上の行の左 84pt。
- Windows: システムのタイトルバーを出さない (`src-tauri/tauri.windows.conf.json` の `"decorations": false`、
  Tauri が Windows でだけ重ねる。配列は丸ごと置き換わるので、ウィンドウの設定はそこにも全部書く)。Slack と同じく
  上の行 (ワークスペース名 / 検索) がタイトルバーで、右端に自前の最小化 / 最大化・元に戻す / 閉じる
  (`ui/WindowControls.tsx`)。上の行の空きをドラッグで移動、ダブルクリックで最大化 / 元に戻す。ログインなど上の行が
  ない画面では、上端 32px の帯 (`ScreenTitleStrip`) が同じ役をする。端のリサイズと Win+矢印のスナップは効くが、
  最大化ボタンにホバーして出る Windows 11 のスナップレイアウトは出ない (ネイティブのボタンでないため)。
- Linux とブラウザ版: システムのタイトルバーのまま。

## 表示: 配色と文字の大きさ

設定の「表示」。どれも端末ごと (localStorage。読めない環境では既定のまま動く)。

- **ライト / ダーク** (M40): `<html data-theme>`。「端末に合わせる」は属性なしで OS に従う。
- **テーマの色**: `<html data-palette>` (`ui/theme.ts` の `PALETTES`)。サイドバーとワークスペースのレール、
  アクセント (リンク、ボタン、選択中の行、フォーカスの枠、選択範囲) が変わる。色は `styles.css` の `--p-*`
  (パレットごとにライトとダークの値) で、ライト / ダークの組み合わせは自由。既定は **Taylis (栗)**: アプリの
  アイコン (`apps/shared/brand/appicon.png`) のこげ茶 #3D2A1E とキャラメル #C08860 から、サイドバー #3b2b21、
  アクセント #8f5530 (ダークでは文字用 #dba67c)。ほかに 藍 (以前の色)・緑・紫・紅・グレー。
  `--accent` は文字・線用、`--accent-solid` (`bg-accent-solid`) は白い文字を載せる塗り用で、ダークでは
  文字用を明るく、塗り用を暗いままにして両方とも WCAG AA (4.5:1) を満たす。全パレットのコントラストは
  `tests/theme.test.ts` が確かめる。白い文字を載せる塗りには `bg-accent` でなく `bg-accent-solid` を使う。
  属性は `main.tsx` が描画前に付ける (React が描くまでパレットの色を使うものは画面に無い)。
  濃いサイドバーの文字 (`--p-sidebar-fg`) はライト表示で約 11:1、ダーク表示で約 12.5:1 (2026-10-04 に明るく
  した)。未読の行は白の太字、セクションの見出しは文字の 70 % (`--sidebar-muted`) で、どちらとも区別できる。
- **サイドバー: 濃い色 / 明るい色**: `<html data-sidebar="light">` (`ui/theme.ts` の `SIDEBAR_TONES`、
  既定は濃い色で属性なし)。どのパレットとも組み合わさり、明るい色は背景がアクセントを 5 % 混ぜた白、文字は
  パレットのサイドバーの色を暗くした色 (`--sl-*`、未読は約 14:1、通常の行は 8.5:1 以上、見出しは 5:1 以上)、
  選んだ行はアクセントの塗り (`--accent-solid`) に白い文字、レールは少し濃い灰色、区切り線とキャンバスとの境の
  線 (`--sidebar-edge`、濃いサイドバーでは透明)。**ライト表示のときだけ効く**: `styles.css` はダークの指定より
  後で `prefers-color-scheme: light` かつ `data-theme="dark"` でないとき、または `data-theme="light"` のときに
  だけ置き換える。ダーク表示では明るいサイドバーは画面全体から浮くので濃いままにする (設定にもそう書く)。
  サイドバーまわり (サイドバー・レール・上の行の検索欄と戻る / 進む・Windows のウィンドウのボタン) の色は
  白の直書きでなく `sidebar-strong` (濃い: 白 / 明るい: 濃い文字)・`sidebar-active-fg`・`sidebar-rail`・
  `sidebar-line`・`sidebar-edge` のトークンで書く。未読の太字と選択中の行が重なるときは選択中の文字色が勝つ
  よう、`cn()` で選択中のクラスを後に置く。macOS の信号機ボタンは OS が描くのでどちらでも同じ。
- **ワークスペースごとの色** (2026-10-06): テーマの色とサイドバーはワークスペースごとに持てる (Slack のように
  ワークスペースが一目で分かる)。localStorage `chikuwa.prefs.workspaceTheme` = `{ [serverUrl]: { palette?, sidebar? } }`
  (キーは `WorkspaceEntry.serverUrl`)、無い値は共通の選択 (`chikuwa.prefs.palette` / `chikuwa.prefs.sidebar`)。
  `ui/theme.ts` の `setThemeWorkspace` が画面のワークスペースを覚えて属性を付け直す。コントローラは開いている
  ワークスペースが変わるたびに (`saveWorkspaces` を通る) 呼ぶので、切り替えと同じタスクで色が変わる。
  `main.tsx` は描画前に最後に開いていたもの (`savedActiveWorkspace()`) で呼ぶ。「ワークスペースを追加」の
  ログイン画面 (開いているものが無い) では色はそのまま。設定は、レールがある時 (`showsRail`) だけ選んだ色を
  そのワークスペースのものにし、「すべてのワークスペースに使う」で共通にする (各自の値を消す)。レールが無い時
  (1 つ・ブラウザ版) は共通の選択を書き、各自の値を消す。ライト / ダークとフォントは端末で 1 つ。端末ごとで、
  サーバには保存しない。
- **フォント** (2026-10-05): 既定は同梱の **Noto Sans JP** (`@fontsource-variable/noto-sans-jp`、SIL OFL 1.1、
  THIRD_PARTY_NOTICES.md)。`main.tsx` が重さの軸だけの可変フォント (`wght.css`) を読み込み、`styles.css` の
  `--font-ui` が `"Noto Sans JP Variable"` を先頭に、その後に以前のシステムのフォント (`--font-system`:
  -apple-system・Segoe UI・Hiragino Sans・Yu Gothic UI …) を並べる。コードは等幅のまま。woff2 は unicode-range で
  124 個 (合計 5.2 MB) に分かれ、ブラウザは画面の文字が使う分だけを取る (日本語の画面で数百 KB、Web では
  `/assets/` が immutable でキャッシュされる)。ビルドの大きさは woff2 の分 (約 5.2 MB) 増える (Tauri のアプリと
  Web のイメージ)。CSS は約 105 KB (gzip で約 30 KB) 増える。CSP は Tauri が `default-src 'self'`、Caddy が
  `font-src 'self' data:` で、同梱のファイルはそのまま読める。設定の「フォント」で「システムのフォント」を選ぶと
  `<html data-font="system">` (`ui/theme.ts` の `FONT_OPTIONS`、端末ごと、描画前に `main.tsx` が付ける) で
  Noto を外し、ファイルも取らない。スマホは変えない (Android の日本語のシステムフォントは Noto Sans CJK JP、
  iOS は Hiragino / SF のまま)。
- **文字の大きさ** (デスクトップ版だけ): ⌘ / Ctrl + 「+」(「=」「;」、テンキーの + も)・「-」・「0」(100%)
  と設定の項目で 80〜200% (0.8 / 0.9 / 1 / 1.1 / 1.25 / 1.5 / 1.75 / 2)。`platform/zoom.ts` が
  Tauri の `Webview.setZoom` (権限 `core:webview:allow-set-webview-zoom`) で画面全体を拡大し、起動時に戻す。
  ウィンドウ設定の `zoomHotkeysEnabled` は使わない (Windows は WebView2 の拡大、macOS は 20% 刻みの差し込み
  スクリプトで、どちらも再起動で 100% に戻り、設定から値を見せられないため)。macOS の信号機ボタンは拡大されない
  ので、そのための余白は `--ui-zoom` で割って同じ大きさに保つ。ブラウザ版はキーを横取りせず (ブラウザの拡大が
  サイトごとに覚える)、設定にも出さない。macOS のメニューバーは Tauri の既定のまま (表示メニューに項目は足して
  いない。足すにはメニュー全体を Rust で作る必要がある)。

## サイドバー・確認のお願い・ホバーの一覧

- サイドバーのセクション見出しは 13px (大文字・字間・`--sidebar-muted`)。見出しの下の行は `SECTION_ROW_PAD`
  (`pl-5 pr-2.5`) で一段下げる。行の中の余白なので選択とホバーの塗りは全幅のまま。上の固定の項目は下げない。
- 自分のセクションは見出しをドラッグして並べ替える (落とす先のセクションの上半分なら前、下半分なら後ろ、その位置に
  アクセントの線)。ドラッグは `application/x-chikuwa-section` を運び、会話のドラッグ (`…-channel`) とは別物として
  扱う (見出しに会話を落とすと従来どおりセクションへ移動)。キーボードでは見出しの ⋯ の「上へ」「下へ」。保存は
  既存の `PATCH /sidebar/sections/{id} {position}` で、手元はすぐ並び替わり (失敗したら元に戻す)、他の端末は
  `sidebar.updated` で揃う (iOS・Android は `position` 順に描く)。既定のセクション (お気に入り・チャンネル・Times・
  DM) はサーバに位置が無いので動かさない。
- 「確認を求める」投稿の下は `AckBar.tsx` の 1 行: 「確認のお願い · 3/8 人が確認 · 名前…」、まだの読み手には
  塗りの「確認しました」(済むと押された「確認済み」)、投稿者と管理者には「未確認 N 人」。分母は
  `GET /messages/{id}/ack/pending` を確認の顔ぶれが変わるたびに静かに読む (失敗しても分母を出さないだけ)。
- 誰がリアクション・返信・投票・確認したか、在席、タスクの担当は `title` ではなく `HoverList` (primitives.tsx)
  で出す。ネイティブの `title` はポインタの位置に出て中身を隠すため。上に 8px 離して (入らなければ下)、300ms、
  `pointer-events-none` でホバーを奪わない。値は `HOVER_LIST`。試験では `tests/hoverList.ts` (フォーカスで開く)。

- 参加していない公開チャンネルはサイドバーに並べない（2026-10-08、利用者の要望：チャンネルが多いと長すぎる）。
  代わりに「チャンネル」セクションの最後に「チャンネルを探す」の行（ゲスト以外、折りたたみ中と未読のみの表示では
  出さない）。見出しのコンパス（⌘+Shift+E）も残す。スマホの「チャンネルを追加」と同じ役目。

## コピーのボタン（2026-10-08）

コピーのボタンはすべて `AppController.copyToClipboard(text, notice?)` を通す。クリップボードに書いたら下のトースト
「コピーしました」（または「仮パスワードをコピーしました」「リンクをコピーしました」のように何を写したか）、
書けなければ（Web でクリップボードの許可が無い、非 HTTPS など）エラーのトースト「クリップボードに書き込めません
でした」。中身は `copyText`（非同期のクリップボード → 隠し textarea + `execCommand("copy")` の順）。ボタンの中で
「コピーしました」に変わる印（カレンダーの購読 URL・回復コード）は戻り値で付ける。トーストはダイアログの上
（`z-[60]`）に出る。新しいコピーのボタンも `navigator.clipboard` を直接呼ばずにこれを使う。

## サイドバーの項目 (M111)

設定 → 表示 →「サイドバーの項目」で、サイドバーの上の項目 (スレッド・アクティビティ・下書き・リマインダー・ファイル・
キャンバス・カレンダー・タスク・締切・予約・保存済み) を項目ごとに表示 / 非表示にし、ドラッグか ↑ / ↓ で並べ替える。
「元に戻す」で既定 (すべて表示、今までの順)。自分のアカウントの設定 (`UserMe.nav_items`) で、すべての端末で同じ
(スマホのホームのタイルにも同じ順と表示)。カタログ・既定の順・規則は `apps/shared/nav-items.json` (`ui/navItems.ts`
が写しで、`tests/navItems.test.tsx` が照合する)。知らない key (新しいクライアントの項目) は描かないが、保存のときは残す。
「予約」(M112、docs/RESERVATIONS.md §6) はサーバが枠の一覧に答えてから出し、数字は担当している枠のすぐできる作業。バッジはそのまま、「下書き」「リマインダー」は中身があるときだけ。詳しくは
docs/MOBILE_UI.md §14。

## 入力欄（リッチ / Markdown）

入力欄は 2 つのモードを人ごとに選ぶ（`users.composer_mode`。選んでいなければリッチ。書式の行の右端の
「Aa」/「M↓」と 設定 → 表示 → 入力欄。サーバがこの設定を知らなければその場だけ切り替わる）。どちらも本文・
下書き・編集を同じ Markdown で持つので、切り替えても中身はそのまま。

- **リッチ**（`ui/RichEditor.tsx`、TipTap / ProseMirror）：太字・斜体・取り消し・コード・リンク・見出し 3 段・
  引用・箇条書き / 番号（3 段）・コードブロックを見たまま編集する。強調は記法が入れ子にしないので 1 つずつ。
  表とディスプレイ数式は Markdown のまま編集するブロック、行の中の数式は `$x$`（書いた TeX のまま、ドルの間を逃がさない）。`**x**` `*x*` `_x_` `~~x~~` `` `x` `` `- ` `1. ` `> `
  `# ` ```` ``` ```` `[表示名](https://…)` は打ったその場で書式になる（`__x__` は太字にしない）。⌘B / ⌘I /
  ⌘⇧X / ⌘E・⌘⇧C / ⌘⇧U（リンクの行）/ ⌘U（ファイル）、Tab / Shift+Tab で入れ子、⌘Z / ⌘⇧Z。貼り付けは HTML
  （Web・Word・Google ドキュメント）を対応する書式だけにし、プレーンテキストは文字どおり（記号は送るときに
  逃がす）、ファイルは添付、選んだ文字に URL を貼るとリンク。送信キーの設定、Shift+Enter の改行（リストでは
  次の項目、空の項目・引用の空行で抜ける）、IME の変換中と確定の Enter（送らない・書式にしない）、メンション /
  絵文字 / スラッシュコマンドの候補、下書き、テンプレートは Markdown のモードと同じ。メッセージの編集欄もリッチ。
  TipTap は `React.lazy` の別チャンク（365 kB、gzip 116 kB）で、リッチのときだけ読み、読むまではテキスト
  エリアが代わりに出る。
- **Markdown**：今までのテキストエリア（記号を打つ、プレビューあり）。

変換は `ui/richMarkdown.ts`（TipTap に依存しない）。Markdown → 入力欄は表示と同じ `parseBlocks` で読み、
本文の 1 行を 1 段落（空の段落は空行）にする。入力欄 → Markdown は打った `_ * ~ \`` を、表示が書式に読む所だけ
`\` で逃がす（行ごとに `tokenizeInline` で読み直して確かめ、要らない `\` は外す。`snake_case`・URL・メール
アドレス・`$a_b$` はそのまま）。前後が文字の斜体（日本語の文の途中）は `_` の外に U+200B、段落の行頭が
見出し・引用・リスト・コードブロック・表の区切りに読まれるときも行頭に U+200B（DATA_MODEL.md「本文の形式」）。
テスト：`richMarkdown.test.ts`（共有ベクトルの往復が 1 回で安定し表示が同じ）、`richMarkdownFuzz.test.ts`
（生成した行）、`richEditor.test.tsx`（スキーマ・入力ルール・取り消し）、`richComposer.test.tsx`（送信・IME・
候補・書式の行・貼り付け・モードの切り替え）。

## 検索欄：入力中の結果と IME の確定

上の行の検索欄（`ui/SearchBar.tsx`）は、打っている間に同じ欄の下へ軽い結果を出す（Slack と同じ）。並びは
一致する人（→ 送信者で絞る）・会話（→ その中を検索）・一致する最近の検索・「メッセージ」（上位 5 件）、最後に
「「…」のすべての結果を見る」。メッセージは `GET /search/messages` を `limit=5` で呼び（`ui/LiveSearch.tsx`）、
打つのが 250 ms 止まってから、IME の変換中は呼ばない。空欄では呼ばない（最低の文字数は結果画面と同じで 1 文字から）。
古い応答は捨て、同じ語は欄を開いている間は覚えた結果を出す（この待ち・変換中・古い応答・覚えた結果の仕組みは
`ui/liveQuery.ts` の `useLiveQuery` で、ドキュメントのサイドバーの検索欄（`ui/DocsSidebarSearch.tsx`）と共通）。
読み込み中・該当なし・エラーは 1 行で出し、トーストは出さない。行の本文は結果画面と同じく一致語を強調し、長い本文は
最初の一致の少し前から出す（ドキュメントのサイドバーの検索欄と、検索画面のドキュメント・キャンバスのタブの題名と抜粋の
強調は `ui/marked.tsx` の 1 つの関数）。

結果画面へ移るのは、どの行も選んでいないときの Enter か「すべての結果を見る」の行だけ。↑ / ↓ で行を選ぶと
Enter はその行（メッセージならその会話（返信はスレッド）を開き、語を最近の検索に入れる）、Esc で閉じる。
スマホ幅の Web は欄が全画面になり、「移動・検索」（`ui/JumpView.tsx`）にも同じメッセージの行が出る（Go は
↓ で選ぶまでメッセージを開かず「メッセージ検索」）。

IME の確定の Enter は、何も送らず・選ばず・移らない（`ui/ime.ts` の `isImeKeyEvent` / `isPlainEnter`）。Chromium は
確定の keydown に `isComposing`（keyCode 229）を付けてから `compositionend` を出すが、WebKit（Safari、macOS の
アプリの WKWebView）は `compositionend` を先に出し、その後の keydown は `isComposing` が false になる。そこで
`compositionend` を document で受けて印を付け、次の keyup（来なければ 100 ms 後）で消し、その間の keydown も
IME のものとして扱う。Enter で動く欄はこの 1 つの関数を使う：検索欄、「移動・検索」、⌘K（cmdk は `isComposing` /
229 しか見ないので、残りを `preventDefault` で止める）、検索結果の送信者・チャンネルの選択、キャンバスの絞り込み、
セクションのアイコン、ドキュメントの題名・セルの編集・選択肢、タスクの追加・サブタスク、表の編集、キャンバス・
ページの編集の候補、メッセージの編集欄。IME の変換中の Esc は変換の取り消しだけで、欄やビューを閉じない。
テスト：`searchLive.test.tsx`（両方の順の IME の Enter、変換中は呼ばない、古い応答を捨てる、行の選択、⌘K、
「移動・検索」）。

## 入力欄: URL の貼り付け

文字を選んで URL (http / https 1 つだけ) を貼ると、置き換えずに `[選んだ文字](URL)` のリンクにする
(`ui/composerEdit.ts` の `linkFromPaste`)。メッセージの入力欄、編集欄、キャンバスの編集欄で効く。挿入は
`execCommand("insertText")` なので ⌘Z / Ctrl+Z で戻せる。選んだ文字が複数行・URL・リンクを含む・`[` `]` を
含むとき、URL に空白や括弧があるとき (記法が URL を `)` で切るため) は普通に貼る。

## 同期の要点 (SYNC_PROTOCOL.md に準拠)

- 起動時は WS 接続 → hello → bootstrap → 開いているチャンネルの catch_up。hello 以降のイベントは
  処理キューで直列化されるため、bootstrap 中に届いたものは自然に「バッファ」される。
- チャンネルごとに `syncedSeq` を持ち、イベントの seq が連番でなければ差分 API で回復する。
  5000 件以上遅れていれば最新ページを読み直す。
- 送信は `client_msg_id` 付きで楽観的に表示し、一時的な失敗 (ネットワーク / 5xx / 429) は再接続後に再送、
  恒久的な失敗 (4xx) は「再送 / 破棄」を選べる。
- refresh token は OS の資格情報ストアにのみ保存し、access token はメモリに置く。
- DM の新着は、ウィンドウが非アクティブなら OS 通知を出す (メンションは M8a 以降)。

## 本文の表示フォーマット

サーバはプレーンテキストを保存し、クライアントが次の最小限の記法だけを解釈する (DATA_MODEL.md)。

| 記法 | 表示 |
| --- | --- |
| `*太字*` | **太字** |
| `_斜体_` | *斜体* (単語の途中の `_` は斜体にしない、M107) |
| `` `code` `` | インラインコード |
| ```` ``` ... ``` ```` | コードブロック (中の記法は解釈しない) |
| `<@user_id>` | @表示名 |
| `<!channel>` / `<!here>` | @channel / @here |
| `https://...` | リンク (別ウィンドウで開く) |
| `\_` `\*` `\~` `` \` `` | その記号の文字 (M107) |

HTML は解釈しない (React が全文をエスケープする)。

`_` の強調 (M107、DATA_MODEL.md「本文の形式」): 開きの `_` の前と閉じの `_` の後が文字 (日本語も)・数字・`_` なら
強調にしない (CommonMark)。`snake_case`・`first_middle_last@example.com`・URL の中の `_` `*` `~` は文字どおり。
ケースは `apps/shared/inline-format.json` (3 クライアントとサーバの通知の 1 行が同じケースを通す)。

改行と空行 (2026-10-05、DATA_MODEL.md「本文の形式」): 1 つの改行は `<br>`、1 行以上の空行は段落の間隔
(`<p>` ごとに `mt-2.5` = 10px、本文の行の高さ 24px の約 0.4)。空行が何行あっても間隔は 1 つ、段落の端の空行は
前後のブロックとの同じ間隔 (`markdown.ts` の `paragraphLayout`、ケースは `apps/shared/body-paragraphs.json`)。
タイムライン・スレッド・入力欄のプレビュー・キャンバスが同じ `MessageBody` / `BlockView` で描く。
