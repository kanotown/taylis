"""Emoji packs, text emoji, labels and keywords for custom emoji (M100)

Revision ID: 0079
Revises: 0078
Create Date: 2026-10-04

docs/EMOJI.md: `emoji_packs` (a named set with its own picker tab and a tab icon in the object
store); `custom_emoji` gains `kind` ("image" or "text": a short label drawn as a pill instead of
an image), `label` (the display name, e.g. 「おじぎ」; the text of a text emoji), `color` (a
palette key for text emoji), `keywords` (search terms, Japanese included), `pack_id` (NULL =
ungrouped, kept when a pack is deleted), `position` (order inside a pack) and `updated_at`.
Image columns stay NOT NULL: a text emoji has an empty content type and storage key and 0x0.
The width and height of image emoji were stored from the start (M12f), so their aspect ratio
needs no backfill.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0079"
down_revision: str | None = "0078"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "emoji_packs",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", sa.String(64), nullable=False, unique=True),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("tab_content_type", sa.Text(), nullable=True),
        sa.Column("tab_storage_key", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.add_column(
        "custom_emoji",
        sa.Column("kind", sa.String(8), nullable=False, server_default="image"),
    )
    op.create_check_constraint(
        "custom_emoji_kind_check", "custom_emoji", "kind IN ('image', 'text')"
    )
    op.add_column("custom_emoji", sa.Column("label", sa.String(32), nullable=True))
    op.add_column("custom_emoji", sa.Column("color", sa.String(16), nullable=True))
    op.add_column(
        "custom_emoji",
        sa.Column(
            "keywords",
            postgresql.ARRAY(sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::text[]"),
        ),
    )
    op.add_column(
        "custom_emoji",
        sa.Column(
            "pack_id",
            sa.Uuid(),
            sa.ForeignKey("emoji_packs.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "custom_emoji",
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "custom_emoji",
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.execute("UPDATE custom_emoji SET updated_at = created_at")
    op.create_index("custom_emoji_pack_idx", "custom_emoji", ["pack_id"])


def downgrade() -> None:
    op.drop_index("custom_emoji_pack_idx", table_name="custom_emoji")
    op.execute("DELETE FROM custom_emoji WHERE kind = 'text'")
    for column in ("updated_at", "position", "pack_id", "keywords", "color", "label"):
        op.drop_column("custom_emoji", column)
    op.drop_constraint("custom_emoji_kind_check", "custom_emoji", type_="check")
    op.drop_column("custom_emoji", "kind")
    op.drop_table("emoji_packs")
