import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow

MAX_NAME_LENGTH = 40
MAX_DESCRIPTION_LENGTH = 200
MAX_TEMPLATE_LENGTH = 4000


class Workflow(Base):
    """A form that posts a message (WORKFLOWS.md §3): the submitter fills the fields and the
    server renders the template into an ordinary message in `channel_id`, as the submitter."""

    __tablename__ = "workflows"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    name: Mapped[str] = mapped_column(String(MAX_NAME_LENGTH))
    emoji: Mapped[str | None] = mapped_column(String(32))
    description: Mapped[str] = mapped_column(Text, default="", server_default="")
    # Where the message is posted (a public or private channel).
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id"))
    # Where the menu offers it; always includes channel_id.
    offered_channel_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid()), default=list, server_default=text("'{}'::uuid[]")
    )
    # [{key, label, type, required, help, options, multiple, default}] (WORKFLOWS.md §3.1).
    fields: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, default=list, server_default=text("'[]'::jsonb")
    )
    template: Mapped[str] = mapped_column(Text)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, server_default=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(f"char_length(name) BETWEEN 1 AND {MAX_NAME_LENGTH}", name="name_length"),
        CheckConstraint(
            f"char_length(template) BETWEEN 1 AND {MAX_TEMPLATE_LENGTH}", name="template_length"
        ),
        CheckConstraint(
            f"char_length(description) <= {MAX_DESCRIPTION_LENGTH}", name="description_length"
        ),
        Index(
            "workflows_name_uniq",
            text("lower(name)"),
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
        ),
        Index(
            "workflows_offered_idx",
            "offered_channel_ids",
            postgresql_using="gin",
            postgresql_where=text("deleted_at IS NULL"),
        ),
    )
