# infra

デプロイと開発環境。

| ファイル | 内容 |
| --- | --- |
| `docker-compose.yml` | `db` (groonga/pgroonga: PostgreSQL 17)、`objectstore` (versitygw)、`app` (uvicorn 単一プロセス)、`caddy` (`proxy` プロファイル) |
| `docker-compose.prod.yml` | 本番用の上書き (ホストへのポート公開を打ち消す) |
| `Dockerfile` | server のイメージ (uv ベース) |
| `Caddyfile` | TLS 終端、`/api/*` と `/ws` を app へ、本文サイズ制限 |
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
