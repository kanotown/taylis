---
title: デモを試す
description: 架空の研究室のデータが入った Taylis を手元で動かす
---

# デモを試す

本物のデータを入れる前に、架空の研究室「Taylis デモ研究室」が入った Taylis を自分のパソコンで動かせます。
教授・助教・学生 5 人と、見学用のアカウント **review** がいて、約 2 週間分の会話（スレッド・リアクション・投票・
日程調整）、週報の提出の回収、タスクと締切、カレンダー、キャンバス、ファイル、予約の枠がそろっています。
人も会話もすべて架空です。

## 必要なもの

- Docker（Docker Desktop か Docker Engine と compose プラグイン）。メモリに 2 GB ほどの余裕
- Git
- 空いているポート 18080（ブラウザで開くアドレス）

## 1. 取得と設定

```sh
git clone https://github.com/kanotown/taylis.git
cd taylis/infra
cp .env.example .env && chmod 600 .env
```

`.env` を開いて、次の値を変えます。ランダムな値は
`python3 -c "import secrets; print(secrets.token_urlsafe(48))"` で作れます。

```ini
WORKSPACE_NAME=Taylis デモ研究室
SECRET_KEY=（ランダムな値）
POSTGRES_PASSWORD=（ランダムな値）
S3_SECRET_KEY=（ランダムな値）
CHAT_DOMAIN=localhost
```

## 2. 起動とデモの書き込み

```sh
docker compose -p taylis-demo -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.behind-proxy.yml --profile proxy up -d --build
docker compose -p taylis-demo -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.behind-proxy.yml exec app python -m app.cli seed-demo
```

初回はイメージのビルドに数分かかります。最後に、作られたアカウントのパスワードが **一度だけ** 表示されます
（`tanaka` は管理者、`review` は一般メンバー）。

## 3. ログイン

ブラウザで <http://localhost:18080/> を開き、`review` と表示されたパスワードでログインします。未読のチャンネルや
アクティビティのメンション、左の「予約」「タスク」「カレンダー」などを見てみてください。管理画面は `tanaka` で
ログインすると開けます。

## やり直す・片付ける

- 最初の状態に戻す（**データベースの中身をすべて消して** 書き直す。`.env` の `WORKSPACE_NAME` がデモの名前のときだけ動きます）：

    ```sh
    docker compose -p taylis-demo -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.behind-proxy.yml exec app python -m app.cli seed-demo --reset
    docker compose -p taylis-demo -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.behind-proxy.yml restart app
    ```

- 止めてデータも消す：

    ```sh
    docker compose -p taylis-demo -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.behind-proxy.yml --profile proxy down -v
    ```

!!! note "本物のワークスペースには書き込みません"
    `seed-demo` は、メッセージがすでにあるデータベースには（`WORKSPACE_NAME` がデモの名前でない限り）書き込みを
    断ります。本番のサーバーで誤って実行しても、架空の人が混ざることはありません。

デモをサーバーに置いて人に見せる（毎晩リセットする）手順は、リポジトリの
[infra/demo/DEPLOY_VPS.md](https://github.com/kanotown/taylis/blob/main/infra/demo/DEPLOY_VPS.md) にあります。
自分のチームで使い始めるときは [クイックスタート](quickstart.md) へ。
