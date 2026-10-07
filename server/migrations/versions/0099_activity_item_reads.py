"""Activity items read one by one (MOBILE_UI.md §6.4, 2026-10-07)

Revision ID: 0099
Revises: 0098
Create Date: 2026-10-07

- activity_item_reads: an activity item I opened (on any of my devices), by the id GET /activity
  gives it (`id`: the message's for mention / thread_reply / reaction, the item's own for the
  other kinds). The item is read while its `at` is not after read_at (a reaction item whose
  newest reaction is later is unread again). Only rows above users.activity_read_at matter:
  moving that position (「すべて既読にする」) deletes the rows at or below it, so the table stays
  small. No foreign key on item_id (it names rows of several tables).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0099"
down_revision: str | None = "0098"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "activity_item_reads",
        sa.Column(
            "user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("item_id", sa.Uuid(), primary_key=True),
        sa.Column(
            "read_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )


def downgrade() -> None:
    op.drop_table("activity_item_reads")
