"""attachments.preview_generation: who owns a preview try (Review v0.1.37 #4, #9)

Revision ID: 0086
Revises: 0085
Create Date: 2026-10-06

docs/PREVIEWS.md §3: every claim of a preview try (the loop's lease, `app.cli generate-previews`)
adds 1. The worker keeps the number it claimed; its result is written only while the row still has
that number (a worker whose lease ran out and whose row was claimed again writes nothing), and its
objects are stored under keys with the number in them (`attachments/{id}.preview.{n}.pdf` /
`.webp`), so an old worker can neither overwrite nor delete a newer try's objects. The GC removes
the keys of every number up to this one, which also catches a try that stopped after a partial
write. Existing rows start at 0 (their previews keep the keys recorded in the row).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0086"
down_revision: str | None = "0085"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "attachments",
        sa.Column("preview_generation", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("attachments", "preview_generation")
