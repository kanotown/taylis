---
title: 文書のプレビュー
description: PDF と Office 文書のプレビューを作る converter (Gotenberg) の設定
---

# 文書のプレビュー

PDF と Office の文書 (doc / docx、xls / xlsx、ppt / pptx、odt / ods / odp、rtf) に、1 ページ目のサムネイルと、
アプリの中で全ページを見られるビューアを付けます。

- **PDF** はアプリのサーバー (`app`) が自分でプレビューを作ります。追加の準備は要りません。
- **Office の文書** は、`converter` サービス ([Gotenberg](https://gotenberg.dev/) 8 の LibreOffice) で PDF にしてから
  プレビューを作ります。

## 起動

`converter` は `docker-compose.yml` に入っているので、ふつうに起動すれば一緒に動きます。最初の起動でイメージの
ダウンロード (約 440 MB、展開後 1.5 GB) が増えます。

## 設定

| 変数 (`infra/.env`) | 内容 | 既定 |
| --- | --- | --- |
| `PREVIEW_CONVERTER_URL` | converter の URL。空にすると Office のプレビューを作りません (PDF は作ります) | `http://converter:3000` |
| `PREVIEWS_ENABLED` | `false` でプレビューを一切作りません | `true` |
| `PREVIEW_MAX_INPUT_BYTES` | これより大きいファイルはプレビューを作りません | 52428800 (50 MB) |

## 安全のための閉じ込め

- converter は外に出られない専用のネットワーク (`internal: true`) にだけつながり、ホストにもインターネットにも
  出られません。ポートも公開しません。
- 1 回 90 秒・55 MB・メモリ 1 GB・CPU 1 の制限があります。
- 確認: `docker compose exec converter curl -m 5 https://example.com` が名前解決できずに失敗すれば、外に出られません。

## 資源

- メモリは待機中 100 MB ほど (LibreOffice は 10 分使わなければ止まります)。変換中は文書によって増えます (上限 1 GB)。
- 小さな文書なら 1 件 1 秒未満で変換できます。
- converter は状態を持たないので、バックアップは要りません。プレビューの画像はオブジェクトストレージに保存され、
  いつものバックアップに入ります。

## プレビュー機能より前のファイル

この機能を入れる前に添付されたファイルのプレビューは、次のコマンドで作れます。途中で止めても続きから再開でき、
「more files are left」と出たらもう一度実行します。

```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec app \
  python -m app.cli generate-previews --limit 200
```

詳しくは [docs/PREVIEWS.md](https://github.com/kanotown/taylis/blob/main/docs/PREVIEWS.md) をご覧ください。
