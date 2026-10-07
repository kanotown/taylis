---
title: Slack / Mattermost / Notion からの移行
description: Slack のエクスポートや Mattermost のチームを会話ごと、Notion の書き出しをドキュメントとして Taylis に読み込む
---

# Slack / Mattermost / Notion からの移行

どれも、サーバーでコマンドを実行して読み込みます。共通する点は次のとおりです。

- **試し読み**（`--dry-run`）：すべてを検査して、何も書き込まずに、人の対応付け・件数・警告を表示します。
  本番の前に必ず実行してください。
- **やり直しても重複しない**：読み込んだものはすべて記録されるので、同じコマンドをもう一度実行すると、
  増えた分だけを足します（途中で止まっても続きから）。
- 読み込んだメッセージは全員が既読の状態で入り、通知は出しません。
- 書き出したファイルには全メッセージが入っています。root だけが読める場所に置き、終わったら消してください。

## Slack から

Slack のワークスペースのエクスポート（ZIP）を読み込みます。

**読み込むもの**：公開チャンネル（アーカイブ済みはアーカイブのまま）、メンバー、メッセージ（時刻はそのまま）、
スレッド、「チャンネルにも送信」した返信、編集の時刻、リアクション、ピン留め、添付ファイル。
本文の書き方（`<@U…>` のメンション、`*太字*`、`~取り消し~`、リンクなど）は Taylis の書き方に変えます。

**読み込まないもの**：非公開チャンネル・DM（オプションで指定したときだけ）、参加・退出の通知、削除済みのメッセージ、
Slack の無料プランで見えなくなった古いファイル、編集の履歴。

### エクスポートを作る（Slack 側）

ワークスペースの管理者が `https://<ワークスペース>.slack.com/services/export` を開き、期間を選んでエクスポートを
始めます。できたら ZIP をダウンロードします。ファイルの URL は時間が経つと使えなくなることがあるので、移行の直前に
作ってください。

!!! note "添付ファイル"
    Slack のエクスポートにはファイルそのものは入っていません。`--download` で Slack から取ってきます。
    取れないとき（403 など）は、`files:read` を持つ Slack のトークンを 1 行のファイルに書いて `--slack-token-file`
    で渡します（コマンドラインに直接書かないでください）。カスタム絵文字の画像もエクスポートに入らないので、
    `--emoji-dir` で画像のフォルダか ZIP を渡します。

### 実行の例

```sh
cd /srv/chikuwachat/infra
install -d -m 700 /srv/chikuwachat/import
# (手元から) scp 'Slack export.zip' root@<サーバー>:/srv/chikuwachat/import/slack-export.zip

# 1. 試し読み (何も書き込みません)
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  run --rm --no-deps --user root -e RUN_MIGRATIONS=false \
  -v /srv/chikuwachat/import:/import app \
  python -m app.cli import-slack /import/slack-export.zip --actor admin \
  --channel-prefix slack- --user taro.yamada=yamada \
  --download --files-cache /import/files --dry-run

# 2. 本番: 1. から --dry-run を外して実行

# 3. 片付け
rm -rf /srv/chikuwachat/import
```

よく使うオプションは次のとおりです。

| オプション | 内容 |
| --- | --- |
| `--actor admin` | 実行する管理者（監査ログに残ります） |
| `--user slackの名前=taylisのユーザー名` | 人の対応付け（Slack のユーザー名・表示名・ID・メールアドレスのどれでも） |
| `--channel-prefix slack-` | 同じ名前のチャンネルがあるときに前置きを付ける |
| `--people-only` | 人の対応付けの表だけを出す |
| `--email-domain-map FROM=TO` | Slack と Taylis でメールのドメインが違うときの読み替え |
| `--activate-domain DOMAIN` | そのドメインの人を有効なアカウントとして作る（Google でログインすると結び付きます） |
| `--download --files-cache DIR` | 添付ファイルを Slack から取ってくる |
| `--emoji-dir`、`--emoji-rename-file` | カスタム絵文字の画像と、日本語の名前の付け替え |

自動デプロイの構成（`docker-compose.release.yml` など）で動かすときのコマンドや、研究室の Slack を移す詳しい例は
[infra/README.md の「Slack からの移行」](https://github.com/kanotown/taylis/blob/main/infra/README.md) をご覧ください。

## Mattermost から

Mattermost のチーム 1 つを読み込みます。2 段に分かれます。

1. `mattermost-extract`：Mattermost の PostgreSQL から、そのチームの分を JSONL に書き出します（読むだけで、
   Mattermost には何も書きません）。
2. `import-mattermost`：その JSONL を読み込みます。添付ファイルとカスタム絵文字は、Mattermost のデータディレクトリ
   （読み取り専用でマウント）から読みます。

**読み込むもの**：公開・非公開チャンネル、メンバー、投稿、スレッド、リアクション、ピン留め、編集の時刻、添付ファイル、
使われているカスタム絵文字。**読み込まないもの**：DM とグループ DM、ほかのチーム、削除済みの投稿、システムメッセージ。

人は `--user mattermostの名前=taylisの名前`、前回の対応、同じメールアドレスの順に対応付け、それ以外で投稿のある人は
**無効化済み** のアカウントとして作ります（管理者が有効にするまでログインできません）。

コマンドの例は [infra/README.md の「Mattermost からの移行」](https://github.com/kanotown/taylis/blob/main/infra/README.md)
をご覧ください。

## Notion から

Notion の書き出し（「Markdown & CSV」）を「ドキュメント」に読み込みます。

**読み込むもの**：ページとサブページの木、データベース（列はプロパティになり、型は値から推測します：チェック・数・日付・URL・
人・マルチセレクト・セレクト・関係・テキスト。日付のあるデータベースにはカレンダーのビューを作ります）、行の本文、画像と
ファイル、ページ間のリンク、コールアウト（引用になります）・トグル（箇条書きになります）・数式・コード・表。

**読み込まないもの**：共有設定、コメント、ページの履歴、ビューの設定、アイコンとカバー、作成者と日時（書き出しに入って
いません。作成者は実行した管理者になります）。

### 書き出しを作る（Notion 側）

取り込みたいページの「…」→「エクスポート」で、形式「Markdown & CSV」、「サブページを含める」と「サブページ用のフォルダを作成する」を
オンにします。できた ZIP をそのまま使います（大きいと ZIP の中に ZIP が入っていますが、そのままで読めます）。

### 実行の例

```sh
cd /srv/chikuwachat/infra
install -d -m 700 /srv/chikuwachat/import
# (手元から) scp 'Export.zip' root@<サーバー>:/srv/chikuwachat/import/notion-export.zip

# 1. 試し読み (何も書き込みません)
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  run --rm --no-deps --user root -e RUN_MIGRATIONS=false \
  -v /srv/chikuwachat/import:/import app \
  python -m app.cli import-notion /import/notion-export.zip --actor admin \
  --access private --dry-run

# 2. 本番: 1. から --dry-run を外して実行

# 3. 片付け
rm -rf /srv/chikuwachat/import
```

| オプション | 内容 |
| --- | --- |
| `--actor admin` | 実行する管理者（監査ログに残り、取り込んだページの作成者になります） |
| `--access workspace-edit` / `workspace-view` / `private` | 取り込んだいちばん上のページの共有（既定は全員が編集）。全員に見えてはいけないページがあるときは `private` で取り込み、確かめてから共有を広げてください |
| `--parent <ページの id>` | そのページの下に取り込む（共有は親から受け継ぎます） |
| `--user "Notion の名前=ユーザー名"`、`--user-map FILE` | 人の列と `@名前` の対応付け（表示名かユーザー名が一致すれば指定しなくても対応します） |
| `--column-types FILE` | 推測した型の指定し直し（`列名 = 型` か `データベース名 / 列名 = 型` の行） |

もう一度実行すると、Notion で増えたページを足し、Taylis で変えていないページは新しい書き出しで上書きします。Taylis で
変えたページはそのまま残し、結果に一覧を出します。詳しくは
[infra/README.md の「Notion からの移行」](https://github.com/kanotown/taylis/blob/main/infra/README.md) をご覧ください。

## 移行の後で

移行で作った人は、[既定のチャンネル](../admin/workspace.md#default-channels) に自動では入りません。管理 →「設定」→
「既定のチャンネル」の「今いる人も全員入れる」で入れてください。
