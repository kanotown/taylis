"""Where imported rows came from (M18): one row per source object, so an import can run again."""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base


class ImportRef(Base):
    """A source object (e.g. a Mattermost post id) and the ChikuwaChat row made from it.

    A second run of the same import finds these and skips what already exists: moving a team over
    can be tried with --dry-run, run, and repeated just before the switch to pick up newer posts.
    """

    __tablename__ = "import_refs"

    source: Mapped[str] = mapped_column(String(32), primary_key=True)  # "mattermost"
    kind: Mapped[str] = mapped_column(
        String(16), primary_key=True
    )  # user, channel, post, file, emoji
    source_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    target_id: Mapped[uuid.UUID]
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
