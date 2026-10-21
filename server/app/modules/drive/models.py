"""The drive's tables (docs/DRIVE.md §4.2, DATA_MODEL.md "drive_*", migration 0118).

A file's bytes and their derived objects (thumbnail, poster, document preview) live in an
`attachments` row per version (attachments.drive_item_id): the preview loop, the GC and
`verify-attachments` work on them as on any other attachment (§4.1).
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow

LOCATION_KINDS = ("workspace", "channel", "user")
UPLOAD_STATUSES = ("active", "completing", "completed", "aborted", "expired")
CONFLICT_MODES = ("version", "rename", "fail")


class DriveLocation(Base):
    """研究室ドライブ (one), a channel's drive, or a person's My Drive (§3.1)."""

    __tablename__ = "drive_locations"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    kind: Mapped[str] = mapped_column(String(16))
    channel_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("channels.id"), unique=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), unique=True)
    # The root folder (drive_items); the foreign key is DEFERRABLE INITIALLY DEFERRED (the two
    # rows refer to each other and are inserted in one transaction).
    root_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey(
            "drive_items.id",
            use_alter=True,
            name="drive_locations_root_fk",
            deferrable=True,
            initially="DEFERRED",
        )
    )
    quota_bytes: Mapped[int | None] = mapped_column(BigInteger)
    # Current versions + older versions + the trash, changed in the transaction that adds or
    # removes a version (§11).
    used_bytes: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
    item_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    external_links: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    # M160: a My Drive whose owner was anonymised (§3.3): the housekeeping purges everything in it
    # (no trash) and then the row.
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("kind IN ('workspace', 'channel', 'user')", name="kind_values"),
        CheckConstraint("(kind = 'channel') = (channel_id IS NOT NULL)", name="channel_by_kind"),
        CheckConstraint("(kind = 'user') = (user_id IS NOT NULL)", name="user_by_kind"),
        Index(
            "drive_locations_workspace_uniq",
            text("(true)"),
            unique=True,
            postgresql_where=text("kind = 'workspace'"),
        ),
    )


class DriveItem(Base):
    """A folder or a file. Rows stay until purged (the trash is trashed_at)."""

    __tablename__ = "drive_items"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    location_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("drive_locations.id"))
    parent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("drive_items.id"))
    kind: Mapped[str] = mapped_column(String(8))
    name: Mapped[str] = mapped_column(Text)
    name_key: Mapped[str] = mapped_column(Text)
    name_sort: Mapped[bytes] = mapped_column(LargeBinary)
    current_version_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey(
            "drive_file_versions.id",
            use_alter=True,
            name="drive_items_current_version_fk",
            deferrable=True,
            initially="DEFERRED",
        )
    )
    size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    content_type: Mapped[str | None] = mapped_column(Text)
    content_modified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    trashed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    trashed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    trash_root_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("drive_items.id"))
    trash_parent_id: Mapped[uuid.UUID | None] = mapped_column()
    change_seq: Mapped[int] = mapped_column(BigInteger)
    # M160: POST /drive/folders {name, client_op_id} sent again answers the folder it made.
    client_op_id: Mapped[uuid.UUID | None] = mapped_column()

    __table_args__ = (
        CheckConstraint("kind IN ('folder', 'file')", name="kind_values"),
        CheckConstraint(
            "(kind = 'file') = (current_version_id IS NOT NULL)", name="version_by_kind"
        ),
        CheckConstraint("parent_id IS NOT NULL OR kind = 'folder'", name="root_is_folder"),
        CheckConstraint("(trashed_at IS NULL) = (trash_root_id IS NULL)", name="trash_root"),
        Index(
            "drive_items_name_uniq",
            "parent_id",
            "name_key",
            unique=True,
            postgresql_where=text("trashed_at IS NULL"),
        ),
        Index(
            "drive_items_children_idx",
            "parent_id",
            text("kind DESC"),
            "name_sort",
            "id",
            postgresql_where=text("trashed_at IS NULL"),
        ),
        Index(
            "drive_items_trash_idx",
            "location_id",
            "trashed_at",
            postgresql_where=text("trashed_at IS NOT NULL AND trash_root_id = id"),
        ),
        Index("drive_items_change_idx", "location_id", "change_seq"),
        Index("drive_items_trash_root_idx", "trash_root_id"),
        Index("drive_items_parent_idx", "parent_id"),
        Index(
            "drive_items_client_op_uniq",
            "created_by",
            "client_op_id",
            unique=True,
            postgresql_where=text("client_op_id IS NOT NULL"),
        ),
    )


class DriveFileVersion(Base):
    __tablename__ = "drive_file_versions"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    item_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("drive_items.id", ondelete="CASCADE"))
    number: Mapped[int] = mapped_column(Integer)
    attachment_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("attachments.id"), unique=True)
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[bytes | None] = mapped_column(LargeBinary)
    content_modified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    source: Mapped[str] = mapped_column(String(16), default="upload", server_default="upload")
    # §6.4: when the media loop finished (SHA-256, thumbnail, poster). Its lease and tries:
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    process_next_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    process_attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    __table_args__ = (
        UniqueConstraint("item_id", "number", name="drive_file_versions_item_number_key"),
        Index(
            "drive_file_versions_unprocessed_idx",
            "process_next_at",
            postgresql_where=text("processed_at IS NULL"),
        ),
    )


class DriveUpload(Base):
    """An upload session (§6): its parts go to an S3 multipart upload of attachments/{id}."""

    __tablename__ = "drive_uploads"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    client_upload_id: Mapped[uuid.UUID] = mapped_column()
    location_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("drive_locations.id", ondelete="CASCADE")
    )
    parent_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("drive_items.id", ondelete="CASCADE"))
    relative_dir: Mapped[str | None] = mapped_column(Text)
    name: Mapped[str] = mapped_column(Text)
    target_item_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("drive_items.id", ondelete="CASCADE")
    )
    on_conflict: Mapped[str] = mapped_column(String(8))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    part_size: Mapped[int] = mapped_column(Integer)
    attachment_id: Mapped[uuid.UUID] = mapped_column(unique=True)
    # Empty for an empty file (no multipart upload: the object is an empty put).
    s3_upload_id: Mapped[str] = mapped_column(Text)
    content_modified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(12), default="active", server_default="active")
    item_id: Mapped[uuid.UUID | None] = mapped_column()
    version_id: Mapped[uuid.UUID | None] = mapped_column()
    # The error code of the last completion that could not finish (the session stays active).
    error: Mapped[str | None] = mapped_column(Text)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (
        UniqueConstraint("user_id", "client_upload_id", name="drive_uploads_client_key"),
        CheckConstraint(
            "status IN ('active', 'completing', 'completed', 'aborted', 'expired')",
            name="status_values",
        ),
        CheckConstraint("on_conflict IN ('version', 'rename', 'fail')", name="conflict_values"),
        Index(
            "drive_uploads_active_idx",
            "expires_at",
            postgresql_where=text("status IN ('active', 'completing')"),
        ),
        Index(
            "drive_uploads_location_idx",
            "location_id",
            postgresql_where=text("status IN ('active', 'completing')"),
        ),
    )


class DriveUploadPart(Base):
    __tablename__ = "drive_upload_parts"

    upload_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("drive_uploads.id", ondelete="CASCADE"), primary_key=True
    )
    part_number: Mapped[int] = mapped_column(Integer, primary_key=True)
    size_bytes: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[bytes] = mapped_column(LargeBinary)
    etag: Mapped[str] = mapped_column(Text)
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
