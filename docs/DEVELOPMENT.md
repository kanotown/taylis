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

## 5. 気をつけること (これまでにはまったところ)

- データを後から埋める移行は、端末が持っている行にも届くよう `updated_seq` を進める (0049 の例)。
- SwiftUI で、中身が空になりうる `Group` や `if` に `.task` や `.sheet` を付けない (リンクのカード、後で送信のダイアログで起きた)。
- iOS の会話は上下を反転したリスト (ARCHITECTURE D23)。下に貼り付けるための補正のコードを足さない。
- 高さが後から変わる中身 (画像・リンクのカード・動画) は、最初から最終の高さを取る (スクロール位置のずれの原因だった)。カスタム絵文字も、画像が来るまで `:name:` ではなく同じ大きさの空白で場所を取る。
- iOS で会話を開くとき、手元の行は追いつき (§7.3) で変わりうる。追いつきと置き場所・着地が済むまで行を見せない (ChannelView の `veiled`、ReadGate.hidesOpeningRows)。
- iOS のスワイプで戻るとき、戻り先の画面はキーボードを無視して並べる (キーボードは去る画面と一緒に出ていく。KeyboardBehavior.swift)。
