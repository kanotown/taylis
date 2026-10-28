"""Channel files in the channel's drive (CF1, M174, docs/CHANNEL_FILES.md §3.2)

Revision ID: 0126
Revises: 0125
Create Date: 2026-10-28

A file posted in a public or private channel becomes version 1 of a new item in the channel's
drive, in the same attachments row (one row, one object). attachments.drive_state is what the
channel sees of it (available / moved / trashed / deleted; NULL for every other row);
drive_items.system_role marks the folder 「投稿のファイル」 (channel_posts). The switches:
workspace_settings.channel_files_to_drive (default on) and channels.files_to_drive (NULL: follow
the workspace). drive_file_versions.source gets the value 'message' (no CHECK on it).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0126"
down_revision: str | None = "0125"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 0118 inserts 研究室ドライブ with deferred foreign keys; when the migrations run in one
    # transaction their checks are still pending, and drive_items cannot be altered until then.
    op.execute("SET CONSTRAINTS ALL IMMEDIATE")
    op.add_column("attachments", sa.Column("drive_state", sa.String(12), nullable=True))
    op.create_check_constraint(
        "drive_state_values",
        "attachments",
        "drive_state IS NULL OR (drive_state IN ('available', 'moved', 'trashed', 'deleted') "
        "AND message_id IS NOT NULL)",
    )
    op.create_index(
        "attachments_drive_state_idx",
        "attachments",
        ["drive_item_id"],
        postgresql_where=sa.text("drive_state IS NOT NULL"),
    )
    op.add_column("drive_items", sa.Column("system_role", sa.String(16), nullable=True))
    op.create_check_constraint(
        "system_role_values",
        "drive_items",
        "system_role IS NULL OR (system_role = 'channel_posts' AND kind = 'folder')",
    )
    op.create_index(
        "drive_items_system_role_uniq",
        "drive_items",
        ["location_id", "system_role"],
        unique=True,
        postgresql_where=sa.text("system_role IS NOT NULL AND trashed_at IS NULL"),
    )
    op.add_column(
        "workspace_settings",
        sa.Column(
            "channel_files_to_drive", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
    )
    op.add_column("channels", sa.Column("files_to_drive", sa.Boolean(), nullable=True))


def downgrade() -> None:
    op.drop_column("channels", "files_to_drive")
    op.drop_column("workspace_settings", "channel_files_to_drive")
    op.drop_index("drive_items_system_role_uniq", table_name="drive_items")
    op.drop_constraint("system_role_values", "drive_items", type_="check")
    op.drop_column("drive_items", "system_role")
    op.drop_index("attachments_drive_state_idx", table_name="attachments")
    op.drop_constraint("drive_state_values", "attachments", type_="check")
    # Tombstones (status 'purged') have no bytes left: the GC removes them as deleted rows.
    op.execute("UPDATE attachments SET status = 'deleted' WHERE status = 'purged'")
    op.drop_column("attachments", "drive_state")
