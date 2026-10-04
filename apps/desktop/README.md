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
```

`npm run tauri build` は更新用のファイル (`.app.tar.gz` と `.sig`) も作り、その署名に更新の秘密鍵
(`TAURI_SIGNING_PRIVATE_KEY`) を求める。リリース (kanotown/taylis-releases、アプリ内の「更新して再起動」) は
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
  platform/   secrets.ts (Keychain / Credential Manager)、sqlite.ts (tauri-plugin-sql)、notify.ts (OS 通知)、deepLink.ts (`chikuwachat://`、Google でログインの戻り)
  state/      app.ts (起動時のセッション復元、ログイン、強制パスワード変更、エンジンのライフサイクル)
  ui/         LoginScreen、ChangePasswordScreen、MainScreen (左: チャンネル / DM、中央: タイムラインと入力欄、右: スレッド用の余白)
src-tauri/    Rust 側: secret_get / secret_set / secret_delete (keyring)、SQL と通知プラグイン、deep link (+ Windows は single-instance)、アプリ内の更新 (updater / process、画面側は state/updates.ts)
tests/        fakeServer.ts (プロトコルの模擬サーバ)、engine / apiClient / markdown のテスト、contract.test.ts (server/tests/contract/*.json)、live.test.ts
```

## ウィンドウのタイトルバー

- macOS: `titleBarStyle: "Overlay"` (tauri.conf.json)。信号機ボタンは上の行に重なり、上の行
  (`data-tauri-drag-region`) でウィンドウを動かす。
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
- **文字の大きさ** (デスクトップ版だけ): ⌘ / Ctrl + 「+」(「=」「;」、テンキーの + も)・「-」・「0」(100%)
  と設定の項目で 80〜200% (0.8 / 0.9 / 1 / 1.1 / 1.25 / 1.5 / 1.75 / 2)。`platform/zoom.ts` が
  Tauri の `Webview.setZoom` (権限 `core:webview:allow-set-webview-zoom`) で画面全体を拡大し、起動時に戻す。
  ウィンドウ設定の `zoomHotkeysEnabled` は使わない (Windows は WebView2 の拡大、macOS は 20% 刻みの差し込み
  スクリプトで、どちらも再起動で 100% に戻り、設定から値を見せられないため)。macOS の信号機ボタンは拡大されない
  ので、そのための余白は `--ui-zoom` で割って同じ大きさに保つ。ブラウザ版はキーを横取りせず (ブラウザの拡大が
  サイトごとに覚える)、設定にも出さない。macOS のメニューバーは Tauri の既定のまま (表示メニューに項目は足して
  いない。足すにはメニュー全体を Rust で作る必要がある)。

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
| `_斜体_` | *斜体* |
| `` `code` `` | インラインコード |
| ```` ``` ... ``` ```` | コードブロック (中の記法は解釈しない) |
| `<@user_id>` | @表示名 |
| `<!channel>` / `<!here>` | @channel / @here |
| `https://...` | リンク (別ウィンドウで開く) |

HTML は解釈しない (React が全文をエスケープする)。
