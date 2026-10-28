"""HEIC / HEIF stills (AL5, docs/ALBUMS.md §6.3, §19; SECURITY.md §4 「画像」「動画」).

Pillow cannot read HEIF, so a HEIC from a Mac or an Android phone is decoded by the app image's
ffmpeg (7.1 on Debian trixie), in the same confinement as a video's poster (videos.run_bounded:
argv only, a bare environment, a timeout, the input limited to the local file and the mov demuxer,
the output capped). What ffmpeg 7.1 does not do for a still, this module does:

- **The file's own description** (`parse`): the primary item of the `meta` box, its size (`ispe`),
  rotation (`irot`) and mirror (`imir`), its ICC profile (`colr`), whether it is a grid of tiles,
  and its EXIF block (the `Exif` item, read through `iloc`). Plain bounded box parsing of the first
  MAX_META_BYTES of the file; nothing here decodes a pixel. The pixel count is checked against
  images.MAX_PIXELS before ffmpeg runs.
- **The tiles**: a phone's HEIC is a grid of 512 x 512 HEVC tiles (a 12 Mpx photo has 48). ffmpeg
  7.1 reads the grid as a stream group but its command line does not join it (later ones do), so
  `ffprobe -show_stream_groups` gives the tiles' streams and offsets and an `xstack` filter joins
  them, cropped to the grid's output size.
- **Upright**: ffmpeg 7.1 neither turns nor mirrors a HEIF still, so the `irot` / `imir` of the
  primary item are applied with `transpose` / `hflip` / `vflip`, and `-noautorotate` keeps a later
  ffmpeg from turning it once more (in HEIF the EXIF Orientation is informative only: the item
  properties say how to show it, as libheif and the Apple frameworks do).

The result is one upright RGB PNG no larger than DISPLAY_PX on its long edge, from which Pillow
makes the thumbnail and the display-size WebP exactly as for any other photo (photos.py).
"""

import io
import json
import logging
import struct
from dataclasses import dataclass
from datetime import datetime, tzinfo
from typing import IO

from PIL import Image
from starlette.concurrency import run_in_threadpool

from app.core.settings import Settings
from app.modules.attachments import videos
from app.modules.attachments.images import MAX_PIXELS, thumbnail_jpeg
from app.modules.attachments.photos import (
    DISPLAY_PX,
    DisplayImage,
    PhotoMeta,
    make_display,
    read_exif_meta,
)

log = logging.getLogger("app.attachments.heif")

HEIF_TYPES = frozenset({"image/heic", "image/heif"})
# The meta box of a phone's HEIC is a few kB (48 tiles); a grid of thousands of tiles is still
# well under this. A file whose meta box lies further is not read (no thumbnail).
MAX_META_BYTES = 4 * 1024 * 1024
MAX_EXIF_BYTES = 1024 * 1024
MAX_ICC_BYTES = 1024 * 1024
MAX_TILES = 1024
MAX_DEPTH = 3
# The joined image is decoded tile by tile into one frame: a bound like the image path's.
DECODE_PX = DISPLAY_PX
MAX_DECODED_OUTPUT = 64 * 1024 * 1024
MAX_PROBE_OUTPUT = 1024 * 1024
# The mov demuxer is the one that reads HEIF (ffmpeg -formats: mov,mp4,m4a,3gp,3g2,mj2).
INPUT_OPTIONS = ("-protocol_whitelist", "file", "-format_whitelist", "mov,mp4,m4a,3gp,3g2,mj2")

_CONTAINERS = {b"meta", b"iinf", b"iprp", b"ipco", b"dinf"}


def is_heif(content_type: str | None) -> bool:
    return (content_type or "").lower() in HEIF_TYPES


# The `ftyp` brands of ISO/IEC 23008-12 Annex B that say HEVC: a still (heic 8 bit, heix 10 bit and
# more, as Core Image writes), its multi-layer and scalable forms (heim, heis), and the image
# sequences (hevc, hevx, hevm, hevs), which a phone writes with a still too.
HEVC_BRANDS = frozenset({b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"hevm", b"hevs"})
# Generic HEIF (any codec): an HEVC one only when its primary item is (an AVIF has its own brand).
GENERIC_BRANDS = frozenset({b"mif1", b"mif2", b"msf1"})
AVIF_BRANDS = frozenset({b"avif", b"avis", b"avio"})
MAX_FTYP_BYTES = 1024


def sniff(head: bytes) -> str | None:
    """image/heic or image/heif for a HEIF file `filetype` misses or calls something else (AL
    follow-up, docs/ALBUMS.md §23): the brands of its leading `ftyp` box (the major one, or a
    generic major one with an HEVC brand among the compatible ones), else a generic HEIF whose
    `meta` box in `head` names an HEVC primary item. None for anything else (filetype decides)."""
    if len(head) < 16 or head[4:8] != b"ftyp":
        return None
    size = struct.unpack_from(">I", head, 0)[0]
    if size < 16 or size > min(len(head), MAX_FTYP_BYTES) or size % 4:
        return None
    major = head[8:12]
    compatible = {head[at : at + 4] for at in range(16, size, 4)}
    if major in HEVC_BRANDS:
        return "image/heic"
    if major not in GENERIC_BRANDS or compatible & AVIF_BRANDS:
        return None
    if compatible & HEVC_BRANDS:
        return "image/heic"
    return "image/heif" if parse(io.BytesIO(head)) is not None else None


@dataclass(frozen=True)
class HeifInfo:
    """The primary image as stored (`width` x `height`, before the rotation)."""

    width: int
    height: int
    # irot / imir in the order the primary item lists them: ("irot", degrees anticlockwise) or
    # ("imir", axis): axis 0 swaps top and bottom, 1 left and right (as libheif, the Apple
    # frameworks and ffmpeg 8 read it; checked against `sips` and ffmpeg 9 on a file from `sips`).
    transforms: tuple[tuple[str, int], ...]
    grid: bool
    exif: bytes | None  # a TIFF block ("MM\0*..." / "II*\0...")
    icc: bytes | None

    @property
    def upright_size(self) -> tuple[int, int]:
        turns = sum(value for kind, value in self.transforms if kind == "irot")
        return (self.height, self.width) if turns % 180 == 90 else (self.width, self.height)


class _Reader:
    def __init__(self, data: bytes) -> None:
        self.data = data

    def u8(self, at: int) -> int:
        return self.data[at]

    def u16(self, at: int) -> int:
        return int(struct.unpack_from(">H", self.data, at)[0])

    def u32(self, at: int) -> int:
        return int(struct.unpack_from(">I", self.data, at)[0])

    def u64(self, at: int) -> int:
        return int(struct.unpack_from(">Q", self.data, at)[0])

    def uint(self, at: int, size: int) -> int:
        if size == 0:
            return 0
        if size == 4:
            return self.u32(at)
        if size == 8:
            return self.u64(at)
        if size == 2:
            return self.u16(at)
        raise ValueError(f"field size {size}")


def _boxes(data: bytes, start: int, end: int) -> list[tuple[bytes, int, int]]:
    """(type, payload start, payload end) of the boxes between start and end."""
    out: list[tuple[bytes, int, int]] = []
    at = start
    while at + 8 <= end:
        size = struct.unpack_from(">I", data, at)[0]
        kind = data[at + 4 : at + 8]
        head = 8
        if size == 1:
            if at + 16 > end:
                break
            size = struct.unpack_from(">Q", data, at + 8)[0]
            head = 16
        elif size == 0:
            size = end - at
        if size < head or at + size > end:
            break
        out.append((kind, at + head, at + size))
        at += size
    return out


def _children(data: bytes, kind: bytes, start: int, end: int) -> list[tuple[bytes, int, int]]:
    # meta and iinf are full boxes (version and flags first); iinf also holds its entry count.
    if kind == b"meta":
        start += 4
    elif kind == b"iinf":
        start += 4 + (2 if data[start] == 0 else 4)
    return _boxes(data, start, end)


def _meta(head: bytes) -> tuple[bytes, int, int] | None:
    for kind, start, end in _boxes(head, 0, len(head)):
        if kind == b"meta":
            return kind, start, end
    return None


def parse(source: IO[bytes]) -> HeifInfo | None:
    """The primary image's description, or None when the file is not a HEIF still we can read."""
    source.seek(0)
    head = source.read(MAX_META_BYTES)
    try:
        return _parse(head, source)
    except (struct.error, IndexError, ValueError) as exc:
        log.info("unreadable HEIF meta box: %s", exc)
        return None


def _parse(head: bytes, source: IO[bytes]) -> HeifInfo | None:
    meta = _meta(head)
    if meta is None:
        return None
    r = _Reader(head)
    primary: int | None = None
    types: dict[int, bytes] = {}
    properties: list[tuple[bytes, int, int]] = []
    associations: dict[int, list[int]] = {}
    locations: dict[int, tuple[int, list[tuple[int, int]], int]] = {}
    idat: tuple[int, int] | None = None
    refs: list[tuple[bytes, int, list[int]]] = []

    def walk(kind: bytes, start: int, end: int, depth: int) -> None:
        nonlocal primary, idat
        for child, c_start, c_end in _children(head, kind, start, end):
            if child in _CONTAINERS and child != b"dinf":
                if child == b"ipco":
                    properties.extend(_boxes(head, c_start, c_end))
                elif depth < MAX_DEPTH:  # meta > iinf / iprp: a hostile nesting goes no deeper
                    walk(child, c_start, c_end, depth + 1)
            elif child == b"pitm":
                primary = r.u16(c_start + 4) if r.u8(c_start) == 0 else r.u32(c_start + 4)
            elif child == b"infe":
                version = r.u8(c_start)
                if version >= 2:
                    at = c_start + 4
                    item = r.u16(at) if version == 2 else r.u32(at)
                    at += 2 if version == 2 else 4
                    types[item] = head[at + 2 : at + 6]
            elif child == b"ipma":
                version, flags = r.u8(c_start), r.u32(c_start) & 0xFFFFFF
                at = c_start + 4
                count = r.u32(at)
                at += 4
                for _ in range(count):
                    item = r.u16(at) if version < 1 else r.u32(at)
                    at += 2 if version < 1 else 4
                    n = r.u8(at)
                    at += 1
                    indices: list[int] = []
                    for _ in range(n):
                        if flags & 1:
                            indices.append(r.u16(at) & 0x7FFF)
                            at += 2
                        else:
                            indices.append(r.u8(at) & 0x7F)
                            at += 1
                    associations[item] = indices
            elif child == b"iloc":
                locations.update(_iloc(r, c_start))
            elif child == b"idat":
                idat = (c_start, c_end)
            elif child == b"iref":
                version = r.u8(c_start)
                for ref, s, _e in _boxes(head, c_start + 4, c_end):
                    item = r.u16(s) if version == 0 else r.u32(s)
                    at = s + (2 if version == 0 else 4)
                    n = r.u16(at)
                    at += 2
                    targets = []
                    for _ in range(n):
                        targets.append(r.u16(at) if version == 0 else r.u32(at))
                        at += 2 if version == 0 else 4
                    refs.append((ref, item, targets))

    walk(b"meta", meta[1], meta[2], 0)
    if primary is None or types.get(primary) not in (b"hvc1", b"grid"):
        return None  # an AVIF (av01), a JPEG item, a sequence-only file: not ours
    width = height = 0
    transforms: list[tuple[str, int]] = []
    icc: bytes | None = None
    for index in associations.get(primary, []):
        if not 1 <= index <= len(properties):
            continue
        kind, start, end = properties[index - 1]
        if kind == b"ispe":
            width, height = r.u32(start + 4), r.u32(start + 8)
        elif kind == b"irot":
            transforms.append(("irot", (r.u8(start) & 0x3) * 90))
        elif kind == b"imir":
            transforms.append(("imir", r.u8(start) & 0x1))
        elif kind == b"colr" and head[start : start + 4] in (b"prof", b"rICC"):
            if end - start - 4 <= MAX_ICC_BYTES:
                icc = head[start + 4 : end] or None
    if width <= 0 or height <= 0:
        return None
    exif_items = [item for item, kind in types.items() if kind == b"Exif"]
    described = {item for ref, item, targets in refs if ref == b"cdsc" and primary in targets}
    exif: bytes | None = None
    for item in sorted(exif_items, key=lambda i: (i not in described, i)):
        exif = _exif(_item_bytes(head, source, locations.get(item), idat))
        if exif:
            break
    return HeifInfo(
        width=width,
        height=height,
        transforms=tuple(transforms),
        grid=types[primary] == b"grid",
        exif=exif,
        icc=icc,
    )


def _iloc(r: _Reader, start: int) -> dict[int, tuple[int, list[tuple[int, int]], int]]:
    """item → (construction method, [(offset, length)], base offset)."""
    version = r.u8(start)
    at = start + 4
    sizes = r.u16(at)
    at += 2
    offset_size, length_size = sizes >> 12, (sizes >> 8) & 0xF
    base_size = (sizes >> 4) & 0xF
    index_size = sizes & 0xF if version in (1, 2) else 0
    count = r.u16(at) if version < 2 else r.u32(at)
    at += 2 if version < 2 else 4
    out: dict[int, tuple[int, list[tuple[int, int]], int]] = {}
    for _ in range(count):
        item = r.u16(at) if version < 2 else r.u32(at)
        at += 2 if version < 2 else 4
        method = 0
        if version in (1, 2):
            method = r.u16(at) & 0xF
            at += 2
        at += 2  # data_reference_index
        base = r.uint(at, base_size)
        at += base_size
        n = r.u16(at)
        at += 2
        extents: list[tuple[int, int]] = []
        for _ in range(n):
            at += index_size
            offset = r.uint(at, offset_size)
            at += offset_size
            length = r.uint(at, length_size)
            at += length_size
            extents.append((offset, length))
        out[item] = (method, extents, base)
    return out


def _item_bytes(
    head: bytes,
    source: IO[bytes],
    location: tuple[int, list[tuple[int, int]], int] | None,
    idat: tuple[int, int] | None,
) -> bytes | None:
    if location is None:
        return None
    method, extents, base = location
    if sum(length for _, length in extents) > MAX_EXIF_BYTES or any(n == 0 for _, n in extents):
        return None
    parts: list[bytes] = []
    for offset, length in extents:
        if method == 0:
            source.seek(base + offset)
            parts.append(source.read(length))
        elif method == 1 and idat is not None:
            start = idat[0] + base + offset
            if start + length > idat[1]:
                return None
            parts.append(head[start : start + length])
        else:
            return None
    return b"".join(parts)


def _exif(item: bytes | None) -> bytes | None:
    """The TIFF block of an Exif item (a 4-byte offset to the TIFF header comes first)."""
    if item is None or len(item) < 8:
        return None
    start = 4 + struct.unpack_from(">I", item, 0)[0]
    tiff = item[start:]
    return tiff if tiff[:4] in (b"MM\x00*", b"II*\x00") else None


def read_exif(info: HeifInfo) -> Image.Exif | None:
    if info.exif is None:
        return None
    exif = Image.Exif()
    try:
        exif.load(info.exif)
    except Exception:  # a broken block: as if absent
        return None
    return exif


# --- decoding (ffmpeg) ----------------------------------------------------------------------------


@dataclass(frozen=True)
class _Tiles:
    streams: list[tuple[int, int, int]]  # (stream index, x, y)
    crop: tuple[int, int, int, int]  # (width, height, x, y) of the output in the joined tiles


def parse_groups(raw: bytes | None) -> _Tiles | int | None:
    """From `ffprobe -show_stream_groups -show_streams`: the tile grid, else the index of the one
    image stream to decode (the primary item: ffmpeg marks it `default`), else None."""
    try:
        return _layout(json.loads(raw) if raw else None)
    except (ValueError, TypeError, KeyError):
        return None


def _layout(data: object) -> _Tiles | int | None:
    if not isinstance(data, dict):
        return None
    for group in data.get("stream_groups") or []:
        if not isinstance(group, dict) or group.get("type") != "Tile Grid":
            continue
        components = group.get("components") or []
        grid = components[0] if components and isinstance(components[0], dict) else None
        if grid is None:
            continue
        tiles: list[tuple[int, int, int]] = []
        for sub in grid.get("subcomponents") or []:
            if isinstance(sub, dict):
                tiles.append(
                    (
                        int(sub["stream_index"]),
                        int(sub["tile_horizontal_offset"]),
                        int(sub["tile_vertical_offset"]),
                    )
                )
        if not tiles or len(tiles) > MAX_TILES:
            return None
        crop = (
            int(grid["width"]),
            int(grid["height"]),
            int(grid.get("horizontal_offset") or 0),
            int(grid.get("vertical_offset") or 0),
        )
        return _Tiles(streams=tiles, crop=crop)
    streams = [s for s in data.get("streams") or [] if isinstance(s, dict)]
    video = [s for s in streams if s.get("codec_type") == "video"]
    for stream in video:
        if (stream.get("disposition") or {}).get("default") == 1:
            return int(stream["index"])
    return int(video[0]["index"]) if len(video) == 1 else None


def _orient(info: HeifInfo) -> list[str]:
    """Filters that show the image as its irot / imir say, in the order the file lists them."""
    steps: list[str] = []
    for kind, value in info.transforms:
        if kind == "irot" and value == 90:  # anticlockwise
            steps.append("transpose=2")
        elif kind == "irot" and value == 180:
            steps.append("hflip,vflip")
        elif kind == "irot" and value == 270:
            steps.append("transpose=1")
        elif kind == "imir":
            steps.append("vflip" if value == 0 else "hflip")
    return steps


def decode_argv(
    ffmpeg: str, path: str, info: HeifInfo, layout: _Tiles | int, max_px: int
) -> list[str]:
    scale = f"scale=w='min({max_px},iw)':h='min({max_px},ih)':force_original_aspect_ratio=decrease"
    tail = ",".join([*_orient(info), scale, "format=rgb24"])
    if isinstance(layout, _Tiles):
        inputs = "".join(f"[0:{index}]" for index, _, _ in layout.streams)
        width, height, x, y = layout.crop
        if len(layout.streams) == 1:
            joined = f"{inputs}crop={width}:{height}:{x}:{y}"
        else:
            places = "|".join(f"{tx}_{ty}" for _, tx, ty in layout.streams)
            joined = (
                f"{inputs}xstack=inputs={len(layout.streams)}:layout={places},"
                f"crop={width}:{height}:{x}:{y}"
            )
        graph = ["-filter_complex", f"{joined},{tail}[out]", "-map", "[out]"]
    else:
        graph = ["-map", f"0:{layout}", "-vf", tail]
    return [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-threads",
        "2",
        *INPUT_OPTIONS,
        # The turn is ours (_orient): never also one that a later ffmpeg reads from the file.
        "-noautorotate",
        "-i",
        f"file:{path}",
        *graph,
        "-frames:v",
        "1",
        "-an",
        "-sn",
        "-dn",
        "-f",
        "image2pipe",
        "-c:v",
        "png",
        "pipe:1",
    ]


async def decode(
    path: str, info: HeifInfo, settings: Settings, max_px: int = DECODE_PX
) -> Image.Image | None:
    """The upright image (a loaded RGB Pillow image, long edge at most max_px, the file's ICC
    profile in its info); None when the tools are off or ffmpeg cannot read the file. The caller
    has checked the pixel count."""
    found = videos.tools(settings)
    if found is None:
        return None
    ffprobe, ffmpeg = found
    timeout = settings.video_probe_timeout_seconds
    async with videos.semaphore(settings.video_probe_max_concurrent):
        raw = await videos.run_bounded(
            [
                ffprobe,
                "-v",
                "error",
                *INPUT_OPTIONS,
                "-show_stream_groups",
                "-show_entries",
                "stream=index,codec_type:stream_disposition=default",
                "-of",
                "json",
                f"file:{path}",
            ],
            timeout,
            MAX_PROBE_OUTPUT,
        )
        layout = parse_groups(raw)
        if layout is None:
            return None
        png = await videos.run_bounded(
            decode_argv(ffmpeg, path, info, layout, max_px), timeout, MAX_DECODED_OUTPUT
        )
    if not png:
        return None
    image = await run_in_threadpool(_load_png, png, max_px)
    if image is not None and info.icc:
        image.info["icc_profile"] = info.icc
    return image


def _load_png(png: bytes, max_px: int) -> Image.Image | None:
    try:
        with Image.open(io.BytesIO(png)) as opened:
            if opened.format != "PNG" or max(opened.size) > max_px:
                return None
            opened.load()
            return opened.copy()
    except Exception as exc:  # not the PNG we asked for
        log.info("decoded HEIF unreadable: %s", exc)
        return None


@dataclass(frozen=True)
class HeifRead:
    meta: PhotoMeta
    # (JPEG, upright width, upright height of the full image), as images.make_thumbnail.
    thumbnail: tuple[bytes, int, int] | None
    display: DisplayImage | None


NOTHING = HeifRead(meta=PhotoMeta(taken=None, has_location=False), thumbnail=None, display=None)


def _parse_file(path: str) -> HeifInfo | None:
    with open(path, "rb") as source:
        return parse(source)


def _render(image: Image.Image, thumb_px: int, display: bool) -> tuple[DisplayImage | None, bytes]:
    shown = make_display(image) if display else None
    return shown, thumbnail_jpeg(image, thumb_px)  # last: it scales the image in place


async def read(
    path: str, settings: Settings, zone: tzinfo, *, now: datetime, display: bool = True
) -> HeifRead | None:
    """A HEIC / HEIF at `path` (a local file): its capture time and location mark (EXIF), its
    thumbnail with the full upright size, and (`display`) its display-size WebP. None when
    ffmpeg is off or missing (nothing was tried: the drive leaves the file for later, as a video).
    Past the pixel limit, or a file ffmpeg cannot read: the metadata alone."""
    if videos.tools(settings) is None:
        return None
    info = await run_in_threadpool(_parse_file, path)
    if info is None:
        return NOTHING
    meta = read_exif_meta(read_exif(info), zone, now=now)
    if info.width * info.height > MAX_PIXELS:
        return HeifRead(meta=meta, thumbnail=None, display=None)
    image = await decode(path, info, settings)
    if image is None:
        return HeifRead(meta=meta, thumbnail=None, display=None)
    shown, thumb = await run_in_threadpool(
        _render, image, settings.attachment_thumbnail_px, display
    )
    width, height = info.upright_size
    return HeifRead(meta=meta, thumbnail=(thumb, width, height), display=shown)
