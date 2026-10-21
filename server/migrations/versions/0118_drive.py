"""The drive (M160, docs/DRIVE.md §4.2, phase D1): locations, items, versions, upload sessions

Revision ID: 0118
Revises: 0117
Create Date: 2026-10-21

drive_locations (研究室ドライブ, a channel's drive, My Drive), drive_items (folders and files, the
trash as trashed_at), drive_file_versions (one attachments row per version), drive_uploads and
drive_upload_parts (resumable S3 multipart uploads), the sequence drive_change_seq, and
attachments.drive_item_id. The workspace drive and its root folder are made here (the two rows
refer to each other: both foreign keys are DEFERRABLE INITIALLY DEFERRED). The external share
links (drive_share_links, drive_share_events, the workspace_settings switches) come with phase D4.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from app.core.ids import uuid7

revision: str = "0118"
down_revision: str | None = "0117"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("CREATE SEQUENCE drive_change_seq")
    op.create_table(
        "drive_locations",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("channel_id", sa.Uuid(), sa.ForeignKey("channels.id"), unique=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), unique=True),
        sa.Column("root_id", sa.Uuid(), nullable=False),
        sa.Column("quota_bytes", sa.BigInteger()),
        sa.Column("used_bytes", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("item_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("external_links", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint("kind IN ('workspace', 'channel', 'user')", name="kind_values"),
        sa.CheckConstraint("(kind = 'channel') = (channel_id IS NOT NULL)", name="channel_by_kind"),
        sa.CheckConstraint("(kind = 'user') = (user_id IS NOT NULL)", name="user_by_kind"),
    )
    op.execute(
        "CREATE UNIQUE INDEX drive_locations_workspace_uniq ON drive_locations ((true)) "
        "WHERE kind = 'workspace'"
    )
    op.create_table(
        "drive_items",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("location_id", sa.Uuid(), sa.ForeignKey("drive_locations.id"), nullable=False),
        sa.Column("parent_id", sa.Uuid(), sa.ForeignKey("drive_items.id")),
        sa.Column("kind", sa.String(8), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("name_key", sa.Text(), nullable=False),
        sa.Column("name_sort", sa.LargeBinary(), nullable=False),
        sa.Column("current_version_id", sa.Uuid()),
        sa.Column("size_bytes", sa.BigInteger()),
        sa.Column("content_type", sa.Text()),
        sa.Column("content_modified_at", sa.DateTime(timezone=True)),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("updated_by", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("trashed_at", sa.DateTime(timezone=True)),
        sa.Column("trashed_by", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("trash_root_id", sa.Uuid(), sa.ForeignKey("drive_items.id")),
        sa.Column("trash_parent_id", sa.Uuid()),
        sa.Column("change_seq", sa.BigInteger(), nullable=False),
        sa.Column("client_op_id", sa.Uuid()),
        sa.CheckConstraint("kind IN ('folder', 'file')", name="kind_values"),
        sa.CheckConstraint(
            "(kind = 'file') = (current_version_id IS NOT NULL)", name="version_by_kind"
        ),
        sa.CheckConstraint("parent_id IS NOT NULL OR kind = 'folder'", name="root_is_folder"),
        sa.CheckConstraint("(trashed_at IS NULL) = (trash_root_id IS NULL)", name="trash_root"),
    )
    op.execute(
        "CREATE UNIQUE INDEX drive_items_name_uniq ON drive_items (parent_id, name_key) "
        "WHERE trashed_at IS NULL"
    )
    op.execute(
        "CREATE INDEX drive_items_children_idx ON drive_items "
        "(parent_id, kind DESC, name_sort, id) WHERE trashed_at IS NULL"
    )
    op.execute(
        "CREATE INDEX drive_items_trash_idx ON drive_items (location_id, trashed_at) "
        "WHERE trashed_at IS NOT NULL AND trash_root_id = id"
    )
    op.create_index("drive_items_change_idx", "drive_items", ["location_id", "change_seq"])
    op.create_index("drive_items_trash_root_idx", "drive_items", ["trash_root_id"])
    # Subtrees with the trash in them (moves, purges); drive_items_children_idx skips the trash.
    op.create_index("drive_items_parent_idx", "drive_items", ["parent_id"])
    op.execute(
        "CREATE UNIQUE INDEX drive_items_client_op_uniq ON drive_items (created_by, client_op_id) "
        "WHERE client_op_id IS NOT NULL"
    )
    # §12: file names, the tokenizer of messages and attachments' names.
    op.execute("CREATE INDEX drive_items_name_pgroonga_idx ON drive_items USING pgroonga (name)")
    op.create_foreign_key(
        "drive_locations_root_fk",
        "drive_locations",
        "drive_items",
        ["root_id"],
        ["id"],
        deferrable=True,
        initially="DEFERRED",
    )

    op.create_table(
        "drive_file_versions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "item_id",
            sa.Uuid(),
            sa.ForeignKey("drive_items.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column(
            "attachment_id",
            sa.Uuid(),
            sa.ForeignKey("attachments.id"),
            nullable=False,
            unique=True,
        ),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.LargeBinary()),
        sa.Column("content_modified_at", sa.DateTime(timezone=True)),
        sa.Column("uploaded_by", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("source", sa.String(16), nullable=False, server_default="upload"),
        sa.Column("processed_at", sa.DateTime(timezone=True)),
        sa.Column("process_next_at", sa.DateTime(timezone=True)),
        sa.Column("process_attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.UniqueConstraint("item_id", "number", name="drive_file_versions_item_number_key"),
    )
    op.execute(
        "CREATE INDEX drive_file_versions_unprocessed_idx ON drive_file_versions "
        "(process_next_at) WHERE processed_at IS NULL"
    )
    op.create_foreign_key(
        "drive_items_current_version_fk",
        "drive_items",
        "drive_file_versions",
        ["current_version_id"],
        ["id"],
        deferrable=True,
        initially="DEFERRED",
    )

    op.create_table(
        "drive_uploads",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("client_upload_id", sa.Uuid(), nullable=False),
        sa.Column(
            "location_id",
            sa.Uuid(),
            sa.ForeignKey("drive_locations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "parent_id",
            sa.Uuid(),
            sa.ForeignKey("drive_items.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("relative_dir", sa.Text()),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("target_item_id", sa.Uuid(), sa.ForeignKey("drive_items.id", ondelete="CASCADE")),
        sa.Column("on_conflict", sa.String(8), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("part_size", sa.Integer(), nullable=False),
        sa.Column("attachment_id", sa.Uuid(), nullable=False, unique=True),
        sa.Column("s3_upload_id", sa.Text(), nullable=False),
        sa.Column("content_modified_at", sa.DateTime(timezone=True)),
        sa.Column("status", sa.String(12), nullable=False, server_default="active"),
        sa.Column("item_id", sa.Uuid()),
        sa.Column("version_id", sa.Uuid()),
        sa.Column("error", sa.Text()),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint("user_id", "client_upload_id", name="drive_uploads_client_key"),
        sa.CheckConstraint(
            "status IN ('active', 'completing', 'completed', 'aborted', 'expired')",
            name="status_values",
        ),
        sa.CheckConstraint("on_conflict IN ('version', 'rename', 'fail')", name="conflict_values"),
    )
    op.execute(
        "CREATE INDEX drive_uploads_active_idx ON drive_uploads (expires_at) "
        "WHERE status IN ('active', 'completing')"
    )
    op.execute(
        "CREATE INDEX drive_uploads_location_idx ON drive_uploads (location_id) "
        "WHERE status IN ('active', 'completing')"
    )
    op.create_table(
        "drive_upload_parts",
        sa.Column(
            "upload_id",
            sa.Uuid(),
            sa.ForeignKey("drive_uploads.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("part_number", sa.Integer(), primary_key=True),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.LargeBinary(), nullable=False),
        sa.Column("etag", sa.Text(), nullable=False),
        sa.Column(
            "received_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )

    op.add_column(
        "attachments",
        sa.Column("drive_item_id", sa.Uuid(), sa.ForeignKey("drive_items.id", ondelete="SET NULL")),
    )
    op.execute(
        "CREATE INDEX attachments_drive_item_idx ON attachments (drive_item_id) "
        "WHERE drive_item_id IS NOT NULL"
    )

    # 研究室ドライブ and its root folder (the name of a root is never shown: the location's is).
    location_id, root_id = uuid7(), uuid7()
    op.execute(
        sa.text(
            "INSERT INTO drive_locations (id, kind, root_id) VALUES (:location, 'workspace', :root)"
        ).bindparams(location=location_id, root=root_id)
    )
    op.execute(
        sa.text(
            "INSERT INTO drive_items (id, location_id, parent_id, kind, name, name_key, name_sort, "
            "change_seq) VALUES (:root, :location, NULL, 'folder', '', '', '\\x'::bytea, "
            "nextval('drive_change_seq'))"
        ).bindparams(location=location_id, root=root_id)
    )


def downgrade() -> None:
    op.drop_index("attachments_drive_item_idx", table_name="attachments")
    op.drop_column("attachments", "drive_item_id")
    op.drop_table("drive_upload_parts")
    op.drop_table("drive_uploads")
    op.drop_constraint("drive_items_current_version_fk", "drive_items", type_="foreignkey")
    op.drop_table("drive_file_versions")
    op.drop_constraint("drive_locations_root_fk", "drive_locations", type_="foreignkey")
    op.drop_table("drive_items")
    op.drop_table("drive_locations")
    op.execute("DROP SEQUENCE drive_change_seq")
