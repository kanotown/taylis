"""Video shape, length and poster (M79)

Revision ID: 0067
Revises: 0066
Create Date: 2026-10-02

SECURITY.md §4 「動画」: at upload the server reads a video's upright size (attachments.width /
height, as for an image), its length (duration_ms) and a poster frame (thumbnail_key, served by
the thumbnail endpoint). video_probed_at says it has looked (found something or not). Existing
videos are not touched here (it needs ffmpeg and the object store): `app.cli probe-videos` fills
them in, moving each message's updated_seq so devices get them through the delta.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0067"
down_revision: str | None = "0066"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("attachments", sa.Column("duration_ms", sa.Integer(), nullable=True))
    op.add_column(
        "attachments", sa.Column("video_probed_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("attachments", "video_probed_at")
    op.drop_column("attachments", "duration_ms")
