"""Document previews (M108)

Revision ID: 0082
Revises: 0081
Create Date: 2026-10-05

docs/PREVIEWS.md: a PDF or Office upload gets a first-page thumbnail (WebP) and, for an Office file,
a PDF made by the converter service, both in the object store next to the original. The preview
loop takes rows whose preview_status is 'pending' in preview_next_at order (partial index).
Existing rows stay 'none' (adding a column with a constant default rewrites nothing):
`app.cli generate-previews` makes previews of files stored before this.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0082"
down_revision: str | None = "0081"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "attachments",
        sa.Column("preview_status", sa.String(16), nullable=False, server_default="none"),
    )
    op.add_column("attachments", sa.Column("preview_pages", sa.Integer(), nullable=True))
    op.add_column("attachments", sa.Column("preview_pdf_key", sa.Text(), nullable=True))
    op.add_column("attachments", sa.Column("preview_thumb_key", sa.Text(), nullable=True))
    op.add_column("attachments", sa.Column("preview_width", sa.Integer(), nullable=True))
    op.add_column("attachments", sa.Column("preview_height", sa.Integer(), nullable=True))
    op.add_column(
        "attachments",
        sa.Column("preview_attempts", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "attachments",
        sa.Column("preview_next_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column("attachments", sa.Column("preview_error", sa.Text(), nullable=True))
    op.create_index(
        "attachments_preview_queue_idx",
        "attachments",
        ["preview_next_at"],
        postgresql_where=sa.text("preview_status = 'pending'"),
    )


def downgrade() -> None:
    op.drop_index("attachments_preview_queue_idx", table_name="attachments")
    for column in (
        "preview_error",
        "preview_next_at",
        "preview_attempts",
        "preview_height",
        "preview_width",
        "preview_thumb_key",
        "preview_pdf_key",
        "preview_pages",
        "preview_status",
    ):
        op.drop_column("attachments", column)
