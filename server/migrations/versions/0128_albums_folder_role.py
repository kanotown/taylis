"""The 「アルバム」 folder gets a system_role (AL follow-up, docs/ALBUMS.md §23)

Revision ID: 0128
Revises: 0127
Create Date: 2026-10-29

drive_items.system_role = 'albums' marks the folder POST /drive/albums {location_id} makes albums
in, so clients can name it in their language. Unlike 「投稿のファイル」 it is an ordinary folder.

Backfill: AL1 kept no record of the folders it made, but it found the folder by its name right
under the location's top (and reused one a person had made there), so every live folder named
「アルバム」 directly under a location's root is that folder. Names are unique per folder, so a
location has at most one.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0128"
down_revision: str | None = "0127"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint("system_role_values", "drive_items", type_="check")
    op.create_check_constraint(
        "system_role_values",
        "drive_items",
        "system_role IS NULL OR (system_role IN ('channel_posts', 'albums') AND kind = 'folder')",
    )
    op.execute(
        sa.text(
            """
            UPDATE drive_items AS i
            SET system_role = 'albums', change_seq = nextval('drive_change_seq')
            FROM drive_locations AS l
            WHERE i.location_id = l.id
              AND i.parent_id = l.root_id
              AND i.kind = 'folder'
              AND i.trashed_at IS NULL
              AND i.system_role IS NULL
              AND i.name_key = :key
            """
        ).bindparams(key="アルバム")
    )


def downgrade() -> None:
    op.execute("UPDATE drive_items SET system_role = NULL WHERE system_role = 'albums'")
    op.drop_constraint("system_role_values", "drive_items", type_="check")
    op.create_check_constraint(
        "system_role_values",
        "drive_items",
        "system_role IS NULL OR (system_role = 'channel_posts' AND kind = 'folder')",
    )
