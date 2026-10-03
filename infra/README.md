# infra

デプロイと開発環境。

| ファイル | 内容 |
| --- | --- |
| `docker-compose.yml` | `db` (groonga/pgroonga: PostgreSQL 17)、`objectstore` (versitygw)、`app` (uvicorn 単一プロセス)、`caddy` (`proxy` プロファイル) |
| `docker-compose.prod.yml` | 本番用の上書き (ホストへのポート公開を打ち消す) |
| `Dockerfile` | server のイメージ (uv ベース) |
| `web.Dockerfile` | Caddy + ブラウザクライアント (apps/desktop を `vite build` して `/srv/web` に置く。M12j) |
| `Caddyfile` | TLS 終端、`/api/*` を app へ、本文サイズ制限、それ以外は SPA (index.html) |
| `.env.example` | 必要な環境変数の一覧 (SECRET_KEY、DATABASE_URL、S3_*、PUSH_*)。秘密の実値は置かない |

## 使い方

```
cp .env.example .env            # 値を埋める (SECRET_KEY, POSTGRES_PASSWORD, S3_SECRET_KEY)
docker compose up -d db objectstore          # 開発: DB とオブジェクトストレージだけ起動し、app はローカルで動かす
docker compose up -d --build app             # app もコンテナで動かす (起動時に alembic upgrade head)
curl http://127.0.0.1:8000/readyz            # {"status":"ok","checks":{"db":"ok","objectstore":"ok"}}

# 本番相当: ポートを公開せず Caddy だけを外に出す
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile proxy up -d --build
```

`docker-compose.yml` は開発向けに PostgreSQL と app を localhost に公開する。`docker-compose.prod.yml` で
それを打ち消し、`proxy` プロファイルの Caddy が TLS 終端と `/api/*` の中継を行う。

ブラウザクライアント (M12j): `caddy` サービスのイメージは `web.Dockerfile` でリポジトリ全体をコンテキストに
ビルドし (`.dockerignore` で apps/desktop と Caddyfile だけを送る)、Desktop と同じ React バンドルを
`https://<CHAT_DOMAIN>/` で配信する。`/m/<id>` や `/invite/<token>` もこの SPA が受ける。フロントを変えたら
`docker compose ... --profile proxy up -d --build caddy`。開発中は `apps/desktop` で `npm run dev` すると
Vite が `/api` を `http://127.0.0.1:8000` (環境変数 `CHIKUWA_API` で変更可) に中継するので、
http://localhost:1420/ をブラウザで開けば同じ cookie セッションで動く。

## オブジェクトストレージ (versitygw)

MinIO のコミュニティ版が終了したため (2026-04 にリポジトリ archive、公式イメージ削除)、S3 互換ストアには
[versitygw](https://github.com/versity/versitygw) (Apache-2.0) の posix バックエンドを使う。
S3 API を通常のディレクトリの上に載せるだけで、バケットはディレクトリ、オブジェクトはファイル
(`/data/<bucket>/<key>`) になる。

compose での構成 (M1 で作成。2026-09-26 に v1.8.0 で S3 API の動作を確認済み):

```yaml
objectstore:
  image: versity/versitygw:v1.8.0
  command: ["posix", "/data"]
  environment:
    ROOT_ACCESS_KEY_ID: ${S3_ACCESS_KEY}
    ROOT_SECRET_ACCESS_KEY: ${S3_SECRET_KEY}
    VGW_REGION: us-east-1
  volumes:
    - objectstore-data:/data
  # ポートは公開しない。app からは http://objectstore:7070 (path-style)
```

app 側の設定: `S3_ENDPOINT=http://objectstore:7070`、`S3_BUCKET=chikuwa`、`S3_ACCESS_KEY`、`S3_SECRET_KEY`、
`S3_REGION=us-east-1`、path-style アドレッシング。バケットはアプリ起動時に `BlobStore.ensure_bucket()` で
作る (CreateBucket は既存バケットに対して `409 BucketAlreadyExists` を返すので、これを成功扱いにする)。

注意点:

- posix バックエンドはオブジェクトのメタデータ (ETag、Content-Type) を拡張属性 (xattr) に保存する。
  Docker の named volume (VM 内の ext4) は xattr に対応している。macOS のバインドマウントは非対応の
  場合があるので、開発でも named volume を使う。本番の Linux (ext4 / xfs) は問題ない。
- アプリはメタデータを PostgreSQL に持ち、ストレージ側の xattr に依存しない。xattr が失われても
  ダウンロードは動く。
- WebUI (`--webui`) と admin API (`--admin-port`) は使わない。
- データディレクトリ直下の `.vgwlocks/` とバケット内の `.sgwtmp/` は versitygw の内部作業用ディレクトリ。バックアップに含めても害はないが、復元後に空でよい。

## 方針

- 本番では PostgreSQL / versitygw のポートをホストに公開しない。開発では `localhost` に限定して公開する。
- 状態は PostgreSQL と versitygw のデータディレクトリの 2 か所だけ。バックアップは `pg_dump` と
  ディレクトリのファイルコピー (`restic` または `rsync -aX`)。復元手順と復元リハーサルは M10 で追加する
  ([docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) §8)。
- 単一プロセス構成の理由と拡張経路は同 §7 / §10。

## APNs の準備 (M5 までに)

1. **App ID の登録**: Apple Developer → Account → Certificates, Identifiers & Profiles → Identifiers → 「+」→
   App IDs → App。Bundle ID は Explicit (例: `jp.example.chikuwachat`) にし、Capabilities で
   Push Notifications にチェックして Register。
2. **認証キーの発行**: 同じ画面の Keys → 「+」→ Key Name を入力 → Apple Push Notifications service (APNs) に
   チェック → Configure は既定 (Environment: Sandbox & Production、Key Restriction: Team Scoped) のまま →
   Continue → Register → Download。
   - `.p8` は **一度しかダウンロードできない** (Apple 側に保存されない)。失くしたら Revoke して作り直す。
   - Key ID (10 桁) を控える。キーはチームで 2 本まで。有効期限は無いが Revoke できる。
   - 1 本のキーで同じチームの全アプリ、sandbox / production の両方に使える。
3. **Team ID**: Account → Membership details に表示される 10 桁の英数字。
4. **保管**: `infra/secrets/AuthKey_<KEYID>.p8` に置く (`.gitignore` の `*.p8` で除外済み。コミット禁止)。
   compose で `/run/secrets/apns_key.p8` にマウントし、`.env` に次を設定する。

   ```
   PUSH_APNS_ENABLED=true
   PUSH_APNS_KEY_PATH=/run/secrets/apns_key.p8
   PUSH_APNS_KEY_ID=<Key ID>
   PUSH_APNS_TEAM_ID=<Team ID>
   PUSH_APNS_BUNDLE_ID=<Bundle ID>
   ```

5. **Xcode 側**: プロジェクトの Signing & Capabilities で Team を選び、「+ Capability」→ Push Notifications を
   追加する (`aps-environment` エンティトルメントが付く)。Xcode から実機にインストールするビルドは
   `aps-environment = development` になるので、端末登録は `push_environment = "sandbox"` で行う。
   実機は Xcode の自動署名で接続時にチームへ登録される。
6. **鍵の疎通確認 (任意、アプリが無くてもできる)**: ダミーのデバイストークンで sandbox に送り、
   `400 BadDeviceToken` が返れば鍵・Key ID・Team ID は正しい。`403 InvalidProviderToken` なら設定ミス。

### FCM (Android) の準備 (M7)

Android のプッシュは Firebase Cloud Messaging を使う (CLAUDE.md)。サーバは FCM HTTP v1 API をサービスアカウントで叩き、
アプリは Firebase SDK でトークンを取得する。どちらも Firebase プロジェクトが必要。

1. **Firebase プロジェクト**: https://console.firebase.google.com で「プロジェクトを追加」(Google アナリティクスは不要)。
2. **Android アプリの登録**: プロジェクトの概要 → Android アイコン → パッケージ名 `jp.chikuwachat.android` を入力 → 登録 →
   `google-services.json` をダウンロードし `apps/android/app/google-services.json` に置く (`.gitignore` 済み)。
   このファイルがあるときだけ Gradle が Google services プラグインを適用する。無くてもビルドは通り、
   プッシュ登録がスキップされるだけ。
3. **サービスアカウント鍵**: プロジェクトの設定 → サービス アカウント → 「新しい秘密鍵の生成」→ JSON を
   `infra/secrets/fcm_service_account.json` に置く (権限 `600`。`*service-account*.json` と `infra/secrets/*` は除外済み)。
   Cloud Messaging API (V1) が有効になっていることを確認する (既定で有効)。
4. **`.env`**:

   ```
   FCM_SERVICE_ACCOUNT_FILE=./secrets/fcm_service_account.json
   PUSH_FCM_ENABLED=true
   PUSH_FCM_SERVICE_ACCOUNT_PATH=/run/secrets/fcm_service_account.json
   ```

   `compose up -d --build app` で反映。サーバは起動時に JSON から `project_id` / `client_email` / `private_key` を読み、
   JWT bearer grant で 1 時間有効のアクセストークンを取得して送信する (追加ライブラリは不要、PyJWT の RS256)。
5. **確認**: Play services 入りのエミュレータ (Pixel_9 など "Google Play" イメージ) か実機でログインすると、
   端末が `push_provider = fcm` で登録される (`GET /api/v1/auth/sessions` の device で確認)。
   `uv run python -m app.cli push-test --user <name> --body "hello"` でテスト通知を送る。
   無効なトークンは FCM の `UNREGISTERED` 応答で `push_token = NULL` になる。

   ```bash
   uv run --with 'pyjwt[crypto]' --with 'httpx[http2]' python - <<'EOF'
   import time, jwt, httpx
   KEY_PATH = "infra/secrets/AuthKey_XXXXXXXXXX.p8"; KEY_ID = "XXXXXXXXXX"; TEAM_ID = "YYYYYYYYYY"; BUNDLE_ID = "jp.example.chikuwachat"
   token = jwt.encode({"iss": TEAM_ID, "iat": int(time.time())}, open(KEY_PATH).read(), algorithm="ES256", headers={"kid": KEY_ID})
   with httpx.Client(http2=True, timeout=20) as c:
       r = c.post("https://api.sandbox.push.apple.com/3/device/" + "00" * 32,
                  headers={"authorization": f"bearer {token}", "apns-topic": BUNDLE_ID, "apns-push-type": "alert"},
                  json={"aps": {"alert": "test"}})
   print(r.status_code, r.text)
   EOF
   ```

## デプロイ手順 (M10)

手動で出す手順。GitHub のタグから自動で出すなら次の「自動デプロイ」を使う (最初の準備だけこの章と共通)。

前提: Linux サーバ 1 台 (2 vCPU / 4 GB 以上)、Docker Engine + compose plugin、DNS が `CHAT_DOMAIN` を向いている、
80 / 443 が開いている。すべてのデータは PostgreSQL のボリュームと versitygw のボリュームにある。

1. **取得と設定**

   ```sh
   git clone <repo> /srv/chikuwachat && cd /srv/chikuwachat/infra
   cp .env.example .env && chmod 600 .env
   # SECRET_KEY (32 文字以上)、POSTGRES_PASSWORD、S3_SECRET_KEY、CHAT_DOMAIN、必要なら PUSH_* を埋める
   mkdir -p secrets && chmod 700 secrets     # APNs の .p8 / FCM のサービスアカウントを置く
   ```

2. **起動** (ポートは Caddy だけ。DB / app / versitygw はホストに出さない)

   ```sh
   docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile proxy up -d --build
   docker compose -f docker-compose.yml -f docker-compose.prod.yml exec app python -m app.cli create-admin --username admin
   ```

   起動時に `alembic upgrade head` が走り、`/readyz` が `db` / `schema` / `objectstore` / `outbox_pending` を返す。
   `curl https://<CHAT_DOMAIN>/healthz` で疎通を確認する。

3. **クライアント**: Desktop / iOS / Android のログイン画面で `https://<CHAT_DOMAIN>` を指定する。ブラウザは
   `https://<CHAT_DOMAIN>/` を開くだけでよい。ユーザーは `create-user` (仮パスワード)、管理者 API、
   または管理画面の招待リンク (M12h) で作る。

   1 つのデプロイが 1 つのワークスペースになる。ワークスペース名は `.env` の `WORKSPACE_NAME` (空なら
   ChikuwaChat) で、クライアントの切り替え一覧と検索欄に出る。チームを分けたいときは、この手順でもう 1 つ
   デプロイし、各クライアントの「ワークスペースを追加」から登録する (docs/WORKSPACES.md)。

4. **バックアップ** (毎日。`infra/backup.sh` は `pg_dump -Fc` の後にオブジェクトストアのファイルを写す)

   ```sh
   # crontab (root)
   30 3 * * * CHIKUWA_PROD=1 /srv/chikuwachat/infra/backup.sh /srv/backups >> /var/log/chikuwachat-backup.log 2>&1
   ```

   `/srv/backups/<UTC 時刻>/{db.dump,objects/,objects.sha256,SHA256SUMS}` ができる。世代は 14 個保持
   (デプロイ直前のバックアップも 1 世代に数える)。`objects/` は増分で、前回から変わっていないファイルは前回の
   バックアップへのハードリンクになる。添付が 7 GB あっても 14 世代で 7 GB と各日の増えた分で済む
   (以前の `objects.tgz` 形式は毎回全体を写していた。`restore.sh` はどちらの形式も戻せる)。バックアップの
   置き場所は 1 つのファイルシステムの中に置く。別のマシンや外部ストレージへは `rsync -aH` (ハードリンクを保つ) /
   `restic` で転送する。`.env` と `secrets/` は別経路で保管する (バックアップには含めない)。

5. **復元** (`infra/restore.sh <backup dir>`: DB → バケット → app 起動 → `verify-attachments`)

   ```sh
   CHIKUWA_PROD=1 ./restore.sh /srv/backups/20260926T033000Z
   ```

   対象プロジェクトの DB とオブジェクトを **置き換える**。復元後に `verify-attachments` が欠損 blob を報告する
   (DB にあってバイト列が無い添付。バックアップ順序の都合で 0 件のはず)。

6. **復元リハーサル** (`infra/restore-rehearsal.sh`): 稼働中のスタックからバックアップを取り、別の compose
   プロジェクト (`chikuwa-rehearsal`、ポート非公開) に復元して users / messages / attachments の件数を比較し、
   片付ける。四半期に一度は実行する。2026-09-26 に開発スタックで成功を確認。

7. **更新**

   ```sh
   git pull && docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile proxy up -d --build app
   ```

   マイグレーションは起動時に自動適用される。後方互換のない変更はリリースノートに書く。
   更新前にバックアップを取る。

8. **運用コマンド** (`docker compose ... exec app python -m app.cli ...`)

   | コマンド | 用途 |
   | --- | --- |
   | `create-admin` / `create-user` | アカウント作成 (仮パスワード表示は一度だけ) |
   | `push-test --user <name>` | プッシュ疎通 |
   | `verify-attachments` | 添付のバイト列欠損を報告 |
   | `probe-videos [--limit 1000]` | M79 より前 (または ffmpeg の無いサーバ) の動画の縦横・長さ・ポスターを埋める。1 本ずつ確定するので途中で止めても再開でき、何度流しても同じ。「more videos are left」と出たらもう一度流す。メッセージに付いた動画はそのメッセージを差分で端末に届け直す |
   | `anonymize-user --username <name>` | 退会: 氏名・メール・資格情報・端末を消し、履歴は「退会したユーザー」名義で残す |
   | `export-channel --channel <name|id> --out <file.jsonl>` | チャンネルの履歴を JSONL で書き出す (添付はメタデータのみ) |

   管理操作は `audit_logs` に記録される (誰が・いつ・何に・何を)。保持期間ジョブが失効セッション (30 日)、
   無効化された端末 (90 日)、処理済み outbox (7 日)、push_deliveries (7 日)、期限切れの未添付アップロード (24 時間)
   を削除する。

9. **ログ**: JSON 行 (`LOG_JSON=true`) を `docker compose logs app` か journald で集める。トークン・パスワード・
   本文は出さない。`DEBUG=true` は本番では無視される。

## 自動デプロイ (GitHub Actions → VPS)

`v1.2.3` の形のタグを push すると、本番の VPS まで自動で出る (`.github/workflows/release.yml`)。

```
git tag v1.2.3 → git push origin v1.2.3
  1. checks   サーバのテスト (lint / 型 / pytest / OpenAPI) と Web クライアント (型 / テスト / ビルド)
  2. images   サーバと Web (Caddy + ブラウザ版) のイメージを作り GHCR (非公開) に push
              ghcr.io/<owner>/chikuwachat-server:v1.2.3 / chikuwachat-web:v1.2.3
  3. deploy   VPS に SSH (強制コマンド chikuwa-deploy だけ実行できる鍵)
              upload: このリリースの infra ファイル (compose / Caddyfile / スクリプト) を置き換える
              deploy: infra/deploy.sh → バックアップ → イメージ取得 → 入れ替え → /readyz を確認
                      起動しなければ直前のリリースに戻して失敗で終わる
  (デスクトップ版のインストーラは Actions → desktop → Run workflow で必要なときだけ作る。未署名)
  deploy が成功したら、GHCR のイメージは新しい 3 リリース分だけ残す (Packages の無料枠)
```

- DB のマイグレーションはアプリの起動時に走る。その直前に `backup.sh` のバックアップを必ず取る
  (`deploy.conf` の `BACKUP_ROOT`)。
- 秘密情報 (`.env`、`secrets/`) は VPS にだけ置き、GitHub には置かない。GitHub に置くのは SSH の
  接続情報だけで、レジストリの認証にはそのワークフロー実行中だけ有効なトークンを使う
  (サーバの `~/.docker/config.json` にも残さない)。
- 切り替え中は数秒 API が止まる。クライアントは自動で再接続する。

### 初回だけの準備

上から順に行う。例ではホスト名を `chat.example.com`、GitHub のアカウントを `kanotown` とする。

**1. Xserver VPS**

- OS は **Debian** (12 または 13)。メモリは 2 GB 以上 (4 GB あると余裕がある。2 GB なら初期設定で
  スワップを足す)。申し込み時に SSH キーを登録しておくと root に鍵でログインできる。
- VPS パネルの **パケットフィルター** を ON にして、次を許可する:

  | 用途 | プロトコル / ポート |
  | --- | --- |
  | SSH (手元と GitHub Actions から) | TCP 22 |
  | Web (Caddy。証明書の取得にも使う) | TCP 80、TCP 443 |
  | HTTP/3 (無くても動く) | UDP 443 |

  GitHub Actions の接続元 IP は固定できないので、SSH は送信元を絞らない (鍵と強制コマンドで守る)。
- サーバーの IPv4 アドレスを VPS パネルで確認しておく。

**2. ドメイン (DNS)**

- ドメインの DNS を管理しているところ (Xserver ドメインや Xserver レンタルサーバーのネームサーバーなら
  その管理画面の「DNS レコード設定」、他社ならそちら) で **A レコード**を足す:
  ホスト名 `chat`、種別 A、内容 = VPS の IPv4 アドレス。IPv6 でも使うなら AAAA も。
- Cloudflare で管理している場合はプロキシをオフ (DNS only、灰色の雲) にする。Caddy が自分で証明書を取り、
  WebSocket と 100 MB のアップロードをそのまま通すため。
- 反映の確認: `dig +short chat.example.com` が VPS の IP を返す。TLS 証明書は最初のデプロイで Caddy が
  自動で取る (80 / 443 が開いていること)。

**3. VPS の初期設定 (`infra/vps-bootstrap.sh`)**

手元 (リポジトリ) でデプロイ用の鍵を作り、ファイルを送る:

```sh
ssh-keygen -t ed25519 -N "" -C chikuwa-deploy -f chikuwa-deploy
scp infra/vps-bootstrap.sh infra/deploy-ssh.sh infra/.env.example infra/deploy.conf.example \
    chikuwa-deploy.pub root@<VPS の IP>:/tmp/
```

VPS に root でログインして実行する (何度実行しても既存の `.env` と `deploy.conf` は上書きしない):

```sh
ssh root@<VPS の IP>
bash /tmp/vps-bootstrap.sh --domain chat.example.com --workspace-name "チーム名" \
    --registry ghcr.io/kanotown --deploy-key-file /tmp/chikuwa-deploy.pub
rm /tmp/vps-bootstrap.sh /tmp/deploy-ssh.sh /tmp/.env.example /tmp/deploy.conf.example /tmp/chikuwa-deploy.pub
```

スクリプトが行うこと:

- Docker Engine と compose plugin (Docker 公式の Debian リポジトリ)、cron、メモリが少なければ 2 GB のスワップ
- `deploy` ユーザー (パスワードなし、docker グループ)、`/srv/chikuwachat/infra` と `/srv/backups`
- 強制コマンド `/usr/local/bin/chikuwa-deploy` (root の持ち物) と、デプロイ鍵の `authorized_keys` への登録
  (`command="/usr/local/bin/chikuwa-deploy",restrict`: その 2 コマンド以外とポート転送などをすべて禁止)
- `infra/.env` を作り、`SECRET_KEY`・`POSTGRES_PASSWORD`・`S3_SECRET_KEY` を新しいランダム値で埋める
  (この値はサーバーにしかない。`.env` はバックアップとは別に控えておく)、`CHAT_DOMAIN` と `WORKSPACE_NAME`
- `infra/deploy.conf` (`REGISTRY`、`BACKUP_ROOT=/srv/backups`)、毎日 3:30 のバックアップ (`/etc/cron.d/chikuwachat-backup`)

最後に GitHub に入れる値 (ホスト鍵の行と指紋) を表示する。APNs / FCM を使うなら、鍵を
`/srv/chikuwachat/infra/secrets/` に置いて `.env` の `PUSH_*` を埋める (上の「APNs の準備」「FCM の準備」)。
root のパスワードログインは、鍵でログインできることを確かめてから止めるとよい。

**4. GitHub**

1. Settings → Environments → `production` を作り、Deployment branches and tags で **タグ `v*` だけ**を許可する。
2. この environment の Secrets (初期設定スクリプトの最後の表示を使う):

   | 名前 | 値 |
   | --- | --- |
   | `DEPLOY_HOST` | `chat.example.com` (DNS が反映する前なら IP) |
   | `DEPLOY_USER` | `deploy` |
   | `DEPLOY_PORT` | SSH のポートを変えた場合だけ (既定 22) |
   | `DEPLOY_KNOWN_HOSTS` | 表示された `chat.example.com ssh-ed25519 AAAA…` の行 (DEPLOY_HOST を IP にしたなら IP の行) |
   | `DEPLOY_SSH_KEY` | 手元の `chikuwa-deploy` (秘密鍵) の全文 |

   秘密鍵は `gh secret set DEPLOY_SSH_KEY --env production --repo kanotown/chikuwachat < chikuwa-deploy` でも入る。
   入れたら手元の `chikuwa-deploy` は消してよい (再発行は鍵を作り直して `authorized_keys` を差し替える)。
3. VPS が ARM の場合だけ、Variables に `DEPLOY_PLATFORMS=linux/arm64` を入れる (既定は linux/amd64)。
4. Actions の無料枠 (非公開リポジトリは月 2,000 分、macOS は 10 倍・Windows は 2 倍で数える) を節約するため、
   iOS のテスト (`ios.yml`) とデスクトップのインストーラ (`desktop.yml`) は手動実行だけにしている
   (Actions → Run workflow。以前は iOS のテストだけで月の 7 割を使っていた)。iOS のテストはコミット前に Mac で
   実行する。Billing の Budgets で Actions / Packages を $0・Stop usage にしておくと、枠を超えても課金されず止まる。
5. Linux のジョブ (ci の server / desktop / android、release の images / deploy) は自前の VPS の self-hosted
   runner (`runs-on: [self-hosted, Linux, X64]`) で動き、Actions の分を使わない。runner は専用ユーザー
   `gh-runner` (docker グループ) で `svc.sh` により常駐 (Settings → Actions → Runners → New self-hosted runner の
   手順)。この非公開リポジトリ専用にする。デプロイ鍵はジョブの一時フォルダ (`RUNNER_TEMP`) にだけ置き、ジョブの
   終わりに消す。テスト用 PostgreSQL はホストの空きポートを使う (runner の VPS 自身の 5432 とぶつからない)。
   runner が止まっているとジョブは待ち続ける。戻すときは `runs-on: ubuntu-latest` に戻す。

**5. 最初のリリース**

`git tag v0.1.0 && git push origin v0.1.0`。DB・オブジェクトストア・アプリ・Caddy がすべて起動し、Caddy が
TLS 証明書を取る。`https://chat.example.com/` が開いたら、VPS で最初の管理者を作る:

```sh
sudo -iu deploy   # root から deploy ユーザーへ (Debian で sudo が無ければ su - deploy)
cd /srv/chikuwachat/infra && set -a && . ./deploy.conf && set +a
CHIKUWA_SERVER_IMAGE=$REGISTRY/chikuwachat-server:$(cat .release) CHIKUWA_WEB_IMAGE=$REGISTRY/chikuwachat-web:$(cat .release) \
  docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.release.yml --profile proxy \
  exec app python -m app.cli create-admin --username admin
```

### 既存の nginx の後ろで動かす (共用サーバー)

他のサイトの nginx がすでに 80 / 443 と証明書 (certbot) を持っているサーバーでは、Caddy に 80 / 443 を
渡さず、nginx の後ろで動かす (ARCHITECTURE.md D22)。

```
利用者 ──https──▶ nginx (TLS、certbot の証明書) ──http──▶ 127.0.0.1:18080 Caddy ──▶ app
                                                              (Web クライアント、本文サイズ、CSP)
```

- 初期設定に `--behind-proxy` を付ける。`deploy.conf` に `EXTRA_COMPOSE_FILES=docker-compose.behind-proxy.yml`
  が入り、Caddy は `127.0.0.1:18080` (`.env` の `BEHIND_PROXY_PORT` で変更可) の HTTP だけを受ける。Docker が
  すでにあれば入れ直さず、パッケージは足りないものだけを入れる。上の 1. のパケットフィルターは既存のサイトの
  設定のままでよい。
- nginx のサイトは `infra/nginx-site.conf.example` から作る (ドメインを置き換える)。証明書は certbot で取る:

  ```sh
  cp nginx-site.conf.example /etc/nginx/sites-available/chikuwachat   # chat.example.com を置き換える
  ln -s /etc/nginx/sites-available/chikuwachat /etc/nginx/sites-enabled/
  nginx -t && systemctl reload nginx
  certbot --nginx -d chat.example.com --redirect
  ```

  nginx は `X-Forwarded-For` を接続元のアドレスで置き換え、`X-Forwarded-Proto` を渡す。Caddy はこの構成でだけ
  プライベートアドレス (nginx) からの転送ヘッダを信用する (SECURITY.md §6)。WebSocket のため `Upgrade` を通し、
  読み取りのタイムアウトを 1 時間にしている。
- 手で compose を動かすときも `-f docker-compose.behind-proxy.yml` を付ける (付けずに Caddy を起動すると
  80 / 443 を取りに行き、nginx とぶつかって起動しない)。

### リリースと戻し方

- **出す**: `git tag v1.2.3 && git push origin v1.2.3`。Actions の release で経過が見える。
- **失敗した**: `deploy.sh` が直前のリリースに戻してワークフローを失敗にする。アプリのログの末尾が
  ワークフローのログに出る。直前のリリースに戻せるのは同じ DB で動く場合。新しいリリースのマイグレーションが
  適用済みで古いコードが動かないときは、デプロイ直前のバックアップを戻す
  (`CHIKUWA_PROD=1 ./restore.sh /srv/backups/<時刻>`。復元は `.release` のリリースで起動する)。
- **前のリリースに戻したい**: Actions → release → Run workflow の「Use workflow from」で Tags から戻したいタグ
  (例 `v1.2.2`) を選んで実行する。テストとイメージ作成は省き、デプロイだけを行う (`production` はタグ `v*`
  からしか動かないので、ブランチのまま実行すると拒否される)。
- 状態: `/srv/chikuwachat/infra/.release` (今のリリース)、`.release.previous`、`releases/<tag>/`
  (各リリースの infra ファイル)。イメージは今と直前の 2 つだけを残す。

**手元で確かめた内容 (2026-09-27)**: ローカルのレジストリと別プロジェクトの compose で、強制コマンド経由の
upload / deploy、初回起動、更新 (バックアップあり)、起動しないリリースの自動ロールバック、
復元 (`restore.sh`) が通ることを確認した。GitHub Actions 上での実行は、リポジトリを push した後の最初のタグで確かめる。

## Mattermost からの移行 (M18)

Mattermost のチーム 1 つを、会話ごとこのサーバへ読み込む。2 段に分かれる。

1. `mattermost-extract`: Mattermost の PostgreSQL から、そのチームの分だけを JSONL ファイルに書き出す。読み取り専用の
   トランザクションで SELECT だけを行い、Mattermost には何も書かない。
2. `import-mattermost`: その JSONL を ChikuwaChat に読み込む。添付ファイルとカスタム絵文字の画像は、Mattermost の
   データディレクトリ (読み取り専用でマウント) から直接読む。

**読み込むもの**: チームの公開 / 非公開チャンネル (アーカイブ済みはアーカイブのまま)、そのメンバー、投稿 (作成順に
チャンネルの seq を振る)、スレッド、リアクション、ピン留め、編集の時刻、添付ファイル (画像はサムネイルも作る)、
投稿で使われているカスタム絵文字。本文の `@名前` はメンションに、`@channel` / `@all` / `@here` はチャンネル全体への
メンションに、標準の絵文字の `:shortcode:` は絵文字そのものに変わる (コードブロックの中は変えない)。

**読み込まないもの**: DM とグループ DM、他のチーム、削除済みの投稿、システムメッセージ (参加・退出など)、
編集の履歴、Webhook の表示名の上書き。

**人の対応付け** (先に当てはまったもの):

1. `--user mattermostの名前=chikuwaの名前` で指定したアカウント (指定先は既に存在すること)
2. 前回の移行で対応付けたアカウント
3. 同じメールアドレスのアカウント
4. それ以外で投稿かリアクションのある人は、新しく**無効化済み**のアカウントを作る (bot は bot アカウント)。
   投稿者を残すためで、管理者が有効化するまでログインできない。名前が使用中なら `名前-mm` にして警告を出す。
   投稿もリアクションもないメンバーやメンションされただけの人は作らない (メンションは `@名前` の文字のまま残る)。

チャンネルのメンバーは有効なアカウントに対応した人だけで、Mattermost のチャンネル管理者と作成者はオーナーになる。
チャンネル名は表示名から作る (空白は `-`、`# @ /` は除く)。同じ名前があれば `名前-mm` にして警告を出す。
読み込んだメッセージは全員が既読の状態で、参加者はスレッドをフォローする。プッシュ通知やメッセージのイベントは
出さない。新しいチャンネルは開いているクライアントにもすぐ現れ、履歴は開いた時に読み込まれる。

**やり直し**: 作った行はすべて `import_refs` に記録する。同じコマンドをもう一度実行すると、読み込み済みの行は
飛ばして、その後に増えた投稿だけを足す (途中で失敗しても、コミット済みのところから続く)。1 回目の後に
Mattermost 側で行われた編集・削除・リアクションは反映しない。本番では、`--dry-run` で確かめた後、Mattermost を
止める (または読み取り専用にする) 直前に 1 回実行するのがよい。

**前提**: この機能と増分バックアップを含むリリースをデプロイしてから行う (以前の `objects.tgz` 形式のままだと、
毎晩 7 GB を丸ごと写すことになる)。添付の分だけオブジェクトストアが増える (🍤 チームは約 7 GB)。

本番サーバー (root。Mattermost の設定とデータは root でしか読めない) での手順:

```sh
cd /srv/chikuwachat/infra
. ./deploy.conf
export CHIKUWA_SERVER_IMAGE="$REGISTRY/chikuwachat-server:$(cat .release)"
export CHIKUWA_WEB_IMAGE="$REGISTRY/chikuwachat-web:$(cat .release)"
install -d -m 700 /srv/chikuwachat/import

# 1. 書き出し (Mattermost は読むだけ。接続先は Mattermost の config.json の DataSource)
docker run --rm --network host --user root -e RUN_MIGRATIONS=false \
  -v /opt/mattermost/config/config.json:/mm/config.json:ro -v /srv/chikuwachat/import:/import \
  "$CHIKUWA_SERVER_IMAGE" \
  python -m app.cli mattermost-extract --mm-config /mm/config.json --team ebi --out /import/ebi.jsonl

# 2. 試し読み (--dry-run: すべて検査して何も書かない。人の対応付け・件数・警告が出る)
docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.release.yml \
  run --rm --no-deps --user root -e RUN_MIGRATIONS=false \
  -v /opt/mattermost/data:/mm-data:ro -v /srv/chikuwachat/import:/import:ro app \
  python -m app.cli import-mattermost /import/ebi.jsonl --files /mm-data --actor admin \
  --user alicemm=alice --user bobmm=ebi --user admin_mm=admin --dry-run

# 3. 本番: 2. から --dry-run を外して実行する

# 4. 終わったら書き出したファイルを消す (チームの全メッセージが入っている)
rm -rf /srv/chikuwachat/import
```

大きなカスタム絵文字 (512 px か 256 KB を超えるもの) は縮めて取り込む。動く GIF は動く GIF のまま 128 / 96 / 64 px に縮める
(以前の版は最初の 1 コマの PNG にしていた)。以前の版で取り込んだ絵文字を動くようにするには、同じコマンドに
`--refresh-emoji` を付けて実行する (取り込み済みの絵文字の画像を Mattermost から読み直す。投稿などは増えた分だけ足す)。
開いているアプリは再起動すると新しい画像になる。

`--actor` は実行する管理者 (監査ログと、作成者が分からない行の作成者になる)。結果には人の対応付け
(`@kanotown → @kano (--user)` など)、件数 (`posts`、`replies`、`files`、`files_missing` など)、警告 (見つからない
ファイル、名前の変更など) が出る。`files_over_upload_limit` はアップロードの上限を超えるが読み込んだファイルの数。

リアクションの絵文字は、カスタム絵文字 (移行したもの・既にあるもの) なら `:名前:`、標準の絵文字なら絵文字そのものに
なる。どちらでもない名前 (Mattermost で消されたカスタム絵文字、画像が見つからなかったものなど) は `:名前:` の
文字のまま入り、結果の「reactions without an emoji image」に回数つきで出る。クライアントは表示のたびに
カスタム絵文字の表を引くので、後から管理画面で同じ名前のカスタム絵文字を追加すれば、過去のリアクションと本文の
`:名前:` もその画像で表示される (移行の前に追加しておいてもよい)。カスタム絵文字にできる名前は a-z・0-9 で始まる
2〜32 文字 (a-z 0-9 _ + -) で、そうでない名前には「not a valid custom emoji name」と付く。31 文字以上など
リアクションとして保存できない名前は「reactions not imported」に出る。

## Slack からの移行 (M87)

Slack のワークスペースの書き出し (エクスポート ZIP) を、会話ごとこのサーバーへ読み込む。読み込み先はどの ChikuwaChat
サーバーでもよい (このサーバー専用の前提は無い)。Mattermost の移行と同じ仕組み (`import_refs`・やり直し・`--dry-run`) を使う。

**読み込むもの**: 公開チャンネル (アーカイブ済みはアーカイブのまま)、そのメンバー、メッセージ (`ts` の順にチャンネルの seq を
振る。時刻は `ts` そのもの)、スレッド (`thread_ts`)、「チャンネルにも送信」した返信 (`thread_broadcast`)、編集の時刻
(`edited.ts`)、リアクション (肌の色も)、ピン留め、添付ファイル (画像はサムネイル、動画は縦横・長さ・ポスターも作る)。
本文の mrkdwn は ChikuwaChat の書き方に変える: `<@U…>` はメンション、`<#C…|名前>` は `#チャンネル名` (読み込んだ
チャンネルは新しい名前)、`<!here>` / `<!channel>` / `<!everyone>` は全体メンション (読み込みでは通知しない)、
`<URL|文字>` はリンク、`*太字*` は `**太字**`、`~取り消し~` は `~~取り消し~~`、コードブロックは前後を独立した行に、
`>` / `>>>` の引用はそのまま、`&amp; &lt; &gt;` は元の文字、`:smile:` などの標準の絵文字は絵文字そのもの。本文が空の
bot の投稿は `attachments` / `blocks` の文字を本文にする。

**読み込まないもの**: 非公開チャンネル・DM・グループ DM (下の `--include-private` / `--include-dms` を付けた時だけ)、
参加・退出・トピックや説明や名前の変更の通知 (チャンネルのトピックと説明は channels.json から取る)、削除済みのメッセージ、
Slack の無料プランで見えなくなった古いファイル (`hidden_by_limit`)、編集の履歴。

**人の対応付け** (先に当てはまったもの):

1. `--user slackの名前=chikuwaの名前`。左は Slack のユーザー名・表示名・ユーザー id (`U…`) のどれでもよい (表示名に
   空白があれば `--user "Hanako S=hana"` のように引用符で囲む)。指定先は既に存在すること
2. 前回の移行で対応付けたアカウント
3. 同じメールアドレスのアカウント (users.json の `profile.email`。書き出しの種類によっては入っていない)
4. それ以外で投稿かリアクションのある人は、新しく**無効化済み**のアカウントを作る (bot は bot アカウント。
   users.json に無い bot も `bot_id` / 表示名ごとに 1 つ作る)。名前が使用中なら `名前-slack` にして警告を出す

**チャンネル名**: Slack のチャンネル名をそのまま使う。読み込み先に同じ名前があると、何も書かずに止まる (例: `#general`)。
その場合は `--channel-prefix slack-` のように前置きを付ける (新しく作るチャンネルがすべて `slack-general` などになる)。
2 回目以降は前回作ったチャンネルに足すので、前置きは同じでなくてもよい。

**添付ファイル**: Slack の書き出しにはファイルそのものは入っておらず、ダウンロード用の URL (`url_private_download`。
標準の書き出しには `?t=` のトークンが付いている) だけがある。

- `--download --files-cache DIR`: Slack から取ってくる。同時に 4 件まで (`--download-concurrency`)、失敗は 4 回まで
  やり直す (429 / 5xx・接続の失敗)。アップロードの上限 (`ATTACHMENT_MAX_BYTES`) を超えるものは取らない。取ったものは
  `DIR/<ファイル id>/<名前>` に残り、次の実行はそこから読む (途中で止めても続きから)。`--dry-run` でもダウンロードは行う
  (ChikuwaChat には何も書かない。本番の実行は同じキャッシュを使う)。
- `?t=` のトークンが効かない (HTTP 403 や「ログイン画面を返した」と出る) ときは、`files:read` を持つ Slack のトークン
  (Slack アプリのユーザートークン `xoxp-…` など) を 1 行のファイルに書いて `--slack-token-file` で渡す。トークンは
  Slack のファイルのホスト (`*.slack.com`・`*.slack-edge.com`・`*.slack-files.com`) に **HTTPS で**送るときだけ付ける。
  `http://` の URL は送る前に断り (結果に「HTTPS でない URL は取得しない」)、転送 (リダイレクト) は 1 回ずつ自分で
  たどって、転送先が `http://` なら断り、トークンを付けるかは転送先ごとに同じ規則で決める (5 回まで。Review v0.1.22 #4)。
  **コマンドラインに直接書かない** (シェルの履歴に残る)。
- `--files-dir DIR`: 別の道具で先にダウンロードしたものを読む (`<id>/<名前>`・`<id>-<名前>`・`<id>.<拡張子>`・`<id>`)。

中身はアップロードと同じく調べる (上限・空のファイル・中身から種類を判定・画素数が多すぎる画像は断る)。取れなかった
ファイルは結果の「files not brought over」に理由つきで出て、メッセージには「📎 名前 (Slack から取得できませんでした)」の
行が残る (移行は止まらない)。この行はやり直しでは直らないので、**本番の前に `--dry-run` で失敗が無いことを確かめる**。

**カスタム絵文字**: Slack の書き出しには入っていない。`--emoji-dir DIR` に `名前.png` (`.gif`・`.jpg`・`.webp`) を
置くと、使われている名前のカスタム絵文字を作る (大きなものは Mattermost の移行と同じく縮める)。無い名前は `:名前:` の
文字のまま入り、結果の「reactions without an emoji image」に出る (後から同じ名前のカスタム絵文字を足せば表示される)。

**書き出しを作る (Slack 側)**: ワークスペースの管理者 (またはオーナー) が、ブラウザで
`https://<ワークスペース>.slack.com/services/export` を開く (ワークスペース名 → 「ツールと設定」→「ワークスペースの設定」
→「データのインポート/エクスポート」→「エクスポート」と同じ)。期間 (「全期間」) を選んで「エクスポートを開始」し、
できたらメールと同じ画面に出るリンクから ZIP をダウンロードする。標準の書き出しは公開チャンネルだけ
(非公開チャンネルと DM が入るのは、有料プランで Slack に申請が通った場合だけ)。無料プランで見えなくなった古いメッセージ・
ファイルは書き出しに入らない。ZIP の中のファイルの URL は時間が経つと使えなくなることがあるので、書き出しは移行の直前に作る。

本番サーバー (root。書き出しには全メッセージが入っているので、root だけが読めるところに置く) での手順:

```sh
# 0. 手元の Mac から、書き出しの ZIP をサーバーへ送る
ssh root@<サーバー> install -d -m 700 /srv/chikuwachat/import
scp ~/Downloads/'<ワークスペース> Slack export <期間>.zip' root@<サーバー>:/srv/chikuwachat/import/slack-export.zip

# ここからサーバーで
cd /srv/chikuwachat/infra
. ./deploy.conf
export CHIKUWA_SERVER_IMAGE="$REGISTRY/chikuwachat-server:$(cat .release)"
export CHIKUWA_WEB_IMAGE="$REGISTRY/chikuwachat-web:$(cat .release)"
chmod 600 /srv/chikuwachat/import/slack-export.zip

# 1. 試し読み (--dry-run: ChikuwaChat には何も書かない。人の対応付け・チャンネルごとの件数・取れなかったファイルが出る。
#    ファイルは /srv/chikuwachat/import/files にダウンロードされ、本番の実行で使い回す)
docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.release.yml \
  run --rm --no-deps --user root -e RUN_MIGRATIONS=false \
  -v /srv/chikuwachat/import:/import app \
  python -m app.cli import-slack /import/slack-export.zip --actor admin \
  --channel-prefix slack- --user taro.yamada=yamada \
  --download --files-cache /import/files --dry-run

# 1'. (ファイルが 403 やログイン画面で取れないときだけ) トークンを 1 行で書いたファイルを作り、
#     1. に --slack-token-file /import/slack-token を足してもう一度
install -m 600 /dev/null /srv/chikuwachat/import/slack-token
nano /srv/chikuwachat/import/slack-token

# 2. 本番: 1. から --dry-run を外して実行する (同じコマンドの再実行は、増えたメッセージだけを足す)

# 3. 終わったら書き出し・キャッシュ・トークンを消す (全メッセージとファイルが入っている)
rm -rf /srv/chikuwachat/import
```

`--actor` は実行する管理者 (監査ログと、作成者が分からない行の作成者になる)。結果には人の対応付け、誰にも対応付け
られなかった人 (新しく作ったアカウント)、件数 (`posts`・`replies`・`files`・`files_failed`・`files_hidden` など)、
チャンネルごとの件数、使われていた絵文字のうち画像が無いもの、取れなかったファイル、警告が出る。添付の分だけオブジェクト
ストアが増え、ダウンロードの間はキャッシュの分も要る (`df -h /srv` で空きを確かめる)。

## 実機での動作確認 (iPhone)

前提: `apps/ios/project.yml` の `DEVELOPMENT_TEAM` で自動署名できること (Xcode にそのチームの Apple ID を
追加済み)、iPhone がデベロッパモード有効 (設定 → プライバシーとセキュリティ → デベロッパモード) で Mac を
信頼していること。

1. **サーバを LAN に公開する。** 開発用 compose は既定で localhost にしか公開しないので、`app` だけ作り直す。
   元に戻すときは `APP_BIND` を付けずに同じコマンドを実行する。

   ```
   cd infra && APP_BIND=0.0.0.0 docker compose up -d app
   ipconfig getifaddr en0        # Mac の LAN アドレス。アプリのサーバ URL に使う
   ```

   macOS のファイアウォールが有効なら Docker への着信を許可する。
2. **UDID を確認する。** USB か同じ Wi‑Fi で接続し `xcrun devicectl list devices` を見る (`physical` の行)。
3. **ビルドして入れる。** Xcode でプロジェクトを開き、対象に iPhone を選んで ▶ でもよい。

   ```
   cd apps/ios && xcodegen generate
   xcodebuild -scheme ChikuwaChat -destination "id=<UDID>" -allowProvisioningUpdates -derivedDataPath build build
   xcrun devicectl device install app --device <UDID> build/Build/Products/Debug-iphoneos/ChikuwaChat.app
   xcrun devicectl device process launch --device <UDID> jp.chikuwachat.ios
   ```

   初回は iPhone 側で「信頼されていないデベロッパ」と出るので、設定 → 一般 → VPN とデバイス管理 で信頼する。
4. **ログインする。** サーバ URL は `http://<Mac の IP>:8000`。ユーザーは既存の開発ユーザーか、
   `docker compose exec -T app python -m app.cli create-user --username <名前> --display-name <表示名>` で追加する
   (初回ログインでパスワード変更を求められる)。Info.plist の ATS は自宅 LAN 向けに平文 HTTP を許可している。
   本番は Caddy の TLS を使う。
5. **プッシュを試す。** Xcode から入れたビルドは `aps-environment = development` なので、端末は
   `push_environment = sandbox` で登録される。まず配線だけ確かめるなら
   `docker compose exec -T app python -m app.cli push-test --user <iPhone のユーザー>` で、`sent` と出れば
   鍵・環境・トークンは正しい (キューを通らないので `push_deliveries` には残らない)。
   実際の流れは **別のユーザー** から送る: iPhone のユーザーとは別のユーザーで Desktop にログインし、
   iPhone をバックグラウンドにして DM を送る (チャンネルならメンション)。次の場合は仕様として届かない
   (PUSH_NOTIFICATIONS.md §4): 自分の投稿、iPhone のユーザーが Desktop でも操作中 (60 秒以内にアクティブ)、
   すでに既読、通知レベルが none / ミュート中。届かないときは `docker compose logs app | grep -i apns` と
   `push_deliveries` 表を見る。`BadDeviceToken` は環境の不一致 (sandbox / production)、
   `InvalidProviderToken` は Key ID / Team ID / 鍵の不一致。
6. **見るところ**: ログイン → チャンネル一覧 → Desktop との送受信 → バックグラウンド中の通知とタップ →
   アプリを再起動してキャッシュが先に出て再同期されること → 機内モードにして送信し、復帰後に届くこと。
