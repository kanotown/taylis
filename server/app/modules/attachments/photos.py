"""What a photo or a video says about itself, and an image's display-size copy (AL1,
docs/ALBUMS.md §4.2, §6; SECURITY.md §4).

- **The capture time**: EXIF DateTimeOriginal (else DateTimeDigitized, else DateTime) with its
  OffsetTimeOriginal (else OffsetTime); without an offset the time is read in the workspace's zone
  and marked `local`. A video's QuickTime creationdate (which carries the phone's zone), else its
  creation_time (UTC). Times before 1970 or later than a day from now are dropped (a camera without
  a clock, a broken tag). It orders and labels an album; nothing else trusts it.
- **A location**: whether the original holds one (GPS latitude / longitude, a video's ISO 6709
  `location` tag). The value itself is never read further or kept.
- **The display size**: the upright image (EXIF orientation applied) scaled so that its long edge
  is at most DISPLAY_PX, as WebP (quality 80) drawn into a fresh image: no EXIF, no XMP, no GPS
  (the ICC colour profile is kept so that a wide-gamut photo keeps its colours). The pixel limit is
  the thumbnail's (images.MAX_PIXELS); an animated image gets none (its first frame alone would
  stand for it in the viewer).

Everything here is header parsing and Pillow; it runs in a thread pool (CPU bound).
"""

import io
import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, timezone, tzinfo
from typing import IO, Any

from PIL import ExifTags, Image, ImageOps

from app.modules.attachments.images import open_checked

DISPLAY_PX = 2048
DISPLAY_QUALITY = 80
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
# How far past now a capture time may be (a phone's clock a little ahead, a zone mistaken).
FUTURE_SLACK = timedelta(days=1)

_EXIF_DATETIME = re.compile(r"^\s*(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})")
_OFFSET = re.compile(r"^\s*([+-])(\d{2}):?(\d{2})\s*$")
# GPSInfo tags that hold a position (a GPS IFD with only its version or a time is no location).
_GPS_POSITION_TAGS = (1, 2, 3, 4)  # GPSLatitudeRef, GPSLatitude, GPSLongitudeRef, GPSLongitude
_ISO6709 = re.compile(r"^[+-]\d+(\.\d+)?[+-]\d+(\.\d+)?")


@dataclass(frozen=True)
class CaptureTime:
    at: datetime
    # True: the file gave no zone; `at` was read in the workspace's.
    local: bool


@dataclass(frozen=True)
class PhotoMeta:
    taken: CaptureTime | None
    has_location: bool


@dataclass(frozen=True)
class DisplayImage:
    data: bytes
    width: int
    height: int


def _bounded(at: datetime, now: datetime) -> datetime | None:
    if at <= EPOCH or at > now + FUTURE_SLACK:
        return None
    return at


def _text(value: Any) -> str | None:
    if isinstance(value, bytes):
        value = value.decode("ascii", errors="ignore")
    if not isinstance(value, str):
        return None
    return value.replace("\x00", "").strip() or None


def parse_offset(value: Any) -> tzinfo | None:
    """'+09:00' (or '+0900') as a fixed zone; None for anything else."""
    raw = _text(value)
    match = _OFFSET.match(raw) if raw else None
    if match is None:
        return None
    sign, hours, minutes = match.groups()
    if int(hours) > 14 or int(minutes) > 59:
        return None
    delta = timedelta(hours=int(hours), minutes=int(minutes))
    return timezone(-delta if sign == "-" else delta)


def parse_exif_datetime(
    value: Any, offset: Any, zone: tzinfo, *, now: datetime
) -> CaptureTime | None:
    """An EXIF 'YYYY:MM:DD HH:MM:SS' with its offset tag (or the workspace's zone)."""
    raw = _text(value)
    match = _EXIF_DATETIME.match(raw) if raw else None
    if match is None:
        return None
    try:
        year, month, day, hour, minute, second = (int(part) for part in match.groups())
        naive = datetime(year, month, day, hour, minute, second)
    except ValueError:  # 0000:00:00 00:00:00, a 13th month
        return None
    fixed = parse_offset(offset)
    at = naive.replace(tzinfo=fixed or zone)
    if fixed is None:
        # The wall time in the zone (ZoneInfo folds; a fixed zone does not).
        at = at.astimezone(UTC).astimezone(zone)
    bounded = _bounded(at, now)
    return CaptureTime(at=bounded, local=fixed is None) if bounded else None


def _exif_ifd(exif: Image.Exif, which: ExifTags.IFD) -> dict[int, Any]:
    try:
        found = exif.get_ifd(which)
    except Exception:  # a broken pointer: as if absent
        return {}
    return dict(found) if found else {}


def read_image_meta(image: Image.Image, zone: tzinfo, *, now: datetime) -> PhotoMeta:
    """From an opened image's header (no pixel is decoded). A broken EXIF block reads as none."""
    try:
        exif = image.getexif()
    except Exception:
        return PhotoMeta(taken=None, has_location=False)
    return read_exif_meta(exif, zone, now=now)


def read_exif_meta(exif: Image.Exif | None, zone: tzinfo, *, now: datetime) -> PhotoMeta:
    """The capture time and the location mark of an EXIF block (an image's, or a HEIF's Exif
    item: heif.py)."""
    if exif is None:
        return PhotoMeta(taken=None, has_location=False)
    sub = _exif_ifd(exif, ExifTags.IFD.Exif)
    gps = _exif_ifd(exif, ExifTags.IFD.GPSInfo)
    candidates = (
        (sub.get(ExifTags.Base.DateTimeOriginal), sub.get(ExifTags.Base.OffsetTimeOriginal)),
        (sub.get(ExifTags.Base.DateTimeDigitized), sub.get(ExifTags.Base.OffsetTimeDigitized)),
        (exif.get(ExifTags.Base.DateTime), sub.get(ExifTags.Base.OffsetTime)),
    )
    taken: CaptureTime | None = None
    for value, offset in candidates:
        taken = parse_exif_datetime(value, offset, zone, now=now)
        if taken is not None:
            break
    has_location = any(gps.get(tag) not in (None, b"", "", ()) for tag in _GPS_POSITION_TAGS)
    return PhotoMeta(taken=taken, has_location=has_location)


def make_display(image: Image.Image, max_px: int = DISPLAY_PX) -> DisplayImage | None:
    """The display-size WebP of an opened (pixel-count checked) image; None for an animated one."""
    if getattr(image, "is_animated", False) and getattr(image, "n_frames", 1) > 1:
        return None
    icc = image.info.get("icc_profile")
    upright = ImageOps.exif_transpose(image) or image
    if max(upright.size) > max_px:
        upright.thumbnail((max_px, max_px), Image.Resampling.LANCZOS)
    has_alpha = upright.mode in ("RGBA", "LA", "PA") or (
        upright.mode == "P" and "transparency" in upright.info
    )
    mode = "RGBA" if has_alpha else "RGB"
    converted = upright.convert(mode)
    # A fresh image: nothing of the original's info (EXIF, XMP, comments) comes along.
    clean = Image.new(mode, converted.size)
    clean.paste(converted)
    out = io.BytesIO()
    options: dict[str, Any] = {"quality": DISPLAY_QUALITY, "method": 4}
    if isinstance(icc, bytes) and icc:
        options["icc_profile"] = icc
    clean.save(out, format="WEBP", **options)
    return DisplayImage(data=out.getvalue(), width=clean.width, height=clean.height)


def read_image(
    source: IO[bytes] | bytes, zone: tzinfo, *, now: datetime, display: bool = True
) -> tuple[PhotoMeta, DisplayImage | None]:
    """The metadata and (`display`) the display-size copy. images.ImageTooLarge past the pixel
    limit (the metadata is then read by `read_image_meta_only`)."""
    with open_checked(source) as image:
        meta = read_image_meta(image, zone, now=now)
        shown = make_display(image) if display else None
    return meta, shown


def read_image_meta_only(source: IO[bytes] | bytes, zone: tzinfo, *, now: datetime) -> PhotoMeta:
    """The metadata of an image of any size (Image.open reads the header only)."""
    with Image.open(io.BytesIO(source) if isinstance(source, bytes) else source) as image:
        return read_image_meta(image, zone, now=now)


# --- videos (ffprobe's format and stream tags) ----------------------------------------------------


def _iso(value: Any) -> datetime | None:
    raw = _text(value)
    if raw is None:
        return None
    # Some muxers repeat a tag: "2026-09-16T09:12:00.000000Z;2026-09-16T09:12:00Z".
    raw = raw.split(";", 1)[0].strip()
    try:
        at = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return at if at.tzinfo is not None else at.replace(tzinfo=UTC)


def parse_video_meta(raw: bytes | None, *, now: datetime) -> PhotoMeta:
    """From `ffprobe -of json` with format_tags / stream_tags: the QuickTime creationdate (local
    time with its zone) else creation_time (UTC); a location tag."""
    try:
        data = json.loads(raw) if raw else None
    except ValueError:
        data = None
    if not isinstance(data, dict):
        return PhotoMeta(taken=None, has_location=False)
    tags: dict[str, Any] = {}
    streams = data.get("streams")
    if isinstance(streams, list) and streams and isinstance(streams[0], dict):
        stream_tags = streams[0].get("tags")
        if isinstance(stream_tags, dict):
            tags.update({str(k).lower(): v for k, v in stream_tags.items()})
    fmt = data.get("format")
    if isinstance(fmt, dict) and isinstance(fmt.get("tags"), dict):
        tags.update({str(k).lower(): v for k, v in fmt["tags"].items()})
    taken: CaptureTime | None = None
    for key in ("com.apple.quicktime.creationdate", "creation_time"):
        at = _iso(tags.get(key))
        bounded = _bounded(at, now) if at is not None else None
        if bounded is not None:
            taken = CaptureTime(at=bounded, local=False)
            break
    has_location = False
    for key in ("location", "com.apple.quicktime.location.iso6709", "location-eng"):
        value = _text(tags.get(key))
        if value and _ISO6709.match(value):
            has_location = True
            break
    return PhotoMeta(taken=taken, has_location=has_location)
