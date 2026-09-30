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
npm run tauri build    # バンドル作成 (macOS: .app / .dmg、Windows: .msi / .exe)
```

同じ Mac で 2 人分のクライアントを動かすには、2 つ目をビルド済みアプリ
(`open -n src-tauri/target/release/bundle/macos/ChikuwaChat.app`) で起動するか、ポート 1421 で
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
src-tauri/    Rust 側: secret_get / secret_set / secret_delete (keyring)、SQL と通知プラグイン、deep link (+ Windows は single-instance)
tests/        fakeServer.ts (プロトコルの模擬サーバ)、engine / apiClient / markdown のテスト、contract.test.ts (server/tests/contract/*.json)、live.test.ts
```

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
