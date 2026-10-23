"""An uncompressed (stored) ZIP written as it streams, its length known before the first byte
(docs/DRIVE.md §7.2, phase D3).

Every file's size is known in advance (the versions' sizes) and nothing is compressed, so every
header, the data, the data descriptors and the central directory have lengths fixed by the names
and sizes alone: `ZipPlan.length` is the exact Content-Length. Only the CRC-32 is learnt while the
bytes go by, so each file is followed by a data descriptor (general purpose flag bit 3) and its
local header carries zeros, the usual way of streaming a ZIP.

- Names are UTF-8 with flag bit 11 (Windows 10 and later, macOS and Info-ZIP read them so).
- ZIP64 is used only where a value does not fit 32 bits (an entry of 4 GiB or more, an entry or the
  central directory beyond 4 GiB): small archives stay plain ZIP, which every unzipper reads.
- Times: the DOS fields in the given zone (Windows Explorer shows them as they are) and the
  extended timestamp extra field 0x5455 in UTC (Info-ZIP, macOS).
- Folders are entries of their own (`name/`), so empty folders survive.

The standard `zipfile` is not used to write: in streaming mode it chooses ZIP64 by a guess about
the size and writes fields whose length then differs, which makes the length hard to know first.
`zipfile` reads what this writes (the tests check it, with ZIP64 beyond 4 GiB too).
"""

import struct
import uuid
import zlib
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, tzinfo

LIMIT32 = 0xFFFFFFFF
LIMIT16 = 0xFFFF
_FLAG_DESCRIPTOR = 0x0008
_FLAG_UTF8 = 0x0800
_UNIX = 3
_DOS_EARLIEST = datetime(1980, 1, 1)
_DOS_LATEST = datetime(2107, 12, 31, 23, 59, 58)


@dataclass
class ZipEntry:
    """One entry: a folder (`size` 0, no source) or a file whose bytes `source` yields."""

    name: str  # the path inside the ZIP, `/`-separated; a folder's ends with `/`
    size: int
    modified: datetime
    is_dir: bool = False
    # Opaque to this module: what `open_source` needs to stream the bytes (a storage key).
    source: str | None = None
    # Opaque to this module too: the drive item (and the file's version) the entry was made from,
    # checked again when the ZIP starts (REVIEW-v0.1.70 #2).
    item_id: uuid.UUID | None = None
    version_id: uuid.UUID | None = None
    # Filled while planning:
    offset: int = 0
    crc: int = 0
    encoded: bytes = field(default=b"", repr=False)

    @property
    def big(self) -> bool:
        """Its size needs ZIP64 (the local header then has a ZIP64 extra field and the data
        descriptor 8-byte sizes)."""
        return not self.is_dir and self.size >= LIMIT32


def _dos(at: datetime, zone: tzinfo) -> tuple[int, int]:
    local = at.astimezone(zone).replace(tzinfo=None) if at.tzinfo else at
    local = min(max(local, _DOS_EARLIEST), _DOS_LATEST)
    time = (local.hour << 11) | (local.minute << 5) | (local.second // 2)
    date = ((local.year - 1980) << 9) | (local.month << 5) | local.day
    return time, date


def _unix_time(at: datetime) -> int:
    stamp = int((at if at.tzinfo else at.replace(tzinfo=UTC)).timestamp())
    return min(max(stamp, 0), 0x7FFFFFFF)


def _timestamp_extra(at: datetime) -> bytes:
    """0x5455, modification time only (the same in the local and the central header)."""
    return struct.pack("<HHBI", 0x5455, 5, 1, _unix_time(at))


def _local_extra(entry: ZipEntry) -> bytes:
    extra = _timestamp_extra(entry.modified)
    if entry.big:
        # Sizes are in the data descriptor (bit 3); the ZIP64 field says they are 8 bytes there.
        extra += struct.pack("<HHQQ", 0x0001, 16, 0, 0)
    return extra


def _central_zip64(entry: ZipEntry) -> bytes:
    values: list[int] = []
    if entry.big:
        values += [entry.size, entry.size]
    if entry.offset >= LIMIT32:
        values.append(entry.offset)
    if not values:
        return b""
    return struct.pack(f"<HH{len(values)}Q", 0x0001, 8 * len(values), *values)


def _needed(entry: ZipEntry) -> int:
    return 45 if entry.big or entry.offset >= LIMIT32 else 20


def local_header_length(entry: ZipEntry) -> int:
    return 30 + len(entry.encoded) + len(_local_extra(entry))


def descriptor_length(entry: ZipEntry) -> int:
    if entry.is_dir:
        return 0
    return 24 if entry.big else 16


def central_header_length(entry: ZipEntry) -> int:
    return (
        46 + len(entry.encoded) + len(_timestamp_extra(entry.modified)) + len(_central_zip64(entry))
    )


@dataclass
class ZipPlan:
    entries: list[ZipEntry]
    zone: tzinfo
    central_offset: int = 0
    central_size: int = 0
    length: int = 0

    @property
    def zip64_end(self) -> bool:
        return (
            len(self.entries) >= LIMIT16
            or self.central_offset >= LIMIT32
            or self.central_size >= LIMIT32
        )

    @property
    def bytes_total(self) -> int:
        return sum(entry.size for entry in self.entries)


def plan(entries: list[ZipEntry], zone: tzinfo = UTC) -> ZipPlan:
    """Lays the entries out: each one's offset, then the central directory's, and the length."""
    offset = 0
    for entry in entries:
        entry.encoded = entry.name.encode("utf-8")
        if len(entry.encoded) > LIMIT16:
            raise ValueError("a name too long for a ZIP")
        entry.offset = offset
        offset += local_header_length(entry) + entry.size + descriptor_length(entry)
    out = ZipPlan(entries=entries, zone=zone, central_offset=offset)
    out.central_size = sum(central_header_length(entry) for entry in entries)
    out.length = offset + out.central_size + (56 + 20 if out.zip64_end else 0) + 22
    return out


def _local_header(entry: ZipEntry, zone: tzinfo) -> bytes:
    time, date = _dos(entry.modified, zone)
    flags = _FLAG_UTF8 | (0 if entry.is_dir else _FLAG_DESCRIPTOR)
    extra = _local_extra(entry)
    sizes = LIMIT32 if entry.big else 0
    return (
        struct.pack(
            "<IHHHHHIIIHH",
            0x04034B50,
            45 if entry.big else 20,
            flags,
            0,  # stored
            time,
            date,
            0,
            sizes,
            sizes,
            len(entry.encoded),
            len(extra),
        )
        + entry.encoded
        + extra
    )


def _descriptor(entry: ZipEntry) -> bytes:
    if entry.big:
        return struct.pack("<IIQQ", 0x08074B50, entry.crc, entry.size, entry.size)
    return struct.pack("<IIII", 0x08074B50, entry.crc, entry.size, entry.size)


def _central_header(entry: ZipEntry, zone: tzinfo) -> bytes:
    time, date = _dos(entry.modified, zone)
    flags = _FLAG_UTF8 | (0 if entry.is_dir else _FLAG_DESCRIPTOR)
    extra = _timestamp_extra(entry.modified) + _central_zip64(entry)
    size32 = LIMIT32 if entry.big else entry.size
    offset32 = LIMIT32 if entry.offset >= LIMIT32 else entry.offset
    mode = (0o40755 << 16) | 0x10 if entry.is_dir else 0o100644 << 16
    needed = _needed(entry)
    return (
        struct.pack(
            "<IHHHHHHIIIHHHHHII",
            0x02014B50,
            (_UNIX << 8) | needed,
            needed,
            flags,
            0,
            time,
            date,
            entry.crc,
            size32,
            size32,
            len(entry.encoded),
            len(extra),
            0,  # comment
            0,  # disk
            0,  # internal attributes
            mode,
            offset32,
        )
        + entry.encoded
        + extra
    )


def _end(plan_: ZipPlan) -> bytes:
    count = len(plan_.entries)
    out = b""
    if plan_.zip64_end:
        zip64_at = plan_.central_offset + plan_.central_size
        out += struct.pack(
            "<IQHHIIQQQQ",
            0x06064B50,
            44,
            (_UNIX << 8) | 45,
            45,
            0,
            0,
            count,
            count,
            plan_.central_size,
            plan_.central_offset,
        )
        out += struct.pack("<IIQI", 0x07064B50, 0, zip64_at, 1)
    out += struct.pack(
        "<IHHHHIIH",
        0x06054B50,
        0,
        0,
        min(count, LIMIT16),
        min(count, LIMIT16),
        min(plan_.central_size, LIMIT32),
        min(plan_.central_offset, LIMIT32),
        0,
    )
    return out


class SourceChanged(Exception):
    """A file's bytes were not the length planned (the stream is cut off: its Content-Length then
    tells the client the download failed)."""


async def stream(
    plan_: ZipPlan, open_source: Callable[[str], AsyncIterator[bytes]]
) -> AsyncIterator[bytes]:
    """The ZIP's bytes, exactly `plan_.length` of them (or fewer, with SourceChanged raised)."""
    for entry in plan_.entries:
        yield _local_header(entry, plan_.zone)
        if entry.is_dir:
            continue
        crc = 0
        seen = 0
        if entry.size:
            assert entry.source is not None
            async for chunk in open_source(entry.source):
                seen += len(chunk)
                if seen > entry.size:
                    raise SourceChanged(entry.name)
                crc = zlib.crc32(chunk, crc)
                yield chunk
        if seen != entry.size:
            raise SourceChanged(entry.name)
        entry.crc = crc & LIMIT32
        yield _descriptor(entry)
    central = b"".join(_central_header(entry, plan_.zone) for entry in plan_.entries)
    yield central + _end(plan_)
