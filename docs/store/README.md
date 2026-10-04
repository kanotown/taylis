# ストアの掲載に使う文面

| ファイル | 中身 |
|---|---|
| [LISTING_JA.md](LISTING_JA.md) | アプリ名・サブタイトル・プロモーションテキスト・キーワード・説明 (日本語、主) |
| [LISTING_EN.md](LISTING_EN.md) | 同じものの短い英語版 |
| [PRIVACY_AND_RATINGS.md](PRIVACY_AND_RATINGS.md) | Apple の App のプライバシー、Play のデータ セーフティ、年齢区分の回答 |
| [REVIEW_NOTES.md](REVIEW_NOTES.md) | Apple の審査メモと Play の「アプリのアクセス権」の雛形 |

公開ページ (加納のサイト):

- プライバシーポリシー: https://kano.ac/pages/apps/taylis-privacy-policy/
- サポート: https://kano.ac/pages/apps/taylis-support/
- アカウントの削除: https://kano.ac/pages/apps/taylis-account-deletion/

## スクリーンショット

- iOS: 6.9 インチ (1320 × 2868、iPhone 17 Pro Max のシミュレータ)。ホーム、会話、スレッド、投票、スタンプ、検索、予約。
- Android: Pixel 9 (1080 × 2424) と、Play の 9:16 に合わせて余白を付けた 1080 × 1920 版。
- ステータスバーは 9:41 に固定 (iOS は `xcrun simctl status_bar … override`、Android はシステム UI のデモモード)。

## デモデータ

スクリーンショットの会話はすべて架空 (実在の人・研究室の内容は使わない)。開発用のサーバに、管理者 API で
架空の研究室のユーザ 7 人 (demo.tanaka, demo.suzuki, demo.watanabe, demo.takahashi, demo.nakamura,
demo.yamamoto, demo.ito) と、#お知らせ・#研究ミーティング・#機材予約・#論文紹介・#雑談・🔒学会準備、DM、
スレッド、リアクション、投票、予約の枠 (GPU サーバ)、予定、タスクを作り、表示用に投稿時刻を 10/2 (金) と
10/5 (月) の朝にずらした。審査用のワークスペースも同じような内容で作るとよい。
