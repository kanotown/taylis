"""Wiki pages (docs/WIKI.md §11.1, DATA_MODEL.md "wiki_pages"; migration 0095, M120)."""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    SmallInteger,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow


class WikiPage(Base):
    """A page of the workspace's one tree (WIKI.md §3). kind page | database | row (database and
    row from M123). Who may read and change it is wiki_effective_grants (access.py), never the
    conversations."""

    __tablename__ = "wiki_pages"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    # NULL: a top-level page (or one whose parent was purged while it was in the trash).
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("wiki_pages.id", ondelete="SET NULL")
    )
    # The ids from the root down to the parent (breadcrumbs, the subtree in one query).
    path: Mapped[list[uuid.UUID]] = mapped_column(ARRAY(PG_UUID(as_uuid=True)), default=list)
    # The fractional index among its siblings (COLLATE "C"), made by the server (ordering.py).
    position: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(String(16), default="page", server_default="page")
    title: Mapped[str] = mapped_column(String(200), default="", server_default="")
    # One emoji or a :custom: emoji.
    icon: Mapped[str | None] = mapped_column(String(64))
    body: Mapped[str] = mapped_column(Text, default="", server_default="")
    # +1 on every change of the body, title, icon, place, trash or access (the larger wins).
    version: Mapped[int] = mapped_column(BigInteger, default=1, server_default=text("1"))
    head_rev_id: Mapped[uuid.UUID] = mapped_column()
    # The change feed (WIKI.md §10, wiki_change_seq): meta_seq moves on every change the tree
    # shows (not on a body save); vis_seq when who can see it may have changed; created_seq once.
    meta_seq: Mapped[int] = mapped_column(BigInteger)
    vis_seq: Mapped[int] = mapped_column(BigInteger)
    created_seq: Mapped[int] = mapped_column(BigInteger)
    inherit_access: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))
    # Rows only (M123): {prop_id: value} and its text for search.
    props: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    props_text: Mapped[str | None] = mapped_column(Text)
    task_total: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    task_done: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    # M145 (WIKI.md §22.3, migration 0108): a page template (top-level, out of the tree, search
    # and backlinks; GET /wiki/templates) or a database's row template (out of its query).
    is_template: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    updated_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deleted_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    # The root of the subtree that went to the trash together (restored and purged together).
    trash_root_id: Mapped[uuid.UUID | None] = mapped_column()

    @property
    def is_deleted(self) -> bool:
        return self.deleted_at is not None


class WikiPageRevision(Base):
    """One version of a page's body (like canvas_revisions, CANVAS.md §4.9).

    kind: create | save | merge | restore (each made the head) | side (a submitted body merged
    into the head) | erased | props (M123) | import (M125)."""

    __tablename__ = "wiki_page_revisions"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    page_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("wiki_pages.id", ondelete="CASCADE"))
    version: Mapped[int | None] = mapped_column(BigInteger)
    kind: Mapped[str] = mapped_column(String(16))
    parent_rev_id: Mapped[uuid.UUID | None] = mapped_column()
    author_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text)
    props: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    client_save_id: Mapped[uuid.UUID | None] = mapped_column()
    label: Mapped[str | None] = mapped_column(String(80))
    lines_added: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    lines_removed: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )


class WikiGrant(Base):
    """A page's own access entry (WIKI.md §4.1): principal workspace (id NULL) | group | user,
    level view | edit | full."""

    __tablename__ = "wiki_grants"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    page_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("wiki_pages.id", ondelete="CASCADE"))
    principal_type: Mapped[str] = mapped_column(String(16))
    principal_id: Mapped[uuid.UUID | None] = mapped_column()
    level: Mapped[str] = mapped_column(String(8))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )


class WikiEffectiveGrant(Base):
    """The inherited result (WIKI.md §4.2 / §4.6): rewritten for a subtree in the transaction of
    every change of the tree or of access. `source_page_id`: the page whose own entry gave it."""

    __tablename__ = "wiki_effective_grants"

    # No primary key in the table (UNIQUE NULLS NOT DISTINCT); the ORM needs one to map it.
    page_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("wiki_pages.id", ondelete="CASCADE"), primary_key=True
    )
    principal_type: Mapped[str] = mapped_column(String(16), primary_key=True)
    principal_id: Mapped[uuid.UUID | None] = mapped_column(primary_key=True, nullable=True)
    level_rank: Mapped[int] = mapped_column(SmallInteger)
    source_page_id: Mapped[uuid.UUID] = mapped_column()


class WikiLink(Base):
    """A page's body links to another page (WIKI.md §3.3): backlinks."""

    __tablename__ = "wiki_links"

    src_page_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("wiki_pages.id", ondelete="CASCADE"), primary_key=True
    )
    dst_page_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("wiki_pages.id", ondelete="CASCADE"), primary_key=True
    )


class WikiNotice(Base):
    """An activity item (WIKI.md §9.3): kind mention (one per page while unread, like
    canvas_mentions) | shared (named in the page's access)."""

    __tablename__ = "wiki_notices"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    page_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("wiki_pages.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(16))
    rev_id: Mapped[uuid.UUID | None] = mapped_column()
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    excerpt: Mapped[str] = mapped_column(String(200), default="", server_default="")
    # kind shared: the level given.
    level: Mapped[str | None] = mapped_column(String(8))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )


class WikiTombstone(Base):
    """A purged page, for the change feed's `removed` (kept 30 days)."""

    __tablename__ = "wiki_tombstones"

    page_id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    seq: Mapped[int] = mapped_column(BigInteger)
    purged_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class WikiDatabase(Base):
    """A database page's schema and saved views (WIKI.md §5, migration 0096, M123). Rows are the
    pages of kind row below it; their values are in wiki_pages.props."""

    __tablename__ = "wiki_databases"

    page_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("wiki_pages.id", ondelete="CASCADE"), primary_key=True
    )
    # {"properties": [{"id", "name", "type", "options", "number_format", "relation"}]}
    schema_doc: Mapped[dict[str, Any]] = mapped_column("schema", JSONB)
    # [{"id", "name", "type", "columns", "sort", "filter", "date_prop_id"}]
    views: Mapped[list[dict[str, Any]]] = mapped_column(JSONB)
    # +1 on every schema or view change (a change written on an older one is refused).
    schema_version: Mapped[int] = mapped_column(BigInteger, default=1, server_default=text("1"))
    # M145: the row template 「新規」 starts from (a row of this database with is_template).
    default_template_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("wiki_pages.id", ondelete="SET NULL")
    )


class WikiRelation(Base):
    """One link of a relation property (WIKI.md §5.7): row `src_page_id` links to row
    `dst_page_id` through `prop_id` of the database `src_database_id`. A two-way relation's
    reverse property reads the same rows from the other end."""

    __tablename__ = "wiki_relations"

    src_page_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("wiki_pages.id", ondelete="CASCADE"), primary_key=True
    )
    prop_id: Mapped[str] = mapped_column(String(24), primary_key=True)
    dst_page_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("wiki_pages.id", ondelete="CASCADE"), primary_key=True
    )
    src_database_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("wiki_pages.id", ondelete="CASCADE")
    )
    # The order in the source's cell.
    position: Mapped[int] = mapped_column(Integer)
    # When it was made: the order in the reverse cell.
    seq: Mapped[int] = mapped_column(
        BigInteger, server_default=text("nextval('wiki_relation_seq')")
    )


class WikiPropLegacy(Base):
    """A value a type change could not convert (WIKI.md §5.2), kept 30 days: changing the type
    back brings it back."""

    __tablename__ = "wiki_props_legacy"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    page_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("wiki_pages.id", ondelete="CASCADE"))
    prop_id: Mapped[str] = mapped_column(String(24))
    prop_type: Mapped[str] = mapped_column(String(16))
    value: Mapped[Any] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
