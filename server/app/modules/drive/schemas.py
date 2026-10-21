"""The drive's API shapes (docs/DRIVE.md §5)."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, model_validator

from app.modules.attachments.schemas import AttachmentPreviewOut

LocationKind = Literal["workspace", "channel", "user"]
ConflictMode = Literal["version", "rename", "fail"]
MAX_BATCH = 500


class DriveLocationOut(BaseModel):
    id: UUID
    kind: LocationKind
    channel_id: UUID | None
    user_id: UUID | None
    root_id: UUID
    # 研究室ドライブ / マイドライブ / the channel's name. The clients may label the first two by
    # kind in their own language.
    name: str
    can_write: bool
    can_manage: bool
    # External links (phase D4): false until then.
    can_share: bool
    external_links: bool
    quota_bytes: int | None
    used_bytes: int
    item_count: int


class DriveLocationListOut(BaseModel):
    locations: list[DriveLocationOut]


class DriveLocationResolve(BaseModel):
    kind: Literal["channel", "me"]
    channel_id: UUID | None = None

    @model_validator(mode="after")
    def _channel(self) -> "DriveLocationResolve":
        if (self.kind == "channel") != (self.channel_id is not None):
            raise ValueError("channel_id goes with kind 'channel' only")
        return self


class DriveFileOut(BaseModel):
    """The current version's attachment (the shape of AttachmentOut's media fields): its
    thumbnail, poster and preview are served by /attachments/{attachment_id}/…"""

    attachment_id: UUID
    version_id: UUID
    width: int | None
    height: int | None
    has_thumbnail: bool
    has_poster: bool
    duration_ms: int | None
    preview: AttachmentPreviewOut | None


class DriveItemOut(BaseModel):
    id: UUID
    location_id: UUID
    parent_id: UUID | None
    kind: Literal["folder", "file"]
    name: str
    size_bytes: int | None
    content_type: str | None
    content_modified_at: datetime | None
    created_by: UUID | None
    created_at: datetime
    updated_by: UUID | None
    updated_at: datetime
    version_count: int
    file: DriveFileOut | None
    # Active external links I can see (phase D4): 0 until then.
    link_count: int
    # Set for an item in the trash (with the one who put it there).
    trashed_at: datetime | None = None
    trashed_by: UUID | None = None


class DriveCrumb(BaseModel):
    id: UUID
    name: str


class DriveItemDetailOut(BaseModel):
    item: DriveItemOut
    # From the location's root (named after the location) down to the item's parent.
    path: list[DriveCrumb]


class DriveChildrenOut(BaseModel):
    folder: DriveItemOut
    # From the root down to the folder itself.
    path: list[DriveCrumb]
    items: list[DriveItemOut]
    next_cursor: str | None


class DriveFolderCreate(BaseModel):
    parent_id: UUID
    name: str | None = Field(default=None, max_length=1000)
    # `a/b/c`: makes the missing folders on the way (mkdir -p) and answers the last one.
    path: str | None = Field(default=None, max_length=8000)
    client_op_id: UUID | None = None

    @model_validator(mode="after")
    def _one(self) -> "DriveFolderCreate":
        if (self.name is None) == (self.path is None):
            raise ValueError("give either name or path")
        return self


class DriveItemRename(BaseModel):
    name: str = Field(max_length=1000)


class DriveMoveIn(BaseModel):
    item_ids: list[UUID] = Field(min_length=1, max_length=MAX_BATCH)
    target_folder_id: UUID
    on_conflict: Literal["fail", "rename"] = "fail"


class DriveTrashIn(BaseModel):
    item_ids: list[UUID] = Field(min_length=1, max_length=MAX_BATCH)


class DriveItemResult(BaseModel):
    id: UUID
    ok: bool
    error: str | None = None


class DriveResultsOut(BaseModel):
    results: list[DriveItemResult]


class DriveRestoreIn(BaseModel):
    on_conflict: Literal["rename", "fail"] = "rename"


class DriveTrashEntryOut(BaseModel):
    """One group in a location's trash (what was put there together)."""

    item: DriveItemOut
    trashed_at: datetime
    trashed_by: UUID | None
    # The items in the group (the root included) and the bytes of their versions.
    item_count: int
    size_bytes: int


class DriveTrashOut(BaseModel):
    entries: list[DriveTrashEntryOut]
    next_cursor: str | None


class DriveUploadCreate(BaseModel):
    client_upload_id: UUID
    parent_id: UUID
    # A folder upload's directory below parent_id (`a/b`), made when the upload completes.
    relative_dir: str | None = Field(default=None, max_length=8000)
    name: str = Field(max_length=1000)
    size_bytes: int = Field(ge=0)
    # The browser's File.lastModified, for display only (never for ordering).
    content_modified_ms: int | None = None
    on_conflict: ConflictMode = "fail"
    # A new version of this file (its name and place stay the item's).
    target_item_id: UUID | None = None


class DriveUploadPatch(BaseModel):
    name: str | None = Field(default=None, max_length=1000)
    on_conflict: ConflictMode | None = None


class DriveUploadOut(BaseModel):
    id: UUID
    client_upload_id: UUID
    status: Literal["active", "completing", "completed", "aborted", "expired"]
    location_id: UUID
    parent_id: UUID
    relative_dir: str | None
    name: str
    on_conflict: ConflictMode
    target_item_id: UUID | None
    part_size: int
    parts_total: int
    received_parts: list[int]
    size_bytes: int
    expires_at: datetime
    created_at: datetime
    item_id: UUID | None
    version_id: UUID | None
    # The error code of the last completion that could not finish (the session stays active:
    # PATCH it and complete again).
    error: str | None


class DriveUploadListOut(BaseModel):
    uploads: list[DriveUploadOut]


class DriveUploadPartOut(BaseModel):
    part_number: int
    size_bytes: int


class DriveUploadCompleteOut(BaseModel):
    status: Literal["completed", "completing"]
    item: DriveItemOut | None = None
    version_id: UUID | None = None


class DriveTakeoverIn(BaseModel):
    target_folder_name: str | None = Field(default=None, max_length=255)


class DriveTakeoverOut(BaseModel):
    folder: DriveItemOut


# --- events (SYNC_PROTOCOL.md §18) -------------------------------------------------------------


class DriveChangedData(BaseModel):
    """Re-read these folders (and the trash) of the location; no names travel."""

    location_id: UUID
    folder_ids: list[UUID]
    seq: int


class DriveUploadUpdatedData(BaseModel):
    upload: DriveUploadOut
