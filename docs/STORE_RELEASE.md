# ストアへの配信 (TestFlight / App Store、Google Play)

iOS 版を TestFlight と App Store に、Android 版を Google Play に出すための手順。デスクトップ版は
DEVELOPMENT.md §6 (GitHub Releases とアプリ内の更新) のまま。

秘密 (API キーの `.p8`、キーストア、パスワード) はリポジトリに入れない。置き場所は
`~/.config/taylis/` (リポジトリの外) で、スクリプトと Gradle はそこか環境変数から読む。

| もの | 置き場所 | 中身 |
|---|---|---|
| `~/.config/taylis/release.env` | デスクトップ版のスクリプトと共用 | `ASC_KEY_ID=…` / `ASC_ISSUER_ID=…` / `ASC_KEY_PATH=~/.config/taylis/AuthKey_XXXXXXXXXX.p8` |
| `~/.config/taylis/AuthKey_<ID>.p8` | App Store Connect API キー | 一度しかダウンロードできない。バックアップしておく |
| `~/.config/taylis/android-release.properties` | Android のアップロード鍵の設定 | `storeFile` / `storePassword` / `keyAlias` / `keyPassword` |
| `~/.config/taylis/taylis-upload.jks` | Android のアップロード鍵 (キーストア) | 失くしたら Play Console でアップロード鍵の再設定を申請する (Play App Signing なので配信は続けられる) |

## 1. 版の番号

| | 見える版 | ビルド番号 |
|---|---|---|
| iOS | `CFBundleShortVersionString` (X.Y.Z、最初のストア版は **1.0.0**) | `CFBundleVersion` (整数。アップロードのたびに 1 つ上げる。今は 91 から) |
| Android | `versionName` (X.Y.Z、**1.0.0**) | `versionCode` (整数。Play へのアップロードのたびに 1 つ上げる。1 から) |

- iOS はどちらも `apps/ios/ChikuwaChat/Info.plist` と `apps/ios/project.yml` の 2 か所を同じにする
  (DEVELOPMENT.md §4)。スクリプトが食い違いを止める。
- Android は `apps/android/app/build.gradle.kts` の `defaultConfig`。
- スクリプトは番号を上げない。上げてコミットしてから走らせる (どのビルドがどのコミットかをリポジトリで追えるように)。
  App Store Connect は同じ版の同じビルド番号を、Play はどのトラックでも一度使った `versionCode` を受け付けない。
- 見える版は機能が変わったら上げる (1.0.0 → 1.1.0、直しだけなら 1.0.1)。サーバのタグ `v0.1.x` とは別の番号。

## 2. iOS: 最初に一度だけ

1. **App Store Connect にアプリを作る**: マイ App →「＋」→ 新規 App。プラットフォーム iOS、名前「Taylis」
   (取られていたら別名)、言語 日本語、バンドル ID `jp.chikuwachat.ios` (Developer サイトの Identifiers に無ければ
   Xcode の自動署名が一度ビルドすると作られる)、SKU は任意 (例 `taylis-ios`)。
2. **API キーを作る**: ユーザとアクセス → 統合 → App Store Connect API →「チームキー」で「＋」、役割は
   **App Manager** (証明書とプロファイルの作成、アップロードに要る)。キー ID と発行者 ID を控え、
   `AuthKey_<キーID>.p8` を `~/.config/taylis/` に置いて `chmod 600`。`release.env` に 3 行を足す:
   ```
   ASC_KEY_ID=XXXXXXXXXX
   ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ASC_KEY_PATH=~/.config/taylis/AuthKey_XXXXXXXXXX.p8
   ```
3. **配布用の証明書**: 自動署名に任せる。スクリプトは `-allowProvisioningUpdates` と API キーを xcodebuild に渡すので、
   Apple Distribution の証明書 (クラウド管理) と App Store 用のプロファイルは書き出しのときに作られる / 取ってくる。
   うまくいかないときは Xcode → Settings → Accounts → チーム →「Manage Certificates…」→「＋」→ Apple Distribution
   で手で作る (この Mac には今 Apple Development と Developer ID しかない)。
4. **プッシュ**: APNs は `.p8` (token 認証) なので証明書は要らない。サーバの APNs キーはそのまま
   sandbox と production の両方に使える (PUSH_NOTIFICATIONS.md)。App ID に Push Notifications の機能が
   付いていること (自動署名で付く)。
5. **App のプライバシー** (App Store Connect の「App のプライバシー」): アプリの `PrivacyInfo.xcprivacy` と同じに答える。
   データはサインインしたワークスペースのサーバ (運用者のサーバ) にだけ送り、開発者や第三者には送らない。
   トラッキングなし。収集するデータ (ユーザに紐付く、目的は「App の機能」): 名前、メールアドレス、ユーザ ID、
   メール / テキストメッセージ (チャットの本文)、写真 / ビデオ (添付)、その他のユーザコンテンツ (ファイル・キャンバス・予定など)。
   クラッシュや利用状況の解析は無し。必要な理由のある API は UserDefaults (CA92.1) だけ。新しく使うとき
   (ファイルの日時、起動からの時間、空き容量、キーボード) は `PrivacyInfo.xcprivacy` に足す。
6. **TestFlight のグループ**: 内部テスト (App Store Connect のユーザ、審査なし) と外部テスト (メールか公開リンク、
   最初のビルドだけベータ版の審査がある) を作る。研究室のメンバーは外部テストのグループに招く。
7. **審査の準備** (App Store に出すとき): 審査用のサーバ URL とアカウント (管理者が作った普通のユーザ) を
   「App Review に関する情報」に書く。審査はふつう公開のサーバに接続して確かめるので、本番か審査用のワークスペースを用意する。
   投稿を報告・ブロックする仕組み (ガイドライン 1.2、ユーザ生成コンテンツ) を求められる。`NSAllowsArbitraryLoads`
   (LAN の http のサーバのため) は理由を聞かれることがある (「自前のサーバを利用者が指定する。LAN では TLS が無いことがある」)。
   暗号の輸出規制の質問は `ITSAppUsesNonExemptEncryption = false` で出ない。

## 3. iOS: リリースのたびに

```sh
# 1. ビルド番号を上げる (Info.plist と project.yml の CFBundleVersion、見える版を変えるなら CFBundleShortVersionString も) → コミット
# 2. 中身の確認 (何もしない)
apps/ios/scripts/release-ios.sh --dry-run
# 3. アーカイブ → 署名 → App Store Connect へアップロード
apps/ios/scripts/release-ios.sh
#    (.ipa を手元に作るだけなら --export-only。Transporter でアップロードできる)
```

- アーカイブは `~/Library/Caches/taylis-release/ios/<版>-<ビルド>/` (`TAYLIS_IOS_BUILD_DIR` で変えられる)。
- アップロードの後、App Store Connect の処理に数分〜数十分。TestFlight のビルドに出たら、テストの内容を書いてグループに付ける。
- App Store に出すときは §3.1 のスクリプトで掲載情報・スクリーンショット・ビルドを入れ、App のプライバシーなど残りを手で埋めて審査に出す。

### 3.1 App Store の掲載情報を入れる (`asc-metadata.py`)

App Store Connect の版のページ (説明・キーワード・スクリーンショット・審査の情報など) は、`docs/store/appstore.json`
から App Store Connect API で入れる。手で貼らない。

```sh
# 何が変わるかを見るだけ (GET だけ。何も書き込まない)
uv run --with pyjwt --with cryptography --with httpx python apps/ios/scripts/asc-metadata.py --dry-run
# 書き込む
uv run --with pyjwt --with cryptography --with httpx python apps/ios/scripts/asc-metadata.py
#   (server/.venv/bin/python でも動く。pyjwt・cryptography・httpx が入っている)
```

- 入れるもの: 版 (編集できる版を探し、無ければ作る。版の文字列は JSON の `version` = ビルドの
  `CFBundleShortVersionString` に合わせる)、著作権、リリース方法 (手動)、ビルド (その版の VALID で期限切れでない
  一番大きいビルド番号。`--build N` で指定、`--no-build` で触らない)、ja / en-US の説明・キーワード・プロモーション
  テキスト・サポート URL・マーケティング URL (新機能は最初の版なので入れない)、名前 (JSON が null ならそのまま)・
  サブタイトル・プライバシーポリシー URL、カテゴリ (ビジネス / 仕事効率化)、年齢区分の質問の回答、App Review の情報、
  スクリーンショット (iPhone 6.9 インチ = `APP_IPHONE_67`、1320 × 2868。ファイルの一覧と順番は JSON の
  `screenshots.files`、置き場所は `screenshots.dir`)。
- 何度走らせてもよい: 今の値と比べて違うところだけ書く。スクリーンショットは MD5 で比べ、同じものは残し、一覧に無いものは
  消し、足りないものを上げて、JSON の順に並べる。途中で失敗しても直してもう一度走らせればよい。
- 一部だけ: `--only screenshots` / `--skip age,review` (手順: version, build, texts, appinfo, categories, age, review,
  screenshots)。
- 秘密はリポジトリに入れない。API キーは `release.env` (上の表)。審査の連絡先と審査用アカウントは
  `~/.config/taylis/asc-review.env` (`chmod 600`。環境変数が優先):
  ```
  ASC_REVIEW_FIRST=Toru
  ASC_REVIEW_LAST=Kano
  ASC_REVIEW_EMAIL=…
  ASC_REVIEW_PHONE=+81…
  ASC_REVIEW_DEMO_USER=…
  ASC_REVIEW_DEMO_PASSWORD=…
  ASC_REVIEW_SERVER_URL=https://…   # 審査メモの {server_url}
  ```
  欠けている値はその欄を書かずに警告する (サーバ URL が無いと審査メモ全体を書かない)。
- 文面を直すときは `docs/store/LISTING_*.md` などの md (人が読む版) と `appstore.json` の両方を直す。
- API で入れられないもの (最後に表示される): **App のプライバシー** (栄養ラベル。`docs/store/PRIVACY_AND_RATINGS.md` §1
  のとおりに手で答える)、価格と配信地域 (無料)、コンテンツの権利の質問、年齢区分の結果の確認、「審査に追加」→ 提出。

### APNs の production について

TestFlight と App Store のビルドは **production** の APNs を使う (配布用のプロファイルで `aps-environment` が
production になる)。アプリは起動のたびに `push_environment` をサーバに送り (`PUT /devices/current`)、
`APNsPushProvider` は端末ごとにその値で sandbox / production のホストを選ぶ。

アプリの判定 (`PushEnvironment`、PushCenter.swift): アプリの中の `embedded.mobileprovision` の `aps-environment`
を読む。Xcode から入れたビルドは (Release 構成でも) 開発用のプロファイルなので sandbox、Ad Hoc は production、
App Store / TestFlight のビルドにはプロファイルが入っていないので production。`#if DEBUG` には頼らない
(Release を Xcode から開発用のプロファイルで入れると sandbox が正しい)。同じ iPhone で Xcode のビルドと TestFlight の
ビルドを入れ替えるとトークンも変わるが、起動時の登録で新しい値と環境に上書きされる。

## 4. Android: 最初に一度だけ

1. **Play Console にアプリを作る**: すべてのアプリ → アプリを作成。名前「Taylis」、既定の言語 日本語、アプリ、無料。
   パッケージ名は最初のアップロードで `jp.chikuwachat.android` に決まる (後から変えられない)。
2. **アップロード鍵を作る** (この鍵は Play へのアップロードにだけ使う。配信の署名は Play App Signing で Google が持つ):
   ```sh
   mkdir -p ~/.config/taylis && chmod 700 ~/.config/taylis
   keytool -genkeypair -v -keystore ~/.config/taylis/taylis-upload.jks -alias upload \
     -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Taylis, O=<研究室名>, C=JP"
   chmod 600 ~/.config/taylis/taylis-upload.jks
   ```
   パスワードを聞かれる (ストアと鍵を同じにしてよい)。`~/.config/taylis/android-release.properties` を作る
   (`chmod 600`):
   ```
   storeFile=~/.config/taylis/taylis-upload.jks
   storePassword=<パスワード>
   keyAlias=upload
   keyPassword=<パスワード>
   ```
   ファイルの代わりに環境変数 `TAYLIS_ANDROID_STORE_FILE` / `TAYLIS_ANDROID_STORE_PASSWORD` /
   `TAYLIS_ANDROID_KEY_ALIAS` / `TAYLIS_ANDROID_KEY_PASSWORD` でもよい (環境変数が優先。設定ファイルの場所は
   `TAYLIS_ANDROID_SIGNING` で変えられる)。どれかが欠けると release のビルドは署名なしになり、Gradle が警告を出す。
   debug のビルドには要らない。キーストアとパスワードはパスワードマネージャなどにバックアップする。
3. **Play App Signing**: 最初のリリースを作るときに「Google が生成した鍵を使う」(既定) を選ぶ。上の鍵はアップロード鍵になる。
4. **Firebase**: `apps/android/app/google-services.json` (git に入れない) が無いとプッシュの無いビルドになるので、
   スクリプトは止まる。FCM はリリースの署名に関係なく動く (Play App Signing の SHA は Google サインインなどを
   足すときだけ Firebase に登録する)。
5. **ストアの掲載情報とポリシー**: プライバシーポリシーの URL、データ セーフティ (iOS の §2.5 と同じ内容: 送信先は
   運用者のサーバ、第三者と共有しない、転送は暗号化 (TLS の本番)、アカウントの削除は管理者に依頼)、コンテンツのレーティング、
   対象年齢、広告なし。審査用のアカウント (「アプリのアクセス権」) にサーバ URL とユーザを書く。
6. **targetSdk**: `targetSdk = 37`。Play の要件 (新規・更新とも、毎年 8 月末に 1 つ上がる。2025 年は API 35) より上なので当分そのままでよい。

## 5. Android: リリースのたびに

```sh
# 1. versionCode を 1 つ上げる (見える版を変えるなら versionName も) → コミット
# 2. 中身の確認 (何もしない)
apps/android/scripts/release-android.sh --dry-run
# 3. 単体テスト + lint (release) + 署名つきの AAB
apps/android/scripts/release-android.sh
```

- AAB は `~/Library/Caches/taylis-release/android/taylis-<versionName>-<versionCode>.aab`
  (`TAYLIS_ANDROID_BUILD_DIR` で変えられる)。スクリプトは署名を `jarsigner` で確かめる。
- Play Console へは手でアップロードする (Play Developer API での自動アップロードは作っていない)。
  トラックは **内部テスト** (100 人まで、審査はほぼ即時) → **クローズド テスト** (招いたメンバー。新しい個人の
  デベロッパー アカウントは製品版の前にクローズド テストで 12 人・14 日が要る) → **製品版** (段階的な公開を使える)。
  同じ AAB を上のトラックに「昇格」できる。
- R8 (縮小・難読化) は使っていない (`isMinifyEnabled = false`)。縮小したビルドを一度も試していないため
  (kotlinx.serialization・Room・OkHttp・Firebase はそれぞれ keep の規則を持つが、漏れは実行時にしか分からない)。
  入れるときはエミュレータで全画面を通してから。AAB が数 MB 大きいだけで、困ることは無い。
