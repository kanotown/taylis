"""API shapes of the wiki (docs/WIKI.md §11.2, SYNC_PROTOCOL.md §17, M120)."""

from datetime import datetime
from typing import Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.modules.canvases.schemas import CanvasTemplateOut
from app.modules.wiki.models import WikiPage, WikiPageRevision

Level = Literal["view", "edit", "full"]
PrincipalType = Literal["workspace", "group", "user"]
PageKind = Literal["page", "database", "row"]
# content: the body (saved or merged); meta: title / icon; restore: a version or the trash;
# props: a database row's values (M123).
PageChange = Literal["content", "meta", "restore", "props"]
OnConflict = Literal["fail", "ours", "theirs", "both"]
RevisionKind = Literal["create", "save", "merge", "side", "restore", "erased", "props", "import"]

MAX_TITLE_LENGTH = 200
MAX_ICON_LENGTH = 64
MAX_GRANTS = 200
MAX_RESOLVE = 200
# WIKI.md §3.2: the tree is at most this deep (a top-level page is depth 1).
MAX_DEPTH = 20


def _clean_title(value: str | None) -> str | None:
    if value is None:
        return None
    return " ".join(value.split())


def _valid_zone(value: str | None) -> str | None:
    if value is None:
        return None
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError("Unknown time zone") from exc
    return value


class PageMeta(BaseModel):
    """A page without its body, the same for everyone (the wiki.page.updated event)."""

    id: UUID
    # null: a top-level page, or (for me) a page whose parent I cannot read: it shows at the top
    # level (WIKI.md §4.6). Always null in wiki.page.updated (the place comes from the feed).
    parent_id: UUID | None
    # The order among siblings (compare as plain strings, byte by byte; ties by id).
    position: str
    kind: PageKind
    title: str
    # One emoji or a :custom: emoji name; null for none.
    icon: str | None
    # +1 on every change of body, title, icon, place, trash or access (the larger wins).
    version: int
    # The version of the body now: the `base_rev_id` of the next save.
    head_rev_id: UUID
    # The tree's change feed position of this page's last change (GET /wiki/changes).
    meta_seq: int
    # false: the page does not take its parent's access (「親から受け継いでいません」).
    inherit_access: bool
    task_total: int
    task_done: int
    created_by: UUID
    updated_by: UUID
    created_at: datetime
    updated_at: datetime
    # Set only in the trash listing (GET /wiki/trash).
    deleted_at: datetime | None = None
    # M145 (WIKI.md §22.3): a page template (top level, never in the tree: GET /wiki/templates)
    # or a database's row template (never in its query: GET /wiki/databases/{id} `templates`).
    is_template: bool = False


class PageItem(PageMeta):
    """A page as one person sees it: the tree, the change feed, search."""

    # What I may do: view (read), edit (body, title, child pages), full (also sharing, moving,
    # the trash).
    my_level: Level
    # Only I can see it (its effective access is me alone): the sidebar's 「プライベート」 when
    # it is top-level for me.
    private: bool


class PageContent(PageItem):
    body: str


class Crumb(BaseModel):
    """An ancestor in the breadcrumbs. One I cannot read has no id, title or icon (「…」)."""

    id: UUID | None
    title: str | None
    icon: str | None
    readable: bool


class PageOut(PageContent):
    """GET /wiki/pages/{id}: the page, its breadcrumbs (root first) and its child pages I can
    read, in order."""

    breadcrumbs: list[Crumb]
    children: list[PageItem]


class TreeOut(BaseModel):
    """Every page I can read (not database rows), and the change feed's position to continue
    from with GET /wiki/changes."""

    pages: list[PageItem]
    cursor: int


class ChangesOut(BaseModel):
    """GET /wiki/changes?since=: what changed in the tree after `since`."""

    # Pages I can read that changed (new, renamed, moved, reordered, restored, shared with me).
    pages: list[PageItem]
    # Pages to drop: in the trash, purged, or no longer readable for me (ids only).
    removed: list[UUID]
    # Pass as `since` next time.
    cursor: int
    # true: `since` is too old (or from another database): read GET /wiki/tree again.
    reset: bool


class PageCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # null: a top-level page (not for guests).
    parent_id: UUID | None = None
    # Place it just before / after this sibling; neither: at the end.
    before_id: UUID | None = None
    after_id: UUID | None = None
    # database (M123): a database page with the title property and one table view (its rows:
    # POST /wiki/databases/{id}/rows).
    kind: Literal["page", "database"] = "page"
    # Left out: the template's title, else 「無題」.
    title: str | None = Field(default=None, max_length=MAX_TITLE_LENGTH)
    # Left out: the page template's icon, else none.
    icon: str | None = Field(default=None, max_length=MAX_ICON_LENGTH)
    # A built-in template (GET /wiki/templates `builtins`, the canvases' templates).
    template_key: str | None = Field(default=None, max_length=40)
    # M145: start from a page template I can read (GET /wiki/templates `pages`): its title, icon
    # and body with the placeholders put in, its images and files copied. Not with template_key.
    template_page_id: UUID | None = None
    # M145: make a page template (a top-level page; not guests). The placeholders of a template
    # it starts from stay as they are.
    is_template: bool = False
    # Left out: the template's body, else empty. Up to 100,000 characters.
    body: str | None = None
    # A top-level page only: workspace (everyone can edit, I have full access; the default) or
    # private (me only). A child page takes its parent's access. A page template: workspace →
    # everyone can read it and I have full access; private → me only.
    access: Literal["workspace", "private"] = "workspace"
    # The client's IANA zone, for a template's {{date}} / {{week}} / {{time}}; UTC when left out.
    tz: str | None = Field(default=None, max_length=64)
    # Idempotency key: a retry returns the page made by the first request (200).
    client_save_id: UUID

    _title = field_validator("title")(_clean_title)
    _tz = field_validator("tz")(_valid_zone)

    @model_validator(mode="after")
    def _one_neighbour(self) -> "PageCreate":
        if self.before_id is not None and self.after_id is not None:
            raise ValueError("Give before_id or after_id, not both")
        if self.template_key is not None and self.template_page_id is not None:
            raise ValueError("Give template_key or template_page_id, not both")
        if self.is_template and (self.parent_id is not None or self.kind != "page"):
            raise ValueError("A page template is a top-level page (no parent_id)")
        if self.template_page_id is not None and self.kind != "page":
            raise ValueError("A page template makes a page")
        return self


class PageDuplicate(BaseModel):
    """POST /wiki/pages/{id}/duplicate (M145, WIKI.md §22.3): 「複製」 and 「テンプレートとして
    保存」. The title, icon and body (placeholders as they are) and the images and files (copied)
    go; a row's values too. Child pages do not."""

    model_config = ConfigDict(extra="forbid")

    # Where the copy goes (null: the top level). Left out: beside the original, under the same
    # parent; a page template always goes to the top level, a row stays in its database.
    parent_id: UUID | None = None
    before_id: UUID | None = None
    after_id: UUID | None = None
    # true: a template (a page template, or a row template of the same database); false: a page
    # or a row; left out: what the original is.
    as_template: bool | None = None
    # Left out: the original's title (with 「（コピー）」 in the reader's language for a copy).
    title: str | None = Field(default=None, max_length=MAX_TITLE_LENGTH)
    # A copy at the top level: workspace or private (left out: private when only I can read the
    # original, else workspace). Under a page it takes that page's access.
    access: Literal["workspace", "private"] | None = None
    # Idempotency key: a retry returns the copy made by the first request (200).
    client_save_id: UUID

    _title = field_validator("title")(_clean_title)

    @model_validator(mode="after")
    def _one_neighbour(self) -> "PageDuplicate":
        if self.before_id is not None and self.after_id is not None:
            raise ValueError("Give before_id or after_id, not both")
        return self


class TemplateApply(BaseModel):
    """POST /wiki/pages/{id}/apply-template (M145): an empty page starts from a template
    (「テンプレートから始める」): its body (placeholders put in with `tz`, files copied), and its
    title and icon when the page has none. One of template_key and template_page_id."""

    model_config = ConfigDict(extra="forbid")

    template_key: str | None = Field(default=None, max_length=40)
    template_page_id: UUID | None = None
    tz: str | None = Field(default=None, max_length=64)
    # Idempotency key: a retry changes nothing again.
    client_save_id: UUID

    _tz = field_validator("tz")(_valid_zone)

    @model_validator(mode="after")
    def _one_template(self) -> "TemplateApply":
        if (self.template_key is None) == (self.template_page_id is None):
            raise ValueError("Give template_key or template_page_id")
        return self


class TemplatesOut(BaseModel):
    """GET /wiki/templates (M145): the page templates I can read (newest first) and the built-in
    templates (CANVAS.md §4.12; create a page from one with `template_key`)."""

    pages: list[PageItem]
    builtins: list[CanvasTemplateOut]


class PageUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, max_length=MAX_TITLE_LENGTH)
    # "" removes the icon.
    icon: str | None = Field(default=None, max_length=MAX_ICON_LENGTH)
    # M145: make it a template or a page / row again (edit). A page template is a top-level
    # page without subpages (400 wiki_template_invalid); a database row becomes one of its row
    # templates.
    is_template: bool | None = None

    _title = field_validator("title")(_clean_title)


class PageContentSave(BaseModel):
    """PUT /wiki/pages/{id}/content: the same as a canvas's (CANVAS.md §4.4)."""

    model_config = ConfigDict(extra="forbid")

    base_rev_id: UUID
    body: str
    client_save_id: UUID
    on_conflict: OnConflict = "fail"


class PageSaveOut(BaseModel):
    page: PageContent
    # The version holding exactly the submitted body (the next save's base_rev_id while the
    # editor still differs from page.body).
    submitted_rev_id: UUID
    merged: bool


class PageConflictOut(BaseModel):
    base: str
    ours: str
    theirs: str
    ours_line: int
    theirs_line: int


class PageConflictDetails(BaseModel):
    head: PageContent
    conflicts: list[PageConflictOut] = Field(default_factory=list)
    timed_out: bool = False


class PageConflictError(BaseModel):
    code: Literal["page_conflict", "page_base_expired"]
    message: str
    details: PageConflictDetails


class PageConflictResponse(BaseModel):
    """409 from PUT /wiki/pages/{id}/content."""

    error: PageConflictError


class PageMove(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # The new parent (null: top level).
    parent_id: UUID | None = None
    before_id: UUID | None = None
    after_id: UUID | None = None
    # Keep who sees it as it is now: the effective access becomes the page's own and it stops
    # taking its parent's (WIKI.md §4.5).
    keep_access: bool = False
    # Only say what would change (who would gain or lose access); nothing is moved.
    dry_run: bool = False

    @model_validator(mode="after")
    def _one_neighbour(self) -> "PageMove":
        if self.before_id is not None and self.after_id is not None:
            raise ValueError("Give before_id or after_id, not both")
        return self


class AccessChange(BaseModel):
    """A principal whose level on the moved page would change (null: none)."""

    principal_type: PrincipalType
    principal_id: UUID | None
    before: Level | None
    after: Level | None


class MoveOut(BaseModel):
    dry_run: bool
    # The page after the move (null for a dry run).
    page: PageItem | None
    # On the moved page itself; its subpages follow it where they take its access.
    changes: list[AccessChange]
    # true: after the move nobody (but an administrator taking it over) could manage the page;
    # the move is refused unless keep_access.
    manager_lost: bool


class GrantIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    principal_type: PrincipalType
    # null for workspace; a group's or a person's id.
    principal_id: UUID | None = None
    level: Level

    @model_validator(mode="after")
    def _principal(self) -> "GrantIn":
        if (self.principal_type == "workspace") != (self.principal_id is None):
            raise ValueError("principal_id is null exactly for workspace")
        return self


class GrantOut(BaseModel):
    principal_type: PrincipalType
    principal_id: UUID | None
    level: Level


class EffectiveOut(BaseModel):
    """An entry of the page's effective access."""

    principal_type: PrincipalType
    principal_id: UUID | None
    level: Level
    # The page whose own entry gives it (this page, or an ancestor); null for an ancestor I cannot
    # read (neither its id nor its title is shown).
    source_page_id: UUID | None
    inherited: bool
    # The ancestor's title when I can read it (「〇〇から」), else null.
    source_title: str | None


class AccessOut(BaseModel):
    page_id: UUID
    inherit_access: bool
    own: list[GrantOut]
    effective: list[EffectiveOut]
    my_level: Level


class AccessUpdate(BaseModel):
    """PUT /wiki/pages/{id}/access: the page's own entries and whether it takes its parent's.
    To narrow an inherited entry, send inherit_access false with the effective entries you keep
    (WIKI.md §4.2)."""

    model_config = ConfigDict(extra="forbid")

    inherit_access: bool
    grants: list[GrantIn] = Field(default_factory=list, max_length=MAX_GRANTS)


class PageRef(BaseModel):
    id: UUID
    title: str
    icon: str | None
    kind: PageKind


class ResolveIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ids: list[UUID] = Field(max_length=MAX_RESOLVE)


class PageRevisionMeta(BaseModel):
    id: UUID
    page_id: UUID
    version: int | None
    kind: RevisionKind
    parent_rev_id: UUID | None
    author_id: UUID
    title: str
    label: str | None
    lines_added: int
    lines_removed: int
    created_at: datetime


class PageRevisionOut(PageRevisionMeta):
    body: str


class PageRevisionPage(BaseModel):
    items: list[PageRevisionMeta]
    next_cursor: str | None


class PageRevisionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str | None = Field(default=None, max_length=80)


class PageRevisionRestore(BaseModel):
    model_config = ConfigDict(extra="forbid")

    client_save_id: UUID


class AdminEffective(BaseModel):
    principal_type: PrincipalType
    principal_id: UUID | None
    level: Level


class AdminPageOut(BaseModel):
    """GET /admin/wiki/pages (WIKI.md §4.3): titles and who has access, never bodies."""

    id: UUID
    parent_id: UUID | None
    kind: PageKind
    title: str
    icon: str | None
    inherit_access: bool
    effective: list[AdminEffective]
    # Someone (not a guest, active) can manage it; false: only a takeover gets it back.
    has_manager: bool
    updated_at: datetime
    deleted_at: datetime | None


class WikiBootstrap(BaseModel):
    """In GET /sync/bootstrap: the change feed's position (read the tree with GET /wiki/tree)."""

    change_seq: int


class WikiChangedData(BaseModel):
    """wiki.changed (audience all): the tree's change feed moved to `seq`; what changed differs
    per person, so read GET /wiki/changes?since= (after about 300 ms, folding several)."""

    seq: int


class WikiPageUpdatedData(BaseModel):
    """wiki.page.updated (audience: who can read the page when it is sent): re-read the page if
    it is open and not being edited (an editor merges with its next save)."""

    page: PageMeta
    change: PageChange


class WikiMentionedData(BaseModel):
    """wiki.mentioned (to one person who can read the page): a save newly mentions them."""

    page_id: UUID
    rev_id: UUID
    title: str
    by_user_id: UUID


class WikiSharedData(BaseModel):
    """wiki.shared (to one person): the page was shared with them by name."""

    page_id: UUID
    title: str
    level: Level
    by_user_id: UUID


def to_meta(row: WikiPage, *, trashed: bool = False) -> PageMeta:
    return PageMeta(
        id=row.id,
        parent_id=row.parent_id,
        position=row.position,
        kind=row.kind,  # type: ignore[arg-type]
        title=row.title,
        icon=row.icon,
        version=row.version,
        head_rev_id=row.head_rev_id,
        meta_seq=row.meta_seq,
        inherit_access=row.inherit_access,
        task_total=row.task_total,
        task_done=row.task_done,
        created_by=row.created_by,
        updated_by=row.updated_by,
        created_at=row.created_at,
        updated_at=row.updated_at,
        deleted_at=row.deleted_at if trashed else None,
        is_template=bool(row.is_template),
    )


def level_name(rank: int) -> Level:
    return {1: "view", 2: "edit", 3: "full"}[rank]  # type: ignore[return-value]


def to_item(row: WikiPage, rank: int, private: bool, *, parent_visible: bool = True) -> PageItem:
    meta = to_meta(row).model_dump()
    if not parent_visible:
        meta["parent_id"] = None
    return PageItem(**meta, my_level=level_name(rank), private=private)


def to_content(
    row: WikiPage, rank: int, private: bool, *, parent_visible: bool = True
) -> PageContent:
    item = to_item(row, rank, private, parent_visible=parent_visible)
    return PageContent(**item.model_dump(), body=row.body)


def to_revision_meta(row: WikiPageRevision) -> PageRevisionMeta:
    return PageRevisionMeta(
        id=row.id,
        page_id=row.page_id,
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


def to_revision_out(row: WikiPageRevision) -> PageRevisionOut:
    return PageRevisionOut(**to_revision_meta(row).model_dump(), body=row.body)
