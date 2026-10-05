---
title: プッシュ通知（APNs / FCM）
description: iOS（APNs）と Android（FCM）のプッシュ通知をサーバーで有効にする
---

# プッシュ通知（APNs / FCM）

スマートフォンにプッシュ通知を送るには、iOS は **APNs**、Android は **FCM** の設定がサーバーに要ります。
設定しなくても Taylis は動きます（スマートフォンのアプリは、開いている間だけ通知を出します）。デスクトップ版と
ブラウザ版はプッシュを使わないので、この設定は要りません。

!!! warning "プッシュはアプリの持ち主の鍵で送ります"
    APNs と FCM の通知は、**アプリを配っている人の** 鍵（Apple の Team と Firebase のプロジェクト）でしか送れません。
    今のところ、自分で立てたサーバーから公式のストア版のアプリにプッシュを送る仕組みはありません（準備中）。
    自分のサーバーでプッシュを使うには、自分の Apple Developer Program と Firebase のプロジェクトで iOS / Android の
    アプリをビルドし、その鍵をサーバーに置きます。改変したアプリを配るときは、名前とアイコンを変える必要があります
    （[ライセンス](../license.md)、[docs/DEVELOPMENT.md の「フォークでのビルド」](https://github.com/kanotown/taylis/blob/main/docs/DEVELOPMENT.md)）。

## iOS (APNs)

APNs は .p8 の鍵による認証（token 認証）を使います。証明書は要りません。

1. **App ID の登録**：Apple Developer → Certificates, Identifiers & Profiles → Identifiers →「+」→ App IDs → App。
   Bundle ID を Explicit で決め（例 `jp.example.chikuwachat`）、Capabilities で Push Notifications にチェックします。
2. **認証キーの発行**：Keys →「+」→ Apple Push Notifications service（APNs）にチェック → Register → Download。
    - `.p8` は **一度しかダウンロードできません**。なくしたら Revoke して作り直します。
    - Key ID（10 桁）と、Membership details の Team ID（10 桁）を控えます。
3. **サーバーに置く**：`.p8` を `infra/secrets/` に置き（コミットしないでください）、`infra/.env` に書きます。

```ini
APNS_KEY_FILE=./secrets/AuthKey_XXXXXXXXXX.p8
PUSH_APNS_ENABLED=true
PUSH_APNS_KEY_PATH=/run/secrets/apns_key.p8
PUSH_APNS_KEY_ID=XXXXXXXXXX
PUSH_APNS_TEAM_ID=YYYYYYYYYY
PUSH_APNS_BUNDLE_ID=jp.example.chikuwachat
```

Xcode から入れた開発用のビルドは sandbox、TestFlight と App Store のビルドは production の APNs を使います。
サーバーは端末ごとに自動で使い分けます。

## Android (FCM)

1. [Firebase のコンソール](https://console.firebase.google.com) でプロジェクトを作ります（Google アナリティクスは不要）。
2. Android のアプリを登録し、`google-services.json` をアプリのビルドに使います（Git には入れません）。
3. プロジェクトの設定 → サービス アカウント →「新しい秘密鍵の生成」で JSON をダウンロードし、
   `infra/secrets/fcm_service_account.json` に置きます（権限 600）。
4. `infra/.env` に書きます。

```ini
FCM_SERVICE_ACCOUNT_FILE=./secrets/fcm_service_account.json
PUSH_FCM_ENABLED=true
PUSH_FCM_SERVICE_ACCOUNT_PATH=/run/secrets/fcm_service_account.json
```

!!! tip "後から鍵を足すとき"
    鍵を置く前に `compose up` していると、Docker がマウント元として **空のディレクトリ**
    （`secrets/fcm_service_account.json/`）を作っていることがあります。`rmdir` してから鍵を置いてください。
    コンテナは uid 10001 で動くので、鍵はそのユーザーが読める持ち主と権限にします。

## 反映と確認

```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile proxy up -d app
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec app \
  python -m app.cli push-test --user hanako --body "hello"
```

`sent` と出れば、鍵・環境・端末のトークンは正しく設定されています。利用者は、アプリの設定の「通知」→
「テスト通知を送る」で自分の端末に届くかを確かめられます（[通知の設定](../guide/notifications.md#test)）。

| エラー | よくある原因 |
| --- | --- |
| `BadDeviceToken`（APNs） | sandbox と production の取り違え |
| `InvalidProviderToken`（APNs） | Key ID・Team ID・鍵の組み合わせの誤り |
| `UNREGISTERED`（FCM） | 端末のトークンが古い（自動で消され、アプリを開くと登録し直されます） |

仕組みは [プッシュ通知の設計](../how-it-works/push.md) をご覧ください。
