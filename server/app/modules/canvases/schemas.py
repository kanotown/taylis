from datetime import datetime
from typing import Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.modules.canvases.models import Canvas, CanvasRevision, CanvasTemplate

EditPolicy = Literal["members", "owners"]
OnConflict = Literal["fail", "ours", "theirs", "both"]
RevisionKind = Literal["create", "save", "merge", "side", "restore", "erased"]
CanvasChange = Literal["content", "title", "settings", "restore"]

# CANVAS.md §4.3. The body limit is checked by the service (422 canvas_too_large); a request
# body of this many Japanese characters stays under the proxy's 1 MB.
MAX_BODY_LENGTH = 100_000
MAX_TITLE_LENGTH = 200
MAX_CANVASES_PER_CONVERSATION = 200
TEMPLATE_KEY_PATTERN = r"^[a-z0-9_]{1,40}$"


def _clean_title(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = " ".join(value.split())
    if not cleaned:
        raise ValueError("A title cannot be blank")
    return cleaned


def _valid_zone(value: str | None) -> str | None:
    if value is None:
        return None
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError("Unknown time zone") from exc
    return value


class CanvasMeta(BaseModel):
    """A canvas without its body: lists and the canvas.* events (CANVAS.md §4.6)."""

    id: UUID
    channel_id: UUID
    title: str
    # +1 on every change; a client keeps the one with the larger version.
    version: int
    # The version of the body now: the `base_rev_id` of the next save.
    head_rev_id: UUID
    # The conversation's canvas tab (at most one per conversation).
    is_channel_tab: bool
    # "owners": only the creator, the channel's owners and administrators change the body (tasks
    # can still be ticked by every member but guests). Ignored in DMs.
    edit_policy: EditPolicy
    template_key: str | None
    # The message that shared it to the conversation, whose thread holds the comments.
    share_message_id: UUID | None
    task_total: int
    task_done: int
    created_by: UUID
    updated_by: UUID
    created_at: datetime
    updated_at: datetime
    # Set only in the trash listing (GET /channels/{id}/canvases?trashed=true).
    deleted_at: datetime | None = None


class CanvasOut(CanvasMeta):
    body: str


class CanvasPage(BaseModel):
    items: list[CanvasMeta]
    # Pass as `cursor` for the next page; null at the end.
    next_cursor: str | None


class CanvasCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Left out: the template's title (placeholders put in), else 「無題のキャンバス」.
    title: str | None = Field(default=None, max_length=MAX_TITLE_LENGTH)
    template_key: str | None = Field(default=None, max_length=40)
    # Left out: the template's body (placeholders put in), else empty. Up to 100,000 characters.
    body: str | None = None
    # The client's IANA zone, for the template's {{date}} / {{week}}; UTC when left out.
    tz: str | None = Field(default=None, max_length=64)
    as_tab: bool = False
    # Post the permalink to the conversation as an ordinary message (its thread holds the
    # comments; share_message_id), in the same transaction.
    share_to_channel: bool = False
    # Idempotency key: a retry returns the canvas made by the first request (200).
    client_save_id: UUID

    _title = field_validator("title")(_clean_title)
    _tz = field_validator("tz")(_valid_zone)


class CanvasUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, max_length=MAX_TITLE_LENGTH)
    edit_policy: EditPolicy | None = None
    is_channel_tab: bool | None = None

    _title = field_validator("title")(_clean_title)


class ContentSave(BaseModel):
    """PUT /canvases/{id}/content (CANVAS.md §4.4)."""

    model_config = ConfigDict(extra="forbid")

    # The version the body was written on: the head_rev_id last received, or the previous
    # save's submitted_rev_id.
    base_rev_id: UUID
    body: str
    # Idempotency key (a new UUIDv4 per save; the same one on a retry).
    client_save_id: UUID
    # When the same words were changed on both sides: fail (409 canvas_conflict), ours, theirs,
    # or both (theirs, then ours quoted with "> ").
    on_conflict: OnConflict = "fail"


class SaveOut(BaseModel):
    canvas: CanvasOut
    # The version holding exactly the submitted body: the next save's base_rev_id while the
    # editor still differs from canvas.body.
    submitted_rev_id: UUID
    # The save was merged with someone else's (canvas.body may differ from what was sent).
    merged: bool


class ConflictOut(BaseModel):
    """A region both sides changed differently. `ours_line` / `theirs_line`: its first line
    (0-based) in the submitted body and in the head."""

    base: str
    ours: str
    theirs: str
    ours_line: int
    theirs_line: int


class CanvasConflictDetails(BaseModel):
    head: CanvasOut
    # Empty for canvas_base_expired.
    conflicts: list[ConflictOut] = Field(default_factory=list)
    # The merge ran past its time budget: the whole document is one conflict.
    timed_out: bool = False


class CanvasConflictError(BaseModel):
    code: Literal["canvas_conflict", "canvas_base_expired"]
    message: str
    details: CanvasConflictDetails


class CanvasConflictResponse(BaseModel):
    """409 from PUT /canvases/{id}/content."""

    error: CanvasConflictError


class RevisionMeta(BaseModel):
    id: UUID
    canvas_id: UUID
    # The canvas's version this made; null for a side version.
    version: int | None
    kind: RevisionKind
    parent_rev_id: UUID | None
    author_id: UUID
    title: str
    label: str | None
    lines_added: int
    lines_removed: int
    created_at: datetime


class RevisionOut(RevisionMeta):
    body: str


class RevisionPage(BaseModel):
    items: list[RevisionMeta]
    next_cursor: str | None


class RevisionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # A name such as 「提出版」; null or blank removes it.
    label: str | None = Field(default=None, max_length=80)


class RevisionRestore(BaseModel):
    model_config = ConfigDict(extra="forbid")

    client_save_id: UUID


class CanvasTemplateOut(BaseModel):
    id: UUID
    key: str
    name: str
    description: str | None
    title: str
    body: str
    position: int
    builtin: bool
    hidden: bool
    updated_at: datetime


class CanvasTemplateCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Left out: one is made up (custom_…).
    key: str | None = Field(default=None, pattern=TEMPLATE_KEY_PATTERN)
    name: str = Field(min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=200)
    title: str = Field(min_length=1, max_length=MAX_TITLE_LENGTH)
    body: str = Field(max_length=MAX_BODY_LENGTH)
    position: int | None = Field(default=None, ge=0, le=10_000)


class CanvasTemplateUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=200)
    title: str | None = Field(default=None, min_length=1, max_length=MAX_TITLE_LENGTH)
    body: str | None = Field(default=None, max_length=MAX_BODY_LENGTH)
    position: int | None = Field(default=None, ge=0, le=10_000)
    hidden: bool | None = None


class CanvasCreatedData(BaseModel):
    """canvas.created: a new canvas, or one back from the trash."""

    canvas: CanvasMeta


class CanvasUpdatedData(BaseModel):
    """canvas.updated: re-read the canvas (GET /canvases/{id}) if it is open and not being
    edited; the body is not in the event."""

    canvas: CanvasMeta
    change: CanvasChange


class CanvasDeletedData(BaseModel):
    """canvas.deleted: moved to the trash; drop it."""

    canvas_id: UUID
    channel_id: UUID


def to_meta(row: Canvas, *, trashed: bool = False) -> CanvasMeta:
    return CanvasMeta(
        id=row.id,
        channel_id=row.channel_id,
        title=row.title,
        version=row.version,
        head_rev_id=row.head_rev_id,
        is_channel_tab=row.is_channel_tab,
        edit_policy=row.edit_policy,  # type: ignore[arg-type]
        template_key=row.template_key,
        share_message_id=row.share_message_id,
        task_total=row.task_total,
        task_done=row.task_done,
        created_by=row.created_by,
        updated_by=row.updated_by,
        created_at=row.created_at,
        updated_at=row.updated_at,
        deleted_at=row.deleted_at if trashed else None,
    )


def to_out(row: Canvas) -> CanvasOut:
    return CanvasOut(**to_meta(row).model_dump(), body=row.body)


def to_revision_meta(row: CanvasRevision) -> RevisionMeta:
    return RevisionMeta(
        id=row.id,
        canvas_id=row.canvas_id,
        version=row.version,
        kind=row.kind,  # type: ignore[arg-type]
        parent_rev_id=row.parent_rev_id,
        author_id=row.author_id,
        title=row.title,
        label=row.label,
        lines_added=row.lines_added,
        lines_removed=row.lines_removed,
        created_at=row.created_at,
    )


def to_revision_out(row: CanvasRevision) -> RevisionOut:
    return RevisionOut(**to_revision_meta(row).model_dump(), body=row.body)


def to_template_out(row: CanvasTemplate) -> CanvasTemplateOut:
    return CanvasTemplateOut(
        id=row.id,
        key=row.key,
        name=row.name,
        description=row.description,
        title=row.title,
        body=row.body,
        position=row.position,
        builtin=row.builtin,
        hidden=row.hidden,
        updated_at=row.updated_at,
    )
