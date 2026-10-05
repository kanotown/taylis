# 開発の進め方と引き継ぎ

別の Mac や新しいセッションで開発を続けるための手順と決まり。秘密の値はここに書かない (infra/secrets/README.md)。
今の進み具合は [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) の表、残りは [BACKLOG.md](BACKLOG.md)。

## 1. 新しい Mac で用意するもの

| もの | メモ |
|---|---|
| Xcode (27 系) と iOS シミュレータ | `brew install xcodegen` (apps/ios/project.yml から作る) |
| Android Studio / SDK | platform 37.0、cmdline-tools、emulator。`apps/android/local.properties` に `sdk.dir=$HOME/Library/Android/sdk` を書く (コミットしない)。Android Studio だけでは cmdline-tools が入らないことがある: `commandlinetools-mac-*_latest.zip` を `$ANDROID_HOME/cmdline-tools/latest` に展開する |
| JDK 21 | `brew install openjdk@21` (keg-only なので `/opt/homebrew/opt/openjdk@21/bin` を PATH に足す)。Gradle に要る |
| エミュレータ | `sdkmanager "system-images;android-36;google_apis_playstore;arm64-v8a"` のあと `avdmanager create avd -n <名前> -k <同じイメージ> -d pixel_9`。config.ini の `disk.dataPartition.size` を 12G にしておくと容量が足りる |
| Node.js (20 系) | `apps/desktop` で `npm install` |
| Rust と Tauri の前提 | Desktop アプリを作るとき (`cargo check` は `apps/desktop/src-tauri`)。`brew install rustup` → `rustup default stable` (rustup も keg-only なので `/opt/homebrew/opt/rustup/bin` を PATH に) |
| uv (Python 3.12) | `brew install uv`、`server` で `uv sync` |
| Docker Desktop | 開発サーバ: `docker compose -f infra/docker-compose.yml up -d --build app` |

## 2. Git に入っていないので手で移すもの

| ファイル | 内容 |
|---|---|
| `infra/.env` | 開発サーバの設定 (SECRET_KEY・DB のパスワード・APNs の ID など)。古い Mac からコピーする |
| `infra/secrets/AuthKey_<KEYID>.p8` | APNs の鍵 (再ダウンロード不可)。権限 600 |
| `apps/ios/ChikuwaChat.xcodeproj/xcshareddata/xcschemes/ChikuwaChat.xcscheme` の手元の変更 | 実機に入れるときの Run を Release にしている (コミットしていない)。コピーするか、Xcode の Edit Scheme で設定し直す |
| Claude Code のメモ | `~/.claude/projects/<リポジトリの絶対パスの / を - にした名前>/memory/`。同じパスに clone すれば、フォルダごとコピーで引き継げる。個人の作業の決まりや運用の情報を含むので Git には入れない |
| `ChikuwaChat-tools/` (リポジトリの隣) | 使い捨ての検証用ハーネス (iOS の XCUITest、Android の操作スクリプト、ヘッドレス Chrome のスクリプト、監査の画面) |

AI の API キー (docs/AI.md) は `infra/secrets/anthropic_api_key` (と `openai_api_key`) に、キーの文字列だけを 1 行で置く (権限 600)。
使わないときも空のファイルを作っておく (`install -m 600 /dev/null infra/secrets/anthropic_api_key`)。ファイルが無いまま
`docker compose up` すると、Docker がその場所に空のフォルダを作り、後からキーを置けなくなる (フォルダを `rmdir` で消せば直る)。
本番では deploy.sh が空のファイル (権限 644。コンテナのアプリ uid 10001 が読むため。`secrets/` は 700) を作る。

利用者の絵文字のセット (docs/EMOJI.md §6 / §8、M102) の絵はリポジトリの外 (手元の `/emoji/Chikuwa` などで、Git から
除外) にあり、古い Mac からフォルダごとコピーする。開発サーバで起動時に取り込ませるには、`infra/.env` に
`EMOJI_PRESETS_DIR_HOST=../emoji` (infra/ から見た場所) を書いて `docker compose -f infra/docker-compose.yml up -d app`
(作り直し)。書かなければ `infra/emoji-presets` (空、Git から除外) がマウントされ、何も入らない。compose を使わず
`uv run` でサーバを動かすときは `EMOJI_PRESETS_DIR=../emoji` を環境変数に置くか、一度だけ
`cd server && uv run python -m app.cli import-emoji-presets --dir ../emoji` (管理者を作った後)。

開発サーバのデータ (Docker のボリューム) は移さなくてよい。新しい Mac では空から始め、`server` の CLI で管理者を作る
(`uv run python -m app.cli create-admin --password ...`。一般のユーザーは `create-user` で、仮のパスワードが表示される。決まったパスワードにするには、その人でログインして `PUT /users/me/password`)。

## 3. 作業の決まり

- コードのコメント・コミットメッセージは英語。
- 共有のデータ (apps/shared の JSON) を変えたら、生成スクリプトを走らせ、全クライアントのテストで確かめる。
- API を変えたら openapi/openapi.json を書き出し直し、Web の型も作り直す (下の表)。
- リリースのタグ (`v0.1.x`) は main の CI が通ってから付ける。
- アプリとサイトのアイコン (iOS の AppIcon、Android のアダプティブアイコン、Tauri の `src-tauri/icons`、Web の favicon / apple-touch-icon) は `apps/shared/brand/appicon.png` から作る。元の画像を差し替えたら `apps/shared/brand/gen_icons.sh` を走らせ、書き出されたファイルをコミットする (macOS で uv・sips・iconutil と、`apps/desktop` の `npm ci` 済みが要る)。

## 4. 検証のコマンド

| 対象 | コマンド |
|---|---|
| サーバ | `cd server && DEBUG=false uv run pytest -q -n 10 && uv run ruff check . && uv run ruff format --check . && uv run mypy app tests` (ruff は CI と同じくフォルダ全体。migrations も含む)。`-n auto` はコアの多い Mac (18 コア) だと PostgreSQL の `max_locks_per_transaction` が足りず `out of shared memory` で大半が落ちるので、ワーカーは 10 までにする。動画の縦横・ポスター (M79) の実物のテストは ffmpeg / ffprobe が要る (`brew install ffmpeg`)。無ければその 3 件は skip され、残りは偽の probe で通る |
| OpenAPI | `cd server && uv run python -m app.cli export-openapi`、Web の型は `cd apps/desktop && npm run gen:api` |
| エラー文言 | `cd apps/shared && python3 gen_errors.py` (Web・iOS・Android の表を作り直す) |
| Desktop / Web | `cd apps/desktop && npm run typecheck && npx vitest run && npx vite build` |
| iOS | `xcodebuild -project apps/ios/ChikuwaChat.xcodeproj -scheme ChikuwaChat -destination 'id=<シミュレータの ID>' test`。途中は `-only-testing:ChikuwaChatTests/<Class>` で絞り、全体はコミット前に 1 回。「Application failed preflight checks (Busy)」は、シミュレータの起動し直しとアプリの削除で直る |
| Android | `ANDROID_HOME=$HOME/Library/Android/sdk apps/android/gradlew -p apps/android :app:testDebugUnitTest :app:lintDebug :app:assembleDebug`。正規表現のフラグなど、JVM の単体テストでは通るが Android で落ちるものがあるのでエミュレータでも確かめる |

iOS のビルド番号は `apps/ios/ChikuwaChat/Info.plist` (CFBundleVersion) と `apps/ios/project.yml` の 2 か所を同じにする。
TestFlight / App Store と Google Play への配信 (版の番号、署名、スクリプト) は docs/STORE_RELEASE.md。

## 5. 気をつけること (これまでにはまったところ)

- データを後から埋める移行は、端末が持っている行にも届くよう `updated_seq` を進める (0049 の例)。
- SwiftUI で、中身が空になりうる `Group` や `if` に `.task` や `.sheet` を付けない (リンクのカード、後で送信のダイアログで起きた)。
- iOS の会話は上下を反転したリスト (ARCHITECTURE D23)。下に貼り付けるための補正のコードを足さない。
- 高さが後から変わる中身 (画像・リンクのカード・動画) は、最初から最終の高さを取る (スクロール位置のずれの原因だった)。カスタム絵文字も、画像が来るまで `:name:` ではなく同じ大きさの空白で場所を取る。
- iOS で会話を開くとき、手元の行は追いつき (§7.3) で変わりうる。追いつきと置き場所・着地が済むまで行を見せない (ChannelView の `veiled`、ReadGate.hidesOpeningRows)。
- iOS のスワイプで戻るとき、戻り先の画面はキーボードを無視して並べる (キーボードは去る画面と一緒に出ていく。KeyboardBehavior.swift)。

## 6. デスクトップ版のリリース

デスクトップ版 (Windows / macOS) はアプリの中で更新できる (「新しい版 (vX) があります」→「更新して再起動」、
設定の「このアプリについて」→「アップデートを確認」。起動時と 6 時間ごとに確認し、Web 版は確認しない)。
配る場所は公開の、バイナリだけのリポジトリ **kanotown/taylis-releases**。各リリース `vX.Y.Z` に
インストーラ、更新用のファイル (Windows は NSIS の `.exe`、macOS は universal の `Taylis.app.tar.gz`)、その `.sig`、
`latest.json` を置く。アプリは `https://github.com/kanotown/taylis-releases/releases/latest/download/latest.json` を見る
(tauri.conf.json の `plugins.updater`)。

手順 (タグを付けて push し、main の CI が通ったあと。この Mac で):

```
apps/desktop/scripts/release-desktop.sh v0.1.30 --dry-run           # 何をするかを表示するだけ
apps/desktop/scripts/release-desktop.sh v0.1.30 --notes notes.md    # 公開する (notes は省くと「Taylis v0.1.30」)
```

1. Windows: Actions の `desktop` ワークフローをタグで (os = windows) 起動して待ち、成果物を落とす。同じタグで成功した
   実行の成果物が残っていればそれを使う (`--rebuild-windows` で作り直し)。NSIS のインストーラはこの Mac で更新の鍵で署名する
   (鍵は GitHub に置かない。ワークフローは `tauri.no-updater.conf.json` で更新用のファイルを作らない)。
2. macOS: タグの一時的な worktree で `npm ci` → universal (Apple silicon + Intel) をビルド。`Taylis.app.tar.gz` は tauri が
   同じ鍵で署名する。cargo の target は `~/Library/Caches/taylis-release` に残して次回を速くする。
3. `latest.json` を作る (`windows-x86_64` は NSIS、`darwin-aarch64` と `darwin-x86_64` は同じ universal の tar.gz)。
4. `gh release create` で kanotown/taylis-releases にリリースを作り、全部を添付する。リリースが既にあれば
   `--clobber` で上書きする (やり直してよい)。最後にリリースの URL を表示する。

**更新の前の保存** (review v0.1.30 #3): 「更新して再起動」はダウンロードの後、全ワークスペース (表示していないものも) の
下書き・キャンバス・送信待ちをサーバへ送り (最大 8 秒。届かなかった分は端末に残り、再起動後に送る)、続けて端末の保存
(SQLite) の完了を必ず待つ (最大 30 秒)。端末の保存が失敗するか終わらなければ、インストールせずにエラーを出す。
インストール中は確認の応答が遅れて届いても表示を戻さず、2 回目の更新を始めない (#6)。

**.dmg の画面**: 開くと「Taylis を Applications にドラッグしてください」の背景 (矢印つき) に、アプリと Applications が
並ぶ。tauri.conf.json の `bundle.macOS.dmg` (背景 `src-tauri/dmg-background.tiff`、窓 660×400、アプリ (180, 170)、
Applications (480, 170)) を tauri が使う。背景は `uv run --with pillow python apps/shared/brand/gen_dmg_background.py`
で作り直す (`apps/shared/brand/dmg-background{,@2x}.png` と、両方を入れた TIFF。位置を変えるときはスクリプトと
tauri.conf.json を揃える)。公証する場合はステープルしたアプリで .dmg を作り直すので、スクリプトは tauri が残す
`bundle/dmg/bundle_dmg.sh` (create-dmg) に同じ配置を渡す (Finder を AppleScript で動かすので、ログインした Mac の
ターミナルで実行し、Finder の操作の許可を求められたら許可する)。

アプリの版はタグに従う: tauri.conf.json / Cargo.toml は 0.1.0 のままで、ビルドの時に `--config '{"version":"X.Y.Z"}'`
を渡す (スクリプトと、`v*` で走ったときの `desktop` ワークフロー)。

**更新の鍵**: 秘密鍵は `~/.tauri/taylis-updater.key` (パスワードなし)、公開鍵は tauri.conf.json の
`plugins.updater.pubkey`。**秘密鍵を無くすと、配ったアプリはもう更新できない** (新しい鍵で署名した版を受け付けないので、
全員に手でインストールし直してもらうことになる)。パスワードマネージャなど Mac の外に必ずバックアップし、
新しい Mac には §2 のファイルと一緒に移す。コミットしない、表示しない。

**Mac の署名**: 今は ad-hoc (`bundle.macOS.signingIdentity "-"`)。Developer ID の証明書が来たら、環境変数で切り替える:
`APPLE_SIGNING_IDENTITY="Developer ID Application: … (TEAMID)"` で署名し、さらに `TAYLIS_NOTARY_PROFILE=<名前>`
(`xcrun notarytool store-credentials <名前>` で作ったキーチェーンのプロファイル) があれば、アプリを公証してステープルし、
更新用の tar.gz を作り直して署名し直し、.dmg も署名・公証・ステープルする。
この 2 つは毎回打たずに `~/.config/taylis/release.env` (リポジトリの外、秘密ではない) に `APPLE_SIGNING_IDENTITY=<証明書の SHA-1>` と
`TAYLIS_NOTARY_PROFILE=<名前>` を書いておけば、スクリプトが読む (環境変数が優先)。証明書を 2 回取り込むと名前があいまいになるので、
名前より SHA-1 (`security find-identity -v -p codesigning`) を使う。

手元で `npm run tauri build` すると、更新用のファイルの署名に秘密鍵を求めて最後に失敗する (アプリ自体はできている)。
鍵なしで作るときは `npm run tauri:build` (`--config src-tauri/tauri.no-updater.conf.json`)。

## 7. 公開リポジトリの CI

このリポジトリは公開 (Apache-2.0) なので、ワークフローはすべて GitHub のホストする runner で動かす
(`ubuntu-latest`、iOS とデスクトップのインストーラは `macos-latest` / `windows-latest`)。self-hosted runner、
とくに本番のサーバーの上の runner は使わない: 外部からの pull request がそこで任意のコードを動かせてしまう。

- ci.yml の server ジョブは、テスト用の PostgreSQL + PGroonga を service container
  (`groonga/pgroonga:latest-alpine-17`、開発用の compose と同じイメージ) で立て、Docker が選んだポートを
  `TEST_DATABASE_URL` に渡す。
- 各ワークフローの `permissions:` は既定で `contents: read`。イメージの push (`packages: write`) は release の
  images / deploy ジョブだけ。
- release.yml の deploy は、元のリポジトリ (フォークでない) の `v*` タグのときだけ動く。SSH の秘密情報は
  environment (`production`、`taylis`) にだけ置く。

持ち主が GitHub の設定で行うこと:

1. Settings → Actions → General → "Fork pull request workflows from outside collaborators" を
   **"Require approval for all outside collaborators"** にする (外部の人の pull request は、持ち主が
   内容を見て承認するまでワークフローが動かない)。
2. 同じ画面の "Workflow permissions" は **"Read repository contents and packages permissions"** のままにし、
   "Allow GitHub Actions to create and approve pull requests" は切っておく。
3. Settings → Environments の `production` と `taylis` は、Deployment branches and tags で **タグ `v*` だけ**を許可する
   (必要なら Required reviewers も)。秘密情報 (`DEPLOY_*`) は environment に置き、リポジトリの Secrets には置かない。
4. Settings → Actions → Runners に以前の self-hosted runner が残っていれば外す (サーバーの runner のサービスも止める)。
5. Settings → Code security で "Private vulnerability reporting" を有効にする (SECURITY.md)。

## 8. フォークでのビルド (Forks)

「Taylis」の名前とリスのアイコンは Apache-2.0 の対象外 (TRADEMARKS.md)。改変版を配るフォークは、名前・アイコン・
アプリの ID を自分のものに替える。替える場所:

| 対象 | 場所 |
| --- | --- |
| アイコン | `apps/shared/brand/appicon.png` を差し替えて `apps/shared/brand/gen_icons.sh` (§3)。DMG の背景は `gen_dmg_background.py` |
| iOS の Team ID | `apps/ios/project.yml` の `DEVELOPMENT_TEAM` (今は公式アプリの `3WF4YQB4L6`)。`xcodegen generate` で `ChikuwaChat.xcodeproj` を作り直す。`apps/ios/scripts/release-ios.sh` の `TEAM_ID` も |
| iOS のバンドル ID | `apps/ios/project.yml` の `bundleIdPrefix` と `PRODUCT_BUNDLE_IDENTIFIER` (`jp.chikuwachat.ios`、テストは `.tests`)。サーバーの `.env` の `PUSH_APNS_BUNDLE_ID`・`PUSH_APNS_TEAM_ID`・`PUSH_APNS_KEY_ID` も合わせる (APNs の topic) |
| Android | `apps/android/app/build.gradle.kts` の `applicationId` (`jp.chikuwachat.android`。`namespace` はコードのパッケージなので替えなくてよい)。FCM は自分の Firebase プロジェクトの `google-services.json` とサービスアカウント |
| デスクトップ | `apps/desktop/src-tauri/tauri.conf.json` の `identifier` (`jp.chikuwachat.desktop`)、`productName`。更新は `plugins.updater` の `endpoints` と `pubkey` を自分の鍵・リポジトリに替える (§6。`release-desktop.sh` の `TAYLIS_RELEASES_REPO`)。更新を使わないなら `npm run tauri:build` |
| 表示名 | 各アプリの表示名 (iOS の `CFBundleDisplayName`、Android の `app_name`、Tauri の `productName`、Web の `<title>`) と、サーバーの `.env` の `WORKSPACE_NAME` |

URL スキーム `chikuwachat://` や内部のパッケージ名は名前の表示ではないので、そのままでも動く (公式アプリと同じ端末に
入れるなら、URL スキームも替えると取り合いにならない)。
