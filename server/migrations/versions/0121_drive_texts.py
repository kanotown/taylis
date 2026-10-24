"""Drive: the text inside files, for the full-text search (2026-10-24, docs/DRIVE.md §29)

Revision ID: 0121
Revises: 0120
Create Date: 2026-10-24

drive_texts: one row per file version the extraction looked at (only current versions are looked
at; a replaced version's row is removed). The text of a PDF (an Office file's through its PDF
preview, a plain text / Markdown / CSV file's directly), NFKC-normalised and capped, with where
each PDF page begins, indexed by PGroonga with the tokenizer of messages. No row: not looked at
yet, or nothing to read in it (an image). The extraction is the drive media loop's (and
`app.cli drive-index`'s): this migration only makes the table.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0121"
down_revision: str | None = "0120"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "drive_texts",
        sa.Column(
            "version_id",
            sa.Uuid(),
            sa.ForeignKey("drive_file_versions.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "item_id",
            sa.Uuid(),
            sa.ForeignKey("drive_items.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # working (claimed, or waiting for a retry) | ready | skipped (reason) | failed (reason)
        sa.Column("status", sa.String(12), nullable=False),
        sa.Column("reason", sa.String(32), nullable=True),
        sa.Column("body", sa.Text(), nullable=False, server_default=""),
        # PDFs: where each page's text begins in body (characters), and the page count.
        sa.Column("page_starts", postgresql.ARRAY(sa.Integer()), nullable=True),
        sa.Column("pages", sa.Integer(), nullable=True),
        sa.Column("truncated", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("extracted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint(
            "status IN ('working', 'ready', 'skipped', 'failed')", name="drive_texts_status_check"
        ),
    )
    op.create_index("drive_texts_item_idx", "drive_texts", ["item_id"])
    op.create_index(
        "drive_texts_working_idx",
        "drive_texts",
        ["next_at"],
        postgresql_where=sa.text("status = 'working'"),
    )
    # The tokenizer of messages and of the file names (TokenBigram, NormalizerAuto).
    op.execute("CREATE INDEX drive_texts_body_pgroonga_idx ON drive_texts USING pgroonga (body)")


def downgrade() -> None:
    op.drop_table("drive_texts")
