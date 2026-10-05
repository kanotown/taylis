---
title: バックアップと復元
description: 毎日のバックアップ、復元、復元のリハーサル
---

# バックアップと復元

Taylis のデータは **PostgreSQL** と **オブジェクトストレージ（versitygw）のデータディレクトリ** の 2 か所だけです。
付属のスクリプトが、この 2 つをまとめてバックアップします。

## 毎日のバックアップ

`infra/backup.sh` は、データベースを `pg_dump` で書き出した後に、添付ファイルを写します。cron で毎日動かします。

```sh
# crontab (root)
30 3 * * * CHIKUWA_PROD=1 /srv/chikuwachat/infra/backup.sh /srv/backups >> /var/log/chikuwachat-backup.log 2>&1
```

- `/srv/backups/<UTC の時刻>/` に `db.dump`・`objects/`・チェックサムができます。
- **14 世代** を残します（更新の直前に取るバックアップも 1 世代に数えます）。
- `objects/` は **増分** です。前回から変わっていないファイルは前回のバックアップへのハードリンクになるので、
  添付が 7 GB あっても、14 世代で 7 GB と毎日の増えた分で済みます。
- バックアップは 1 つのファイルシステムの中に置きます。別のマシンや外部のストレージへは、ハードリンクを保つ
  `rsync -aH` か `restic` で送ってください。

!!! danger "`.env` と `secrets/` は別に保管する"
    バックアップには `.env`（秘密の値）と `secrets/`（APNs / FCM の鍵など）は入りません。安全な別の場所に控えてください。

## 復元

`infra/restore.sh` は、データベース → 添付ファイル → アプリの起動 → 添付ファイルの検査 の順に戻します。

```sh
cd /srv/chikuwachat/infra
CHIKUWA_PROD=1 ./restore.sh /srv/backups/20260926T033000Z
```

- 今のデータベースと添付ファイルを **置き換えます**。
- 復元の後、`verify-attachments` がデータベースにあって実物の無い添付ファイルを報告します（ふつうは 0 件です）。

## 復元のリハーサル

`infra/restore-rehearsal.sh` は、動いているサーバーからバックアップを取り、別の compose プロジェクトに復元して、
ユーザー・メッセージ・添付ファイルの件数を比べてから片付けます。今のサーバーには触れません。
**四半期に一度** は実行して、本当に戻せることを確かめてください。

## 運用のコマンド

`docker compose ... exec app python -m app.cli <コマンド>` で使います。

| コマンド | 用途 |
| --- | --- |
| `create-admin` / `create-user` | アカウントの作成（仮のパスワードは一度だけ表示） |
| `push-test --user <名前>` | プッシュ通知の疎通の確認 |
| `verify-attachments` | 添付ファイルの実物の欠けを報告 |
| `anonymize-user --username <名前>` | 退会：名前・メール・ログイン情報・端末を消し、履歴は「退会したユーザー」で残す |
| `export-channel --channel <名前> --out <ファイル.jsonl>` | チャンネルの履歴を JSONL で書き出す（添付はメタデータのみ） |
| `generate-previews` | 古い文書のプレビューを作る |
| `import-emoji-presets` | サーバーのフォルダの絵文字のセットを取り込む |

古いセッション（30 日）、無効にした端末（90 日）などは、サーバーが自動で掃除します。
