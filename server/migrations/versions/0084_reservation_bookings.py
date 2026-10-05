"""Reservation pools become the workspace's, with hourly bookings and notices (M112)

Revision ID: 0083
Revises: 0082
Create Date: 2026-10-05

docs/RESERVATIONS.md §2. `reservation_pools` lose their channel: `log_channel_id` (optional, the
channel the 「予約」 bot writes in; none by default), `visibility` (all / channel / group with
`visibility_channel_id` / `visibility_group_id`) and `max_hours` (the longest booking, 6) are new.
`reservations` get `kind` (walkin / booking) and a booking's `start_at` / `end_at`, the status
`booked`, and lose `channel_id` and `ready_notified_at` (the notices remember what was told).
`reservation_notices` are the activity items of kind reservation.

Existing pools stay with their queue and holders (all walk-ins): a pool of a private channel is
seen by that channel's members (visibility channel), any other by everyone. None keeps writing in
its channel (log_channel_id empty): the page and the activity items replace the posts; an
administrator can name a log channel again.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0083"
down_revision: str | None = "0082"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OLD_ACTIVE = sa.text("status IN ('waiting', 'holding', 'returning')")
WALKIN_ACTIVE = sa.text("kind = 'walkin' AND status IN ('waiting', 'holding', 'returning')")
ACTIVE = sa.text("status IN ('waiting', 'booked', 'holding', 'returning')")


def upgrade() -> None:
    op.add_column(
        "reservation_pools",
        sa.Column("max_hours", sa.Integer(), nullable=False, server_default=sa.text("6")),
    )
    op.add_column(
        "reservation_pools",
        sa.Column(
            "log_channel_id",
            sa.Uuid(),
            sa.ForeignKey("channels.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "reservation_pools",
        sa.Column("visibility", sa.String(16), nullable=False, server_default=sa.text("'all'")),
    )
    op.add_column(
        "reservation_pools",
        sa.Column(
            "visibility_channel_id",
            sa.Uuid(),
            sa.ForeignKey("channels.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "reservation_pools",
        sa.Column(
            "visibility_group_id",
            sa.Uuid(),
            sa.ForeignKey("user_groups.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.execute(
        """
        UPDATE reservation_pools p
           SET visibility = 'channel', visibility_channel_id = p.channel_id
          FROM channels c
         WHERE c.id = p.channel_id AND c.type = 'private'
        """
    )
    op.create_check_constraint(
        "reservation_pools_visibility_check",
        "reservation_pools",
        "visibility IN ('all', 'channel', 'group')",
    )
    op.create_check_constraint(
        "reservation_pools_max_hours_check", "reservation_pools", "max_hours >= 1"
    )
    op.drop_index("reservation_pools_channel_idx", table_name="reservation_pools")
    op.drop_column("reservation_pools", "channel_id")

    op.add_column(
        "reservations",
        sa.Column("kind", sa.String(8), nullable=False, server_default=sa.text("'walkin'")),
    )
    op.add_column("reservations", sa.Column("start_at", sa.DateTime(timezone=True)))
    op.add_column("reservations", sa.Column("end_at", sa.DateTime(timezone=True)))
    op.drop_index("reservations_active_uniq", table_name="reservations")
    op.drop_index("reservations_pool_active_idx", table_name="reservations")
    op.drop_constraint("reservations_status_check", "reservations", type_="check")
    op.drop_column("reservations", "channel_id")
    op.drop_column("reservations", "ready_notified_at")
    op.create_check_constraint(
        "reservations_status_check",
        "reservations",
        "status IN ('waiting', 'booked', 'holding', 'returning', 'done', 'cancelled')",
    )
    op.create_check_constraint(
        "reservations_kind_check",
        "reservations",
        "kind IN ('walkin', 'booking') AND "
        "(kind = 'walkin' OR (start_at IS NOT NULL AND end_at > start_at))",
    )
    op.create_index(
        "reservations_walkin_uniq",
        "reservations",
        ["pool_id", "user_id"],
        unique=True,
        postgresql_where=WALKIN_ACTIVE,
    )
    op.create_index(
        "reservations_pool_active_idx",
        "reservations",
        ["pool_id", "status"],
        postgresql_where=ACTIVE,
    )
    op.create_index("reservations_pool_end_idx", "reservations", ["pool_id", "end_at"])

    op.create_table(
        "reservation_notices",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "pool_id",
            sa.Uuid(),
            sa.ForeignKey("reservation_pools.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "reservation_id",
            sa.Uuid(),
            sa.ForeignKey("reservations.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("key", sa.String(200), nullable=False),
        sa.Column("operator", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("done_at", sa.DateTime(timezone=True)),
        sa.Column("done_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.UniqueConstraint("user_id", "key", name="reservation_notices_user_key_uniq"),
    )
    op.create_index(
        "reservation_notices_user_idx", "reservation_notices", ["user_id", sa.text("at DESC")]
    )
    op.create_index(
        "reservation_notices_open_idx",
        "reservation_notices",
        ["pool_id"],
        postgresql_where=sa.text("operator AND done_at IS NULL"),
    )


def downgrade() -> None:
    """Back to channel pools: bookings and notices go; a pool without a channel to return to (no
    log channel, no visibility channel) goes with its rows."""
    op.drop_table("reservation_notices")
    op.execute("DELETE FROM reservations WHERE kind = 'booking'")
    op.add_column(
        "reservation_pools",
        sa.Column(
            "channel_id", sa.Uuid(), sa.ForeignKey("channels.id", ondelete="CASCADE"), nullable=True
        ),
    )
    op.execute(
        "UPDATE reservation_pools SET channel_id = COALESCE(log_channel_id, visibility_channel_id)"
    )
    op.execute("DELETE FROM reservation_pools WHERE channel_id IS NULL")
    op.alter_column("reservation_pools", "channel_id", nullable=False)
    op.create_index("reservation_pools_channel_idx", "reservation_pools", ["channel_id"])
    op.drop_constraint("reservation_pools_visibility_check", "reservation_pools", type_="check")
    op.drop_constraint("reservation_pools_max_hours_check", "reservation_pools", type_="check")
    for column in (
        "max_hours",
        "log_channel_id",
        "visibility",
        "visibility_channel_id",
        "visibility_group_id",
    ):
        op.drop_column("reservation_pools", column)

    op.drop_index("reservations_pool_end_idx", table_name="reservations")
    op.drop_index("reservations_pool_active_idx", table_name="reservations")
    op.drop_index("reservations_walkin_uniq", table_name="reservations")
    op.drop_constraint("reservations_kind_check", "reservations", type_="check")
    op.drop_constraint("reservations_status_check", "reservations", type_="check")
    op.add_column(
        "reservations",
        sa.Column(
            "channel_id", sa.Uuid(), sa.ForeignKey("channels.id", ondelete="CASCADE"), nullable=True
        ),
    )
    op.execute(
        "UPDATE reservations r SET channel_id = p.channel_id "
        "FROM reservation_pools p WHERE p.id = r.pool_id"
    )
    op.alter_column("reservations", "channel_id", nullable=False)
    op.add_column("reservations", sa.Column("ready_notified_at", sa.DateTime(timezone=True)))
    for column in ("kind", "start_at", "end_at"):
        op.drop_column("reservations", column)
    op.create_check_constraint(
        "reservations_status_check",
        "reservations",
        "status IN ('waiting', 'holding', 'returning', 'done', 'cancelled')",
    )
    op.create_index(
        "reservations_active_uniq",
        "reservations",
        ["pool_id", "user_id"],
        unique=True,
        postgresql_where=OLD_ACTIVE,
    )
    op.create_index(
        "reservations_pool_active_idx",
        "reservations",
        ["pool_id", "status"],
        postgresql_where=OLD_ACTIVE,
    )
