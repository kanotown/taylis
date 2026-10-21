"""The drive's external share links (M163, docs/DRIVE.md §4.2, §9, phase D4)

Revision ID: 0119
Revises: 0118
Create Date: 2026-10-21

drive_share_links (a link to a file or a folder: only the SHA-256 of its token, an optional
Argon2id password, an expiry, an optional download limit, revocation), drive_share_events (how the
public side used a link, kept 180 days), and the workspace's switches for the links
(workspace_settings.drive_external_links_enabled, drive_link_max_days,
drive_link_password_required), deferred from migration 0118.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0119"
down_revision: str | None = "0118"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "drive_share_links",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "item_id",
            sa.Uuid(),
            sa.ForeignKey("drive_items.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "location_id",
            sa.Uuid(),
            sa.ForeignKey("drive_locations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("token_hash", sa.LargeBinary(), nullable=False, unique=True),
        sa.Column("password_hash", sa.Text()),
        sa.Column("password_version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("expires_at", sa.DateTime(timezone=True)),
        sa.Column("max_downloads", sa.Integer()),
        sa.Column("download_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("note", sa.String(80)),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.Column("revoked_by", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("last_used_at", sa.DateTime(timezone=True)),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint("max_downloads IS NULL OR max_downloads > 0", name="max_downloads"),
        sa.CheckConstraint("download_count >= 0", name="download_count"),
    )
    op.execute(
        "CREATE INDEX drive_share_links_item_idx ON drive_share_links (item_id) "
        "WHERE revoked_at IS NULL"
    )
    op.execute(
        "CREATE INDEX drive_share_links_location_idx ON drive_share_links (location_id) "
        "WHERE revoked_at IS NULL"
    )
    op.create_index("drive_share_links_created_by_idx", "drive_share_links", ["created_by"])

    op.create_table(
        "drive_share_events",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column(
            "link_id",
            sa.Uuid(),
            sa.ForeignKey("drive_share_links.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("item_id", sa.Uuid()),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("bytes", sa.BigInteger()),
        sa.Column("ip", postgresql.INET()),
        sa.Column("user_agent", sa.String(200)),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint(
            "kind IN ('open', 'download', 'zip', 'password_failed', 'refused')",
            name="kind_values",
        ),
    )
    op.create_index("drive_share_events_link_idx", "drive_share_events", ["link_id", "created_at"])
    op.create_index("drive_share_events_created_idx", "drive_share_events", ["created_at"])

    op.add_column(
        "workspace_settings",
        sa.Column(
            "drive_external_links_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
    )
    op.add_column(
        "workspace_settings",
        sa.Column("drive_link_max_days", sa.Integer(), server_default="90"),
    )
    op.add_column(
        "workspace_settings",
        sa.Column(
            "drive_link_password_required",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("workspace_settings", "drive_link_password_required")
    op.drop_column("workspace_settings", "drive_link_max_days")
    op.drop_column("workspace_settings", "drive_external_links_enabled")
    op.drop_table("drive_share_events")
    op.drop_table("drive_share_links")
