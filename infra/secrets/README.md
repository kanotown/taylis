# infra/secrets

秘密ファイルの置き場。この README 以外は `.gitignore` で除外され、コミットされない。

| ファイル | 用途 | 参照する設定 |
| --- | --- | --- |
| `AuthKey_<KEYID>.p8` | APNs 認証キー (Apple Developer の Keys で発行。再ダウンロード不可) | `PUSH_APNS_KEY_PATH` (compose で `/run/secrets/apns_key.p8` にマウント) |
| `anthropic_api_key` | Anthropic の API キー (1 行。M65 の AI 機能、docs/AI.md)。無ければ AI は「使えない」と表示されるだけ | `AI_API_KEY_FILE` (既定 `/run/secrets/anthropic_api_key`。compose が `infra/.env` の `ANTHROPIC_API_KEY_FILE` のファイルをマウント) |
| `openai_api_key` | OpenAI の API キー (1 行。docs/AI.md §12)。モデルが OpenAI のボット用。無ければそのボットが「使えない」になるだけ | `AI_OPENAI_API_KEY_FILE` (既定 `/run/secrets/openai_api_key`。compose が `infra/.env` の `OPENAI_API_KEY_FILE` のファイルをマウント) |
| `livekit_api_secret` | LiveKit の API シークレット (1 行。32 バイト以上の乱数。`openssl rand -base64 48`。M130 のアプリ内通話、docs/CALLS.md §7.4・§8.6)。サーバで通話を使うときだけ | `LIVEKIT_API_SECRET_FILE` (`docker-compose.livekit.yml` が `/run/secrets/livekit_api_secret` にマウント。権限 `644`) |
| `livekit.env` | deploy.sh が `livekit_api_secret` と `.env` の `LIVEKIT_API_KEY` から作る (`LIVEKIT_KEYS=<key>: <secret>`、権限 `600`)。手で書かない | LiveKit のコンテナの `env_file` (LiveKit は他人が読める鍵ファイルを拒むため) |
| `fcm_service_account.json` | FCM のサービスアカウント鍵 (Firebase コンソール → プロジェクトの設定 → サービス アカウント → 新しい秘密鍵の生成) | `PUSH_FCM_SERVICE_ACCOUNT_PATH` (compose で `/run/secrets/fcm_service_account.json` にマウント) |

- ディレクトリは `700` (deploy ユーザーだけ) にする。ファイルは `600` が基本だが、コンテナのアプリ (uid 10001) が読むもの
  (`anthropic_api_key`、`openai_api_key`) は `644` にする。ディレクトリが `700` なので、ほかの利用者からは読めない。
  `600` のままだとアプリが読めず、AI は「使えない」になる (エラーにはならない)。
- Key ID / Team ID / Bundle ID などの識別子は `infra/.env` (これも除外済み) に書く。docs には書かない。
- `.p8` はリポジトリ外 (パスワードマネージャ等) にも控えを置くこと。
