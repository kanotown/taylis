"""Channel feeds: RSS / Atom subscriptions posted into a channel (M97)

Revision ID: 0076
Revises: 0075
Create Date: 2026-10-04

docs/FEEDS.md §2: `channel_feeds` (the channel, the member who registered it, the channel's feed
bot, the URL (unique per channel), the feed's title and site, enabled, the conditional-GET
validators, the seen entries' hashes, the fetch schedule and the failure bookkeeping).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0076"
down_revision: str | None = "0075"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "channel_feeds",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("channel_id", sa.Uuid(), sa.ForeignKey("channels.id"), nullable=False),
        sa.Column("owner_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("bot_user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("url", sa.String(2048), nullable=False),
        sa.Column("title", sa.String(200), nullable=True),
        sa.Column("site_url", sa.String(2048), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("needs_baseline", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("etag", sa.String(512), nullable=True),
        sa.Column("last_modified", sa.String(128), nullable=True),
        sa.Column(
            "seen_keys",
            postgresql.ARRAY(sa.String(32)),
            nullable=False,
            server_default=sa.text("'{}'::varchar[]"),
        ),
        sa.Column("next_fetch_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_fetched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_success_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error_code", sa.String(32), nullable=True),
        sa.Column("last_error", sa.String(300), nullable=True),
        sa.Column("consecutive_failures", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("failure_notified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("post_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_post_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint("channel_id", "url", name="channel_feeds_channel_url_uniq"),
    )
    op.create_index(
        "channel_feeds_due_idx",
        "channel_feeds",
        ["next_fetch_at"],
        postgresql_where=sa.text("enabled"),
    )
    op.create_index("channel_feeds_owner_idx", "channel_feeds", ["owner_id"])


def downgrade() -> None:
    op.drop_index("channel_feeds_owner_idx", table_name="channel_feeds")
    op.drop_index("channel_feeds_due_idx", table_name="channel_feeds")
    op.drop_table("channel_feeds")
