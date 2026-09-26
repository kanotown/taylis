"""initial schema (M1): users, devices, sessions, channels, channel_members, messages

Revision ID: 0001
Revises:
Create Date: 2026-09-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _timestamps() -> list[sa.Column[sa.DateTime]]:
    return [
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    ]


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS citext")

    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("username", postgresql.CITEXT(), nullable=False),
        sa.Column("display_name", sa.String(80), nullable=False),
        sa.Column("email", postgresql.CITEXT(), nullable=True),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column(
            "must_change_password", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
        sa.Column("role", sa.String(16), nullable=False, server_default="member"),
        *_timestamps(),
        sa.Column("deactivated_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("username", name="uq_users_username"),
        sa.UniqueConstraint("email", name="uq_users_email"),
    )

    op.create_table(
        "devices",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", name="fk_devices_user_id_users"),
            nullable=False,
        ),
        sa.Column("platform", sa.String(16), nullable=False),
        sa.Column("device_name", sa.String(80), nullable=True),
        sa.Column("app_version", sa.String(40), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("disabled_reason", sa.String(32), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
    )
    op.create_index(
        "devices_user_enabled_idx", "devices", ["user_id"], postgresql_where=sa.text("enabled")
    )

    op.create_table(
        "sessions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", name="fk_sessions_user_id_users"),
            nullable=False,
        ),
        sa.Column(
            "device_id",
            sa.Uuid(),
            sa.ForeignKey("devices.id", name="fk_sessions_device_id_devices"),
            nullable=False,
        ),
        sa.Column("refresh_token_hash", sa.LargeBinary(32), nullable=False),
        sa.Column("prev_token_hash", sa.LargeBinary(32), nullable=True),
        sa.Column("rotated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_ip", sa.String(45), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "last_used_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoke_reason", sa.String(32), nullable=True),
        sa.UniqueConstraint("refresh_token_hash", name="uq_sessions_refresh_token_hash"),
        sa.UniqueConstraint("prev_token_hash", name="uq_sessions_prev_token_hash"),
    )
    op.create_index(
        "sessions_user_active_idx",
        "sessions",
        ["user_id"],
        postgresql_where=sa.text("revoked_at IS NULL"),
    )

    op.create_table(
        "channels",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("type", sa.String(16), nullable=False),
        sa.Column("name", postgresql.CITEXT(), nullable=True),
        sa.Column("topic", sa.Text(), nullable=True),
        sa.Column("purpose", sa.Text(), nullable=True),
        sa.Column("dm_key", sa.String(64), nullable=True),
        sa.Column(
            "created_by",
            sa.Uuid(),
            sa.ForeignKey("users.id", name="fk_channels_created_by_users"),
            nullable=True,
        ),
        sa.Column("last_seq", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
        sa.Column("last_message_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "(type IN ('public', 'private')) = (name IS NOT NULL)", name="ck_channels_name_by_type"
        ),
        sa.CheckConstraint(
            "(type IN ('dm', 'group_dm')) = (dm_key IS NOT NULL)", name="ck_channels_dm_key_by_type"
        ),
    )
    op.create_index(
        "channels_name_uniq",
        "channels",
        ["name"],
        unique=True,
        postgresql_where=sa.text("name IS NOT NULL"),
    )
    op.create_index(
        "channels_dm_key_uniq",
        "channels",
        ["dm_key"],
        unique=True,
        postgresql_where=sa.text("dm_key IS NOT NULL"),
    )

    op.create_table(
        "channel_members",
        sa.Column(
            "channel_id",
            sa.Uuid(),
            sa.ForeignKey("channels.id", name="fk_channel_members_channel_id_channels"),
            primary_key=True,
        ),
        sa.Column(
            "user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", name="fk_channel_members_user_id_users"),
            primary_key=True,
        ),
        sa.Column("role", sa.String(16), nullable=False, server_default="member"),
        sa.Column(
            "joined_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("channel_members_user_idx", "channel_members", ["user_id"])

    op.create_table(
        "messages",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "channel_id",
            sa.Uuid(),
            sa.ForeignKey("channels.id", name="fk_messages_channel_id_channels"),
            nullable=False,
        ),
        sa.Column(
            "sender_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", name="fk_messages_sender_id_users"),
            nullable=False,
        ),
        sa.Column("seq", sa.BigInteger(), nullable=False),
        sa.Column("updated_seq", sa.BigInteger(), nullable=False),
        sa.Column("client_msg_id", sa.Uuid(), nullable=True),
        sa.Column("body", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("channel_id", "seq", name="uq_messages_channel_seq"),
    )
    op.create_index(
        "messages_client_msg_id_uniq",
        "messages",
        ["sender_id", "client_msg_id"],
        unique=True,
        postgresql_where=sa.text("client_msg_id IS NOT NULL"),
    )
    op.create_index("messages_channel_updated_seq_idx", "messages", ["channel_id", "updated_seq"])


def downgrade() -> None:
    op.drop_table("messages")
    op.drop_table("channel_members")
    op.drop_table("channels")
    op.drop_table("sessions")
    op.drop_table("devices")
    op.drop_table("users")
