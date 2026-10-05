---
title: サーバーを立てる
description: Taylis のサーバーを自分たちで立てて運用する
---

# サーバーを立てる

Taylis のサーバーは、Linux のサーバー 1 台に Docker Compose で立てます。Redis・Kafka・Kubernetes などは使いません。
数十人・数百万件のメッセージまでを、この構成のまま扱えるように作っています。

## 必要なもの { #requirements }

| もの | 内容 |
| --- | --- |
| サーバー | Linux (Debian 12 / 13 で確かめています)、2 vCPU / メモリ 4 GB 以上がおすすめ (2 GB ならスワップを足す) |
| ソフトウェア | Docker Engine と compose プラグイン |
| ドメイン名 | サーバーを指す DNS の名前 (例 `chat.example.com`) |
| ポート | TCP 80 と 443 (証明書の取得にも使います)。HTTP/3 を使うなら UDP 443 |
| ディスク | 添付ファイルの分 (移行するなら数 GB)、バックアップの置き場所 |

プッシュ通知を使うなら、Apple Developer Program (iOS) と Firebase のプロジェクト (Android) も必要です
([プッシュ通知](push.md))。

## 構成

```text
利用者 ──https──▶ Caddy (TLS、ブラウザ版の配信) ──▶ app (FastAPI、WebSocket)
                                                     ├─▶ db (PostgreSQL 17 + PGroonga)
                                                     ├─▶ objectstore (versitygw: S3 互換、添付ファイル)
                                                     └─▶ converter (Gotenberg: Office 文書のプレビュー)
```

| サービス | 役割 |
| --- | --- |
| `caddy` | TLS の終端 (証明書は自動で取得)、`/api/*` をアプリへ、それ以外はブラウザ版を配信 |
| `app` | Taylis のサーバー本体 (Python / FastAPI)。起動のときにデータベースの移行を自動で適用します |
| `db` | PostgreSQL と、日本語・英語の全文検索の PGroonga |
| `objectstore` | 添付ファイルの置き場所 (versitygw。ふつうのディレクトリの上に S3 の API を載せます) |
| `converter` | Office の文書を PDF にしてプレビューを作ります (外のネットワークには出られません) |

**データの置き場所は、PostgreSQL と versitygw のデータディレクトリの 2 か所だけ** です。バックアップもこの 2 つを
取ります ([バックアップと復元](backup.md))。

## 進め方

1. [クイックスタート](quickstart.md): サーバーを起動して、最初の管理者を作ります。
2. 必要に応じて:
    - [既存のリバースプロキシの後ろで](reverse-proxy.md) (nginx などがすでに 80 / 443 を使っているサーバー)
    - [プッシュ通知 (APNs / FCM)](push.md)
    - [文書のプレビュー](previews.md)
3. [バックアップと復元](backup.md) を毎日動かします。
4. [更新と自動デプロイ](updates.md): 新しい版への更新、GitHub のタグからの自動デプロイ。
5. [Slack / Mattermost からの移行](import.md)。
6. うまくいかないときは [困ったとき](troubleshooting.md)。

このサイトには要点だけを書いています。手順と設定の全体は、リポジトリの
[infra/README.md](https://github.com/kanotown/taylis/blob/main/infra/README.md) と
[infra/.env.example](https://github.com/kanotown/taylis/blob/main/infra/.env.example) にあります。

!!! warning "サーバーの担当者はすべてのメッセージを読めます"
    サーバー・データベース・バックアップを扱える人は、非公開チャンネルや DM を含むすべてのメッセージを技術的には
    読めます。誰がサーバーを扱うかを決め、利用者に伝えてください ([プライバシーとデータの扱い](../privacy.md#admins))。
