# ruff: noqa: RUF001  (the chat text uses full-width exclamation and question marks)
"""The fictional demo lab (people, channels and conversations) that `app.cli seed-demo` writes.

Everything here is made up. Times are `(day, "HH:MM")` in Asia/Tokyo, where day 0 is the "anchor"
day (today, or yesterday when the seed runs before noon) and -13 is almost two weeks earlier; day-0
posts stay before 12:00 so that nothing is in the future. In bodies, `<@username>` becomes a
mention, `<!channel>` stays a channel mention and `{d+N}` / `{d-N}` becomes the date N days after
(before) the anchor, e.g. 「10/16（金）」.
"""

from dataclasses import dataclass, field

WORKSPACE_NAME = "Taylis デモ研究室"
WORKSPACE_NAME_EN = "Taylis Demo Lab"
DEMO_WORKSPACE_NAMES = (WORKSPACE_NAME, WORKSPACE_NAME_EN)
TZ = "Asia/Tokyo"
POOL_NAME = "Claude Premium シート（デモ）"


@dataclass(frozen=True)
class Person:
    username: str
    display_name: str
    title: str
    affiliation: str  # lab roster: faculty | student
    rank: str | None = None
    grade: str | None = None
    supervisor: str | None = None
    reading: str | None = None
    research_topic: str | None = None
    admin: bool = False
    status: tuple[str, str] | None = None  # (emoji, text)


# The professor is the workspace administrator (creates the reservation pool, edits the roster).
CAST: tuple[Person, ...] = (
    Person(
        "tanaka",
        "田中 一郎",
        "教授",
        "faculty",
        rank="professor",
        reading="たなか いちろう",
        research_topic="機械学習・自然言語処理",
        admin=True,
    ),
    Person(
        "suzuki",
        "鈴木 花子",
        "助教",
        "faculty",
        rank="assistant_professor",
        reading="すずき はなこ",
        research_topic="データ解析・実験計測",
    ),
    Person(
        "watanabe",
        "渡辺 美咲",
        "D1",
        "student",
        grade="D1",
        supervisor="tanaka",
        reading="わたなべ みさき",
        research_topic="少数ラベルでの学習",
        status=("📝", "論文執筆中"),
    ),
    Person(
        "takahashi",
        "高橋 健太",
        "M2",
        "student",
        grade="M2",
        supervisor="tanaka",
        reading="たかはし けんた",
        research_topic="学習率スケジュールの比較",
    ),
    Person(
        "nakamura",
        "中村 大輝",
        "M2",
        "student",
        grade="M2",
        supervisor="suzuki",
        reading="なかむら だいき",
        research_topic="センサデータの異常検知",
        status=("🎤", "学会準備中"),
    ),
    Person(
        "yamamoto",
        "山本 さくら",
        "M1",
        "student",
        grade="M1",
        supervisor="suzuki",
        reading="やまもと さくら",
        research_topic="Attention の可視化",
    ),
    Person(
        "ito",
        "伊藤 翔",
        "B4",
        "student",
        grade="B4",
        supervisor="suzuki",
        reading="いとう しょう",
        research_topic="小型センサの較正",
    ),
)

# The account for reviewers (App Store review, visitors): a regular member, M1, supervised by 鈴木.
REVIEW_DISPLAY_NAME = "Review User"
REVIEW = Person(
    "review",
    REVIEW_DISPLAY_NAME,
    "M1",
    "student",
    grade="M1",
    supervisor="suzuki",
    reading="れびゅー",
    research_topic="関連研究のサーベイと再現実験",
)

TEXT_EMOJI = (
    # name, label, colour, keywords
    ("confirmed", "確認しました", "green", ["かくにん", "確認"]),
    ("thanks", "ありがとうございます", "pink", ["ありがとう", "感謝"]),
    ("noted", "承知しました", "blue", ["しょうち", "了解"]),
)


@dataclass(frozen=True)
class ChannelSpec:
    key: str
    name: str
    owner: str
    type: str  # public | private
    topic: str
    members: tuple[str, ...] | None = None  # None: everyone (the cast and the review account)


CHANNELS: tuple[ChannelSpec, ...] = (
    ChannelSpec("general", "お知らせ", "tanaka", "public", "研究室全体へのお知らせ"),
    ChannelSpec("meeting", "研究ミーティング", "tanaka", "public", "毎週月曜 13:00〜 進捗共有"),
    ChannelSpec(
        "equip", "機材予約", "suzuki", "public", "GPU サーバ・実験機材・Claude シートの予約"
    ),
    ChannelSpec(
        "papers", "論文紹介", "watanabe", "public", "読んだ論文を気軽に共有 / papers (JA・EN)"
    ),
    ChannelSpec("chat", "雑談", "ito", "public", "なんでも"),
    ChannelSpec(
        "weekly", "週報", "tanaka", "public", "毎週月曜に週報のスレッドが立ちます。返信して提出"
    ),
    ChannelSpec(
        "conf",
        "学会準備",
        "tanaka",
        "private",
        "11 月の学会発表の準備",
        ("tanaka", "suzuki", "nakamura", "yamamoto", "ito", "review"),
    ),
)
DEFAULT_CHANNELS = ("general", "meeting", "chat")

# Times channels (`times-<username>`): made by their owners; the supervisors join.
TIMES_OWNERS = ("watanabe", "takahashi", "review")

# DMs: key -> the people in it (the first one opens it).
DMS: dict[str, tuple[str, ...]] = {
    "dm_suzuki_review": ("suzuki", "review"),
    "dm_tanaka_review": ("tanaka", "review"),
    "dm_suzuki_yamamoto": ("suzuki", "yamamoto"),
    "gdm_dinner": ("ito", "yamamoto", "nakamura", "review"),
}


@dataclass(frozen=True)
class Post:
    channel: str  # a ChannelSpec key, "times:<username>" or a DMS key
    author: str
    at: tuple[int, str]
    body: str
    key: str | None = None
    parent: str | None = None  # the key of the thread's root
    reactions: dict[str, tuple[str, ...]] = field(default_factory=dict)
    priority: str | None = None
    ack_requested: bool = False
    acks: tuple[str, ...] = ()
    poll: dict[str, object] | None = None
    votes: tuple[tuple[str, int], ...] = ()  # choice poll: (who, option index)
    answers: dict[str, tuple[str, ...]] = field(default_factory=dict)  # schedule poll: answers
    files: tuple[str, ...] = ()  # keys of FILES
    pin: bool = False


ALL_STUDENTS = ("watanabe", "takahashi", "nakamura", "yamamoto", "ito")

POSTS: tuple[Post, ...] = (
    # ---- #お知らせ ---------------------------------------------------------------------------
    Post(
        "general",
        "tanaka",
        (-13, "09:00"),
        "後期のゼミは毎週月曜 13:00〜 2 号館 3 階のセミナー室です。\n"
        "進捗は #研究ミーティング に、週報は #週報 のスレッドにお願いします。",
        key="g_rules",
        pin=True,
        reactions={
            "👍": ("suzuki", "watanabe", "takahashi", "nakamura", "yamamoto", "ito", "review")
        },
    ),
    Post(
        "general",
        "suzuki",
        (-9, "17:10"),
        "共用 PC のパスワードを変更しました。新しいものは研究室の掲示板に貼ってあります。",
        reactions={":noted:": ("watanabe", "takahashi", "ito")},
    ),
    Post(
        "general",
        "suzuki",
        (-6, "10:00"),
        "研究室の大掃除を {d+10} 15:00 から行います 🧹\n都合の悪い人は早めに連絡してください。",
        reactions={":noted:": ("takahashi", "yamamoto", "ito"), "👍": ("nakamura",)},
    ),
    Post(
        "general",
        "tanaka",
        (-3, "17:30"),
        "<!channel> 来週月曜の全体ミーティングは 13:00 から 2 号館 3 階のセミナー室で行います。\n"
        "各自、進捗スライドを 3 枚程度用意してください。",
        key="g_meeting",
        priority="important",
        ack_requested=True,
        acks=("suzuki", "watanabe", "takahashi", "nakamura"),
        reactions={":confirmed:": ("suzuki", "watanabe", "takahashi", "nakamura")},
    ),
    Post(
        "general",
        "suzuki",
        (-1, "08:50"),
        "秋の交流会のお店を決めたいので、投票をお願いします！（日程は {d+12} の夜です）",
        key="g_poll",
        poll={
            "question": "秋の交流会、どのお店がいいですか？",
            "options": ["駅前のイタリアン", "大学近くの焼き鳥屋", "中華料理（円卓あり）"],
            "multiple": True,
        },
        votes=(
            ("tanaka", 1),
            ("watanabe", 0),
            ("watanabe", 2),
            ("takahashi", 1),
            ("nakamura", 2),
            ("ito", 1),
        ),
        reactions={"🎉": ("ito", "takahashi")},
    ),
    Post(
        "general",
        "tanaka",
        (0, "09:15"),
        "学会発表の練習会を {d+2} 16:00 から行います。発表者は伊藤さんと中村さんです。"
        "聞きに来られる人はぜひ。",
        reactions={"🙏": ("ito", "nakamura")},
    ),
    Post(
        "general",
        "suzuki",
        (0, "10:40"),
        "Claude Premium シートの予約ができるようになりました（左の「予約」から）。\n"
        "時間を決めて予約するか、今すぐ使いたいときは順番待ちに入ってください。担当は鈴木と田中です。",
        reactions={"🎉": ("takahashi", "nakamura")},
    ),
    # ---- #研究ミーティング --------------------------------------------------------------------
    Post(
        "meeting",
        "tanaka",
        (-13, "14:40"),
        "後期最初のミーティングお疲れさまでした。後期の目標をこのチャンネルに書いておいてください。",
        key="m_goals",
    ),
    Post(
        "meeting",
        "watanabe",
        (-13, "15:05"),
        "後期の目標：\n・ジャーナル論文の投稿（12 月）\n・実験 2 の追加データ収集",
        parent="m_goals",
    ),
    Post(
        "meeting",
        "takahashi",
        (-13, "15:20"),
        "後期の目標：修論の実験を 11 月中に終えて、12 月から執筆に入ります",
        parent="m_goals",
    ),
    Post(
        "meeting",
        "review",
        (-12, "10:00"),
        "後期の目標：関連研究のサーベイ 20 本と、ベースラインの再現実験です",
        parent="m_goals",
    ),
    Post(
        "meeting",
        "review",
        (-12, "10:05"),
        "M1 の Review です。後期は関連研究のサーベイと、小さな再現実験から始めます。"
        "よろしくお願いします！",
        reactions={"👋": ("tanaka", "suzuki", "yamamoto", "ito"), ":thanks:": ("watanabe",)},
    ),
    Post(
        "meeting",
        "takahashi",
        (-6, "09:02"),
        "今週の進捗です。\n・データ前処理のスクリプトを整理しました\n"
        "・ベースラインの精度が 82.4% → 85.1% に向上\n・次は学習率のスケジュールを比較します",
        key="m_progress",
        files=("chart",),
        reactions={
            "👍": ("tanaka", "watanabe", "yamamoto"),
            "🎉": ("nakamura", "ito"),
            ":thanks:": ("suzuki",),
        },
    ),
    Post(
        "meeting",
        "tanaka",
        (-6, "09:05"),
        "いいですね。評価にはどのくらいのデータを使いましたか？",
        parent="m_progress",
    ),
    Post(
        "meeting",
        "takahashi",
        (-6, "09:07"),
        "検証用の 1,200 件です。テスト用のデータはまだ触っていません。",
        parent="m_progress",
    ),
    Post(
        "meeting",
        "watanabe",
        (-6, "09:10"),
        "学習率は cosine と warmup ありで比べると違いが見えやすいと思います",
        parent="m_progress",
    ),
    Post(
        "meeting",
        "yamamoto",
        (-6, "09:12"),
        "前処理のスクリプト、私の実験でも使わせてください！",
        parent="m_progress",
    ),
    Post(
        "meeting",
        "takahashi",
        (-6, "09:14"),
        "もちろんです。使い方は README にまとめておきました 👍",
        parent="m_progress",
        reactions={"🙏": ("yamamoto", "review")},
    ),
    Post(
        "meeting",
        "yamamoto",
        (-6, "09:20"),
        "M1 の山本です。今週は関連研究のサーベイを 5 本進めました。\n"
        "要点は来週のミーティングで共有します。",
        reactions={":thanks:": ("tanaka", "suzuki", "watanabe"), "👀": ("ito",)},
    ),
    Post(
        "meeting",
        "watanabe",
        (-5, "14:05"),
        "先週の実験結果をまとめました。条件 B のほうが安定して収束しています 📈",
        files=("results_pdf",),
        reactions={"👍": ("tanaka",)},
    ),
    Post(
        "meeting",
        "suzuki",
        (-5, "14:20"),
        "ありがとうございます。月曜のミーティングで少し時間を取りましょう",
    ),
    Post(
        "meeting",
        "nakamura",
        (-5, "16:48"),
        "来週からの輪講の担当表を作りました。確認お願いします 🙏",
        files=("rinko_docx",),
        reactions={":confirmed:": ("suzuki", "takahashi", "review")},
    ),
    Post(
        "meeting",
        "tanaka",
        (-2, "11:00"),
        "M1 の個別面談の日程を決めたいので、都合のよい時間を入れてください。",
        key="m_schedule",
        poll={
            "kind": "schedule",
            "question": "M1 個別面談（1 時間）",
            # (days after the anchor, start "HH:MM", minutes)
            "slots": [(3, "10:00", 60), (3, "15:00", 60), (4, "13:00", 60), (5, "10:00", 60)],
        },
        answers={"yamamoto": ("yes", "maybe", "yes", "no"), "suzuki": ("yes", "yes", "no", "yes")},
    ),
    Post(
        "meeting",
        "ito",
        (0, "09:02"),
        "今週の進捗（B4 伊藤）\n・センサの較正データを 3 日分取りました\n"
        "・ノイズの原因が電源まわりだと分かったので、来週フィルタを試します",
        reactions={"👍": ("suzuki", "nakamura")},
    ),
    Post(
        "meeting",
        "tanaka",
        (0, "09:31"),
        "<@review> サーベイの進み具合を、来週のミーティングで 5 分ほど紹介してもらえますか？",
        key="m_ask_review",
    ),
    Post("meeting", "nakamura", (0, "09:35"), "実験用の GPU、今日の午後から使わせてもらいます。"),
    # ---- #機材予約 ----------------------------------------------------------------------------
    Post(
        "equip",
        "suzuki",
        (-10, "10:00"),
        "GPU サーバの利用ルールです。\n・1 回の利用は最大 24 時間まで\n"
        "・長時間のジョブは前日までにこのチャンネルで共有\n"
        "・終わったら nvidia-smi でプロセスが残っていないか確認",
        pin=True,
        reactions={":noted:": ("watanabe", "takahashi", "nakamura", "yamamoto", "ito")},
    ),
    Post(
        "equip",
        "nakamura",
        (-4, "15:30"),
        "明日 10 時から 2 日ほど GPU を 2 枚使います。",
        key="e_gpu",
    ),
    Post(
        "equip",
        "suzuki",
        (-4, "15:41"),
        "了解です。高橋さんの実験とかぶらないようにお願いします",
        parent="e_gpu",
    ),
    Post(
        "equip",
        "takahashi",
        (-4, "15:50"),
        "こちらは週末に回すので大丈夫です 👍",
        parent="e_gpu",
        reactions={":thanks:": ("nakamura",)},
    ),
    Post(
        "equip",
        "ito",
        (-1, "16:00"),
        "オシロスコープを木曜の午後に借ります。",
        reactions={":noted:": ("suzuki",)},
    ),
    # ---- #論文紹介 ----------------------------------------------------------------------------
    Post(
        "papers",
        "watanabe",
        (-11, "15:10"),
        "今週読んだ論文です。少ないラベルで学習する手法の比較で、実験の設計がとても丁寧でした。\n"
        "データ拡張の組み合わせを変えたときの結果の表が参考になります 📄",
        key="p_fewlabel",
        reactions={":noted:": ("takahashi", "yamamoto", "review")},
    ),
    Post(
        "papers",
        "takahashi",
        (-11, "16:02"),
        "読みました。付録の追加実験も面白かったです",
        parent="p_fewlabel",
    ),
    Post(
        "papers",
        "watanabe",
        (-8, "11:00"),
        "Sharing a nice survey on evaluating LLM-based agents. Section 4 has a clear taxonomy of "
        "benchmarks — worth reading before our reading group.",
        key="p_survey",
        reactions={"👀": ("yamamoto", "ito"), "🙏": ("review",)},
    ),
    Post(
        "papers",
        "tanaka",
        (-8, "11:30"),
        "Thanks. Let's pick this one for the next 輪講.",
        parent="p_survey",
    ),
    Post(
        "papers",
        "yamamoto",
        (-2, "13:40"),
        "Attention の可視化手法を比較した論文を読みました。"
        "手法ごとに解釈がかなり違うのが印象的でした。",
        key="p_attention",
        reactions={"👍": ("watanabe",)},
    ),
    Post(
        "papers",
        "review",
        (-2, "14:02"),
        "可視化のコードは公開されていますか？",
        parent="p_attention",
    ),
    Post(
        "papers",
        "yamamoto",
        (-2, "14:10"),
        "GitHub にありました！あとでリンクを貼ります",
        parent="p_attention",
        reactions={":thanks:": ("review",)},
    ),
    # ---- #雑談 -------------------------------------------------------------------------------
    Post(
        "chat",
        "ito",
        (-12, "12:40"),
        "学食の新メニューのカレーうどん、おいしかったです 🍛",
        key="c_curry",
        reactions={"😋": ("nakamura", "yamamoto", "takahashi")},
    ),
    Post("chat", "nakamura", (-12, "12:45"), "今日行ってみます！", parent="c_curry"),
    Post(
        "chat",
        "takahashi",
        (-7, "18:30"),
        "駅前に新しいコーヒー屋さんができてました ☕",
        reactions={"👀": ("watanabe", "review")},
    ),
    Post(
        "chat",
        "nakamura",
        (-4, "12:10"),
        "Anyone up for badminton this Friday evening? 🏸",
        key="c_badminton",
        reactions={"🙋": ("ito", "review")},
    ),
    Post("chat", "ito", (-4, "12:14"), "行きます！", parent="c_badminton"),
    Post("chat", "review", (-4, "12:20"), "I'm in!", parent="c_badminton"),
    Post(
        "chat",
        "yamamoto",
        (-1, "19:00"),
        "研究室の観葉植物、だいぶ大きくなってきました 🌱",
        reactions={"🌱": ("suzuki", "ito")},
    ),
    Post("chat", "ito", (0, "08:45"), "おはようございます。今日は雨なので傘を忘れずに ☔"),
    # ---- #学会準備 (private) ------------------------------------------------------------------
    Post(
        "conf",
        "suzuki",
        (-9, "10:00"),
        "発表スライドの提出締め切りは {d+14} です。旅費の申請も忘れずに。",
        ack_requested=True,
        acks=("nakamura", "yamamoto", "ito"),
        reactions={":confirmed:": ("nakamura", "yamamoto", "ito")},
    ),
    Post("conf", "ito", (-9, "10:12"), "旅費の申請書、どこにありましたっけ？", key="k_form"),
    Post(
        "conf",
        "suzuki",
        (-9, "10:15"),
        "共有フォルダの「事務手続き」に入っています。",
        parent="k_form",
        reactions={":thanks:": ("ito",)},
    ),
    Post(
        "conf",
        "tanaka",
        (-3, "15:00"),
        "準備のチェックリストをこのチャンネルのキャンバスにまとめました。終わった項目にはチェックを入れてください。",
        reactions={"👍": ("nakamura", "ito")},
    ),
    Post(
        "conf",
        "nakamura",
        (0, "11:00"),
        "予稿の初稿をアップしました。コメントお願いします 🙏",
        files=("draft_pdf",),
    ),
    # ---- times --------------------------------------------------------------------------------
    Post(
        "times:watanabe",
        "watanabe",
        (-10, "22:10"),
        "実験 2 のデータ取り直し。夜のほうがノイズが少ない気がする",
    ),
    Post(
        "times:watanabe",
        "watanabe",
        (-3, "23:40"),
        "投稿先のジャーナルのテンプレート、LaTeX のクラスファイルが古くて苦戦中…",
        key="t_latex",
    ),
    Post(
        "times:watanabe",
        "tanaka",
        (-2, "08:30"),
        "去年の山田さんの原稿に直したクラスファイルがあったはずです",
        parent="t_latex",
        reactions={":thanks:": ("watanabe",)},
    ),
    Post(
        "times:takahashi",
        "takahashi",
        (-8, "10:30"),
        "今日は前処理の高速化。pandas → polars で 3 倍速くなった",
        reactions={"👍": ("tanaka",)},
    ),
    Post(
        "times:takahashi",
        "takahashi",
        (-1, "17:20"),
        "学習率スケジュールの比較、cosine が一番よさそう。明日は seed を変えて再確認",
    ),
    Post(
        "times:review",
        "review",
        (-12, "20:00"),
        "times を作りました。毎日の作業メモをここに書いていきます。",
    ),
    Post(
        "times:review",
        "review",
        (-6, "18:30"),
        "今日読んだ論文：2 本。どちらも評価の設計が丁寧で参考になった。",
    ),
    Post(
        "times:review",
        "review",
        (-2, "17:45"),
        "再現実験、環境構築でつまずき中。CUDA のバージョンが合わない…",
        key="t_cuda",
    ),
    Post(
        "times:review",
        "suzuki",
        (-2, "18:02"),
        "研究室の GPU サーバに conda の環境があるので、それを使うと早いですよ",
        parent="t_cuda",
        reactions={":thanks:": ("review",)},
    ),
    # ---- DMs ----------------------------------------------------------------------------------
    Post(
        "dm_tanaka_review",
        "tanaka",
        (-5, "11:00"),
        "先週の面談のメモを共有します。来月までにテーマを 2 つに絞りましょう。",
    ),
    Post(
        "dm_tanaka_review",
        "review",
        (-5, "11:30"),
        "ありがとうございます。候補をまとめておきます。",
    ),
    Post(
        "dm_suzuki_review",
        "suzuki",
        (-2, "18:05"),
        "Review さん、来週の TA の件ですが、火曜 3 限をお願いできますか？",
    ),
    Post("dm_suzuki_review", "review", (-2, "18:20"), "はい、大丈夫です！"),
    Post(
        "dm_suzuki_review",
        "suzuki",
        (0, "08:40"),
        "ありがとうございます。資料は今日中にお送りします。",
    ),
    Post(
        "dm_suzuki_yamamoto",
        "suzuki",
        (-3, "18:05"),
        "山本さん、面談の日程調整に答えておいてくださいね。",
    ),
    Post("dm_suzuki_yamamoto", "yamamoto", (-3, "18:20"), "はい、入れておきます！"),
    Post("gdm_dinner", "ito", (0, "09:25"), "練習会のあと、みんなでごはん行きませんか？"),
    Post("gdm_dinner", "nakamura", (0, "09:27"), "行きます！"),
)

# The review account has read up to just before these points (channel key -> anchor-relative
# time); everything else is read. The rest of the cast has read everything.
REVIEW_UNREAD_FROM: dict[str, tuple[int, str]] = {
    "general": (0, "00:00"),
    "meeting": (0, "00:00"),
    "conf": (0, "00:00"),
    "dm_suzuki_review": (0, "00:00"),
    "gdm_dinner": (-30, "00:00"),
}


@dataclass(frozen=True)
class FileSpec:
    filename: str
    kind: str  # chart | pdf | docx
    title: str = ""
    lines: tuple[tuple[str, ...], ...] = ()


FILES: dict[str, FileSpec] = {
    "chart": FileSpec("accuracy.png", "chart"),
    "results_pdf": FileSpec(
        "experiment2-summary.pdf",
        "pdf",
        "Experiment 2: summary (demo)",
        (
            (
                "Goal: compare two training conditions (A, B) on the validation split.",
                "",
                "Setup",
                "- 1,200 validation samples, 3 random seeds per condition",
                "- 30 epochs, batch size 64",
                "",
                "Result",
                "- Condition B converges more stably (std 0.4 vs 1.1).",
                "- Final accuracy: A 84.2%, B 85.0%.",
            ),
            (
                "Next steps",
                "- Repeat with the test split once the protocol is fixed.",
                "- Try a longer warmup for condition A.",
                "",
                "All numbers in this file are fictional demo data.",
            ),
        ),
    ),
    "draft_pdf": FileSpec(
        "proceedings-draft-nakamura.pdf",
        "pdf",
        "Anomaly detection for lab sensors (draft)",
        (
            (
                "Daiki Nakamura (fictional), Taylis Demo Lab",
                "",
                "Abstract",
                "We detect anomalies in low-cost environmental sensors with a small",
                "autoencoder and compare it with simple statistical baselines.",
                "",
                "1. Introduction",
                "2. Method",
                "3. Experiments",
                "4. Conclusion",
            ),
        ),
    ),
    "rinko_docx": FileSpec(
        "輪講担当表.docx",
        "docx",
        "輪講 担当表（後期）",
        (("{d+7} 渡辺", "{d+14} 高橋", "{d+21} 中村", "{d+28} 山本", "{d+35} Review"),),
    ),
}

WEEKLY_REPORT_NAME = "週報"
WEEKLY_REPORT_BODY = (
    "**週報 {week}**\n今週の進捗・来週の予定・相談したいことを、このスレッドに返信してください。"
)
# Submitted replies (who, hours after the post). The others (中村, 伊藤, review) have not yet.
WEEKLY_REPORT_REPLIES: tuple[tuple[str, int, str], ...] = (
    ("watanabe", 5, "今週の進捗\n- 実験 2 のデータ収集が 8 割\n来週の予定\n- 論文の図を作り直す"),
    ("takahashi", 26, "今週の進捗\n- 学習率スケジュールの比較\n相談したいこと\n- 計算資源の確保"),
    ("yamamoto", 50, "今週の進捗\n- サーベイ 5 本\n来週の予定\n- 面談の準備"),
)

CANVAS_TITLE = "学会準備チェックリスト"
CANVAS_BODY = """# 学会準備チェックリスト

## 発表（中村・伊藤）
- [x] 予稿の初稿
- [ ] 予稿の最終版を提出 📅 {iso+7}
- [ ] 発表スライド（第 1 稿）
- [ ] 練習会（{d+2} 16:00）

## 事務手続き
- [x] 参加登録
- [ ] 旅費の申請書を提出
- [ ] 宿泊先の予約

## 当日
- [ ] ポスター用の筒を借りる
- [ ] 名刺を印刷
"""

LINKS: tuple[tuple[str, str, str], ...] = (
    ("general", "研究室 Wiki（デモ）", "https://example.com/lab-wiki"),
    ("general", "学会の Web サイト（デモ）", "https://example.com/conference"),
)
