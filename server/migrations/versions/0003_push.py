"""push notifications (M5): device push tokens, notification preferences, push deliveries

Revision ID: 0003
Revises: 0002
Create Date: 2026-09-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "devices", sa.Column("push_provider", sa.String(8), nullable=False, server_default="none")
    )
    op.add_column("devices", sa.Column("push_token", sa.Text(), nullable=True))
    op.add_column("devices", sa.Column("push_environment", sa.String(16), nullable=True))
    op.add_column("devices", sa.Column("push_token_invalid_reason", sa.String(32), nullable=True))
    op.create_index(
        "devices_push_token_uniq",
        "devices",
        ["push_provider", "push_token"],
        unique=True,
        postgresql_where=sa.text("push_token IS NOT NULL"),
    )

    op.create_table(
        "notification_preferences",
        sa.Column(
            "user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", name="fk_notification_preferences_user_id_users"),
            primary_key=True,
        ),
        sa.Column(
            "channel_id",
            sa.Uuid(),
            sa.ForeignKey("channels.id", name="fk_notification_preferences_channel_id_channels"),
            primary_key=True,
        ),
        sa.Column("level", sa.String(16), nullable=False),
        sa.Column("muted_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )

    op.create_table(
        "push_deliveries",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), primary_key=True),
        sa.Column("event_id", sa.BigInteger(), nullable=False),
        sa.Column(
            "device_id",
            sa.Uuid(),
            sa.ForeignKey("devices.id", name="fk_push_deliveries_device_id_devices"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", name="fk_push_deliveries_user_id_users"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(8), nullable=False),
        sa.Column("collapse_key", sa.Text(), nullable=True),
        sa.Column("channel_id", sa.Uuid(), nullable=True),
        sa.Column("message_id", sa.Uuid(), nullable=True),
        sa.Column("message_seq", sa.BigInteger(), nullable=True),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column("status", sa.String(8), nullable=False, server_default="pending"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column(
            "next_attempt_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("event_id", "device_id", name="uq_push_deliveries_event_device"),
    )
    op.create_index(
        "push_deliveries_pending_idx",
        "push_deliveries",
        ["next_attempt_at"],
        postgresql_where=sa.text("status = 'pending'"),
    )


def downgrade() -> None:
    op.drop_table("push_deliveries")
    op.drop_table("notification_preferences")
    op.drop_index("devices_push_token_uniq", table_name="devices")
    op.drop_column("devices", "push_token_invalid_reason")
    op.drop_column("devices", "push_environment")
    op.drop_column("devices", "push_token")
    op.drop_column("devices", "push_provider")
