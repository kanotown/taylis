---
title: 困ったとき
description: サーバーの運用でよくある問題と確かめ方
---

# 困ったとき

## まず見るところ

```sh
cd /srv/chikuwachat/infra
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs --tail 200 app
curl https://chat.example.com/healthz
```

アプリのコンテナの中では `/readyz` が、データベース・スキーマ・オブジェクトストレージ・送信待ちの通知の状態を返します。

ログは JSON の行 (`LOG_JSON=true`) で出せます。トークン・パスワード・メッセージの本文はログに出しません。

## よくある問題

??? question "ブラウザで開けない・証明書のエラーになる"
    - DNS がサーバーを指しているか: `dig +short chat.example.com`
    - 80 / 443 が開いているか (VPS のパネルのファイアウォールも)
    - Cloudflare のプロキシがオフ (DNS only) になっているか
    - Caddy のログ: `docker compose ... logs caddy`

??? question "nginx の後ろで Caddy が起動しない"
    `-f docker-compose.behind-proxy.yml` を付け忘れると、Caddy が 80 / 443 を取りに行って nginx とぶつかります。
    手で compose を動かすときも必ず付けてください ([既存のリバースプロキシの後ろで](reverse-proxy.md))。

??? question "メッセージがリアルタイムに届かない (再読み込みすると出る)"
    WebSocket が途中で切られています。リバースプロキシで `Upgrade` / `Connection` を通しているか、読み取りの
    タイムアウトが短すぎないかを確かめてください。Cloudflare のプロキシを通している場合はオフにします。

??? question "大きなファイルを添付できない"
    添付の上限は `.env` の `ATTACHMENT_MAX_BYTES` (既定 100 MB) と、Caddyfile の上限の両方で決まります。前に nginx を
    置いているなら `client_max_body_size` も大きくしてください。

??? question "プッシュ通知が届かない"
    1. 利用者に「テスト通知を送る」を試してもらい、結果を見ます ([通知の設定](../guide/notifications.md#test))。
    2. サーバーで `python -m app.cli push-test --user <名前>` を実行します。
    3. `docker compose ... logs app | grep -i apns` (または `fcm`) を見ます。
    4. 別の端末で操作中・既読・ミュート・おやすみ時間の間は、仕様として送りません。

    詳しくは [プッシュ通知](push.md) をご覧ください。

??? question "Office の文書のプレビューが「作成中」のまま"
    `converter` が動いているか (`docker compose ... ps converter`)、`PREVIEW_CONVERTER_URL` が空になっていないかを
    確かめます。一時的な失敗はサーバーが後で再試行します。`generate-previews --retry-failed` でやり直せます。

??? question "Google でのログインのボタンが出ない"
    クライアント ID・secret・`SSO_GOOGLE_ALLOWED_DOMAINS`・`PUBLIC_BASE_URL` のどれかが欠けていると、起動のときに
    ログに理由を出して SSO なしで起動します。アプリのログを見てください。

??? question "パスワードを忘れた・2 要素認証の端末をなくした"
    管理者が管理画面で仮のパスワードを発行するか、2 要素認証を解除します。管理者自身が入れなくなったときは、
    サーバーで `create-admin` を使って別の管理者を作れます。

??? question "ディスクがいっぱいになりそう"
    `df -h /srv` で確かめます。バックアップは 14 世代を残し、添付ファイルは増分なので、増えるのはおもに添付の分です。
    移行のときは、ダウンロードのキャッシュの分も要ります。

## 報告と相談

不具合は [GitHub の Issue](https://github.com/kanotown/taylis/issues) で報告できます (対応のお約束はできません)。
**脆弱性は公開の場に書かず**、[SECURITY.md](https://github.com/kanotown/taylis/blob/main/SECURITY.md) の方法で
非公開で知らせてください。
