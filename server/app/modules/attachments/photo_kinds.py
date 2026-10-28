"""Which files the drive reads as photos or videos (AL1, docs/ALBUMS.md §4.2): the images the
thumbnails are made of (images.IMAGE_TYPES) and every video/*."""

from app.modules.attachments.images import IMAGE_TYPES
from app.modules.attachments.videos import is_video


def is_image(content_type: str | None) -> bool:
    return (content_type or "").lower() in IMAGE_TYPES


def photo_kind(content_type: str | None) -> bool:
    """A photo or a video: what an album shows."""
    return is_image(content_type) or is_video(content_type or "")
