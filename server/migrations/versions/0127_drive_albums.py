"""Photo albums on drive folders (AL1, M180, docs/ALBUMS.md §4)

Revision ID: 0127
Revises: 0126
Create Date: 2026-10-29

An album is a drive folder plus a little metadata (drive_albums, keyed by the folder). A drive
image's display-size copy (2048 px WebP without metadata) and what the server read from a photo or
a video (its capture time, whether it holds a location) live in its attachments row, as the
thumbnail does; drive_items.taken_at copies the current version's capture time for the album's
order. drive_share_links.originals: whether a link hands out the original files (album links are
made with false).

Nothing is computed here: the drive's media loop reads new versions, and `app.cli drive-photos`
the stored ones (photo_probed_at IS NULL), a bounded number a run.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "0127"
down_revision: str | None = "0126"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # As 0126: 0118's deferred foreign keys must be checked before drive_items can be altered.
    op.execute("SET CONSTRAINTS ALL IMMEDIATE")
    op.create_table(
        "drive_albums",
        sa.Column(
            "folder_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("drive_items.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "cover_item_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("drive_items.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("sort", sa.String(8), nullable=False, server_default="taken"),
        sa.Column("sort_order", sa.String(4), nullable=False, server_default="asc"),
        sa.Column("starts_on", sa.Date(), nullable=True),
        sa.Column("ends_on", sa.Date(), nullable=True),
        sa.Column(
            "created_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint("sort IN ('taken', 'name', 'added')", name="sort_values"),
        sa.CheckConstraint("sort_order IN ('asc', 'desc')", name="sort_order_values"),
        sa.CheckConstraint(
            "ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on", name="dates_order"
        ),
    )
    op.execute(
        "CREATE INDEX drive_albums_description_pgroonga_idx ON drive_albums "
        "USING pgroonga (description)"
    )
    op.create_index("drive_albums_cover_idx", "drive_albums", ["cover_item_id"])

    op.add_column("attachments", sa.Column("display_key", sa.Text(), nullable=True))
    op.add_column("attachments", sa.Column("display_width", sa.Integer(), nullable=True))
    op.add_column("attachments", sa.Column("display_height", sa.Integer(), nullable=True))
    op.add_column("attachments", sa.Column("display_bytes", sa.Integer(), nullable=True))
    op.add_column("attachments", sa.Column("taken_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("attachments", sa.Column("taken_at_local", sa.Boolean(), nullable=True))
    op.add_column("attachments", sa.Column("has_location", sa.Boolean(), nullable=True))
    op.add_column(
        "attachments", sa.Column("photo_probed_at", sa.DateTime(timezone=True), nullable=True)
    )

    op.add_column("drive_items", sa.Column("taken_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index(
        "drive_items_taken_idx",
        "drive_items",
        ["parent_id", "taken_at", "id"],
        postgresql_where=sa.text("trashed_at IS NULL AND kind = 'file'"),
    )

    op.add_column(
        "drive_share_links",
        sa.Column("originals", sa.Boolean(), nullable=False, server_default=sa.text("true")),
    )


def _revoke_or_refuse() -> None:
    """REVIEW-v0.1.82 #2: a server before 0127 has no `originals` and hands out every original
    file (a photo's EXIF location too) through a link made with originals=false. Refuses the
    downgrade while such a link is not revoked, unless `alembic -x album_links=revoke`: then those
    links are revoked (their people make new ones after the downgrade, knowing what they hand
    out). Expired links count too: an older server reads the same expiry, but it is simpler and
    safer not to keep any."""
    found = op.get_bind().execute(
        sa.text(
            "SELECT count(*) FROM drive_share_links WHERE originals = false AND revoked_at IS NULL"
        )
    )
    count = int(found.scalar_one())
    if count == 0:
        return
    if context.get_x_argument(as_dictionary=True).get("album_links") != "revoke":
        raise RuntimeError(
            f"0127 downgrade refused: {count} share link(s) hand out no original files, and a "
            "server before 0127 would hand out the originals (with their EXIF location) through "
            "them. Run `alembic -x album_links=revoke downgrade <rev>` to revoke those links "
            "first (docs/ALBUMS.md §24)."
        )
    op.execute(
        "UPDATE drive_share_links SET revoked_at = now(), updated_at = now() "
        "WHERE originals = false AND revoked_at IS NULL"
    )


def downgrade() -> None:
    _revoke_or_refuse()
    op.drop_column("drive_share_links", "originals")
    op.drop_index("drive_items_taken_idx", table_name="drive_items")
    op.drop_column("drive_items", "taken_at")
    # The display images stay in the store until their attachments are removed (the GC no
    # longer knows their keys after this): `verify-attachments` does not report them.
    for column in (
        "photo_probed_at",
        "has_location",
        "taken_at_local",
        "taken_at",
        "display_bytes",
        "display_height",
        "display_width",
        "display_key",
    ):
        op.drop_column("attachments", column)
    op.drop_index("drive_albums_cover_idx", table_name="drive_albums")
    op.execute("DROP INDEX IF EXISTS drive_albums_description_pgroonga_idx")
    op.drop_table("drive_albums")
