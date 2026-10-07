"""操作ボタン (actions, M143, docs/ACTIONS.md §3)

Revision ID: 0106
Revises: 0105
Create Date: 2026-10-07

- action_settings: the switch (off by default), whether the buttons also show on the 在室状況
  page, how long presses are kept.
- actions: the buttons (relay URL, the name of the signing key's file, action_key, who may press).
- action_invocations: every press and test (unique per person and client_invoke_id, so a retried
  request never calls the relay twice).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0106"
down_revision: str | None = "0105"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _ts(name: str, *, nullable: bool = False, default: bool = True) -> sa.Column:  # type: ignore[type-arg]
    return sa.Column(
        name,
        sa.DateTime(timezone=True),
        nullable=nullable,
        server_default=sa.func.now() if default else None,
    )


def upgrade() -> None:
    op.create_table(
        "action_settings",
        sa.Column("singleton", sa.Boolean(), primary_key=True, server_default=sa.text("true")),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column(
            "show_on_attendance", sa.Boolean(), nullable=False, server_default=sa.text("false")
        ),
        sa.Column("log_retention_days", sa.Integer(), nullable=False, server_default="365"),
        _ts("updated_at"),
        sa.Column("updated_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.CheckConstraint("singleton", name="action_settings_singleton"),
    )
    op.create_table(
        "actions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", sa.String(40), nullable=False),
        sa.Column("group_label", sa.String(40)),
        sa.Column("icon", sa.String(32)),
        sa.Column("emoji", sa.String(32)),
        sa.Column("action_key", sa.String(100), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("secret_name", sa.Text(), nullable=False),
        sa.Column("confirm", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("confirm_text", sa.String(200)),
        sa.Column(
            "allowed_roles",
            postgresql.ARRAY(sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'"),
        ),
        sa.Column(
            "allowed_group_ids",
            postgresql.ARRAY(sa.Uuid()),
            nullable=False,
            server_default=sa.text("'{}'"),
        ),
        sa.Column(
            "allowed_user_ids",
            postgresql.ARRAY(sa.Uuid()),
            nullable=False,
            server_default=sa.text("'{}'"),
        ),
        sa.Column(
            "notice_channel_id", sa.Uuid(), sa.ForeignKey("channels.id", ondelete="SET NULL")
        ),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        _ts("created_at"),
        _ts("updated_at"),
    )
    op.create_table(
        "action_invocations",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "action_id",
            sa.Uuid(),
            sa.ForeignKey("actions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("client_invoke_id", sa.Uuid()),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("status_code", sa.Integer()),
        sa.Column("error", sa.Text()),
        sa.Column("message", sa.String(200)),
        sa.Column("latency_ms", sa.Integer()),
        _ts("created_at"),
        _ts("finished_at", nullable=True, default=False),
        sa.UniqueConstraint("user_id", "client_invoke_id", name="action_invocations_client_uq"),
        sa.CheckConstraint("kind IN ('invoke', 'test')", name="action_invocations_kind"),
        sa.CheckConstraint(
            "status IN ('pending', 'succeeded', 'failed')", name="action_invocations_status"
        ),
    )
    op.create_index(
        "action_invocations_action_idx", "action_invocations", ["action_id", "created_at"]
    )
    op.create_index("action_invocations_created_idx", "action_invocations", ["created_at"])


def downgrade() -> None:
    op.drop_table("action_invocations")
    op.drop_table("actions")
    op.drop_table("action_settings")
