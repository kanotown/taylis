"""Canvas mentions in the activity (M76)

Revision ID: 0066
Revises: 0065
Create Date: 2026-10-02

docs/CANVAS.md §20: `canvas_mentions`, one activity item per person a canvas newly mentions
(written with canvas.mentioned). While unread, a later mention in the same canvas moves the row
instead of adding one. Rows go with the canvas (purge) and the person; nothing is backfilled
(the mentions of M72 were pushes only).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0066"
down_revision: str | None = "0065"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "canvas_mentions",
        sa.Column("id", postgresql.UUID(), nullable=False),
        sa.Column("user_id", postgresql.UUID(), nullable=False),
        sa.Column("canvas_id", postgresql.UUID(), nullable=False),
        sa.Column("rev_id", postgresql.UUID(), nullable=False),
        sa.Column("actor_id", postgresql.UUID(), nullable=False),
        sa.Column("excerpt", sa.Text(), server_default="", nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["canvas_id"], ["canvases.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["actor_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("canvas_mentions_user_idx", "canvas_mentions", ["user_id", sa.text("at DESC")])
    op.create_index("canvas_mentions_canvas_idx", "canvas_mentions", ["canvas_id", "user_id"])


def downgrade() -> None:
    op.drop_index("canvas_mentions_canvas_idx", table_name="canvas_mentions")
    op.drop_index("canvas_mentions_user_idx", table_name="canvas_mentions")
    op.drop_table("canvas_mentions")
