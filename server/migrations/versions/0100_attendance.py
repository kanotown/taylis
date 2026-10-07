"""在室状況 (attendance, M140, docs/PRESENCE.md §2)

Revision ID: 0100
Revises: 0099
Create Date: 2026-10-07

- attendance_settings: the switch (off by default), who may add personal states, log retention.
- attendance_states: the workspace's states (owner_id NULL) and personal ones; deleting archives.
- attendance_current: one row per person (state, since, note, where the change came from).
- attendance_log: every change, appended; purged after the retention.
- attendance_integrations: outside systems (webhook url + signing key file name, inbound token
  hash).
- attendance_deliveries: one outgoing webhook delivery each (unique per outbox event and
  integration, so a replayed outbox row does not send twice).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0100"
down_revision: str | None = "0099"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _ts(name: str, *, nullable: bool = False, default: bool = True) -> sa.Column:  # type: ignore[type-arg]
    return sa.Column(
        name,
        sa.DateTime(timezone=True),
        nullable=nullable,
        server_default=sa.func.now() if default else None,
    )


def upgrade() -> None:
    op.create_table(
        "attendance_settings",
        sa.Column("singleton", sa.Boolean(), primary_key=True, server_default=sa.text("true")),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("personal_rule", sa.Text(), nullable=False, server_default="nobody"),
        sa.Column(
            "personal_group_ids",
            postgresql.ARRAY(sa.Uuid()),
            nullable=False,
            server_default=sa.text("'{}'"),
        ),
        sa.Column("log_retention_days", sa.Integer(), nullable=False, server_default="365"),
        _ts("updated_at"),
        sa.Column("updated_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.CheckConstraint("singleton", name="attendance_settings_singleton"),
        sa.CheckConstraint(
            "personal_rule IN ('nobody', 'everyone', 'admins', 'groups')",
            name="attendance_settings_rule",
        ),
    )
    op.create_table(
        "attendance_states",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("owner_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE")),
        sa.Column("label", sa.String(40), nullable=False),
        sa.Column("emoji", sa.String(32)),
        sa.Column("color", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        _ts("archived_at", nullable=True, default=False),
        _ts("created_at"),
        _ts("updated_at"),
        sa.CheckConstraint(
            "kind IN ('in_room', 'on_site', 'off_site', 'gone')", name="attendance_states_kind"
        ),
    )
    op.create_index("attendance_states_owner_idx", "attendance_states", ["owner_id"])
    op.create_table(
        "attendance_current",
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column("state_id", sa.Uuid(), sa.ForeignKey("attendance_states.id"), nullable=False),
        _ts("since", default=False),
        sa.Column("note", sa.String(100)),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("actor_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("integration_id", sa.Uuid()),
        _ts("updated_at"),
    )
    op.create_table(
        "attendance_log",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), primary_key=True),
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("from_state_id", sa.Uuid()),
        sa.Column("to_state_id", sa.Uuid(), nullable=False),
        sa.Column("note", sa.String(100)),
        _ts("at", default=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("actor_id", sa.Uuid()),
        sa.Column("integration_id", sa.Uuid()),
    )
    op.create_index("attendance_log_user_idx", "attendance_log", ["user_id", "id"])
    op.create_index("attendance_log_at_idx", "attendance_log", ["at"])
    op.create_table(
        "attendance_integrations",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("url", sa.Text()),
        sa.Column("secret_name", sa.Text()),
        sa.Column("token_hash", sa.LargeBinary(), unique=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        _ts("created_at"),
        _ts("updated_at"),
        _ts("last_inbound_at", nullable=True, default=False),
    )
    op.create_table(
        "attendance_deliveries",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "integration_id",
            sa.Uuid(),
            sa.ForeignKey("attendance_integrations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("outbox_event_id", sa.BigInteger()),
        sa.Column("log_id", sa.BigInteger()),
        sa.Column("user_id", sa.Uuid()),
        sa.Column("event", sa.Text(), nullable=False),
        sa.Column("body", postgresql.JSONB(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        _ts("next_attempt_at"),
        sa.Column("last_status_code", sa.Integer()),
        sa.Column("last_error", sa.Text()),
        _ts("delivered_at", nullable=True, default=False),
        _ts("created_at"),
        sa.UniqueConstraint(
            "outbox_event_id", "integration_id", name="attendance_deliveries_event_uq"
        ),
    )
    op.create_index(
        "attendance_deliveries_due_idx",
        "attendance_deliveries",
        ["next_attempt_at"],
        postgresql_where=sa.text("status = 'pending'"),
    )
    op.create_index(
        "attendance_deliveries_integration_idx",
        "attendance_deliveries",
        ["integration_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_table("attendance_deliveries")
    op.drop_table("attendance_integrations")
    op.drop_table("attendance_log")
    op.drop_table("attendance_current")
    op.drop_table("attendance_states")
    op.drop_table("attendance_settings")
