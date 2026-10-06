"""Sidebar sorts: name / recent / manual per section, and the default sections' own row

Revision ID: 0090
Revises: 0089
Create Date: 2026-10-07

DATA_MODEL.md sidebar_sections 「並べ替え」: each of my sections, and the default
お気に入り / チャンネル / ダイレクトメッセージ, is ordered by name, by recent activity or by
hand. `sort` says which and `manual_order` keeps the hand-made order as the conversation ids in
order (ids no longer in the section are skipped by the clients; the next drag sends the whole list
again). The default sections have no sidebar_sections row, so they get sidebar_default_sections
(no row = the default: name, for the DMs recent).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0090"
down_revision: str | None = "0089"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_UUIDS = postgresql.ARRAY(postgresql.UUID(as_uuid=True))


def upgrade() -> None:
    op.add_column(
        "sidebar_sections",
        sa.Column("sort", sa.String(10), nullable=False, server_default="name"),
    )
    op.add_column(
        "sidebar_sections",
        sa.Column("manual_order", _UUIDS, nullable=False, server_default="{}"),
    )
    op.create_table(
        "sidebar_default_sections",
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("key", sa.String(16), primary_key=True),
        sa.Column("sort", sa.String(10), nullable=False),
        sa.Column("manual_order", _UUIDS, nullable=False, server_default="{}"),
        sa.CheckConstraint(
            "key IN ('favorites', 'channels', 'dms')", name="sidebar_default_sections_key"
        ),
    )


def downgrade() -> None:
    op.drop_table("sidebar_default_sections")
    op.drop_column("sidebar_sections", "manual_order")
    op.drop_column("sidebar_sections", "sort")
