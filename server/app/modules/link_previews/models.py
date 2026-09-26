from datetime import datetime

from sqlalchemy import DateTime, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base


class LinkPreview(Base):
    """One fetched page (DATA_MODEL.md link_previews). Failures are cached too, briefly."""

    __tablename__ = "link_previews"

    url_hash: Mapped[str] = mapped_column(String(64), primary_key=True)  # sha256 of the URL
    url: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16))  # 'ok' | 'failed'
    title: Mapped[str | None] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    image_url: Mapped[str | None] = mapped_column(Text)
    site_name: Mapped[str | None] = mapped_column(Text)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
