"""M42: canvas search index and canvas images (CANVAS.md §4.3, §4.8, §4.10)

Revision ID: 0047
Revises: 0046
Create Date: 2026-09-30

- canvases_search_idx: one PGroonga index on ARRAY[title, body], so a search asks one index for
  both (`title &@~ q OR body &@~ q` used none: 1,374 ms in CANVAS.md §7).
- attachments.canvas_id: the canvas an image (or file) in a canvas's body belongs to. Its
  channel_id is the canvas's conversation and message_id stays NULL. When a canvas is purged its
  images are marked deleted first; SET NULL only keeps the row deletable.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0047"
down_revision: str | None = "0046"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "CREATE INDEX canvases_search_idx ON canvases USING pgroonga ((ARRAY[title::text, body]))"
    )
    op.add_column(
        "attachments",
        sa.Column(
            "canvas_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("canvases.id", ondelete="SET NULL", name="attachments_canvas_id_fkey"),
            nullable=True,
        ),
    )
    op.execute(
        "CREATE INDEX attachments_canvas_idx ON attachments (canvas_id) WHERE canvas_id IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS attachments_canvas_idx")
    op.drop_column("attachments", "canvas_id")
    op.execute("DROP INDEX IF EXISTS canvases_search_idx")
