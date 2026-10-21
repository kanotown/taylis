"""Item names (docs/DRIVE.md §4.3): normalised, checked, compared without case, sorted in the
sidebar's Japanese name order, and made unique with 「名前 (1).pdf」."""

import re
import unicodedata

from app.core.collation import name_key as collation_key
from app.core.errors import AppError

MAX_NAME = 255
MAX_DEPTH = 32  # folders from the root (§4.3)
MAX_CHILDREN = 10_000
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def invalid(message: str) -> AppError:
    return AppError(422, "drive_name_invalid", message)


def normalize(raw: str) -> str:
    """NFC (a macOS browser or Finder sends NFD voicing marks) without surrounding spaces;
    422 drive_name_invalid for an empty name, more than 255 characters, `/`, control
    characters, `.` and `..`. Characters Windows refuses are kept (names from Nextcloud stay as
    they are); downloads replace them."""
    name = unicodedata.normalize("NFC", raw).strip()
    if not name:
        raise invalid("A name cannot be empty")
    if len(name) > MAX_NAME:
        raise invalid(f"A name has at most {MAX_NAME} characters")
    if "/" in name:
        raise invalid("A name cannot contain /")
    if _CONTROL.search(name):
        raise invalid("A name cannot contain control characters")
    if name in (".", ".."):
        raise invalid("A name cannot be . or ..")
    return name


def split_path(raw: str) -> list[str]:
    """`a/b/c` (a folder upload's relative directory, POST /drive/folders {path}) as checked
    names. Leading and trailing slashes are ignored; an empty segment is refused."""
    trimmed = raw.strip().strip("/")
    if not trimmed:
        raise invalid("A path cannot be empty")
    segments = trimmed.split("/")
    if len(segments) > MAX_DEPTH:
        raise AppError(422, "drive_depth_exceeded", f"Folders nest at most {MAX_DEPTH} deep")
    return [normalize(segment) for segment in segments]


def key(name: str) -> str:
    """Two names in one folder clash when these are equal (NFC + casefold)."""
    return unicodedata.normalize("NFC", name).casefold()


def _escaped(data: bytes) -> bytes:
    """A component of the sort key that may contain 0x00: 0x00 → 0x00 0xFF, then 0x00 0x00 ends
    it, so a shorter text sorts first and the next component is never compared with it."""
    return data.replace(b"\x00", b"\x00\xff") + b"\x00\x00"


def sort_key(name: str) -> bytes:
    """core.collation's key as bytes that compare (memcmp, PostgreSQL's bytea order) the way the
    key's tuples do: each element is its class + 1, its value in 4 bytes and (a run of digits)
    the digits; 0x00 ends the elements; then the two text levels."""
    elements, level2, level3 = collation_key(name)
    out = bytearray()
    for cls, value, digits in elements:
        out.append(cls + 1)
        out += value.to_bytes(4, "big")
        if cls == 1:
            out += digits.encode("ascii") + b"\x00"
    out.append(0)
    out += _escaped(level2)
    out += _escaped(level3)
    return bytes(out)


def numbered(name: str, n: int, *, is_file: bool) -> str:
    """「名前 (n).pdf」 (a folder: 「名前 (n)」), the way Finder, Explorer and the downloads
    (PREVIEWS.md §9) number a name that is taken; kept within 255 characters."""
    stem, ext = name, ""
    if is_file:
        dot = name.rfind(".")
        if dot > 0:
            stem, ext = name[:dot], name[dot:]
    suffix = f" ({n})"
    room = MAX_NAME - len(suffix) - len(ext)
    return f"{stem[: max(room, 1)]}{suffix}{ext}"


_WINDOWS_BAD = re.compile(r'[<>:"/\\|?*\x00-\x1f\x7f]')
_RESERVED = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{i}" for i in range(1, 10)}
    | {f"LPT{i}" for i in range(1, 10)}
)


def download_name(name: str) -> str:
    """The name a download is saved under (PREVIEWS.md §9 「ファイル名」): characters Windows
    refuses become `_`, no leading `.` nor trailing `.` / space, a reserved name gets a leading
    `_`, at most 200 characters with the extension kept."""
    cleaned = _WINDOWS_BAD.sub("_", name).lstrip(".").rstrip(". ")
    if not cleaned:
        return "download"
    stem, dot, ext = cleaned.rpartition(".")
    if not dot:
        stem, ext = cleaned, ""
    if stem.upper() in _RESERVED:
        cleaned = "_" + cleaned
    if len(cleaned) > 200:
        tail = f".{ext}" if dot and len(ext) < 20 else ""
        cleaned = cleaned[: 200 - len(tail)] + tail
    return cleaned
