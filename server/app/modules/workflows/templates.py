"""「テンプレートから作成」 (WORKFLOWS.md §6): the research lab's forms from its old Slack, as
starting points for the editor. Never created as workflows by themselves."""

from typing import Any

from app.modules.workflows.schemas import WorkflowField, WorkflowTemplateOut


def _seminar(key: str, title: str) -> dict[str, Any]:
    return {
        "key": key,
        "name": f"{title}案内",
        "emoji": "📣",
        "description": f"{title}の日時・場所・発表者をお知らせします",
        "fields": [
            {"key": "回", "label": "回", "type": "text", "required": True, "help": "例: 6"},
            {
                "key": "日時",
                "label": "日時",
                "type": "datetime",
                "required": True,
                "default": {"kind": "next_weekday", "weekday": 1, "time": "13:00"},
            },
            {"key": "場所", "label": "場所/URL", "type": "text", "help": "教室や Zoom の URL"},
            {"key": "内容", "label": "内容", "type": "textarea"},
            {"key": "発表者", "label": "発表者", "type": "user", "multiple": True},
        ],
        "template": (
            f"<!channel> *【第 {{{{回}}}} 回{title}のお知らせ】*\n"
            "• *日時*\uff1a{{日時}}\n"
            "• *場所*\uff1a{{場所}}\n"
            "• *内容*\uff1a{{内容}}\n"
            "• *発表者*\uff1a{{発表者}}"
        ),
    }


_TEMPLATES: list[dict[str, Any]] = [
    _seminar("undergrad_seminar", "学部ゼミ"),
    _seminar("graduate_seminar", "院ゼミ"),
    {
        "key": "seminar_absence",
        "name": "ゼミ欠席報告",
        "emoji": "🙇",
        "description": "ゼミの欠席・遅刻・早退を報告します",
        "fields": [
            {
                "key": "報告者",
                "label": "報告者",
                "type": "user",
                "required": True,
                "default": {"kind": "me"},
            },
            {
                "key": "日付",
                "label": "日付",
                "type": "date",
                "required": True,
                "default": {"kind": "today"},
            },
            {
                "key": "内容",
                "label": "報告の内容",
                "type": "select",
                "required": True,
                "options": ["欠席", "遅刻", "早退"],
                "default": {"kind": "literal", "value": "欠席"},
            },
            {"key": "理由", "label": "理由", "type": "textarea"},
        ],
        "template": (
            "*【報告者】* {{報告者}}\n"
            "*【報告の内容】* ゼミの{{内容}}\n"
            "*【日付】* {{日付}}\n"
            "*【理由】* {{理由}}"
        ),
    },
    {
        "key": "bibliography",
        "name": "書誌情報報告",
        "emoji": "📚",
        "description": "発表した論文の書誌情報を報告します",
        "fields": [
            {"key": "種類", "label": "種類", "type": "select", "required": True,
             "options": ["国際会議", "国内会議", "論文誌", "研究会", "その他"]},
            {"key": "著者", "label": "著者", "type": "text", "required": True,
             "help": "例: 山田太郎, 鈴木花子"},
            {"key": "タイトル", "label": "タイトル", "type": "text", "required": True},
            {"key": "会議雑誌名", "label": "会議/雑誌名", "type": "text", "required": True},
            {"key": "年", "label": "年", "type": "text", "required": True, "help": "例: 2026"},
            {"key": "巻号ページ", "label": "巻号ページ", "type": "text",
             "help": "例: Vol. 12, No. 3, pp. 45-56"},
            {"key": "DOI", "label": "DOI/URL", "type": "text"},
        ],
        "template": (
            "*【書誌情報】* {{種類}}\n"
            "• *著者*\uff1a{{著者}}\n"
            "• *タイトル*\uff1a{{タイトル}}\n"
            "• *会議/雑誌名*\uff1a{{会議雑誌名}}\n"
            "• *年*\uff1a{{年}}\n"
            "• *巻号ページ*\uff1a{{巻号ページ}}\n"
            "• *DOI/URL*\uff1a{{DOI}}"
        ),
    },
]  # fmt: skip


def workflow_templates() -> list[WorkflowTemplateOut]:
    return [
        WorkflowTemplateOut(
            key=t["key"],
            name=t["name"],
            emoji=t["emoji"],
            description=t["description"],
            fields=[WorkflowField.model_validate(field) for field in t["fields"]],
            template=t["template"],
        )
        for t in _TEMPLATES
    ]
