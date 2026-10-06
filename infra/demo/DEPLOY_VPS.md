# デモサーバーを本番と同じサーバーに置く

本番の Taylis（`/srv/chikuwachat`、ホストの nginx の後ろで Caddy が `127.0.0.1:18080`）が動いているサーバーに、
2 つ目の Taylis としてデモ（架空のデータ、[README.md](README.md)）を置く手順です。例は Taylis の公開デモ・審査用サーバー
`https://demo.kano-lab.com`（本番は `taylis.kano-lab.com`）で、別のドメインならコマンドの中のドメインを置き換えます。

```
利用者 ──https──▶ nginx ──┬─▶ 127.0.0.1:18080 Caddy ─▶ 本番（compose プロジェクト chikuwachat、/srv/chikuwachat）
                          └─▶ 127.0.0.1:18081 Caddy ─▶ デモ（compose プロジェクト taylis-demo、/srv/taylis-demo）
```

- **本番には触れません**。compose のプロジェクト名（`taylis-demo`）が違うので、コンテナ・ボリューム・ネットワークは
  別です（`taylis-demo-db-1`、`taylis-demo_db-data` …）。本番の `deploy.sh`・バックアップ・cron も別のままです。
- プッシュ通知と AI は無効（鍵を置かない）。文書のプレビュー（converter）は有効。絵文字のプリセットは空。
- イメージは本番と同じリリースのもの（`ghcr.io/kanotown/chikuwachat-server:<tag>` / `chikuwachat-web:<tag>`）。同じ
  Docker なので、本番が取ってきたイメージがそのまま使えます。
- **必要なリリース**：`seed-demo` を含むリリース（このコマンドが入った後の最初のタグ）。本番の `.release` がそれより
  古ければ、本番を先に上げるか、`TAG=` に新しいタグを書きます。

以下はすべてそのサーバーで root として実行します。コマンドに `#` のコメントは入れていません（そのまま貼れます）。

## 1. DNS

`demo.kano-lab.com` の **A レコード**をこのサーバーの IP アドレスに向けます（`*.kano-lab.com` のワイルドカードは別の
サーバーを指しているので、個別のレコードが要ります）。反映を確かめます。

```sh
dig +short demo.kano-lab.com
```

## 2. 取得と設定

```sh
TAG="$(cat /srv/chikuwachat/infra/.release)"
echo "$TAG"
git clone --depth 1 --branch "$TAG" https://github.com/kanotown/taylis.git /srv/taylis-demo
cd /srv/taylis-demo/infra
install -m 600 demo/demo.env.example .env
install -d -m 700 secrets
for key in SECRET_KEY POSTGRES_PASSWORD S3_SECRET_KEY; do sed -i "s|^$key=\$|$key=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')|" .env; done
sed -i 's/demo\.example\.com/demo.kano-lab.com/g' .env
grep -E '^(WORKSPACE_NAME|CHAT_DOMAIN|BEHIND_PROXY_PORT|PUBLIC_BASE_URL)=' .env
```

review（審査・見学用の一般メンバー）のパスワードを 1 行のファイルに置きます。下はランダムに作る例で、決めたものを
`printf '%s\n' '<パスワード>' > secrets/demo_review_password` で書いてもかまいません（8 文字以上）。

```sh
(umask 077 && python3 -c 'import secrets; print(secrets.token_urlsafe(12))' > secrets/demo_review_password)
cat secrets/demo_review_password
```

`.env` と `secrets/` はリポジトリに入れません（`.gitignore` 済み）。

## 3. 起動

```sh
/srv/taylis-demo/infra/demo/demo-vps.sh up "$TAG"
```

`demo-vps.sh` は本番の `deploy.sh` と同じ compose の組み合わせ（`docker-compose.yml` + `prod` + `release` +
`behind-proxy`、`--profile proxy`）を `-p taylis-demo` で動かし、`/readyz` が `ok` になるまで待ちます。初回はデータベースの
移行が走ります。イメージの取得に失敗した場合（ghcr.io のパッケージが非公開など）は、このサーバーにあるイメージで起動します。
無ければ `docker login ghcr.io` してからやり直します。

## 4. nginx と証明書

本番のサイトの設定例から作ります。ポートを 18081 にし、`map` の変数名を本番のサイトと別にします（同じ名前の `map` が
2 つあると nginx が起動しません）。

```sh
cd /srv/taylis-demo/infra
sed -e 's/chat\.example\.com/demo.kano-lab.com/g' -e 's/18080/18081/g' -e 's/chikuwachat_connection/taylis_demo_connection/g' nginx-site.conf.example > /etc/nginx/sites-available/taylis-demo
ln -s /etc/nginx/sites-available/taylis-demo /etc/nginx/sites-enabled/taylis-demo
nginx -t && systemctl reload nginx
```

このサーバーには certbot のアカウントが 2 つあるので、本番（taylis）の証明書と同じアカウントを `--account` で指定します。
まずそのアカウントの ID を調べます（本番の証明書の更新設定に書いてあります。`certbot show_account` でも確かめられます）。

```sh
ls /etc/letsencrypt/renewal/
grep -h '^account' /etc/letsencrypt/renewal/taylis.kano-lab.com.conf
```

表示された `account = <ID>` の `<ID>` を使って証明書を取ります（`--redirect` で http は https に転送）。

```sh
certbot --nginx -d demo.kano-lab.com --redirect --account <ID>
nginx -t && systemctl reload nginx
```

## 5. デモを書き込む

```sh
/srv/taylis-demo/infra/demo/demo-vps.sh seed
cat /srv/taylis-demo/infra/secrets/demo-accounts.txt
```

`demo-accounts.txt`（モード 600）に架空の人のパスワードが入ります。`tanaka` が管理者です。review のパスワードは
`secrets/demo_review_password` のものです。もう一度 `seed` しても何もしません（既にあるときは review のパスワードだけを
ファイルの内容に合わせ直します）。

## 6. 確かめる

```sh
curl -s https://demo.kano-lab.com/healthz
curl -s https://demo.kano-lab.com/api/v1/server
docker exec taylis-demo-app-1 python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/readyz').read().decode())"
/srv/taylis-demo/infra/demo/demo-vps.sh status
```

- `/healthz` は `{"status":"ok"}`、`/api/v1/server` の `name` は `Taylis デモ研究室`、`/readyz` は `"status":"ok"`
  （`/readyz` は Caddy が外に出さないので、コンテナの中から見ます）。
- ブラウザで `https://demo.kano-lab.com/` を開き、`review` でログインします。アプリでは「サーバ URL」に
  `https://demo.kano-lab.com` を入れます。
- 本番が変わっていないことも確かめます：`docker ps --format '{{.Names}}'` に `chikuwachat-*` と `taylis-demo-*` が
  並び、`curl -s https://taylis.kano-lab.com/healthz` が `ok`。

## 7. 毎晩のリセット（任意）

見学者が書いたものを毎晩消して、新しい日付で書き直します。リセットは架空の人のパスワードも作り直し、
`secrets/demo-accounts.txt` を書き換えます（review のパスワードは変わりません）。本番のバックアップ（03:30）と重ならない
時刻にします。

```sh
printf '%s\n' 'SHELL=/bin/bash' 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' '15 4 * * * root /srv/taylis-demo/infra/demo/demo-vps.sh reset >> /var/log/taylis-demo-reset.log 2>&1' > /etc/cron.d/taylis-demo
chmod 644 /etc/cron.d/taylis-demo
```

- 正午より前のリセットは、前日を「今日」として会話を並べます（[README.md](README.md)「中身」）。
- ストアの審査の最中に消えると困るときは、その間だけ `/etc/cron.d/taylis-demo` を外します。
- 手で今すぐリセットするとき：`/srv/taylis-demo/infra/demo/demo-vps.sh reset`

## 8. 本番の更新に合わせて上げる

本番に新しいリリースが入ったら、デモも同じタグにします（データベースの移行はアプリの起動時に走ります）。

```sh
TAG="$(cat /srv/chikuwachat/infra/.release)"
cd /srv/taylis-demo
git fetch --depth 1 origin tag "$TAG"
git checkout -q "$TAG"
/srv/taylis-demo/infra/demo/demo-vps.sh up "$TAG"
```

本番の `deploy.sh` は今と前のリリース以外のイメージを消しますが、デモのコンテナが使っているイメージは消えません。

## メモリの目安

このサーバー（12 GB）に足されるのは、手元で測った値でおよそ次のとおりです。

| コンテナ | 待機中 | 備考 |
| --- | --- | --- |
| db（PostgreSQL + PGroonga） | 約 200 MB | デモのデータは数 MB |
| app（uvicorn 1 プロセス） | 約 200 MB | |
| caddy（Web クライアントを配信） | 約 70 MB | |
| objectstore（versitygw） | 約 20 MB | |
| converter（Gotenberg / LibreOffice） | 約 100 MB | 変換中は約 300 MB、上限 1 GB（10 分使わなければ LibreOffice を止める） |

合わせて**待機中 0.6 GB 前後、文書の変換中でも 1.5 GB 程度まで**です。ディスクはイメージを本番と共有するので、
増えるのはデータベースとオブジェクトストレージの数十 MB だけです。

## 止める・消す

```sh
/srv/taylis-demo/infra/demo/demo-vps.sh down
```

すっかり消すとき（データも、nginx のサイトも、証明書も）：

```sh
cd /srv/taylis-demo/infra
CHIKUWA_SERVER_IMAGE=unused CHIKUWA_WEB_IMAGE=unused docker compose -p taylis-demo -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.release.yml -f docker-compose.behind-proxy.yml --profile proxy down -v
rm -f /etc/cron.d/taylis-demo /etc/nginx/sites-enabled/taylis-demo /etc/nginx/sites-available/taylis-demo
nginx -t && systemctl reload nginx
certbot delete --cert-name demo.kano-lab.com
rm -rf /srv/taylis-demo
```
