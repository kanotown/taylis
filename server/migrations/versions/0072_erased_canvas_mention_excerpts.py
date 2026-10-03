"""Blank the activity excerpts of erased canvas versions (Review v0.1.22 #3)

Revision ID: 0072
Revises: 0071
Create Date: 2026-10-03

docs/CANVAS.md §20.2: erasing a version's body now also blanks the `canvas_mentions.excerpt`
copied from that version. This does the same for the versions erased before (data only; the
rows stay, `excerpt` becomes ''). The downgrade has nothing to bring back.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0072"
down_revision: str | None = "0071"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "UPDATE canvas_mentions AS m SET excerpt = '' "
        "FROM canvas_revisions AS r "
        "WHERE r.canvas_id = m.canvas_id AND r.id = m.rev_id AND r.kind = 'erased' "
        "AND m.excerpt <> ''"
    )


def downgrade() -> None:
    pass
