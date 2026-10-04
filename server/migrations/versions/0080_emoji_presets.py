"""Preset emoji packs from a server-side folder (M102)

Revision ID: 0080
Revises: 0079
Create Date: 2026-10-04

docs/EMOJI.md §8: the folders under EMOJI_PRESETS_DIR are imported at startup. `emoji_packs.
preset_key` (the folder name) and `custom_emoji.preset_key` say where a pack or emoji came from;
`preset_hash` / `preset_tab_hash` are the SHA-256 of the file last imported, so a changed file
replaces the image and an unchanged one costs nothing. `emoji_preset_removals` remembers what an
administrator deleted (shortcode "" = the whole pack), so the next startup does not bring it back.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0080"
down_revision: str | None = "0079"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("emoji_packs", sa.Column("preset_key", sa.String(255), nullable=True))
    op.add_column("emoji_packs", sa.Column("preset_tab_hash", sa.String(64), nullable=True))
    op.create_unique_constraint("emoji_packs_preset_key_key", "emoji_packs", ["preset_key"])
    op.add_column("custom_emoji", sa.Column("preset_key", sa.String(255), nullable=True))
    op.add_column("custom_emoji", sa.Column("preset_hash", sa.String(64), nullable=True))
    op.create_table(
        "emoji_preset_removals",
        sa.Column("preset_key", sa.String(255), primary_key=True),
        # "" = the whole pack was deleted; otherwise the shortcode of one deleted emoji.
        sa.Column("shortcode", sa.String(32), primary_key=True, server_default=""),
        sa.Column(
            "removed_by",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "removed_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )


def downgrade() -> None:
    op.drop_table("emoji_preset_removals")
    op.drop_column("custom_emoji", "preset_hash")
    op.drop_column("custom_emoji", "preset_key")
    op.drop_constraint("emoji_packs_preset_key_key", "emoji_packs", type_="unique")
    op.drop_column("emoji_packs", "preset_tab_hash")
    op.drop_column("emoji_packs", "preset_key")
