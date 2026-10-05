"""Which uploads get a document preview (M108, docs/PREVIEWS.md §2).

The kind is the extension the converter is given ("docx", ...; "pdf" for a PDF, which is not
converted). It comes from the sniffed content type; only when the sniffer could not tell an Office
file from a plain ZIP / OLE container (a Word file whose first entries are large, an old .doc) does
the uploaded name's extension decide, and then only among the extensions below: the name never
reaches a path or a storage key (the converter gets "document.<kind>").
"""

import uuid

from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.attachments.models import Attachment

PDF_TYPE = "application/pdf"

OFFICE_TYPES: dict[str, str] = {
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.ms-powerpoint": "ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/vnd.oasis.opendocument.text": "odt",
    "application/vnd.oasis.opendocument.spreadsheet": "ods",
    "application/vnd.oasis.opendocument.presentation": "odp",
    "application/rtf": "rtf",
}
OFFICE_EXTENSIONS = frozenset(OFFICE_TYPES.values())
# What `filetype` answers for an Office file it could not place.
CONTAINER_TYPES = frozenset(
    {"application/zip", "application/x-ole-storage", "application/octet-stream"}
)
PREVIEW_TYPES = frozenset({PDF_TYPE, *OFFICE_TYPES})


def source_kind(content_type: str, filename: str) -> str | None:
    """ "pdf", an Office extension, or None (no preview for this file)."""
    content_type = content_type.lower()
    if content_type == PDF_TYPE:
        return "pdf"
    if content_type in OFFICE_TYPES:
        return OFFICE_TYPES[content_type]
    if content_type in CONTAINER_TYPES:
        _, dot, ext = filename.rpartition(".")
        ext = ext.lower()
        if dot and ext in OFFICE_EXTENSIONS:
            return ext
    return None


def wants_preview(
    content_type: str,
    filename: str,
    size_bytes: int,
    *,
    enabled: bool,
    converter: bool,
    max_bytes: int,
) -> bool:
    """A preview can be made: previews are on, the file is not too large, and it is a PDF or an
    Office file while a converter is configured."""
    if not enabled or size_bytes > max_bytes:
        return False
    kind = source_kind(content_type, filename)
    return kind == "pdf" or (kind is not None and converter)


def wants(attachment: Attachment, settings: Settings) -> bool:
    return wants_preview(
        attachment.content_type,
        attachment.filename,
        attachment.size_bytes,
        enabled=settings.previews_enabled,
        converter=bool(settings.preview_converter_url),
        max_bytes=settings.preview_max_input_bytes,
    )


def queue_on_upload(attachment: Attachment, settings: Settings) -> None:
    """At upload (service.upload): queue the preview when this file gets one. The preview loop
    is woken by the router; the upload itself never waits for it."""
    if wants(attachment, settings):
        attachment.preview_status = "pending"
        attachment.preview_next_at = utcnow()


# --- the preview's object keys ------------------------------------------------------------------
# Sibling keys like the thumbnail's (service.thumbnail_key): a posix-backed store cannot hold an
# object "attachments/{id}" and a directory of the same name. Each try writes under its own claim
# number (attachments.preview_generation, Review v0.1.37 #4), so a try that lost its lease can
# neither overwrite nor delete a newer try's objects.


def pdf_key(attachment_id: uuid.UUID, generation: int) -> str:
    return f"attachments/{attachment_id}.preview.{generation}.pdf"


def thumb_key(attachment_id: uuid.UUID, generation: int) -> str:
    return f"attachments/{attachment_id}.preview.{generation}.webp"


def possible_preview_keys(attachment_id: uuid.UUID, last_generation: int) -> list[str]:
    """Every key a try of this row up to claim `last_generation` may have written (Review v0.1.37
    #9): the keys from before the claim numbers (M108) and those of claims 1 .. last_generation.
    A try that stopped after a partial write recorded nothing; the GC and a finished try remove
    these (deleting a key that is not there is a no-op)."""
    keys = [f"attachments/{attachment_id}.preview.pdf", f"attachments/{attachment_id}.preview.webp"]
    for generation in range(1, last_generation + 1):
        keys += [pdf_key(attachment_id, generation), thumb_key(attachment_id, generation)]
    return keys
