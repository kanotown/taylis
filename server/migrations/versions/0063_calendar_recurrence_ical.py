"""M68: recurring calendar events and iCal feeds (CALENDAR.md §10)

Revision ID: 0063
Revises: 0062
Create Date: 2026-10-02

- calendar_events: rrule (the normalized RRULE; NULL = a one-off event), tz (the zone it repeats
  in; required with rrule) and series_end (a bound on the last occurrence's end, NULL = no end).
- calendar_event_overrides: one occurrence changed or cancelled (この予定だけ), keyed by its
  original start.
- calendar_event_alarms.occurrence_start: which occurrence of a series the alarm is for.
- calendar_feeds: private iCal feed URLs (only the token's SHA-256).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0063"
down_revision: str | None = "0062"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TIME_SHAPE = (
    "(all_day AND starts_at IS NULL AND ends_at IS NULL"
    " AND start_date IS NOT NULL AND end_date IS NOT NULL"
    " AND end_date >= start_date AND end_date - start_date < 60)"
    " OR (NOT all_day AND start_date IS NULL AND end_date IS NULL"
    " AND starts_at IS NOT NULL AND ends_at IS NOT NULL"
    " AND ends_at > starts_at AND ends_at - starts_at <= interval '14 days')"
)


def upgrade() -> None:
    uid = postgresql.UUID(as_uuid=True)
    op.add_column("calendar_events", sa.Column("rrule", sa.Text(), nullable=True))
    op.add_column("calendar_events", sa.Column("tz", sa.String(64), nullable=True))
    op.add_column(
        "calendar_events", sa.Column("series_end", sa.DateTime(timezone=True), nullable=True)
    )
    op.create_check_constraint("rrule_tz", "calendar_events", "rrule IS NULL OR tz IS NOT NULL")
    op.execute(
        "CREATE INDEX calendar_events_recurring_idx ON calendar_events (owner_id, channel_id) "
        "WHERE rrule IS NOT NULL AND deleted_at IS NULL"
    )

    op.create_table(
        "calendar_event_overrides",
        sa.Column(
            "series_id",
            uid,
            sa.ForeignKey("calendar_events.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("occurrence_start", sa.String(32), primary_key=True),
        sa.Column("cancelled", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column(
            "changed",
            postgresql.ARRAY(sa.String(16)),
            nullable=False,
            server_default=sa.text("'{}'"),
        ),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column("location", sa.Text(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("all_day", sa.Boolean(), nullable=True),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("start_date", sa.Date(), nullable=True),
        sa.Column("end_date", sa.Date(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint(
            "title IS NULL OR char_length(title) BETWEEN 1 AND 200", name="title_length"
        ),
        sa.CheckConstraint(
            "location IS NULL OR char_length(location) <= 200", name="location_length"
        ),
        sa.CheckConstraint(
            "description IS NULL OR char_length(description) <= 4000", name="description_length"
        ),
        sa.CheckConstraint(
            "(all_day IS NULL AND starts_at IS NULL AND ends_at IS NULL"
            f" AND start_date IS NULL AND end_date IS NULL) OR {_TIME_SHAPE}",
            name="time_shape",
        ),
    )

    op.add_column(
        "calendar_event_alarms", sa.Column("occurrence_start", sa.String(32), nullable=True)
    )

    op.create_table(
        "calendar_feeds",
        sa.Column("id", uid, primary_key=True),
        sa.Column("user_id", uid, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("token_hash", sa.LargeBinary(), nullable=False, unique=True),
        sa.Column("scope", sa.String(16), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("scope IN ('all', 'personal')", name="scope_values"),
    )
    op.create_index("calendar_feeds_user_idx", "calendar_feeds", ["user_id"])


def downgrade() -> None:
    op.drop_index("calendar_feeds_user_idx", table_name="calendar_feeds")
    op.drop_table("calendar_feeds")
    op.drop_column("calendar_event_alarms", "occurrence_start")
    op.drop_table("calendar_event_overrides")
    op.execute("DROP INDEX IF EXISTS calendar_events_recurring_idx")
    # A recurring event becomes its first occurrence (the rule is lost).
    op.drop_constraint("rrule_tz", "calendar_events", type_="check")
    op.drop_column("calendar_events", "series_end")
    op.drop_column("calendar_events", "tz")
    op.drop_column("calendar_events", "rrule")
