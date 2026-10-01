"""M53: scheduling polls: poll_votes.answer and poll_comments (SCHEDULING.md §2)

Revision ID: 0052
Revises: 0051
Create Date: 2026-10-01

- poll_votes.answer: 'yes' | 'maybe' | 'no' (maru, sankaku, batsu). Every existing vote, and
  every vote of a choice poll or from an app before M53, is 'yes'. One row per person and slot
  (the primary key stays (message_id, user_id, option_index)); no row is 「未回答」.
- poll_comments: one short comment (1-100 characters) per person on a poll, shown in the
  people-by-slots table. Deleted with the message's row (ON DELETE CASCADE), like message_acks.
- The poll itself stays in messages.poll (JSONB): `kind`, `slots`, `tz` and `decided` are new keys
  there, so no change to messages.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0052"
down_revision: str | None = "0051"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "poll_votes",
        sa.Column("answer", sa.String(8), nullable=False, server_default="yes"),
    )
    op.create_check_constraint("answer_values", "poll_votes", "answer IN ('yes', 'maybe', 'no')")
    op.create_table(
        "poll_comments",
        sa.Column(
            "message_id",
            sa.Uuid(),
            sa.ForeignKey("messages.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint("char_length(text) BETWEEN 1 AND 100", name="text_length"),
    )


def downgrade() -> None:
    op.drop_table("poll_comments")
    op.drop_constraint("answer_values", "poll_votes", type_="check")
    op.drop_column("poll_votes", "answer")
