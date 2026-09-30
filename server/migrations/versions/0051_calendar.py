"""M51: calendar_events and calendar_event_alarms (CALENDAR.md §2)

Revision ID: 0051
Revises: 0050
Create Date: 2026-10-01

- calendar_events: one-off events in a person's own calendar (channel_id NULL) or a channel's
  shared calendar. A timed event has starts_at/ends_at (at most 14 days), an all-day one
  start_date/end_date (end included, at most 60 days); the CHECK keeps exactly one pair.
- calendar_event_alarms: one row per event and person (the one notified), with the time it works
  out to (fire_at) and the zone of the device that set it (8:00 of an all-day event, and the time
  shown in the notification).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0051"
down_revision: str | None = "0050"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    uid = postgresql.UUID(as_uuid=True)
    op.create_table(
        "calendar_events",
        sa.Column("id", uid, primary_key=True),
        sa.Column("channel_id", uid, sa.ForeignKey("channels.id"), nullable=True),
        sa.Column("owner_id", uid, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("all_day", sa.Boolean(), nullable=False),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("start_date", sa.Date(), nullable=True),
        sa.Column("end_date", sa.Date(), nullable=True),
        sa.Column("location", sa.Text(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("client_event_id", uid, nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("char_length(title) BETWEEN 1 AND 200", name="title_length"),
        sa.CheckConstraint(
            "location IS NULL OR char_length(location) <= 200", name="location_length"
        ),
        sa.CheckConstraint(
            "description IS NULL OR char_length(description) <= 4000", name="description_length"
        ),
        sa.CheckConstraint(
            "(all_day AND starts_at IS NULL AND ends_at IS NULL"
            " AND start_date IS NOT NULL AND end_date IS NOT NULL"
            " AND end_date >= start_date AND end_date - start_date < 60)"
            " OR (NOT all_day AND start_date IS NULL AND end_date IS NULL"
            " AND starts_at IS NOT NULL AND ends_at IS NOT NULL"
            " AND ends_at > starts_at AND ends_at - starts_at <= interval '14 days')",
            name="time_shape",
        ),
    )
    op.execute(
        "CREATE INDEX calendar_events_channel_idx ON calendar_events (channel_id, starts_at) "
        "WHERE channel_id IS NOT NULL AND NOT all_day AND deleted_at IS NULL"
    )
    op.execute(
        "CREATE INDEX calendar_events_personal_idx ON calendar_events (owner_id, starts_at) "
        "WHERE channel_id IS NULL AND NOT all_day AND deleted_at IS NULL"
    )
    op.execute(
        "CREATE INDEX calendar_events_channel_day_idx ON calendar_events (channel_id, start_date) "
        "WHERE channel_id IS NOT NULL AND all_day AND deleted_at IS NULL"
    )
    op.execute(
        "CREATE INDEX calendar_events_personal_day_idx ON calendar_events (owner_id, start_date) "
        "WHERE channel_id IS NULL AND all_day AND deleted_at IS NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX calendar_events_client_uniq ON calendar_events "
        "(owner_id, client_event_id) WHERE client_event_id IS NOT NULL"
    )

    op.create_table(
        "calendar_event_alarms",
        sa.Column(
            "event_id",
            uid,
            sa.ForeignKey("calendar_events.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("user_id", uid, sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("minutes_before", sa.Integer(), nullable=False),
        sa.Column("tz", sa.String(64), nullable=False),
        sa.Column("fire_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint(
            "minutes_before IN (0, 5, 10, 15, 30, 60, 1440, -480)", name="minutes_before_values"
        ),
        sa.CheckConstraint("status IN ('pending', 'fired', 'cancelled')", name="status_values"),
    )
    op.execute(
        "CREATE INDEX calendar_event_alarms_due_idx ON calendar_event_alarms (fire_at) "
        "WHERE status = 'pending'"
    )
    op.execute(
        "CREATE INDEX calendar_event_alarms_user_idx ON calendar_event_alarms (user_id) "
        "WHERE status = 'pending'"
    )


def downgrade() -> None:
    op.drop_table("calendar_event_alarms")
    op.drop_table("calendar_events")
