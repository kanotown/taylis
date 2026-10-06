# デモのワークスペース（Taylis デモ研究室）

架空の研究室「Taylis デモ研究室」（英語名 Taylis Demo Lab）を、空のサーバーに書き込むためのものです。人・会話・ファイルは
すべて架空です。手元で Taylis を触ってみるとき、スクリーンショットを撮るとき、ストアの審査用のサーバーに使います。

| ファイル | 内容 |
| --- | --- |
| `server/app/demo/content.py` | 登場人物・チャンネル・会話（日時はシードした日から逆算） |
| `server/app/demo/seed.py` | `python -m app.cli seed-demo` の本体。API をプロセス内で呼んで作り、日時だけを過去へずらす |
| `infra/demo/README.md` | この文書（手元で動かす） |
| `infra/demo/DEPLOY_VPS.md` | 本番と同じサーバーに 2 つ目の Taylis としてデモを置く手順 |
| `infra/demo/demo-vps.sh` | そのサーバーでの起動・シード・リセット |
| `infra/demo/demo.env.example` | そのサーバーの `infra/.env` のひな形 |

## 中身

- **人**：田中 一郎（教授・管理者）、鈴木 花子（助教）、渡辺 美咲（D1）、高橋 健太（M2）、中村 大輝（M2）、山本 さくら（M1）、
  伊藤 翔（B4）と、審査・見学用の **review**（一般メンバー、M1、指導教員は鈴木）。名簿（学年・指導教員）つき。
- **チャンネル**：#お知らせ、#研究ミーティング、#機材予約、#論文紹介、#雑談、#週報、🔒学会準備、times（渡辺・高橋・review）、
  DM とグループ DM。約 2 週間分の会話（日本語、一部英語）、スレッド、リアクション、テキスト絵文字（確認しました・
  ありがとうございます・承知しました）、ピン留め、確認のお願い、投票、日程調整、チャンネルのリンク。
- **定期投稿**：毎週月曜の「週報」（提出の回収つき。3 人が提出済み、中村・伊藤・review は未提出）。
- **タスク・締切・カレンダー**：シードした日を基準に、これからの締切と予定（毎週の研究ミーティングなど）。
- **キャンバス**：🔒学会準備の「学会準備チェックリスト」。
- **ファイル**：グラフの PNG、PDF 2 つ、Word（.docx）1 つ（シードのときに生成）。
- **予約**：「Claude Premium シート（デモ）」2 枠、担当は鈴木・田中。明日以降の予約 2 件、利用中 2 人、順番待ち 1 人。
- review には未読（#お知らせ・#研究ミーティング・🔒学会準備・DM）とアクティビティのメンションが残る。

日時の基準は「シードした日」です。正午より前にシードすると、その前日を基準にします（当日の朝の投稿が未来にならないように）。

## 手元で動かす

Docker（compose プラグイン）が要ります。本番用の compose をそのまま使い、Caddy は `http://localhost:18080` だけで受けます
（TLS なし、ほかのプロジェクトとぶつからないよう compose のプロジェクト名を `taylis-demo` にします）。

```sh
git clone https://github.com/kanotown/taylis.git
cd taylis/infra
cp .env.example .env && chmod 600 .env
```

`.env` で次を変えます（ランダムな値は `python3 -c "import secrets; print(secrets.token_urlsafe(48))"`）。

```ini
WORKSPACE_NAME=Taylis デモ研究室
SECRET_KEY=（ランダムな値）
POSTGRES_PASSWORD=（ランダムな値）
S3_SECRET_KEY=（ランダムな値）
CHAT_DOMAIN=localhost
```

起動して、デモを書き込みます。

```sh
docker compose -p taylis-demo -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.behind-proxy.yml --profile proxy up -d --build
docker compose -p taylis-demo -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.behind-proxy.yml exec app python -m app.cli seed-demo
```

最後に、作ったアカウントのパスワードが **一度だけ** 表示されます（review も含む。`tanaka` は管理者）。ブラウザで
<http://localhost:18080/> を開き、`review` でログインしてください。

- **もう一度実行しても何もしません**（「already in this database」）。最初からやり直すときは `--reset` を付けます。
  `--reset` は **データベースの中身をすべて消します**。`.env` の `WORKSPACE_NAME` がデモの名前（`Taylis デモ研究室` か
  `Taylis Demo Lab`）でなければ断ります（`--i-know` で強制）。リセットの後は `restart app` でアプリを起動し直します。
- review のパスワードを決めておくには、1 行のファイルを標準入力で渡します：
  `... exec -T app python -m app.cli seed-demo --review-password-file /dev/stdin < review-password.txt`
  （環境変数 `DEMO_REVIEW_PASSWORD` でも可）。ほかの人のパスワードは毎回ランダムです。
- メッセージがすでにあるデータベース（本物のワークスペース）には、`WORKSPACE_NAME` がデモの名前でない限り書き込みません。
- プッシュ通知と AI は使いません（鍵を置かなければ無効のまま）。文書のプレビューは converter が作ります。
- 片付け：`docker compose -p taylis-demo -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.behind-proxy.yml --profile proxy down -v`
  （`-v` でデータも消える）。

開発用のサーバー（`uv run uvicorn …`、docs/DEVELOPMENT.md）に書き込むときは、`server/` で
`WORKSPACE_NAME="Taylis デモ研究室" uv run python -m app.cli seed-demo` とします（空のデータベースで）。

## 作り（server/app/demo）

- データは公開 API を**プロセスの中で**（httpx の ASGI transport、ネットワークもサーバーの起動も不要）呼んで作ります。
  チャンネルの seq・outbox・検索・投票・回収・予約は、ふだんの操作と同じコードが作ります。投稿は「今」行われるので、
  最後に UPDATE で日時だけを台本の時刻にずらし（メッセージ、スレッドの最終返信、チャンネルの最終投稿・作成・参加、
  リアクション・投票・確認の時刻）、既読の位置を API で決めます。シードのセッションは最後にログアウトします。
- 「済み」の印は予約の枠（最後に作る）。人だけがあって枠がなければ、途中で止まったシードとして `--reset` を求めます。
- `--reset` は `alembic_version` 以外の表をすべて空にし（`TRUNCATE … CASCADE`）、ワークスペースの ID はそのまま残します
  （入っているアプリが同じワークスペースとして扱い続ける）。移行が入れる行（ワークスペースの設定、メッセージの雛形、
  組み込みのキャンバスの雛形）は入れ直し、添付・アイコン・絵文字のオブジェクトはオブジェクトストレージから消します。
- テスト：`server/tests/test_seed_demo.py`（空のデータベースへのシード、再実行で変わらないこと、`--reset` を断ること、
  本物のデータがあるときに断ること）。
