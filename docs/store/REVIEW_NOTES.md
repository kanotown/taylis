# 審査への説明 (Apple の App Review メモ / Google Play の「アプリのアクセス権」)

`<…>` を埋めて貼る。審査は公開のサーバに接続して確かめるので、審査用のワークスペース (本番とは別のサーバか、
本番の中の審査用チャンネルだけに入った普通のユーザ) を用意し、架空の会話をいくつか入れておく
(ローカルの開発 DB の demo.* ユーザのような内容。docs/store/README の「デモデータ」)。
審査用アカウントは管理者ではなく普通のメンバー (`member`) で作り、2 要素認証は付けない。

## 1. Apple: App Review に関する情報

`apps/ios/scripts/asc-metadata.py` が入れる (STORE_RELEASE.md §3.1)。メモは `docs/store/appstore.json` の `review.notes`
(`{server_url}` と `{demo_user}` は実行時に埋める)。電話番号・審査用ユーザ・パスワード・サーバ URL はリポジトリに入れず
`~/.config/taylis/asc-review.env` に置く。

- サインイン情報: ユーザ名 `<reviewer>` / パスワード `<password>`
- 連絡先: Toru Kano / kanotown@gmail.com / `<電話番号>`
- メモ (英語で貼る):

```text
Taylis is a chat client for self-hosted Taylis servers. Each organization (for example a university
research lab) runs its own server and its administrator creates the accounts. There is no public
sign-up and the app is not a general social network: people only talk with members of their own
organization.

How to sign in for review:
1. On the first screen, enter the server URL: {server_url}
2. Username: {demo_user}   Password: see the Sign-In Information above.
3. Tap "ログイン" (Log in).
The demo workspace contains fictional channels (#お知らせ, #研究ミーティング, ...), a thread, a poll
and direct messages.

Organization sign-in: the button appears only when a server enables it, and it accepts only accounts
of the organization's own Google Workspace domain configured on that server (an existing
education/enterprise account). On such a server the button reads "<domain> のアカウントでログイン"
("Log in with your <domain> account", e.g. "example.ac.jp のアカウントでログイン", or the
organization's name when the administrator sets one) over the line "組織の Google Workspace アカウント"
("your organization's Google Workspace account"), with a building icon rather than a social-login
logo; Google's account chooser is limited to that domain. The app has no other third-party or social login, so we
believe Sign in with Apple is not required (Guideline 4.8, education/enterprise account exception).
The review server uses a username and password.

User-generated content safeguards (Guideline 1.2):
- Report: long-press a message and choose "報告する" (Report). Reports go to the
  server administrators, who can delete messages and deactivate accounts.
- Block: open a person's profile and choose "ブロック" (Block); their messages are hidden.
- Users can edit and delete their own messages.
- Only members created or invited by the organization's administrator can post.
- Contact: kanotown@gmail.com

Account deletion (Guideline 5.1.1(v)): 設定 (Settings) > アカウント (Account) > アカウントを削除
(Delete account). The profile and sign-in data are erased and the user's messages remain as
"退会したユーザー" (deleted user).

Push notifications: the app asks for permission after sign-in. To check delivery, open Settings
and tap "テスト通知を送る" (Send test notification).

Networking: NSAllowsArbitraryLoads is set because each organization enters its own server URL, and
servers on a local network may not have TLS. Production servers use HTTPS.

Optional AI features (summaries, a bot) are server-side and only appear when the server
administrator enables them; they are disabled on the review server.
```

- 審査サーバで AI 機能を切るか、メモの最後の文を消す。
- 報告・ブロック・アカウント削除の場所は M104 の実装 (iOS / Android) に合わせて確かめてから貼る。

## 2. Google Play: アプリのアクセス権 (App access)

「一部の機能が制限されている」を選び、手順を追加する:

- 名前: 審査用ワークスペースへのログイン
- ユーザ名: `<reviewer>`
- パスワード: `<password>`
- その他の手順:

```text
This app connects to a self-hosted chat server run by an organization; accounts are created by the
administrator (no public sign-up).
1. Open the app. In "サーバ URL" enter: <https://review.example.ac.jp>
2. Enter the username and password above and tap "ログイン".
3. The demo workspace has fictional channels, a thread, a poll and direct messages.
Report a message: long-press it > "報告する". Block a user: profile > "ブロック".
Delete account: 設定 > アカウント > アカウントを削除 (also explained at
https://kano.ac/pages/apps/taylis-account-deletion/).
No 2-step verification is required for this account.
```

## 3. Google Play: そのほかのポリシーの申告

| 項目 | 回答 |
|---|---|
| 広告 | 含まない |
| 対象年齢 | 18 歳以上 |
| ニュースアプリ | いいえ |
| 政府のアプリ | いいえ |
| 金融機能 | なし |
| 健康 | なし |
| アカウントの削除 | アプリ内 + https://kano.ac/pages/apps/taylis-account-deletion/ |
| フォアグラウンド サービス / 正確なアラーム / フルスクリーン インテント などの特別な権限 | 使っていない (要求する権限はインターネット、ネットワーク状態、通知のみ) |
| ユーザ生成コンテンツ (UGC) | あり。報告・ブロック・管理者による削除、利用規約は組織の運用ルール |
