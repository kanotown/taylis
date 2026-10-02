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
    String,
    Text,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow


class Canvas(Base):
    """A Markdown document that belongs to a conversation (DATA_MODEL.md canvases, CANVAS.md §4.3).

    Who may read and change it follows the conversation's membership. Edits do not use the
    channel's seq (a canvas is not a timeline item)."""

    __tablename__ = "canvases"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id"))
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text, default="", server_default="")
    # +1 on every change of body, title, settings, trash or restore ("the larger wins").
    version: Mapped[int] = mapped_column(BigInteger, default=1, server_default=text("1"))
    head_rev_id: Mapped[uuid.UUID] = mapped_column()
    is_channel_tab: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false")
    )
    edit_policy: Mapped[str] = mapped_column(
        String(16), default="members", server_default="members"
    )
    template_key: Mapped[str | None] = mapped_column(String(40))
    # The message that shared it to the conversation (its thread holds the comments); M42.
    share_message_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("messages.id"))
    task_total: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    task_done: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
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

    __table_args__ = (
        CheckConstraint("edit_policy IN ('members', 'owners')", name="edit_policy_values"),
        Index(
            "canvases_channel_idx",
            "channel_id",
            text("updated_at DESC"),
            postgresql_where=text("deleted_at IS NULL"),
        ),
        Index(
            "canvases_tab_uniq",
            "channel_id",
            unique=True,
            postgresql_where=text("is_channel_tab AND deleted_at IS NULL"),
        ),
    )

    @property
    def is_deleted(self) -> bool:
        return self.deleted_at is not None


class CanvasRevision(Base):
    """One version of a canvas's body (CANVAS.md §4.3, §4.9).

    kind: create | save | merge | restore | task (each made the canvas's head; `version` is the
    canvas's version it produced; task, M80: the server's change for a linked task), side (a
    submitted body that was merged into the head: the base of that device's next save; `version`
    NULL), erased (its body was erased)."""

    __tablename__ = "canvas_revisions"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    canvas_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("canvases.id", ondelete="CASCADE"))
    version: Mapped[int | None] = mapped_column(BigInteger)
    kind: Mapped[str] = mapped_column(String(16))
    # The version this one was made from: the base of a save or a side, the head a merge or a
    # restore went on top of.
    parent_rev_id: Mapped[uuid.UUID | None] = mapped_column()
    author_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text)
    client_save_id: Mapped[uuid.UUID | None] = mapped_column()
    label: Mapped[str | None] = mapped_column(String(80))
    # Lines added / removed against the parent (the history list shows them without bodies).
    lines_added: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    lines_removed: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "kind IN ('create', 'save', 'merge', 'side', 'restore', 'erased', 'task')",
            name="kind_values",
        ),
        Index("canvas_revisions_canvas_idx", "canvas_id", "created_at"),
        Index(
            "canvas_revisions_save_uniq",
            "author_id",
            "client_save_id",
            unique=True,
            postgresql_where=text("client_save_id IS NOT NULL"),
        ),
    )


class CanvasTemplate(Base):
    """A starting point for a new canvas (CANVAS.md §4.12). The built-in ones (`builtin`) come
    with the server and can be edited or hidden but not deleted."""

    __tablename__ = "canvas_templates"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    key: Mapped[str] = mapped_column(String(40), unique=True)
    name: Mapped[str] = mapped_column(String(80))
    description: Mapped[str | None] = mapped_column(String(200))
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text)
    position: Mapped[int] = mapped_column(Integer)
    builtin: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    hidden: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
