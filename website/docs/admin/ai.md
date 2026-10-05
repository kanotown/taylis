---
title: AI
description: AI のボット・要約・AI に聞くを有効にする（任意）
---

# AI（任意）

Taylis の AI の機能は **任意** です。サーバーに API キーを置かなければ、AI の機能は画面に出てきません。

| 機能 | 内容 |
| --- | --- |
| AI のボット | チャンネルで `@ボット名` とメンションすると、会話を読んでスレッドに返事をします |
| 要約 | 未読・スレッド・直近 1 日 / 7 日を要約します。結果は頼んだ人にだけ見えます |
| AI に聞く | 検索画面から、過去のメッセージを手がかりに出典付きで答えます |

!!! warning "会話の内容が外部のサービスに送られます"
    AI を使うと、会話の一部が、ボットのモデルの事業者（Anthropic または OpenAI）の API に送られます。
    有効にする前に、利用者にそのことを伝えてください。ボットのいるチャンネルの詳細や、要約・AI に聞くの画面には、
    送り先が表示されます。

## 有効にする（サーバーの担当者）

1. API キーをファイルに 1 行で置きます。
    - Anthropic (Claude): `infra/secrets/anthropic_api_key`
    - OpenAI: `infra/secrets/openai_api_key`
2. `infra/.env` に次を書き、アプリを起動し直します。

```ini
ANTHROPIC_API_KEY_FILE=./secrets/anthropic_api_key
AI_API_KEY_FILE=/run/secrets/anthropic_api_key
# OpenAI も使うとき
OPENAI_API_KEY_FILE=./secrets/openai_api_key
AI_OPENAI_API_KEY_FILE=/run/secrets/openai_api_key
# 月の予算 (米ドル、UTC の暦月) と、1 人あたりの直近 24 時間の回数
AI_MONTHLY_BUDGET_USD=30
AI_USER_DAILY_RUNS=50
```

キーはサーバーのファイルにだけ置き、データベースや端末には置きません。

## ボットを作る（管理者）

管理 →「AI」でボットを作ります。

| 項目 | 内容 |
| --- | --- |
| 名前・ユーザー名 | メンションに使う名前（例 `ai-assistant`） |
| 性格 | 口調や役割（4,000 文字まで） |
| モデル | Claude Opus 5.5（既定）・Claude Sonnet 5.5・Claude Haiku 4.5・GPT-6.1 Sol・GPT-6 Luna |
| 考える量 | low / medium / high |
| 非公開を許す | オフ（既定）なら公開チャンネルにだけ入れられ、DM も作れません |
| 有効 | オフにすると返事をしません |

ボットをチャンネルに入れるのは、そのチャンネルのメンバーか管理者です。ボットは何も書き換えず、返事を書くだけです。

## 上限と費用

- **月の予算**（`AI_MONTHLY_BUDGET_USD`、既定 30 ドル）を超えそうになると、新しい依頼を受け付けません。
- **1 人あたりの回数**（`AI_USER_DAILY_RUNS`、直近 24 時間で既定 50 回。メンション・要約・AI に聞くの合計）。
- 管理 →「AI」に、今月の使用量（ボットごと・人ごと）が出ます。
- 送った内容と返事は記録に残り、入力の本文は 90 日で消します（費用と件数は残します）。

詳しくは [docs/AI.md](https://github.com/kanotown/taylis/blob/main/docs/AI.md) をご覧ください。
