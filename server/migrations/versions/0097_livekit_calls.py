"""M130: in-app calls on LiveKit (docs/CALLS.md §3.1) and the end of M117's meeting links (§11)

Revision ID: 0097
Revises: 0096
Create Date: 2026-10-07

- calls: one row per call (its id is the LiveKit room's name); at most one open call per
  conversation (calls_channel_open_uidx). message_id: the call message.
- call_participants: one row per LiveKit connection (livekit_sid is the participant's sid, the key
  that makes webhooks idempotent); open while left_at IS NULL.
- messages.call_id: the call a message announces (messages.call_url keeps M117's links, and holds
  the /call/<id> page of a LiveKit call).
- workspace_settings.in_app_calls_enabled: the administrator's switch (on by default; it only
  works when the server has LiveKit configured).
- workspace_settings.meeting_base_url: M117's meeting service, retired: every value is cleared and
  the default dropped (the column goes in M136).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0097"
down_revision: str | None = "0096"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "calls",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "channel_id",
            sa.Uuid(),
            sa.ForeignKey("channels.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "message_id",
            sa.Uuid(),
            sa.ForeignKey("messages.id", ondelete="SET NULL"),
            nullable=True,
            unique=True,
        ),
        sa.Column(
            "started_by",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "started_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("end_reason", sa.Text(), nullable=True),
        sa.Column("peak_participants", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("participant_count", sa.Integer(), nullable=False, server_default="0"),
        sa.CheckConstraint(
            "end_reason IS NULL OR end_reason IN ('empty', 'reconciled', 'archived', 'admin')",
            name="calls_end_reason_check",
        ),
    )
    op.create_index(
        "calls_channel_open_uidx",
        "calls",
        ["channel_id"],
        unique=True,
        postgresql_where=sa.text("ended_at IS NULL"),
    )
    op.create_index(
        "calls_open_idx", "calls", ["started_at"], postgresql_where=sa.text("ended_at IS NULL")
    )
    op.create_table(
        "call_participants",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "call_id", sa.Uuid(), sa.ForeignKey("calls.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("livekit_sid", sa.Text(), nullable=False, unique=True),
        sa.Column("joined_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("left_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "call_participants_open_idx",
        "call_participants",
        ["call_id"],
        postgresql_where=sa.text("left_at IS NULL"),
    )
    op.create_index("call_participants_call_idx", "call_participants", ["call_id", "user_id"])
    op.add_column(
        "messages",
        sa.Column(
            "call_id", sa.Uuid(), sa.ForeignKey("calls.id", ondelete="SET NULL"), nullable=True
        ),
    )
    op.add_column(
        "workspace_settings",
        sa.Column(
            "in_app_calls_enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
    )
    op.alter_column("workspace_settings", "meeting_base_url", server_default=None)
    op.execute("UPDATE workspace_settings SET meeting_base_url = NULL")


def downgrade() -> None:
    op.alter_column("workspace_settings", "meeting_base_url", server_default="https://meet.jit.si/")
    op.drop_column("workspace_settings", "in_app_calls_enabled")
    op.drop_column("messages", "call_id")
    op.drop_index("call_participants_call_idx", table_name="call_participants")
    op.drop_index("call_participants_open_idx", table_name="call_participants")
    op.drop_table("call_participants")
    op.drop_index("calls_open_idx", table_name="calls")
    op.drop_index("calls_channel_open_uidx", table_name="calls")
    op.drop_table("calls")
