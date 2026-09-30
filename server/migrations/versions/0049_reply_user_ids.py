"""C3 (MOBILE_POLISH.md): messages.reply_user_ids, who replied to a thread parent

Revision ID: 0049
Revises: 0048
Create Date: 2026-09-30

- messages.reply_user_ids uuid[]: the distinct authors of a parent's live replies, most recent
  reply first, at most 5. Kept with reply_count / last_reply_at in the reply's transaction.
- Backfill: every parent that has replies, from its rows (the same rule as the app's
  messages repository `refresh_reply_user_ids`).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0049"
down_revision: str | None = "0048"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column(
            "reply_user_ids",
            postgresql.ARRAY(sa.Uuid()),
            nullable=False,
            server_default=sa.text("'{}'::uuid[]"),
        ),
    )
    op.execute(
        """
        UPDATE messages AS p SET reply_user_ids = ARRAY(
            SELECT r.sender_id FROM messages AS r
            WHERE r.parent_id = p.id AND r.deleted_at IS NULL
            GROUP BY r.sender_id
            ORDER BY max(r.seq) DESC
            LIMIT 5
        )
        WHERE p.id IN (SELECT DISTINCT parent_id FROM messages WHERE parent_id IS NOT NULL)
        """
    )


def downgrade() -> None:
    op.drop_column("messages", "reply_user_ids")
