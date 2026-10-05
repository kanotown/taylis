---
title: ライセンス
description: Taylis のライセンス、商標、第三者のソフトウェアとデータ
---

# ライセンス

## ソースコード: Apache License 2.0

Taylis のソースコードは [Apache License 2.0](https://github.com/kanotown/taylis/blob/main/LICENSE) で公開しています。
使う・調べる・改変する・自分たちのサーバーで動かす、のどれも、このライセンスの条件のもとで自由に行えます。

## 名前とアイコン (商標)

「**Taylis**」の名前と **リスのアイコン・ロゴ** (アプリのアイコン、ファビコン、それらから作った画像) は、
Apache License の対象 **外** です (Apache License 2.0 の第 6 条)。© Toru Kano, all rights reserved.

| してよいこと | 改変版を配るときに必要なこと |
| --- | --- |
| コードを Apache License のもとで使い、改変し、自分たちのサーバーで動かす | **別の名前** と **別のアイコン** を使う。公式の Taylis であるかのように見せない |
| 公式のアプリやリリースを、改変せずに元の名前とアイコンのまま配る | ブランドの画像を差し替える (`apps/shared/brand/gen_icons.sh` で 1 枚の画像から全部を作り直せます) |
| 「Taylis をもとにした」「Taylis のサーバーに対応」のように、名前で事実を説明する | アプリの識別子 (バンドル ID など) を変え、公式のアプリと取り違えたり上書きしたりしないようにする |

詳しくは [TRADEMARKS.md](https://github.com/kanotown/taylis/blob/main/TRADEMARKS.md) と
[NOTICE](https://github.com/kanotown/taylis/blob/main/NOTICE) をご覧ください。

## 第三者のソフトウェアとデータ

Taylis は多くのオープンソースのソフトウェアとデータを使っています。同梱しているものの例:

| もの | ライセンス |
| --- | --- |
| 絵文字のデータ (Unicode の絵文字のデータ、CLDR の注釈) | Unicode License v3 |
| 絵文字の名前のデータ (iamcal/emoji-data) | MIT License |
| Noto Sans JP (デスクトップ版・ブラウザ版のフォント) | SIL Open Font License 1.1 |
| PDF.js (文書のビューア) | Apache License 2.0 |

文書のプレビューの converter (Gotenberg、MIT。中の LibreOffice は MPL-2.0) は同梱せず、Docker のイメージとして
取得します。すべての一覧は [THIRD_PARTY_NOTICES.md](https://github.com/kanotown/taylis/blob/main/THIRD_PARTY_NOTICES.md)
にあります。

## このサイト

このサイトの文章は、ソースコードと同じく Apache License 2.0 です。画面の画像は架空のデモのデータで作っています。
サイトは [MkDocs](https://www.mkdocs.org/) と [Material for MkDocs](https://squidfunk.github.io/mkdocs-material/) で
作っています。
