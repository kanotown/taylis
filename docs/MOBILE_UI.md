# MOBILE_UI (スマホの画面を Slack に近づける設計)

2026-09-28 の設計提案 (復元、[ROADMAP.md](ROADMAP.md) 参照)。MUI-1 (会話画面) は実装済み (M25・M29)。下部タブ (MUI-2) 以降は未着手。

> 今回はコードを読んで設計しただけで、実装・ビルド・エミュレータ操作はしていない。ファイル:行は 2026-09-28 時点のもの。
> 比べる相手は Slack の現行モバイル版。
> - 2020 年: 下部タブ (Home / DMs / Mentions & reactions / You) を導入
> - 2024 年の再設計: タブを 5 → 3 (Home / DMs / Activity) に減らし、Activity をメンション・スレッド・招待などの集約先にした
> - 2025-11 の iOS 26 版: Liquid Glass を取り入れ、検索を下部ナビゲーションへ移し、入力欄をカプセル型にした
>
> 参考:
> - [Re-designing Slack on Mobile](https://slack.design/articles/re-designing-slack-on-mobile/)
> - [A simpler, more organized Slack on your phone](https://slack.com/blog/productivity/simpler-more-organized-slack-mobile-app)
> - [Slack for iOS 26](https://slack.com/blog/news/redesigning-slack-ios26)
> - [Introducing the new Activity view](https://slack.com/help/articles/46751260742035-Introducing-the-new-Activity-view-in-Slack)
> - [Customize the Slack mobile app](https://slack.com/help/articles/29788684062739-Customize-the-Slack-mobile-app)

---

## 1. 結論 (要約)

- **一番効くのは会話画面**。毎日何十回も触るのは会話画面なので、ここを先に直す。
  - 長押しの操作を下からのシートに統一する。上段にクイックリアクション、下にラベル付きの操作一覧。3 端末とも今は「長い縦メニュー / 小さなドロップダウン / ラベル無しのアイコン 13 個」とバラバラ。
  - 見出しのアイコンを減らす。Android は 7 個あり、題名が隠れる。
  - iOS のスレッドをシートからプッシュ遷移に変える。
  - サーバの変更は要らず、工数は M。
- **次にナビゲーションの骨格を作る**。下部タブを「ホーム / DM / アクティビティ / 自分」の 4 つにする。
  - ホームは上部に横スクロールのタイル (スレッド・下書き・保存・リマインダー・ファイル) を置き、その下は折りたためるセクション、右下に新規メッセージの作成ボタン。
  - 今の固定 6 行と「すべて/未読」の切り替えはやめる。
  - 工数は L。Android は MainScreen.kt の状態管理を作り直すことになる。
- **サーバの変更が要るのは 2 つ**。
  - DM 一覧のプレビュー: ChannelOut に `last_message` を足す。工数 M。
  - アクティビティのリアクション通知と既読の印: `GET /activity` と `activity_read_at` を足す。工数 L。
  - どちらもタブの骨格ができてから段階的に入れる。アクティビティは、最初は既存の `/mentions` と `/threads` だけで出す。
- iPad / タブレット / Desktop の広い画面は、今のサイドバー型のままにする。タブ型にするのはスマホ幅だけ。

---

## 2. 現在のナビゲーションと画面 (正確な現状)

### 2.1 iOS
```
RootView ─ MainView (NavigationSplitView, MainView.swift:23)
 ├ サイドバー: ChannelListView
 │   ツールバー: [アバター→設定シート][接続点] 〈ワークスペース名〉 [🔍→検索シート][＋メニュー]
 │   [すべて|未読] / スレッド・メンション・下書き*・リマインダー*・ファイル・保存済み (*は件数>0 のとき)
 │   お気に入り / 自分のセクション / チャンネル (+チャンネルを探す) / DM / 参加できるチャンネル
 └ 詳細: selection で切替 (threads|saved|mentions|reminders|files|drafts|<channelId>)
     ChannelView: [リンク列] タイムライン [入力中…] [入力欄]
       ツールバー: 〈#名前 / トピック〉 [★][📌][🔔][ⓘ]
       シート: チャンネル情報 / ピン / メンバー追加 / リンク編集 / スレッド (ThreadView, .sheet)
```

### 2.2 Android
```
AppRoot ─ MainScreen (Scaffold 1 つ、状態 25 個、BackHandler 6 個)
 topBar: 検索中は SearchTopBar、それ以外は TopAppBar
   一覧:   [アバター→設定] 〈ワークスペース名〉 [接続点][🔍][⋮]
   会話:   [←] 〈#名前/トピック〉 [接続点][★][📌][📁][🔔][ⓘ][🔍][⋮]
   スレッド:[←] 〈スレッド/#名前〉 [接続点][フォロー chip][🔍][⋮]
 本文: search | pins | files | thread | saved | channel | reminders | mentions | drafts | threads | ChannelList
 ダイアログ: 新規 DM・メンバー・チャンネル作成・情報・設定・ブラウザ (多くは AlertDialog)
```

### 2.3 Web (幅 768px 未満)
一覧 (濃い色のサイドバーを全画面) と会話/各ビュー (左上に「戻る」) を 1 列ずつ切り替える。
- スレッドとピンは全画面で出る。
- 見出しはベルと ⋯ だけ。
- メッセージはタップで操作アイコン 13 個が下に浮かぶ。

---

## 3. ギャップ分析

| # | 項目 | Slack モバイル | iOS | Android | Web (スマホ) | 影響 | 工数 |
|---|---|---|---|---|---|---|---|
| 1 | 下部タブ | Home / DMs / Activity (+検索) | 無し | 無し | 無し | 大 | L |
| 2 | ホームの構成 | 上部タイル (Threads・Later・Drafts…)、折りたためるセクション、未読の会話は上に集まる | 固定 6 行が縦に並び、未読は全体を絞るフィルタ | 同じ | 同じ (サイドバー) | 大 | M |
| 3 | 移動 (Jump to) | ホーム上部の検索欄に最近の会話が出て、名前で移動できる | 検索シートの候補 (M16b) だけ | SearchBar の候補だけ | ⌘K の移動が有り | 中 | S |
| 4 | 新規作成ボタン | 右下の鉛筆 FAB で宛先を選ぶ | ＋メニューの中 | ⋮ メニューの中 | サイドバーの中 | 中 | S |
| 5 | 会話の見出し | 名前 + 人数/トピック、タップで全画面の詳細 | 4 アイコン | **7 アイコン + 接続点** | ベルと ⋯ (済) | 大 (Android) | S |
| 6 | 長押しの操作 | ボトムシート (上段にリアクション 6 + 追加、下にラベル付きの一覧、テキストをコピー) | contextMenu が最大 16 行 | 行に付くドロップダウン | ラベル無しのアイコン 13 個 | 大 | M |
| 7 | テキストのコピー | 有り | 本文の選択のみ (行の長押しと競合しうる) | **無し** | ブラウザで選択 | 中 | S |
| 8 | リアクションの表示 | 折り返し + 「＋」チップ | **折り返さない** | FlowRow、＋無し | 有り | 中 | S |
| 9 | スレッドの開き方 | プッシュ遷移、スワイプで戻る | シート + 閉じる | 全画面 (OK) | 全画面 (OK) | 中 | S |
| 10 | 過去ログの読み込み | 上端で自動 | **ボタン** | 自動 | 自動 | 中 | S |
| 11 | 返信のまとめ | 参加者のアバター + 件数 + 最終返信 | 件数だけ | 件数だけ | 件数だけ | 小 | S (アバターはサーバが要る) |
| 12 | 入力欄 | ＋ / Aa / @ / 😊 / / / カメラ、送信の長押しで予約 | ＋メニューのみ、書式・@ は無し | 添付・絵文字・時計、**カメラ無し** | 書式バー有り | 中 | M |
| 13 | アクティビティ | メンション・スレッド・リアクション・招待を 1 画面に、未読印 | メンションとスレッドが別の行、リアクション無し | 同じ | 同じ | 大 | L (サーバ) |
| 14 | DM 一覧 | 専用タブ、最後の発言のプレビューと時刻 | 名前とステータスだけ | 同じ | 同じ | 大 | M (サーバ) |
| 15 | 自分 (You) | ステータス・通知の一時停止・離席・環境設定がすぐ出る | 設定シート 1 枚、一時停止はステータスの奥 | 巨大な AlertDialog | ダイアログ | 中 | M |
| 16 | プル更新 | ホーム・DM・Activity | 一覧の一部だけ | 無し | 不要 | 小 | S |
| 17 | ハプティクス | 長押し・リアクション | 無し | combinedClickable の既定のみ | 無し | 小 | S |
| 18 | スワイプ | 一覧の既読・ミュートなど | お気に入りのみ | 無し | 無し | 小 | S |
| 19 | 配色・ダーク | ブランド色 + テーマの選択 | OS に追従、システムの青 | Material You (壁紙色) | OS に追従、#5b5bd6 | 小〜中 | S |
| 20 | 画面遷移 | プッシュ / 予測型「戻る」 | 有り (Nav) | **アニメーション無し** | 無し | 小 | S |

「スワイプで返信」は Slack 本家には無い (LINE や Teams 系の操作)。iOS の「戻る」スワイプや表の横スクロールとぶつかるので、既定では入れない案にする (決定事項 7)。

---

## 4. 優先順位 (影響 × 工数)

| 優先 | 内容 | サーバ | 理由 |
|---|---|---|---|
| P0 | 操作シート (#6 #7)、見出しの整理とチャンネル詳細の全画面化 (#5)、iOS のスレッドをプッシュに (#9)、iOS の過去ログ自動読み込み (#10)、リアクションの折り返しと＋ (#8)、ハプティクス (#17) | 不要 | 会話画面は毎回触る。工数は小さいのに 3 端末の差が大きい |
| P1 | 下部タブの骨格 (#1)、ホームの再構成 (#2 #3 #4)、アクティビティ段階 A (メンション + スレッド、既存 API) | 不要 | 使い方の型が Slack と同じになる。未読を辿る手数が減る |
| P1 | 「自分」タブと設定の画面化 (#15)、テーマの切り替え (#19) | 不要 | 研究室の用途では、学生がおやすみ時間や一時停止を見つけやすいことが大事 |
| P2 | 入力欄のツールバー (#12) | 不要 | iOS の書式ボタンは選択範囲の API 次第 (決定事項 6) |
| P2 | DM プレビュー (#14) | 要 | 新しいフィールドとイベント処理が要る |
| P2 | アクティビティ段階 B (リアクション・「すべて」・既読の印) (#13) | 要 | 新しい API、マイグレーション、docs の更新 |
| P3 | 一覧のスワイプ (#18)、プル更新 (#16)、セクション折りたたみの同期、画像のグリッド表示、返信の最終時刻と参加者、「次の未読へ」 | 一部 | 仕上げ |

---

## 5. 新しい情報設計 (スマホ幅)

```
TabView / NavigationBar (4 タブ、会話・スレッドの中ではタブバーを隠す)
 ├ ホーム      NavigationStack: Home → 会話 → スレッド / チャンネル詳細 / プロフィール
 ├ DM          NavigationStack: DM 一覧 → 会話 → スレッド
 ├ アクティビティ NavigationStack: Activity → 会話 (該当位置) / スレッド
 └ 自分        NavigationStack: You → 通知 / 表示 / プロフィール編集 / アカウント / ワークスペース
全画面で重ねるもの: 移動・検索 (ホーム上部から)、新規メッセージ (FAB)、画像ビューア
```
- 開いているタブをもう一度押すと、そのタブの先頭に戻る。先頭にいるときは一番上までスクロールする (Slack と同じ)。
- 通知をタップしたときの行き先:
  - DM: DM タブのスタックを [会話] に置き換える
  - チャンネル / スレッド: ホームタブのスタックを [会話, (スレッド)] に置き換える
  - アクティビティの行から開いたもの: アクティビティのスタックに積む
- 広い画面は今のサイドバー型 (iOS の NavigationSplitView、Android と Web の 2〜3 列) を続ける。サイドバーに「アクティビティ」(今の「メンション」を置き換え) と「DM」を足して、中身を揃える。

---

## 6. 画面ごとの仕様

### 6.1 ホーム
```
┌──────────────────────────────────┐
│ [WS] 研究室 ▾                       ⋯ │ ← 左: ワークスペース切替 (2 つ以上のとき)。⋯: すべて既読 / 未読をまとめる / チャンネルを探す / 作成 / メンバー一覧
│ 🔍 移動・検索…                          │ ← タップで 6.2 (iOS 26 風に下部へ置く案は決定事項 1)
│ [💬スレッド 3][📝下書き 2][🔖保存 5][⏰1][📁] │ ← 横スクロールのタイル (0 件のものは薄く表示)
├──────────────────────────────────┤
│ ▾ 未読              (「未読をまとめる」ON のとき)│
│ ▾ お気に入り                             │
│ ▾ 〈自分のセクション〉            ⋯        │
│ ▾ チャンネル                              │
│   #  general                           │
│   🔒 m2-進捗                   (2)      │ ← 44pt/48dp の 1 行。未読は太字、メンション数は赤い丸、ミュートは 55%
│   ＋ チャンネルを追加                       │
│ ▾ ダイレクトメッセージ (新しい順 5 件)          │
│   すべての DM → (DM タブへ)                 │
│                                  (✏️) │ ← 新規メッセージ
└──────────────────────────────────┘
```
- **行の密度**:
  - ホームの行ではトピックの 2 行目を出さない (トピックはブラウザと詳細で見せる)
  - グリフとアバターは 20〜24pt にする
  - 今 (36pt タイル + 2 行目) よりも 1 画面に並ぶ会話が増える
- **折りたたみ**:
  - セクションの見出しをタップして開閉する (iOS 17 の `Section(isExpanded:)`、Android は LazyColumn の見出し行)
  - 閉じていても、未読のある会話は表示する (Slack と同じ)
  - 開閉の状態: 自分のセクションはサーバで同期する (7.3)。組み込みのセクションは端末に保存する
- **未読**:
  - 今の「すべて/未読」ピッカー (ChannelListView.swift:29-36) とチップ (MainScreen.kt:564-568) はやめる
  - 代わりに「未読をまとめる」をオンにすると、先頭の「未読」セクションに未読の会話を集める (既存の `sidebar.unreadOnly` 設定を置き換え)
- **タイル**:
  - 今の固定 6 行を置き換える (「メンション」はアクティビティへ移る)
  - バッジの規則は今の行と同じにする。スレッドは threadSummary の件数でメンションがあれば赤、リマインダーは通知済みの件数で赤
- **プル更新**: エンジンの再同期 (bootstrap と表示中の catch_up) を呼ぶ。正しさは同期プロトコルが担うので、これは利用者が安心するための操作。
- **✏️ 新規メッセージ**:
  - 宛先を選ぶ画面を出す。チャンネルと人を 1 つの検索欄で選べ、複数人ならグループ DM、自分だけの DM (自分の名前、「メモや下書きに使える、自分だけの DM」) も選べる
  - 選んだら会話を開いて入力欄にフォーカスする
  - 既存の NewDmView / NewDmDialog とチャンネルのピッカーを使う

### 6.2 移動・検索 (全画面)
- 空欄のとき:
  - 「最近の会話」: 端末ごとに開いた順で最大 10 件。サーバは使わない
  - M16b の最近の検索とよく使う絞り込み
- 入力中:
  - 一致する会話を先頭に出し、タップで移動する
  - 次に人 (タップで DM を開く)、最後に「"語" をメッセージ検索」(既存の結果画面 SearchView / SearchResultsPane)
- Desktop の ⌘K (QuickSwitcher.tsx) と同じ一致規則にする。前方一致を先に、かな/英字は大文字小文字を区別しない。規則と検証ケースは `apps/shared/jump-match.json` (M37 で決定。⌘K もこれに合わせる)。
- 決定事項 1 (M37): 「移動・検索」の欄はホームの上部に置く。決定事項 5 (M37): Web のスマホ幅のホームは明るい地のリスト。

### 6.3 DM タブ
```
│ ダイレクトメッセージ                    (✏️)│
│ 🔍 DM を検索     [すべて][未読]              │
│ (av●) 山田先生                  14:32     │
│       あなた: 了解しました、明日の…           │
│ (av)  佐藤, 鈴木                昨日  (3)  │
│       佐藤: スライド共有します                │
```
- 行は 64pt/72dp。1 行目は名前と時刻、2 行目はプレビュー。
  - 時刻は「今日なら時刻 / 昨日 / 7 日以内なら曜日 / それより前は M/d」
  - プレビューの先頭 (M49 で決定): 自分のものは「あなた: 」(自分だけの DM では付けない)。1:1 DM の相手のものは
    何も付けない (行の名前が相手なので。Slack と同じ)。グループ DM は「<表示名>: 」(知らない人は「メンバー: 」)。
    system メッセージは先頭なし。まだ何も無ければ 2 行目は今までどおり (ステータス・プレゼンス・人数)
  - 添付だけなら通知と同じ言い方 (「画像を送信しました」「ファイルを 2 件送信しました」…)
  - 未読のときはプレビューも太字 (Slack と同じ)。ステータスの絵文字は 1 行目の名前の後ろ
  - 規則は Web の `ui/dmPreview.ts` の `previewLine` / `previewExcerpt`。検証ケースは `apps/shared/dm-preview.json`
    (サーバ・3 端末共通)
- 並び順は last_message_at の新しい順 (今の順と同じ)。自分だけの DM (メンバーが自分だけ) は先頭に固定し、まだ無いときも先頭に出す。最初に開いたときに作る。名前は自分の表示名 (Slack / Mattermost と同じ)。ホームの「ダイレクトメッセージ」でも先頭 (畳んだとき・未読だけのときは出さない)。空の会話と履歴の始まりには「ここはあなただけのスペースです。メモや下書き、あとで見返したいリンクやファイルを置いておけます。ほかの人には見えません。」 (2026-09-29 追加・変更)。
- スワイプ: 右→左は「既読にする」(`PUT /channels/{id}/read`)、左→右は「お気に入り」。長押しはお気に入り・セクションへ移動・通知の設定。
- プレビューにはサーバの `last_message` を使う (7.1)。M49 でサーバと Web が対応、iOS / Android は次。

### 6.4 アクティビティ
```
│ アクティビティ                            ⋯ │ ← ⋯: すべて既読
│ [すべて][メンション][スレッド][リアクション]       │
│ ● (av) 山田先生 · #輪講 · 10:05             │
│        @あなた 来週の発表順を…                │
│ ● 💬 「学会の締切」 3 件の新しい返信 · #m2-進捗   │
│   (av) 佐藤 ほか 2 人が 👍 「スライド v2 です」    │
```
- **段階 A (サーバ変更なし)**:
  - フィルタは [メンション | スレッド] の 2 つ
  - メンションは `GET /mentions` を使い、行は既存の MessageCardView
  - スレッドは `GET /threads` を使い、行は既存の ThreadRowView / ThreadsPane
  - タップしたら revealMessage / スレッド画面を開く
  - タブのバッジは今の threadSummary と、メンションのある会話の数で出す
- **段階 B (7.2)**: 「すべて」と「リアクション」を足し、項目ごとに未読の点、「すべて既読」を付ける。
  - 未読は `activity_read_at` より新しい項目。端末をまたいで同期する
  - タブのバッジは未読の項目数。メンションを含むときは赤
- 研究室向けの候補: 「確認依頼」フィルタ。確認を求められていて自分がまだ確認していない投稿 (M15e の ack) を出す (決定事項 3)。

### 6.5 自分 (You)
```
│ (64) 山田 太郎                       │
│      @yamada · M2                    │
│ [😀 ステータスを更新]                   │ ← 既存の StatusEditorView (ステータスだけにする)
│ 🔕 通知を一時停止            オフ  >     │ ← 30 分 / 1 時間 / 2 時間 / 明日 8:00 / 日時を指定 / 再開
│ 🌙 おやすみ時間       22:00〜07:00  >    │ ← 今は StatusEditorView の中にある (ProfileSheet.swift:201-217)
│ (離席中にする)             [  ]        │ ← 決定事項 8 (サーバ変更)
│ 🔔 通知 (キーワード・端末の通知)      >    │
│ 🎨 表示 (端末に合わせる/ライト/ダーク、連続した投稿をまとめる) > │ ← 端末ごとの設定 (サーバ変更なし)
│ 👤 プロフィールを編集 (写真・表示名・肩書) > │
│ 🔒 アカウント (パスワード・2 要素認証・ログイン中の端末) > │ ← 端末一覧は既存の GET/DELETE /auth/sessions を使う
│ 🏢 ワークスペース                    >    │
│ ログアウト (赤)                         │
```
- iOS: SettingsView (Sheets.swift:390-588) をいくつかのプッシュ画面に分ける。
- Android: SettingsDialog (Dialogs.kt:330-455) と StatusDialog の AlertDialog をやめて、画面にする。
- 表示の「連続した投稿をまとめる」(M47、2026-09-30 追加): 端末ごと、初期値オフ。オフのときはチャンネル・DM・スレッドのどれでも投稿ごとにアイコンと名前を出す。オンのときはどれでも、同じ人の続けての投稿の 2 つ目以降をまとめる。Desktop は設定の「表示」に同じスイッチを置く。

### 6.6 会話画面
**見出し**:
```
[‹] [#] 輪講 ›  🔕            [🔍]
     12 人 · 毎週木曜の輪講
[📌 ピン 3] [📁 ファイル] [🔗 リンク…] [＋]     ← 見出しの下のタブ列 (今のリンク列 ChannelLinksRow を広げたもの)
```
- 題名をタップするとチャンネル詳細を全画面で開く (6.8)。
- 右端は「このチャンネル内を検索」だけにする。M16b の channel 絞り込みを付けて開く。
- ★・ベル・ⓘ・メンバー追加は詳細へ移す。ミュート中は題名の横に 🔕 を出すだけにする。
- Android からは ★📌📁🔔ⓘ🔍⋮ と接続点が消える (接続の状態は既存の ConnectionBanner で十分)。
- 研究室向けに「キャンバス」「times」を足すときは、このタブ列に並べる (別途の設計と合わせる)。

**タイムライン**:
- まとめ方の規則は今のまま (5 分、Timeline.swift:43 / Timeline.kt:24、3 端末で同じ)。
- リアクション:
  - 折り返す。iOS は Layout プロトコルで FlowLayout を作る
  - 最後に「☺︎＋」チップを置く
- 返信のまとめ: 「💬 3 件の返信 · 最終 14:32」にする。最終返信時刻は既存の `last_reply_at` を使う。参加者のアバターは P3 でサーバが要る。
- 画像が 2 枚以上なら 2 列のグリッドで出す。今は縦に並ぶ (AttachmentsView.swift)。
- iOS も上端で過去ログを自動で読む。Android と同じく、上端の番兵が表示されたら loadOlder する。

**長押しの操作シート (3 端末で内容と順番を揃える)**:
```
┌──────────────────────────────┐
│ 山田 · 「来週の発表順を…」(1 行のプレビュー)    │
│ 👍 ❤️ 😂 🎉 👀 ✅   [☺︎＋]              │
├──────────────────────────────┤
│ 💬 スレッドで返信                          │
│ 📋 テキストをコピー                         │ ← 新規。コピーする中身は Mentions.decode した本文 (記法はそのまま)
│ 🔗 リンクをコピー                           │
│ 🔖 保存 / 保存を解除                        │
│ ⏰ リマインド                        >     │
│ ↗︎ 別のチャンネルに共有                      │
│ 📌 ピン留め / 外す                          │
│ ✉️ ここから未読にする                       │
│ ✏️ 編集                    (自分の投稿)     │
│ 🗑 削除 (赤)          (自分の投稿 / 管理者)  │
└──────────────────────────────┘
```
- iOS:
  - `.onLongPressGesture(minimumDuration: 0.35)` と `.sensoryFeedback(.impact(weight: .medium), trigger:)` で開く
  - シートは `.sheet` + `.presentationDetents([.medium, .large])`
  - contextMenu をやめる代わりに `.accessibilityActions` で同じ操作を VoiceOver に出す
  - 本文の `.textSelection` は、長押しとの競合を実機で確かめたうえで外す。外したら、選択したいときはシートの「テキストを選択」で選べる全文を出す
- Android:
  - `ModalBottomSheet` を使い、MessageMenu (MessageActions.kt:35-73) を置き換える
  - TalkBack 向けに `semantics { customActions }` を付ける
- Web: styles.css:109-117 の浮くアイコン列をやめる。長押し (pointer で 450ms) またはタップで出る「⋯」から、下からのシート (Radix Dialog) を開く。

**入力欄**:
```
閉じているとき: [＋] [ #輪講 へのメッセージ        ] [➤]
フォーカス中:   [ 本文…                            ]
               [＋][Aa][@][☺︎][/][🚩]            [➤]   ← 🚩 は重要度と「確認を求める」(トップレベルの投稿のみ)
Aa → 書式バー [B][I][S][`][```][🔗][•][1.][❝] (選択範囲を記法で囲む。DATA_MODEL.md「本文の形式」に従う)
＋ → シート: 最近の写真 (横スクロール) / カメラ / ファイル / 投票 (/poll) / 後で送信…
➤ 長押し → 後で送信 (プリセット + 日時指定)
```
- iOS:
  - 書式ボタンには選択範囲が要る。iOS 18 なら `TextField(text:selection:)`、iOS 17 のままなら UITextView のラッパーを作る (決定事項 6)
  - 送信の長押しは Menu の primaryAction で作る
- Android:
  - 写真は `PickMultipleVisualMedia` (権限は不要)
  - カメラは `TakePicture` と FileProvider (マニフェストに追加)
  - 選択範囲は `TextFieldValue` で扱える
- Web: Composer.tsx の書式バー (M16d で折りたためる) を、スマホでは入力欄の下の 1 行に出す。

### 6.7 スレッド
- iOS:
  - 各タブの NavigationStack に `navigationDestination` でプッシュする
  - ThreadView の中の NavigationStack と「閉じる」(ThreadView.swift:32,105) は外す
  - フォローはツールバーのベルのアイコンにする
- Android と Web は今の全画面のまま。フォローのチップはベルのアイコンにする (MainScreen.kt:336-348)。

### 6.8 チャンネル詳細 (全画面)
- 上から順に:
  - 大きなグリフ、名前、トピック
  - 丸いボタンの列: [★ お気に入り][🔔 通知][🔍 検索][👤＋ 追加]
  - 説明とトピック (編集できる)
  - メンバー (N) の一覧
  - ピン / ファイル / リンク
  - 通知 (3 択 + 8 時間ミュート)
  - 管理 (名前の変更・投稿の制限・公開/非公開の変換・アーカイブ・退出)
- iOS: ChannelInfoView (Sheets.swift:155-387) の中身はほぼそのまま使い、シートからプッシュ遷移に変える。
- Android: ChannelInfoDialog (Dialogs.kt:156-) を画面にする。ProfileDialog はボトムシートにする。

---

## 7. データモデル / API の変更 (P2 以降、OpenAPI と docs も一緒に更新する)

### 7.1 DM (と会話) のプレビュー
- `ChannelOut.last_message: {id, sender_id, type, seq, excerpt, has_attachments, created_at} | null` を足す (M49 で実装)。
  - 対象はトップレベルと `also_in_channel` の投稿で、削除済みは除く
  - excerpt はサーバの `notification_text()` (messages/mentions.py) で作る。メンションを名前にして 140 文字まで。本文が無ければ `attachment_text()`。プッシュの本文と同じ規則になる
  - `seq` は取り直しの応答と手元の値の新旧を比べるため、`type` は system メッセージに先頭を付けないため
- 返すのは **会員に向けた応答だけ** (bootstrap と `GET /channels`・`GET /channels/{id}`・既存の DM を返す `POST /dms`)。
  - `channel.updated` は非会員にも配ることがある (M15b) ので、ここには含めない。他の応答とイベントでは常に null で、クライアントは持っている値を残す
  - DM に限らず会員の会話すべてに入れる。1 会話 1 回のインデックス参照で、DM だけに絞っても問い合わせの数も時間もほぼ変わらないため。クライアントが出すのは今は DM 一覧だけ
- クライアントでの更新 (SYNC_PROTOCOL.md §7.8):
  - `message.created` (タイムラインの行) が来たら置き換える。**`synced_seq` が null の会話でも更新する**
  - `message.updated` で同じ id なら本文を差し替える
  - `message.deleted` で同じ id なら、持っているタイムラインのその前の行にする。持っていなければ `GET /channels/{id}` を取り直す
- 性能: LATERAL で (channel_id, seq) の一意インデックスを逆順にたどる (マイグレーション不要)。chikuwa_perf (103 会話・47 万件) で全会話 1 クエリ 1 ms (温まった状態、初回 24 ms)。bootstrap の問い合わせの数は会話の数で増えない (テストあり)。重くなったら `channels.last_message_id` を last_message_at と同じトランザクションで更新する (messages/repository.py の allocate_seq)。

### 7.2 アクティビティ (段階 B)
- `GET /api/v1/activity?filter=all|mentions|threads|reactions&cursor=&limit=50`
  - 返す形: `{items:[{kind:"mention"|"reaction"|"thread_reply", at, message: MessageOut, actor_ids:[…], emoji?, thread?}], next_cursor, read_at}`
  - mention は既存の `/mentions` の問い合わせ、reaction は `reactions ⋈ messages (sender_id = 自分, reactions.user_id ≠ 自分)`、thread_reply はフォロー中のスレッドの新しい返信。これらを `UNION ALL` して、(at, kind, id) のカーソルで並べる
  - 今参加している会話だけに絞る。削除済みは除く。ゲストの見える範囲も守る
  - 必要なら `reactions (created_at)` にインデックスを足す
- `PUT /api/v1/activity/read {read_at}` を足す。read_state と同じく大きい方にだけ進める (max-merge)。
  - 自分の他の端末には `activity.read` (audience=user) を送る
  - bootstrap に `activity: {read_at, unread_count}` を足す。他のワークスペースのバッジ用に `GET /sync/summary` にも足す
- 保存するのは `users.activity_read_at timestamptz` の 1 列だけ (マイグレーション 1 本)。
  - 項目ごとに既読の行は作らない (CLAUDE.md の ReadState と同じ考え方)
- 接続中の件数:
  - クライアントがイベントから数える。メンションの `message.created`、自分の投稿への `message.updated change=reaction`、`thread.updated`
  - 再接続したら bootstrap の値で直す (WS だけに頼らない)

### 7.3 セクションの折りたたみ
- `sidebar_sections.collapsed bool` を足し、`PATCH /sidebar/sections/{id}` で変える。組み込みのセクション (未読・お気に入り・チャンネル・DM) は端末に保存する。

### 7.4 更新する docs
- DATA_MODEL.md: `last_message`、`activity_read_at`、`collapsed`
- SYNC_PROTOCOL.md: §4.1 の bootstrap の欄、§6 の `activity.read`、§7.4 のプレビュー更新
- openapi.json と各クライアントの生成物
- IMPLEMENTATION_PLAN.md: M17 の行として足す

---

## 8. 3 クライアントで揃えるもの
- タブの名前・順番・バッジの規則 (DM タブ = 未読のある DM の数、アクティビティ = 未読の項目数でメンションがあれば赤、ホーム = 未読メンションがあれば点)。
- ホームのセクションの順番、折りたたんでも未読は出す規則、タイルの種類と並び順。
- 操作シートの項目・順番・文言。クイックリアクションは今の `["👍","❤️","😂","🎉","👀","✅"]` (ChannelView.swift:347、MessageActions.kt:32、Web の REACTION_PALETTE) を使い続ける。
- プレビューの文言 (あなた: / 送信者名: / 添付の言い方。§6.3) と時刻表示の規則。既存の excerpt 関数 (Timeline.excerpt / plainText / Web) に揃える。検証ケースは `apps/shared/dm-preview.json` (M49)。
- 未読の判定 (showsUnread / badgeContribution、Store.swift:31-33 と Channels.kt と channels.ts) は変えない。
- 契約テスト (ContractTests.swift / ContractTest.kt / Web) に、プレビューとアクティビティ既読の fixture を足す。

---

## 9. クライアントごとの作業

**iOS**
- 新規ファイル:
  - `HomeView` (ChannelListView から作る)、`DMListView`、`ActivityView` (MentionsView と ThreadsListView を中に持つ)、`YouView` (SettingsView を分けたもの)
  - `MessageActionSheet`、`JumpView`、`ComposeDestinationView`、`FlowLayout`
- 変更するファイル:
  - MainView: 幅が compact のときは TabView と各タブの `NavigationStack(path:)`、広いときは今の SplitView
  - ChannelView: ツールバー、過去ログの自動読み込み、スレッドのプッシュ、contextMenu の削除
  - ThreadView、ChannelInfoView (プッシュにする)、ComposerView (ツールバー)
- テスト: 新しい画面ごとにスナップショットテスト (`TEST_RUNNER_SNAPSHOT_DIR` の既存の方式)、プレビュー更新とアクティビティの件数の単体テスト。

**Android**
- MainScreen.kt を分ける:
  - `MainNav` (sealed Route、タブごとの戻るスタック、NavigationBar、AnimatedContent、予測型「戻る」)
  - `HomeScreen` / `DmListScreen` / `ActivityScreen` / `YouScreen`
  - `MessageActionSheet`、`ChannelDetailsScreen`、設定の各画面 (AlertDialog をやめる)
- その他の変更:
  - `PullToRefreshBox`
  - Theme.kt のブランド色の ColorScheme
  - 入力欄のツールバー、カメラと写真ピッカー
- 戻るスタックは自前の `SnapshotStateList<Route>` にし、依存は増やさない。Navigation 3 と同じ考え方なので、後から移るのも簡単。
- テスト: Channels.sections (折りたたみ・未読セクション)、ナビゲーションの状態遷移 (検索結果へ戻る流れを含む)、プレビューの更新の JUnit。

**Web (スマホ幅だけ)**
- `MobileTabBar`
- MainScreen の compact 分岐を `tab` と画面スタックで書く
- `ActivityView` (MentionsView を広げる)、`DmListView`、`YouView`、`MessageActionSheet` (styles.css:109-117 を置き換える)
- ホームは明るい地のリストにする。サイドバーの濃い色は見出しの帯だけに残すか、決定事項 5 で決める
- vitest のテストが頼る `timeline` / `composer` / `message` のクラス名は残す

---

## 10. リスクと対策
1. **既読と通知抑止の判定が崩れる**。
   - TabView は隠れたタブの画面も生かしておく。ChannelView の markRead (ChannelView.swift:52-61) は、隠れていても `engine.status` や scenePhase の変化で、古い visibleFrames のまま既読を進めてしまう
   - 対策: 「選ばれているタブの一番上の画面であること」を条件に加える。`engine.currentChannelId` (MainView.swift:119-124) もその画面だけが設定する
   - Android も同じ (ChannelPane.kt:109-121)
2. **通知タップとリンクの行き先**。
   - `chikuwaOpenChannel` (MainView.swift:125-138)、`pendingChannelId` と `pendingReveal` (MainScreen.kt:168-175,275-279) を、タブを選ぶ処理に書き直す
3. **Android の作り直しで既存の挙動が壊れる**。
   - M16b の「検索結果に戻る」(backToSearch / searchThread、MainScreen.kt:104-107,234-262)、ワークスペースごとの状態保存 (AppRoot.kt:33) を保つ
   - 状態遷移を純粋関数にしてテストする
4. **iOS 17 の制約**。選択範囲の binding と Tab API は iOS 18 から。書式バーは UIKit のラッパーで作るか、最低バージョンを上げる。
5. **プライバシー**。
   - `last_message` を非会員に向けたイベントに入れない
   - アクティビティは退出した非公開チャンネルの項目を返さない
   - ゲストの見える範囲を守る
6. **性能**。
   - ホームのセクションは描画のたびに再計算しているが、数十会話なら問題ない
   - タブごとに会話画面を生かしておくとメモリが増える。タブを切り替えたら会話の timeline 計算を止めるか、前面のタブ以外はスタックを浅くする
   - アクティビティの UNION は計測してからインデックスを決める
7. **アクセシビリティの後退**。contextMenu をやめても、VoiceOver と TalkBack のカスタムアクションで同じ操作ができるようにする。タップ領域は 44pt/48dp 以上。
8. **3 端末の差**。仕様表 (8 章) を IMPLEMENTATION_PLAN に載せ、契約テストの fixture と各端末のスナップショット/目視で確かめる。
9. **研究室向け機能との重なり**。times やキャンバスの入口 (ホームのタイル、会話のタブ列) をこの設計で空けておき、別途の設計と合わせる。

---

## 11. 検証方針 (実装時)
- iOS: `xcodegen generate` と xcodebuild test (スナップショットで各画面をライト/ダーク、iPhone SE と Pro Max の幅)。実機で長押し・ハプティクス・VoiceOver を確かめる。
- Android: `:app:testDebugUnitTest :app:lintDebug :app:assembleDebug`。エミュレータの 360dp / 411dp で見出し・シート・予測型「戻る」を目視する。
- Web: tsc と vitest と build。headless Chrome の 390px / 360px (タッチ、ライト/ダーク) で見て、1400px の表示が変わらないことも確かめる。
- サーバ (P2): pytest (権限・ゲスト・退出後・削除・カーソル)、ruff と mypy、マイグレーションの往復、OpenAPI の再生成。
