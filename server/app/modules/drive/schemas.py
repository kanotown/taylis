"""The drive's API shapes (docs/DRIVE.md §5)."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

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
    # Phase D4: whether I may make external links here (a person who can write, not a guest; the
    # location's and the workspace's switches on).
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


class DrivePostOut(BaseModel):
    """CF1 (docs/CHANNEL_FILES.md §11.1): a message that has a version of this file as its
    attachment (「投稿」 in the details: who posted it where; 「メッセージを表示」)."""

    message_id: UUID
    channel_id: UUID
    # The thread's parent when the message is a reply.
    parent_id: UUID | None
    sender_id: UUID
    version_number: int
    posted_at: datetime


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
    # Phase D4: the item's links that have not been revoked, expired or used up (shown to everyone
    # who can read the item: what is shared outside should be known to those who put files here).
    link_count: int
    # Set for an item in the trash (with the one who put it there).
    trashed_at: datetime | None = None
    trashed_by: UUID | None = None
    # CF1 (docs/CHANNEL_FILES.md §3.3): 'channel_posts' for 「投稿のファイル」 (clients name it in
    # their language and offer no rename, move or trash: 409 drive_folder_system), else null.
    system_role: Literal["channel_posts"] | None = None
    # CF1: a version of this file is attached to a message that is not deleted (the list's small
    # speech-bubble mark).
    posted: bool = False
    # CF1: those messages that the caller can read, newest first, at most 5. Only in
    # GET /drive/items/{id} (null in lists, search hits and other answers).
    posts: list[DrivePostOut] | None = None


class DriveCrumb(BaseModel):
    id: UUID
    name: str


class DriveItemDetailOut(BaseModel):
    item: DriveItemOut
    # From the location's root (named after the location) down to the item's parent.
    path: list[DriveCrumb]
    # Phase D6: the location's kind, so a client names the root in its own language (the card
    # of a `/d/<id>` link in a message).
    location_kind: LocationKind | None = None


class DriveChildrenOut(BaseModel):
    folder: DriveItemOut
    # From the root down to the folder itself.
    path: list[DriveCrumb]
    items: list[DriveItemOut]
    next_cursor: str | None
    # Phase D4: working external links on this folder or a folder above it (what is put here is
    # shared outside; the listing says so).
    shared_above: int = 0


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


class DriveImpactIn(BaseModel):
    """CF1 (docs/CHANNEL_FILES.md §6.4, §11.1): what moving these items into `target_folder_id`
    (or, without one, putting them in the trash) would do to the messages their posted files are
    attached to."""

    item_ids: list[UUID] = Field(min_length=1, max_length=MAX_BATCH)
    target_folder_id: UUID | None = None


class DriveImpactChannelOut(BaseModel):
    channel_id: UUID
    # Messages of this channel whose attached file would change (be moved out of the channel's
    # drive, come back to it, or go to the trash).
    messages: int
    # Members of the channel (who can sign in; bots aside) who see at least one of those files in
    # its message now and would not afterwards, and how many of them are guests.
    unreadable_after: int
    unreadable_guests: int


class DriveImpactOut(BaseModel):
    # Every message concerned (also in channels the caller cannot read, which are not listed).
    posted_messages: int
    channels: list[DriveImpactChannelOut]


class DriveMessageFileOut(BaseModel):
    """CF1 (docs/CHANNEL_FILES.md §7.3): what deleting the message would do to one of its posted
    files. `trash`: drive_files=auto (and trash) puts it in the drive's trash (30 days); else it
    stays in the drive, because it is in the trash already or in another location (`in_trash`,
    `moved`), the caller did not post it and is no moderator (`not_permitted`), or it changed
    since it was posted (`changed`: a newer version, or another message shows it)."""

    attachment_id: UUID
    item_id: UUID
    state: Literal["available", "moved", "trashed"]
    trash: bool
    reason: Literal["in_trash", "moved", "not_permitted", "changed"] | None


class DriveMessageFilesOut(BaseModel):
    files: list[DriveMessageFileOut]


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
    # The file's own modification time as sent (display only); the clients match a file picked again
    # to its session by name, size and this (phase D2).
    content_modified_at: datetime | None = None
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


class DrivePreviewOut(BaseModel):
    """2026-10-22 (§27): the preview of a file's current version after POST
    /drive/items/{id}/preview. 'pending' while the server makes it (drive.changed follows when
    it is ready or failed), 'ready', 'failed'; null when this file gets no preview (not a PDF or
    an Office file, too large, previews off, or no converter for an Office file)."""

    preview: AttachmentPreviewOut | None


class DriveDownloadTicketOut(BaseModel):
    """A URL the browser's own download (or a video's source) can follow without the bearer
    token (§7.3): relative to the server, valid `expires_in` seconds after its last use."""

    url: str
    expires_in: int


class DriveSnippetPart(BaseModel):
    """A piece of a snippet: `hit` pieces are the searched words as found (to be marked)."""

    text: str
    hit: bool = False


DriveMatch = Literal["name", "content", "both"]
DrivePageKind = Literal["page", "slide", "sheet"]


class DriveSearchHitOut(BaseModel):
    item: DriveItemOut
    # The location's name, then the folders down to the item's parent.
    path: list[DriveCrumb]
    location_kind: LocationKind
    # §29 (`content=true`): what matched, the name, the text inside the file or both. Always
    # "name" without `content`.
    match: DriveMatch = "name"
    # §29: the text around the first word found inside the file (about 30 characters before it
    # and 90 after, spaces folded, "…" where cut), in pieces; null when only the name matched.
    snippet: list[DriveSnippetPart] | None = None
    # §29: the page of the PDF (a legacy Office file: of its PDF preview) the snippet is on,
    # from 1; null for a plain text file, a Word file read from its package (§29.6) or a name
    # match. §29.6: for a presentation or a spreadsheet read from its package, the slide or the
    # sheet (page_kind says which).
    page: int | None = None
    # §29.6 (2026-10-25): what `page` counts: "page" (a PDF page: the document viewer opens
    # there), "slide" (「12 枚目」) or "sheet"; null when `page` is. Older clients read every
    # `page` as a PDF page.
    page_kind: DrivePageKind | None = None


class DriveSearchOut(BaseModel):
    items: list[DriveSearchHitOut]
    next_cursor: str | None
    # §29 (`content=true`): the words looked for, as PGroonga split them.
    keywords: list[str] = Field(default_factory=list)


# --- versions, copies, ZIPs (phase D3) ---------------------------------------------------------


class DriveVersionOut(BaseModel):
    id: UUID
    number: int
    size_bytes: int
    # What made it: upload, copy, restore (an older version brought back), attachment, import.
    source: str
    uploaded_by: UUID | None
    created_at: datetime
    content_modified_at: datetime | None
    current: bool
    # Hex, once the media loop has read the bytes (§6.4).
    sha256: str | None = None


class DriveVersionListOut(BaseModel):
    """Newest first. Older versions are kept DRIVE_VERSIONS_MAX at most, each at most
    DRIVE_VERSIONS_DAYS after it was replaced (`keep_versions`, `keep_days`)."""

    versions: list[DriveVersionOut]
    keep_versions: int
    keep_days: int


class DriveCopyIn(BaseModel):
    item_ids: list[UUID] = Field(min_length=1, max_length=MAX_BATCH)
    target_folder_id: UUID
    on_conflict: Literal["fail", "rename"] = "rename"
    # The same request sent again answers the copies it made (per item).
    client_op_id: UUID | None = None


class DriveCopyResult(DriveItemResult):
    # The new item made from `id`.
    new_id: UUID | None = None


class DriveCopyResultsOut(BaseModel):
    results: list[DriveCopyResult]


class DriveZipIn(BaseModel):
    item_ids: list[UUID] = Field(min_length=1, max_length=MAX_BATCH)


class DriveZipOut(BaseModel):
    """`url` (relative to the server) streams the ZIP once, within `expires_in` seconds, without
    the bearer token: an uncompressed ZIP (ZIP64 when needed) of `entries` entries, exactly
    `zip_bytes` long (its Content-Length), holding `size_bytes` of files."""

    url: str
    expires_in: int
    entries: int
    size_bytes: int
    zip_bytes: int
    filename: str


# --- administrators: usage and quotas (§11) -----------------------------------------------------


class DriveUsageParts(BaseModel):
    """Bytes of the current versions (outside the trash), of older versions, and of the trash."""

    current_bytes: int
    old_versions_bytes: int
    trash_bytes: int


class DriveLocationUsageOut(DriveUsageParts):
    id: UUID
    kind: LocationKind
    channel_id: UUID | None
    user_id: UUID | None
    # The channel's name or the person's display name (never anything inside).
    name: str
    archived: bool
    used_bytes: int
    item_count: int
    quota_bytes: int | None
    # The quota that applies: its own, else DRIVE_USER_DEFAULT_QUOTA_BYTES for a My Drive.
    effective_quota_bytes: int | None
    updated_at: datetime
    # CF1 (docs/CHANNEL_FILES.md §8): of used_bytes, the files posted in the channel (version 1
    # of an item filed from a message, posted_bytes ≤ used_bytes). Posting is never refused for
    # the quota, so used_bytes may pass quota_bytes.
    posted_bytes: int = 0


class DrivePersonUsageOut(BaseModel):
    user_id: UUID
    # The versions this person put in any drive (uploads, copies, restores).
    bytes: int
    versions: int


class DriveUsageTotalOut(DriveUsageParts):
    used_bytes: int
    item_count: int
    location_count: int
    # DRIVE_TOTAL_QUOTA_BYTES / DRIVE_USER_DEFAULT_QUOTA_BYTES (null: none).
    total_quota_bytes: int | None
    user_default_quota_bytes: int | None
    # The chat's attachments (messages, canvases, pages), not counted by any quota.
    chat_attachments_bytes: int
    chat_attachment_count: int


class DriveUsageOut(BaseModel):
    total: DriveUsageTotalOut
    locations: list[DriveLocationUsageOut]
    people: list[DrivePersonUsageOut]


class DriveQuotaIn(BaseModel):
    # Bytes; null removes the location's own quota.
    quota_bytes: int | None = Field(ge=0)


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


class DriveLocationUpdatedData(BaseModel):
    """The location's settings changed (its quota): read the locations again. Only the id travels
    (what a location shows depends on who reads it)."""

    location_id: UUID


# --- external share links (phase D4, §5.4, §9) --------------------------------------------------

ShareLinkState = Literal["active", "expired", "exhausted", "revoked", "paused"]


class DriveShareLinkOut(BaseModel):
    """A link as its creator, the location's managers and the administrators see it. `state`:
    active; expired; exhausted (its download limit is used up); revoked; paused (works again by
    itself: its creator cannot read the item now or is no longer a person who may share, the
    item is in the trash or moved to another location, the channel is archived, or the location
    or the workspace turned external links off)."""

    id: UUID
    item_id: UUID
    item_name: str
    item_kind: Literal["folder", "file"]
    location_id: UUID
    location_kind: LocationKind
    location_name: str
    created_by: UUID
    created_by_name: str
    created_at: datetime
    expires_at: datetime | None
    has_password: bool
    max_downloads: int | None
    download_count: int
    note: str | None
    last_used_at: datetime | None
    state: ShareLinkState
    # Whether the reader may change it (its creator) and revoke it (its creator, the location's
    # managers, the administrators).
    can_edit: bool = False
    can_revoke: bool = False


class DriveShareLinkCreate(BaseModel):
    """POST /drive/items/{id}/links. `expires_at` left out: DRIVE_SHARE_DEFAULT_DAYS (7) from now;
    null: no expiry (only when the workspace allows it, drive_link_max_days null)."""

    model_config = ConfigDict(extra="forbid")

    expires_at: datetime | None = None
    password: str | None = Field(default=None, min_length=4, max_length=128)
    max_downloads: int | None = Field(default=None, ge=1, le=100_000)
    note: str | None = Field(default=None, max_length=80)


class DriveShareLinkPatch(BaseModel):
    """PATCH /drive/links/{id}: only the fields sent change. `password: null` removes the
    password; any change of the password ends the unlocked browsers' cookies."""

    model_config = ConfigDict(extra="forbid")

    expires_at: datetime | None = None
    password: str | None = Field(default=None, min_length=4, max_length=128)
    max_downloads: int | None = Field(default=None, ge=1, le=100_000)
    note: str | None = Field(default=None, max_length=80)


class DriveShareLinkCreatedOut(BaseModel):
    """The only time the link's address is shown (only its SHA-256 is kept, §19 Q4). `url` is
    absolute when the server knows its address (PUBLIC_BASE_URL), else the same as `path`
    (the client puts its server's origin in front)."""

    link: DriveShareLinkOut
    url: str
    path: str


class DriveLinkPolicyOut(BaseModel):
    """What the share dialog may offer for an item: the workspace's switch and the location's,
    whether the reader may make a link here (a person who can write, not a guest), the longest
    expiry in days (null: links without an expiry are allowed), the default, and whether a
    password is required."""

    enabled: bool
    location_enabled: bool
    can_share: bool
    max_days: int | None
    default_days: int
    password_required: bool


class DriveItemLinksOut(BaseModel):
    links: list[DriveShareLinkOut]
    policy: DriveLinkPolicyOut


class DriveShareLinkListOut(BaseModel):
    links: list[DriveShareLinkOut]
    next_cursor: str | None = None


class DriveShareEventOut(BaseModel):
    id: int
    kind: Literal["open", "download", "zip", "password_failed", "refused"]
    item_id: UUID | None
    item_name: str | None
    bytes: int | None
    # The creator sees the first two parts only (203.0.x.x); administrators the whole address.
    ip: str | None
    user_agent: str | None
    created_at: datetime


class DriveShareEventListOut(BaseModel):
    events: list[DriveShareEventOut]
    next_cursor: str | None = None


class DriveLocationPatch(BaseModel):
    """PATCH /drive/locations/{id}: who manages the location (§3.2)."""

    model_config = ConfigDict(extra="forbid")

    external_links: bool


class DriveShareSettingsOut(BaseModel):
    """The workspace's switches for external links (workspace_settings, §4.2)."""

    external_links_enabled: bool
    link_max_days: int | None
    link_password_required: bool
    default_days: int


class DriveShareSettingsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    external_links_enabled: bool | None = None
    # null: links without an expiry are allowed.
    link_max_days: int | None = Field(default=None, ge=1, le=3650)
    link_password_required: bool | None = None


# --- the public side (/shares/{token}, no sign-in) ---------------------------------------------


class SharedItemOut(BaseModel):
    """An item as the public side shows it: never who made or changed it, nor its location."""

    id: UUID
    kind: Literal["folder", "file"]
    name: str
    size_bytes: int | None
    content_type: str | None
    modified_at: datetime
    has_thumbnail: bool = False
    width: int | None = None
    height: int | None = None
    preview: AttachmentPreviewOut | None = None


class ShareInfoOut(BaseModel):
    """GET /shares/{token}. Before a password link is unlocked only `password_required` (and the
    workspace's name) is told: `kind`, `item` and `root_id` are null."""

    state: Literal["active"] = "active"
    kind: Literal["folder", "file"] | None
    password_required: bool
    unlocked: bool
    expires_at: datetime | None
    # null: no download limit.
    downloads_left: int | None
    root_id: UUID | None
    item: SharedItemOut | None
    workspace_name: str


class SharedChildrenOut(BaseModel):
    folder: SharedItemOut
    # From the shared folder (never above it) down to this folder.
    path: list[DriveCrumb]
    items: list[SharedItemOut]
    next_cursor: str | None


class ShareUnlockIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    password: str = Field(min_length=1, max_length=128)


# --- conversations (phase D6, §13) -------------------------------------------------------------


class DriveSaveAttachmentIn(BaseModel):
    """A conversation's attachment copied into a drive folder (§13.2)."""

    attachment_id: UUID
    folder_id: UUID
    # The new file's name; the attachment's file name when left out.
    name: str | None = Field(default=None, max_length=1000)
    on_conflict: Literal["fail", "rename"] = "rename"
    # The same request sent again answers the file it made.
    client_op_id: UUID | None = None


class DriveReachOut(BaseModel):
    """Of a conversation's members (people and guests who can sign in, not bots), how many can
    read a drive item and how many cannot (§13.1: the composer's warning before a link is
    sent)."""

    readable: int
    unreadable: int
