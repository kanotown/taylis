"""Blocking users and reporting messages (M104)

Revision ID: 0081
Revises: 0080
Create Date: 2026-10-05

docs/MODERATION.md: `user_blocks` is one person's private list of the people they blocked (their
messages are folded away on all of the blocker's devices, no push from them, no 1:1 DM from them).
`message_reports` holds the reports of messages to the administrators, with a copy of the body at
the time (the author may edit or delete it afterwards).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0081"
down_revision: str | None = "0080"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "user_blocks",
        sa.Column(
            "blocker_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "blocked_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint("blocker_id <> blocked_id", name="user_blocks_not_self_check"),
    )
    # "Who blocked this sender?" (push planning, the 1:1 DM check).
    op.create_index("user_blocks_blocked_idx", "user_blocks", ["blocked_id"])
    op.create_table(
        "message_reports",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "message_id",
            sa.Uuid(),
            sa.ForeignKey("messages.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "channel_id",
            sa.Uuid(),
            sa.ForeignKey("channels.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("reporter_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("reported_user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("reason", sa.String(16), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("body_snapshot", sa.Text(), nullable=False, server_default=""),
        sa.Column("status", sa.String(16), nullable=False, server_default="open"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "resolved_by",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.CheckConstraint(
            "reason IN ('spam', 'harassment', 'inappropriate', 'other')",
            name="message_reports_reason_check",
        ),
        sa.CheckConstraint("status IN ('open', 'resolved')", name="message_reports_status_check"),
        # One report per person and message: reporting again returns the first one.
        sa.UniqueConstraint("message_id", "reporter_id", name="message_reports_once"),
    )
    op.create_index("message_reports_status_idx", "message_reports", ["status", "created_at"])


def downgrade() -> None:
    op.drop_index("message_reports_status_idx", table_name="message_reports")
    op.drop_table("message_reports")
    op.drop_index("user_blocks_blocked_idx", table_name="user_blocks")
    op.drop_table("user_blocks")
