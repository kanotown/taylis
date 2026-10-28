"""A file's content type from its first bytes (SECURITY.md §4): `filetype`, after the HEIF brands it
does not know (heix, heim, heis, the sequences, a generic mif1 holding HEVC: heif.sniff, docs/
ALBUMS.md §23)."""

import filetype

from app.modules.attachments import heif

OCTET = "application/octet-stream"


def content_type(head: bytes) -> str:
    if not head:
        return OCTET
    found = heif.sniff(head)
    if found is not None:
        return found
    kind = filetype.guess(head)
    return kind.mime if kind is not None else OCTET
