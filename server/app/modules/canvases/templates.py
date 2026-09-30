"""Canvas templates: the built-in ones and the placeholders (CANVAS.md §4.12).

The server puts the placeholders in once, when a canvas is made from a template, in the zone the
client sends (`tz`). What they become (test vectors in tests/test_canvases.py):

- ``{{date}}``    → ``2026-10-01 (水)``
- ``{{week}}``    → ``2026-W40`` (ISO 8601 week, the same as the post templates' ``{week}``)
- ``{{me}}``      → in the body a mention ``<@user-id>``; in the title the display name
- ``{{me_name}}`` → the display name
- ``{{channel}}`` → the channel's name; for a DM the other members' display names (joined by
  ``、``), for the DM with oneself one's own

Other ``{{…}}`` stay as they are.
"""

import re
import uuid
from dataclasses import dataclass
from datetime import date

WEEKDAYS = "月火水木金土日"
PLACEHOLDER = re.compile(r"\{\{(date|week|me|me_name|channel)\}\}")


@dataclass(frozen=True)
class Builtin:
    key: str
    name: str
    description: str
    title: str
    body: str


# Migration 0046 seeds these (a frozen copy); ensure_builtin_templates puts back one that is
# missing. Admins may edit or hide them but not delete them.
BUILTINS: tuple[Builtin, ...] = (
    Builtin(
        key="weekly_report",
        name="週報",
        description="今週やったこと・来週の予定・相談",
        title="週報 {{week}} {{me_name}}",
        body=(
            "# 週報 {{week}}\n報告: {{me}} ({{date}})\n\n"
            "## 今週やったこと\n- \n\n## 来週の予定\n- \n\n"
            "## 相談したいこと\n- \n\n## 論文・学会の状況\n- \n"
        ),
    ),
    Builtin(
        key="minutes",
        name="議事録",
        description="出席・議題・決定事項・TODO",
        title="議事録 {{date}}",
        body=(
            "# 議事録 {{date}}\n## 出席\n\n## 議題\n\n## 決定事項\n\n"
            "## TODO\n- [ ] 担当 @ / 期限 📅\n"
        ),
    ),
    Builtin(
        key="research_plan",
        name="研究計画",
        description="背景・目的・方法・スケジュール",
        title="研究計画 {{me_name}}",
        body=(
            "# 研究計画\n作成: {{me}} ({{date}})\n\n## 背景\n\n## 目的\n\n## 方法\n\n"
            "## スケジュール\n- [ ] \n\n## 参考文献\n"
        ),
    ),
    Builtin(
        key="conference_checklist",
        name="学会準備チェックリスト",
        description="参加登録から精算まで",
        title="学会準備 {{me_name}}",
        body=(
            "# 学会準備\n- 学会名: \n- 会期・会場: \n\n## チェックリスト\n"
            "- [ ] 参加登録\n- [ ] 旅費申請\n- [ ] 宿泊・交通の手配\n- [ ] 予稿の提出 📅\n"
            "- [ ] 発表資料の作成\n- [ ] 発表練習\n- [ ] 精算\n"
        ),
    ),
    Builtin(
        key="thesis_schedule",
        name="卒論・修論スケジュール",
        description="テーマ決定から最終提出まで",
        title="卒論・修論スケジュール {{me_name}}",
        body=(
            "# 卒論・修論スケジュール\n担当: {{me}}\n\n"
            "- [ ] テーマ決定 📅\n- [ ] 中間発表 📅\n- [ ] 初稿を指導教員へ 📅\n"
            "- [ ] 修正版の提出 📅\n- [ ] 最終発表の資料 📅\n- [ ] 発表練習 📅\n"
            "- [ ] 最終提出 📅\n"
        ),
    ),
)


@dataclass(frozen=True)
class Context:
    today: date
    me_id: uuid.UUID
    me_name: str
    channel: str


def format_date(day: date) -> str:
    return f"{day.isoformat()} ({WEEKDAYS[day.weekday()]})"


def format_week(day: date) -> str:
    year, week, _ = day.isocalendar()
    return f"{year}-W{week:02d}"


def expand(text: str, ctx: Context, *, title: bool) -> str:
    """Put the placeholders in (once: what they become is not expanded again)."""

    def value(match: re.Match[str]) -> str:
        name = match.group(1)
        if name == "date":
            return format_date(ctx.today)
        if name == "week":
            return format_week(ctx.today)
        if name == "me":
            return ctx.me_name if title else f"<@{ctx.me_id}>"
        if name == "me_name":
            return ctx.me_name
        return ctx.channel

    return PLACEHOLDER.sub(value, text)
