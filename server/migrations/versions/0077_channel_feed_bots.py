"""Channel feed bots: a named, adoptable feed bot per channel; users.bot_kind (M98)

Revision ID: 0077
Revises: 0076
Create Date: 2026-10-04

docs/FEEDS.md §2: `channel_feed_bots` (one row per channel that has had a feed bot: the bot, and
whether an administrator adopted an existing bot for it), filled from the feeds' bots. `users.
bot_kind` = "feed" marks the bots only the channel feeds post as (clients load their link previews
by themselves, SECURITY.md §14); `updated_at` moves so that clients' caches see the change.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0077"
down_revision: str | None = "0076"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("bot_kind", sa.String(16), nullable=True))
    op.create_table(
        "channel_feed_bots",
        sa.Column(
            "channel_id",
            sa.Uuid(),
            sa.ForeignKey("channels.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("bot_user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False, unique=True),
        sa.Column("adopted", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.execute(
        """
        INSERT INTO channel_feed_bots (channel_id, bot_user_id)
        SELECT DISTINCT ON (channel_id) channel_id, bot_user_id
        FROM channel_feeds
        ORDER BY channel_id, created_at
        ON CONFLICT DO NOTHING
        """
    )
    op.execute(
        """
        UPDATE users SET bot_kind = 'feed', updated_at = now()
        WHERE role = 'bot' AND id IN (SELECT bot_user_id FROM channel_feeds)
        """
    )


def downgrade() -> None:
    op.drop_table("channel_feed_bots")
    op.drop_column("users", "bot_kind")
