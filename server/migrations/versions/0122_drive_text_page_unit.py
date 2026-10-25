"""Drive: Office files' text read from the package; slides and sheets (2026-10-25, DRIVE.md §29.6)

Revision ID: 0122
Revises: 0121
Create Date: 2026-10-25

drive_texts.page_unit: what page_starts count for a text read straight from an OOXML / ODF
package: "slide" (a presentation) or "sheet" (a spreadsheet); null for a PDF's pages (and a text
without pages). The search shows 「12 枚目」 for a slide.

The rows skipped for want of a PDF preview (`no_preview`) go: Word / Excel / PowerPoint and
OpenDocument files no longer need one, so the media loop reads them again straight from the
package (a legacy doc / xls / ppt is recorded as skipped again at once). The files that waited
for a preview that never came (too large for the converter) have no row and are taken as they are.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0122"
down_revision: str | None = "0121"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("drive_texts", sa.Column("page_unit", sa.String(8), nullable=True))
    op.execute("DELETE FROM drive_texts WHERE status = 'skipped' AND reason = 'no_preview'")


def downgrade() -> None:
    op.drop_column("drive_texts", "page_unit")
