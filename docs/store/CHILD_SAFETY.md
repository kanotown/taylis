# 子どもの安全基準（Google Play の「子どもの安全基準に関するポリシー」）

Google Play は、ソーシャル・コミュニケーションのアプリに次を求める（2026-10-06 に Taylis が指摘を受けた）：

1. 児童の性的虐待と搾取（CSAE）を明確に禁止する、**公開の基準**（世界中から見られるウェブページ）
2. アプリを離れずに利用者が懸念を送れる、**アプリ内のフィードバックの手段**
3. CSAM（児童性的虐待のコンテンツ）への対応と、関係する法律の順守
4. 子どもの安全についての**連絡先**

2 はメッセージの報告（MODERATION.md §3。メッセージの操作 →「報告する」）があったが、審査では見つけてもらえず
「アプリを離れずにフィードバックを送る手段を用意すること」として差し戻された（2026-10-06）。そこで M119 で、
メッセージを選ばずに送れる報告（MODERATION.md §3.1）を足した：「設定」→「問題を報告・ご意見」（いつでも見える
場所）と、相手のプロフィール →「報告する」。種類に「子どもの安全」があり、届いた報告は管理者への DM の先頭に
「⚠️ 子どもの安全」と出る。足りなかったのは、この見える場所の手段と、1 の公開ページと、Play Console の申告。

## 1. 公開ページ

置き場所: 加納のサイト（プライバシーポリシー・サポート・アカウント削除と同じ並び）
`https://kano.ac/pages/apps/taylis-child-safety/`。下の文面をそのまま載せる（日本語と英語を 1 ページに）。

---

### Taylis 子どもの安全基準 / Child Safety Standards

最終更新：2026 年 10 月 6 日

Taylis（開発：加納 徹）は、児童の性的虐待と搾取（CSAE）を一切容認しません。

**禁止事項**

Taylis では、次の行為とコンテンツを禁止します。

- 児童性的虐待のコンテンツ（CSAM）の投稿・共有・保存・要求
- 児童を性的な対象とするコンテンツ（画像・動画・文章・イラストを含む）
- 児童への性的な目的での接近（グルーミング）、性的な勧誘、性的な脅迫（セクストーション）
- 児童の人身売買、その他児童を性的に搾取するあらゆる行為

**報告の方法**

- アプリの「設定」→「問題を報告・ご意見」：種類（「子どもの安全」など）を選び、内容を書いて送信します。
  特定のメッセージや相手がなくても、いつでも送れます。
- 相手のプロフィール →「報告する」：その人についての懸念を送れます。
- 問題のメッセージを長押し（デスクトップでは右クリック）→「報告する」：理由を選んで、そのメッセージを報告します。
- どの方法もアプリを離れずに送れ、報告はそのサーバの管理者全員に直ちに届きます。
- ユーザーのブロック：相手のプロフィールから「ブロック」を選べます。
- 開発者への連絡：下の連絡先へメールでお知らせください。

**対応**

- CSAE にあたるコンテンツを確認した場合、速やかに削除し、関係するアカウントを停止します。
- CSAM を確認した場合は、適用される法律に従い、警察などの関係機関（日本ではインターネット・ホットラインセンター、
  海外では NCMEC などの各国の窓口）に報告します。
- Taylis は日本の「児童買春、児童ポルノに係る行為等の規制及び処罰並びに児童の保護等に関する法律」をはじめ、
  子どもの安全に関する適用される法律を順守します。

**連絡先（子どもの安全に関する窓口）**

加納 徹（Taylis 開発者）　kanotown[at]gmail.com（[at] を @ に置き換えてください）

---

Taylis has zero tolerance for child sexual abuse and exploitation (CSAE).

**Prohibited**: posting, sharing, storing or requesting child sexual abuse material (CSAM); content that sexualizes
minors (images, video, text or illustrations); grooming, sexual solicitation or sextortion of minors; trafficking or
any other sexual exploitation of children.

**How to report**: in the app, open Settings > "Report a problem / feedback" (問題を報告・ご意見), choose a category
(such as "Child safety") and describe the concern; no message or person needs to be selected. You can also report a
person from their profile ("Report", 報告する), or long-press a message (right-click on desktop) and choose "Report".
Reports reach all administrators of the server immediately, without leaving the app. You can also block a user from
their profile, or email the contact below.

**What we do**: we promptly remove CSAE content and suspend the accounts involved. We report CSAM to the relevant
authorities as required by applicable law (such as the Internet Hotline Center in Japan and NCMEC or the national
hotline elsewhere). Taylis complies with applicable child safety laws.

**Child safety contact**: Toru Kano (developer of Taylis), kanotown[at]gmail.com (replace [at] with @).

---

## 2. Play Console の申告

Play Console → ポリシー → アプリのコンテンツ →「子どもの安全基準」：

| 質問 | 答え |
|---|---|
| CSAE を禁止する公開の基準 | `https://kano.ac/pages/apps/taylis-child-safety/` |
| アプリ内のフィードバックの手段 | あり：「設定」→「問題を報告・ご意見」（種類に「子どもの安全」、メッセージや相手を選ばずに送れる）、プロフィール →「報告する」、メッセージの長押し →「報告する」。どれもアプリを離れずに送れ、サーバの管理者全員に届く |
| CSAM への対応 | 確認したら削除し、法律に従って関係機関に報告する |
| 法律の順守 | 順守する |
| 子どもの安全の連絡先 | 加納 徹、kanotown@gmail.com |

申告を保存したら、指摘の出ているリリース（またはアプリ）の審査を出し直す。

## 3. 運用の注意

- 報告はアプリの各サーバの管理者に届く（研究室など、組織ごとの運用）。開発者が運営するサーバ（本番・デモ）では、
  報告の DM と「管理 → 報告」を開発者が見る。
- ページの文面と実際の機能（報告・ブロック・管理者による削除）を合わせておく。報告の場所を変えたら、このページも直す。
