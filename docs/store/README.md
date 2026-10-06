# ストアの掲載に使う文面

| ファイル | 中身 |
|---|---|
| [LISTING_JA.md](LISTING_JA.md) | アプリ名・サブタイトル・プロモーションテキスト・キーワード・説明 (日本語、主) |
| [LISTING_EN.md](LISTING_EN.md) | 同じものの短い英語版 |
| [PRIVACY_AND_RATINGS.md](PRIVACY_AND_RATINGS.md) | Apple の App のプライバシー、Play のデータ セーフティ、年齢区分の回答 |
| [REVIEW_NOTES.md](REVIEW_NOTES.md) | Apple の審査メモと Play の「アプリのアクセス権」の雛形 |
| [appstore.json](appstore.json) | App Store Connect に入れる値 (上の 4 つから抜き出したもの)。`apps/ios/scripts/asc-metadata.py` が読む (STORE_RELEASE.md §3.1)。文面を直すときは md と両方を直す |

公開ページ (加納のサイト):

- プライバシーポリシー: https://kano.ac/pages/apps/taylis-privacy-policy/
- サポート: https://kano.ac/pages/apps/taylis-support/
- アカウントの削除: https://kano.ac/pages/apps/taylis-account-deletion/
- 子どもの安全基準（Google Play の申告、文面は [CHILD_SAFETY.md](CHILD_SAFETY.md)）: https://kano.ac/pages/apps/taylis-child-safety/

## スクリーンショット

- iOS: 6.9 インチ (1320 × 2868、iPhone 17 Pro Max のシミュレータ)。ホーム、会話、スレッド、投票、スタンプ、検索、予約。
- iPad (M109 から): アプリが iPad にも対応したので、App Store には **13 インチの iPad のスクリーンショットも要る**
  (2064 × 2752 の縦か 2752 × 2064 の横、iPad Pro 13-inch (M5) のシミュレータ)。M109 で撮ったもの: 横のサイドバー +
  #研究ミーティング + スレッドのペイン、縦のスレッド (サイドバーをしまった 2 列)、縦の会話、横の #お知らせ (投票)、縦の
  アクティビティ。`asc-metadata.py` は表示の種類を 1 つ (`screenshots.displayType`) しか扱わないので、iPad の組
  (`APP_IPAD_PRO_3GEN_129`) は今は App Store Connect で手で上げるか、スクリプトを複数の組に広げる。
- Android: Pixel 9 (1080 × 2424) と、Play の 9:16 に合わせて余白を付けた 1080 × 1920 版。
- ステータスバーは 9:41 に固定 (iOS は `xcrun simctl status_bar … override`、Android はシステム UI のデモモード)。

## デモデータ

スクリーンショットの会話はすべて架空 (実在の人・研究室の内容は使わない)。開発用のサーバに、管理者 API で
架空の研究室のユーザ 7 人 (demo.tanaka, demo.suzuki, demo.watanabe, demo.takahashi, demo.nakamura,
demo.yamamoto, demo.ito) と、#お知らせ・#研究ミーティング・#機材予約・#論文紹介・#雑談・🔒学会準備、DM、
スレッド、リアクション、投票、予約の枠 (GPU サーバ)、予定、タスクを作り、表示用に投稿時刻を 10/2 (金) と
10/5 (月) の朝にずらした。審査用のワークスペースも同じような内容で作るとよい。
