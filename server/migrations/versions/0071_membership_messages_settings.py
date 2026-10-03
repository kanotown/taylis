"""Join / leave messages and the workspace settings (M88)

Revision ID: 0071
Revises: 0070
Create Date: 2026-10-03

docs/MEMBERSHIP.md:

- `messages.system_event`: what a system message (`type = 'system'`) says, as data
  (`{kind, actor_id, user_ids}`), so clients write the line with today's names in their own
  language. The body keeps a plain-text fallback for clients before M88.
- `workspace_settings`: one row of workspace-wide switches an administrator sets —
  「参加・退出の表示」 (`show_membership_messages`) and 「参加前にチャンネルの中を見られる」
  (`preview_before_join`), both on by default (today's behaviour).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0071"
down_revision: str | None = "0070"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("messages", sa.Column("system_event", postgresql.JSONB(), nullable=True))
    op.create_table(
        "workspace_settings",
        sa.Column("singleton", sa.Boolean(), primary_key=True, server_default=sa.true()),
        sa.Column(
            "show_membership_messages", sa.Boolean(), nullable=False, server_default=sa.true()
        ),
        sa.Column("preview_before_join", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
        ),
        sa.CheckConstraint("singleton", name="workspace_settings_singleton"),
    )
    op.execute("INSERT INTO workspace_settings (singleton) VALUES (true)")


def downgrade() -> None:
    op.drop_table("workspace_settings")
    op.drop_column("messages", "system_event")
