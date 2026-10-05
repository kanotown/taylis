---
title: 既存のリバースプロキシの後ろで
description: nginx などがすでに 80 / 443 を使っているサーバーで Taylis を動かす
---

# 既存のリバースプロキシの後ろで

ほかのサイトの nginx がすでに 80 / 443 と証明書 (certbot) を持っているサーバーでは、Caddy に 80 / 443 を渡さず、
nginx の後ろで動かします。

```text
利用者 ──https──▶ nginx (TLS、certbot の証明書) ──http──▶ 127.0.0.1:18080 Caddy ──▶ app
                                                            (ブラウザ版、本文の大きさの上限、CSP)
```

## 1. Caddy をローカルのポートだけで動かす

compose に `docker-compose.behind-proxy.yml` を足します。Caddy は `127.0.0.1:18080` の HTTP だけを受けます
(ポートは `.env` の `BEHIND_PROXY_PORT` で変えられます)。

```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.behind-proxy.yml \
  --profile proxy up -d --build
```

!!! warning "いつも `-f docker-compose.behind-proxy.yml` を付ける"
    付けずに Caddy を起動すると、Caddy が 80 / 443 を取りに行って nginx とぶつかり、起動しません。
    自動デプロイを使うときは `deploy.conf` の `EXTRA_COMPOSE_FILES=docker-compose.behind-proxy.yml` で付きます
    (初期設定のスクリプトの `--behind-proxy`)。

## 2. nginx のサイトを作る

リポジトリの [infra/nginx-site.conf.example](https://github.com/kanotown/taylis/blob/main/infra/nginx-site.conf.example)
から作り、`chat.example.com` を自分のドメインに置き換えます。証明書は certbot で取ります。

```sh
cp nginx-site.conf.example /etc/nginx/sites-available/chikuwachat   # chat.example.com を置き換える
ln -s /etc/nginx/sites-available/chikuwachat /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d chat.example.com --redirect
```

この設定例では次の設定をしています。ほかのリバースプロキシを使うときも、同じ設定が必要です。

- `X-Forwarded-For` を接続元のアドレスで **置き換え**、`X-Forwarded-Proto` を渡す (Caddy はこの構成でだけ、
  プライベートアドレスからの転送ヘッダを信用します)。
- WebSocket のために `Upgrade` と `Connection` を通す。
- 読み取りのタイムアウトを長く (1 時間) する。WebSocket の接続を切らないためです。
- アップロードの上限 (`client_max_body_size`) を、添付ファイルの上限 (既定 100 MB) より大きくする。

## TLS について

本番では TLS が必須です。Caddy を表に出す構成 ([クイックスタート](quickstart.md)) では、Caddy が Let's Encrypt
などから証明書を自動で取って更新します。nginx の後ろの構成では、nginx (certbot) が TLS を受け持ちます。
