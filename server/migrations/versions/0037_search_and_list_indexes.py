"""search and list indexes (M19): filter-only searches, /mentions, /files

Revision ID: 0037
Revises: 0036
Create Date: 2026-09-28
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0037"
down_revision: str | None = "0036"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LIVE = sa.text("deleted_at IS NULL")


def upgrade() -> None:
    # Searches without words (on:, after:, before:, from:) read the newest live messages first.
    op.create_index("messages_created_idx", "messages", ["created_at"], postgresql_where=LIVE)
    op.create_index(
        "messages_sender_created_idx",
        "messages",
        ["sender_id", "created_at"],
        postgresql_where=LIVE,
    )
    # /mentions: mentioned by name, by a keyword hit, or @channel / @here.
    op.create_index(
        "messages_mentioned_gin", "messages", ["mentioned_user_ids"], postgresql_using="gin"
    )
    op.create_index(
        "messages_keyword_hits_gin", "messages", ["keyword_user_ids"], postgresql_using="gin"
    )
    op.create_index(
        "messages_mention_all_idx",
        "messages",
        ["created_at"],
        postgresql_where=sa.text("mention_all AND deleted_at IS NULL"),
    )
    # GET /files pages newest first on (attached_at DESC, id).
    op.create_index(
        "attachments_listing_idx",
        "attachments",
        [sa.text("attached_at DESC"), "id"],
        postgresql_where=sa.text("status = 'attached' AND deleted_at IS NULL"),
    )


def downgrade() -> None:
    for name, table in (
        ("attachments_listing_idx", "attachments"),
        ("messages_mention_all_idx", "messages"),
        ("messages_keyword_hits_gin", "messages"),
        ("messages_mentioned_gin", "messages"),
        ("messages_sender_created_idx", "messages"),
        ("messages_created_idx", "messages"),
    ):
        op.drop_index(name, table_name=table)
