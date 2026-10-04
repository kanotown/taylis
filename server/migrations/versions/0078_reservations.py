"""Reservation pools: a channel's shared seats with a queue (M99)

Revision ID: 0078
Revises: 0077
Create Date: 2026-10-04

docs/RESERVATIONS.md §2: `reservation_pools` (a channel's limited resource: capacity, minimum
guaranteed hours, grace minutes, operators), `reservation_bots` (the bot a channel's pools post
as) and `reservations` (each request, from the queue to the end of its holding; ended rows stay).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0078"
down_revision: str | None = "0077"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ACTIVE = sa.text("status IN ('waiting', 'holding', 'returning')")


def _times() -> list[sa.Column[object]]:
    return [
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    ]


def upgrade() -> None:
    op.create_table(
        "reservation_pools",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "channel_id",
            sa.Uuid(),
            sa.ForeignKey("channels.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("capacity", sa.Integer(), nullable=False),
        sa.Column("min_hours", sa.Integer(), nullable=False),
        sa.Column("grace_minutes", sa.Integer(), nullable=False),
        sa.Column("tz", sa.String(64), nullable=False),
        sa.Column(
            "operator_ids",
            postgresql.ARRAY(sa.Uuid()),
            nullable=False,
            server_default=sa.text("'{}'::uuid[]"),
        ),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        *_times(),
        sa.CheckConstraint("capacity >= 1", name="reservation_pools_capacity_check"),
    )
    op.create_index("reservation_pools_channel_idx", "reservation_pools", ["channel_id"])
    op.create_table(
        "reservation_bots",
        sa.Column(
            "channel_id",
            sa.Uuid(),
            sa.ForeignKey("channels.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("bot_user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False, unique=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_table(
        "reservations",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "pool_id",
            sa.Uuid(),
            sa.ForeignKey("reservation_pools.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "channel_id",
            sa.Uuid(),
            sa.ForeignKey("channels.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("assigned_at", sa.DateTime(timezone=True)),
        sa.Column("assigned_by", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("guarantee_until", sa.DateTime(timezone=True)),
        sa.Column("returned_at", sa.DateTime(timezone=True)),
        sa.Column("evict_notice_at", sa.DateTime(timezone=True)),
        sa.Column("evict_at", sa.DateTime(timezone=True)),
        sa.Column("ready_notified_at", sa.DateTime(timezone=True)),
        sa.Column("ended_at", sa.DateTime(timezone=True)),
        sa.Column("ended_by", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("end_reason", sa.String(16)),
        *_times(),
        sa.CheckConstraint(
            "status IN ('waiting', 'holding', 'returning', 'done', 'cancelled')",
            name="reservations_status_check",
        ),
    )
    op.create_index(
        "reservations_active_uniq",
        "reservations",
        ["pool_id", "user_id"],
        unique=True,
        postgresql_where=ACTIVE,
    )
    op.create_index(
        "reservations_pool_active_idx",
        "reservations",
        ["pool_id", "status"],
        postgresql_where=ACTIVE,
    )
    op.create_index("reservations_user_idx", "reservations", ["user_id"])


def downgrade() -> None:
    op.drop_table("reservations")
    op.drop_table("reservation_bots")
    op.drop_table("reservation_pools")
