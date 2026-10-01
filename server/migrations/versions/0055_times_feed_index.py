"""M61: the Times feed's index (TIMES_FEED.md §3, L8)

Revision ID: 0055
Revises: 0054
Create Date: 2026-10-02

The feed takes each followed times' newest timeline rows in (created_at, id) order, then merges
them. Without this index each channel's walk goes down messages_created_idx and skips the other
channels' rows (30 times x 3,000 posts among 190k messages: 238 ms for the first page; 0.5 ms with
it, and 0.6 ms for a page deep in the history).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0055"
down_revision: str | None = "0054"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index(
        "messages_timeline_created_idx",
        "messages",
        ["channel_id", sa.text("created_at DESC"), sa.text("id DESC")],
        postgresql_where=sa.text("deleted_at IS NULL AND (parent_id IS NULL OR also_in_channel)"),
    )


def downgrade() -> None:
    op.drop_index("messages_timeline_created_idx", table_name="messages")
