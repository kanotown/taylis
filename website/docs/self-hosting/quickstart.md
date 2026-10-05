---
title: クイックスタート
description: Taylis のサーバーを起動して、最初の管理者を作るまで
---

# クイックスタート

Linux のサーバーに Taylis を立てて、ブラウザでログインするまでの手順です。[必要なもの](index.md#requirements) を
先にご確認ください。

## 1. DNS とファイアウォール

- ドメインの DNS に **A レコード** (IPv6 も使うなら AAAA) を足し、`chat.example.com` がサーバーの IP アドレスを
  指すようにします。`dig +short chat.example.com` でサーバーの IP が返れば反映されています。
- TCP 80 と 443 を開けます (HTTP/3 を使うなら UDP 443 も)。
- Cloudflare を使っている場合は、プロキシをオフ (DNS only) にしてください。Caddy が自分で証明書を取り、
  WebSocket と大きなアップロードをそのまま通すためです。

## 2. Docker を入れる

Docker Engine と compose プラグインを入れます (Docker 公式の手順に従ってください)。`docker compose version` で
確かめられます。

## 3. 取得と設定

```sh
git clone https://github.com/kanotown/taylis.git /srv/chikuwachat
cd /srv/chikuwachat/infra
cp .env.example .env && chmod 600 .env
mkdir -p secrets && chmod 700 secrets
```

`.env` を開いて、少なくとも次を埋めます。

```ini
ENVIRONMENT=production
WORKSPACE_NAME=チーム名
# 32 文字以上のランダムな値
SECRET_KEY=
# ランダムな値
POSTGRES_PASSWORD=
S3_SECRET_KEY=
CHAT_DOMAIN=chat.example.com
```

ランダムな値は次のコマンドで作れます。

```sh
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

!!! danger "`.env` と `secrets/` はリポジトリに入れない"
    `.env` には秘密の値が入ります。Git にコミットせず、バックアップとは別の安全な場所に控えておいてください
    (なくすと、バックアップを戻しても動かせなくなります)。

## 4. 起動

```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile proxy up -d --build
```

- 外に出るのは Caddy (80 / 443) だけです。データベース・アプリ・オブジェクトストレージのポートはホストに出しません。
- 起動のときにデータベースの移行が自動で適用されます。
- Caddy が TLS の証明書を自動で取ります (80 / 443 が開いていて、DNS が向いている必要があります)。

動いているかを確かめます。

```sh
curl https://chat.example.com/healthz
```

## 5. 最初の管理者を作る

```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec app \
  python -m app.cli create-admin --username admin
```

仮のパスワードが **一度だけ** 表示されます。

## 6. ログインする

- ブラウザで `https://chat.example.com/` を開き、`admin` と仮のパスワードでログインします。新しいパスワードを決めます。
- デスクトップ版やスマートフォンのアプリでは、ログイン画面の「サーバ URL」に `https://chat.example.com` を入れます。

ここからは [管理者ガイド](../admin/index.md) に沿って、メンバーを作るか招待リンクを送ってください。

## 次にすること

- [バックアップ](backup.md) を毎日動かす (いちばん大事です)
- [プッシュ通知](push.md) を設定する
- 他のサイトの nginx がすでにあるサーバーなら [既存のリバースプロキシの後ろで](reverse-proxy.md)
- 新しい版への [更新](updates.md)
