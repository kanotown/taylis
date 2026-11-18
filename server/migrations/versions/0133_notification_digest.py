"""M192: the mentions held back while notifications were paused (notification_digest_items)

Revision ID: 0133
Revises: 0132
Create Date: 2026-11-18

PUSH_NOTIFICATIONS.md §18. A message push to someone that only their pause (dnd_until: 取り込み中 /
通知を一時停止, or quiet hours) held back, and that addresses them (a mention, or a DM / group DM),
is noted here; when no pause is in effect any more, the worker sends one summary push and deletes
the person's rows in the same transaction. One row per person and message (re-processing the
outbox event notes nothing twice); `id` orders them and keys the summary's push_deliveries. Whether
it is a mention or a DM is the conversation's type, read when the summary is written.

users.notify_digest: the summary on or off (default on). Off: nothing is noted.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0133"
down_revision: str | None = "0132"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("notify_digest", sa.Boolean(), nullable=False, server_default="true"),
    )
    op.create_table(
        "notification_digest_items",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), primary_key=True),
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "message_id",
            sa.Uuid(),
            sa.ForeignKey("messages.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint(
            "user_id", "message_id", name="notification_digest_items_user_message_uniq"
        ),
    )


def downgrade() -> None:
    # An older server never sends the summary: what was noted is simply dropped.
    op.drop_table("notification_digest_items")
    op.drop_column("users", "notify_digest")
