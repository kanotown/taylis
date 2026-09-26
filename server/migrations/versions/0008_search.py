"""full-text search (M9b): PGroonga indexes on message bodies and attachment filenames

Revision ID: 0008
Revises: 0007
Create Date: 2026-09-26
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pgroonga")
    op.execute("CREATE INDEX messages_body_pgroonga_idx ON messages USING pgroonga (body)")
    op.execute(
        "CREATE INDEX attachments_filename_pgroonga_idx ON attachments USING pgroonga (filename)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS attachments_filename_pgroonga_idx")
    op.execute("DROP INDEX IF EXISTS messages_body_pgroonga_idx")
