"""M41: canvases (CANVAS.md §4.3): the documents, their versions and the templates

Revision ID: 0046
Revises: 0045
Create Date: 2026-09-30

The search index (canvases_search_idx) and attachments.canvas_id come with M42.
"""

import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0046"
down_revision: str | None = "0045"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The built-in templates as of this migration (app/modules/canvases/templates.py BUILTINS is the
# living copy; the server also puts back a missing one at startup).
BUILTINS = [
    (
        "weekly_report",
        "週報",
        "今週やったこと・来週の予定・相談",
        "週報 {{week}} {{me_name}}",
        "# 週報 {{week}}\n報告: {{me}} ({{date}})\n\n"
        "## 今週やったこと\n- \n\n## 来週の予定\n- \n\n"
        "## 相談したいこと\n- \n\n## 論文・学会の状況\n- \n",
    ),
    (
        "minutes",
        "議事録",
        "出席・議題・決定事項・TODO",
        "議事録 {{date}}",
        "# 議事録 {{date}}\n## 出席\n\n## 議題\n\n## 決定事項\n\n## TODO\n- [ ] 担当 @ / 期限 📅\n",
    ),
    (
        "research_plan",
        "研究計画",
        "背景・目的・方法・スケジュール",
        "研究計画 {{me_name}}",
        "# 研究計画\n作成: {{me}} ({{date}})\n\n## 背景\n\n## 目的\n\n## 方法\n\n"
        "## スケジュール\n- [ ] \n\n## 参考文献\n",
    ),
    (
        "conference_checklist",
        "学会準備チェックリスト",
        "参加登録から精算まで",
        "学会準備 {{me_name}}",
        "# 学会準備\n- 学会名: \n- 会期・会場: \n\n## チェックリスト\n"
        "- [ ] 参加登録\n- [ ] 旅費申請\n- [ ] 宿泊・交通の手配\n- [ ] 予稿の提出 📅\n"
        "- [ ] 発表資料の作成\n- [ ] 発表練習\n- [ ] 精算\n",
    ),
    (
        "thesis_schedule",
        "卒論・修論スケジュール",
        "テーマ決定から最終提出まで",
        "卒論・修論スケジュール {{me_name}}",
        "# 卒論・修論スケジュール\n担当: {{me}}\n\n"
        "- [ ] テーマ決定 📅\n- [ ] 中間発表 📅\n- [ ] 初稿を指導教員へ 📅\n"
        "- [ ] 修正版の提出 📅\n- [ ] 最終発表の資料 📅\n- [ ] 発表練習 📅\n"
        "- [ ] 最終提出 📅\n",
    ),
]


def upgrade() -> None:
    uid = postgresql.UUID(as_uuid=True)
    op.create_table(
        "canvases",
        sa.Column("id", uid, primary_key=True),
        sa.Column("channel_id", uid, sa.ForeignKey("channels.id"), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("body", sa.Text(), nullable=False, server_default=""),
        sa.Column("version", sa.BigInteger(), nullable=False, server_default="1"),
        sa.Column("head_rev_id", uid, nullable=False),
        sa.Column("is_channel_tab", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("edit_policy", sa.String(16), nullable=False, server_default="members"),
        sa.Column("template_key", sa.String(40), nullable=True),
        sa.Column("share_message_id", uid, sa.ForeignKey("messages.id"), nullable=True),
        sa.Column("task_total", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("task_done", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_by", uid, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("updated_by", uid, sa.ForeignKey("users.id"), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_by", uid, sa.ForeignKey("users.id"), nullable=True),
        sa.CheckConstraint("edit_policy IN ('members', 'owners')", name="edit_policy_values"),
    )
    op.execute(
        "CREATE INDEX canvases_channel_idx ON canvases (channel_id, updated_at DESC) "
        "WHERE deleted_at IS NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX canvases_tab_uniq ON canvases (channel_id) "
        "WHERE is_channel_tab AND deleted_at IS NULL"
    )

    op.create_table(
        "canvas_revisions",
        sa.Column("id", uid, primary_key=True),
        sa.Column(
            "canvas_id", uid, sa.ForeignKey("canvases.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("version", sa.BigInteger(), nullable=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("parent_rev_id", uid, nullable=True),
        sa.Column("author_id", uid, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("client_save_id", uid, nullable=True),
        sa.Column("label", sa.String(80), nullable=True),
        sa.Column("lines_added", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("lines_removed", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint(
            "kind IN ('create', 'save', 'merge', 'side', 'restore', 'erased')",
            name="kind_values",
        ),
    )
    op.create_index("canvas_revisions_canvas_idx", "canvas_revisions", ["canvas_id", "created_at"])
    op.execute(
        "CREATE UNIQUE INDEX canvas_revisions_save_uniq ON canvas_revisions "
        "(author_id, client_save_id) WHERE client_save_id IS NOT NULL"
    )

    op.create_table(
        "canvas_templates",
        sa.Column("id", uid, primary_key=True),
        sa.Column("key", sa.String(40), nullable=False, unique=True),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("description", sa.String(200), nullable=True),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("builtin", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("hidden", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("created_by", uid, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    table = sa.table(
        "canvas_templates",
        sa.column("id", uid),
        sa.column("key", sa.String),
        sa.column("name", sa.String),
        sa.column("description", sa.String),
        sa.column("title", sa.String),
        sa.column("body", sa.Text),
        sa.column("position", sa.Integer),
        sa.column("builtin", sa.Boolean),
    )
    op.bulk_insert(
        table,
        [
            {
                "id": uuid.uuid4(),
                "key": key,
                "name": name,
                "description": description,
                "title": title,
                "body": body,
                "position": position,
                "builtin": True,
            }
            for position, (key, name, description, title, body) in enumerate(BUILTINS)
        ],
    )


def downgrade() -> None:
    op.drop_table("canvas_templates")
    op.drop_table("canvas_revisions")
    op.drop_table("canvases")
