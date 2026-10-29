"""AL1 (M180, docs/ALBUMS.md): photo albums on drive folders.

What a photo says about itself (EXIF capture time with and without its offset, the eight
orientations, the location mark, broken and absurd values; a video's tags), the display-size
image (its size, no metadata, the pixel limit, animated images), the media loop and the
`drive-photos` backfill (bounded, resumable, the lazy path of /display), albums made, changed and
unmade in each kind of location with its readers and writers (guests too), the order by capture
time (missing dates, both directions, the cursor), the card (counts, dates, four thumbnails, the
cover), adding a conversation's photos (moved within the album's channel drive with the message
unchanged, copied elsewhere, idempotent), external links that keep the originals (403, the
display-size ZIP without metadata) or hand them out, the trash and moves, the search, the quota
(display images not counted) and the GC's derived keys.

No test depends on today's date: every capture time is fixed in the past, and the parser's "now"
is passed in where the future matters.
"""

import io
import uuid
import zipfile
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient, Response
from PIL import ExifTags, Image
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.attachments import photos, videos
from app.modules.attachments import service as attachments
from app.modules.attachments.images import ImageTooLarge
from app.modules.attachments.models import Attachment
from app.modules.audit.models import AuditLog
from app.modules.drive import media
from app.modules.drive import photos as drive_photos
from app.modules.drive.models import DriveAlbum, DriveFileVersion, DriveItem, DriveLocation
from app.modules.users.models import User
from tests.drive_helpers import (
    act_as,
    complete,
    drive_settings,
    folder,
    location,
    send_parts,
    workspace_root,
)
from tests.helpers import make_user

API = "/api/v1"
TOKYO = ZoneInfo("Asia/Tokyo")
# The parser's "now" in the unit tests (the integration tests use photos from 2026-09).
NOW = datetime(2026, 10, 1, tzinfo=UTC)


@pytest.fixture
def as_user(app: FastAPI) -> Callable[[User], None]:
    return act_as(app)


# --- photos made for the tests -------------------------------------------------------------------


def jpeg(
    size: tuple[int, int] = (300, 200),
    *,
    original: str | None = None,
    offset: str | None = None,
    plain_datetime: str | None = None,
    orientation: int | None = None,
    gps: bool = False,
    gps_version_only: bool = False,
    color: tuple[int, int, int] = (200, 80, 40),
    xmp: bool = True,
) -> bytes:
    """A JPEG with the EXIF asked for (and an XMP packet, to see it go)."""
    image = Image.new("RGB", size, color)
    exif = Image.Exif()
    if orientation is not None:
        exif[ExifTags.Base.Orientation] = orientation
    if plain_datetime is not None:
        exif[ExifTags.Base.DateTime] = plain_datetime
    sub = exif.get_ifd(ExifTags.IFD.Exif)
    if original is not None:
        sub[ExifTags.Base.DateTimeOriginal] = original
    if offset is not None:
        sub[ExifTags.Base.OffsetTimeOriginal] = offset
    if gps or gps_version_only:
        info = exif.get_ifd(ExifTags.IFD.GPSInfo)
        info[0] = b"\x02\x02\x00\x00"
        if gps:
            info[1], info[2] = "N", (35.0, 40.0, 12.5)
            info[3], info[4] = "E", (139.0, 46.0, 1.0)
    out = io.BytesIO()
    options: dict[str, Any] = {"exif": exif, "quality": 90}
    if xmp:
        options["xmp"] = b'<x:xmpmeta xmlns:x="adobe:ns:meta/">where-we-were</x:xmpmeta>'
    image.save(out, format="JPEG", **options)
    return out.getvalue()


def opened(data: bytes) -> Image.Image:
    return Image.open(io.BytesIO(data))


def no_metadata(data: bytes) -> None:
    image = opened(data)
    assert image.format == "WEBP"
    assert dict(image.getexif()) == {}
    assert "exif" not in image.info and "xmp" not in image.info
    assert b"where-we-were" not in data and b"Exif" not in data


# --- the capture time ----------------------------------------------------------------------------


def test_exif_datetime_with_and_without_its_offset() -> None:
    plus = photos.parse_exif_datetime("2026:09:16 09:12:00", "+09:00", TOKYO, now=NOW)
    assert plus is not None and not plus.local
    assert plus.at.astimezone(UTC) == datetime(2026, 9, 16, 0, 12, tzinfo=UTC)
    minus = photos.parse_exif_datetime("2026:09:16 09:12:00", "-05:30", TOKYO, now=NOW)
    assert minus is not None and minus.at.astimezone(UTC) == datetime(
        2026, 9, 16, 14, 42, tzinfo=UTC
    )
    compact = photos.parse_exif_datetime("2026:09:16 09:12:00", "+0900", TOKYO, now=NOW)
    assert compact is not None and compact.at == plus.at
    # No offset: the workspace's zone, marked local.
    local = photos.parse_exif_datetime("2026:09:16 09:12:00\x00", None, TOKYO, now=NOW)
    assert local is not None and local.local
    assert local.at.astimezone(UTC) == datetime(2026, 9, 16, 0, 12, tzinfo=UTC)
    other_zone = photos.parse_exif_datetime(
        "2026:09:16 09:12:00", None, ZoneInfo("Europe/Berlin"), now=NOW
    )
    assert other_zone is not None
    assert other_zone.at.astimezone(UTC) == datetime(2026, 9, 16, 7, 12, tzinfo=UTC)
    # A broken offset is no offset.
    weird = photos.parse_exif_datetime("2026:09:16 09:12:00", "JST", TOKYO, now=NOW)
    assert weird is not None and weird.local


@pytest.mark.parametrize(
    "value",
    [
        None,
        "",
        "0000:00:00 00:00:00",
        "2026:13:01 00:00:00",
        "yesterday",
        b"\xff\xfe",
        12345,
        "1969:12:31 23:59:59",  # before 1970
        "1970:01:01 09:00:00",  # the epoch itself (a clock never set), in Tokyo
        "2026:10:03 00:00:00",  # more than a day after "now"
    ],
)
def test_exif_datetime_refuses_nonsense(value: Any) -> None:
    assert photos.parse_exif_datetime(value, None, TOKYO, now=NOW) is None


def test_exif_datetime_allows_a_clock_a_little_ahead() -> None:
    soon = photos.parse_exif_datetime("2026:10:01 20:00:00", "+00:00", TOKYO, now=NOW)
    assert soon is not None


def test_image_meta_reads_original_then_falls_back_and_marks_gps() -> None:
    with opened(jpeg(original="2026:09:16 09:12:00", offset="+09:00", gps=True)) as image:
        meta = photos.read_image_meta(image, TOKYO, now=NOW)
    assert meta.taken is not None and not meta.taken.local
    assert meta.taken.at.astimezone(UTC) == datetime(2026, 9, 16, 0, 12, tzinfo=UTC)
    assert meta.has_location
    # Only the base IFD's DateTime (an edited file): used, read as local time.
    with opened(jpeg(plain_datetime="2026:09:17 18:00:00")) as image:
        meta = photos.read_image_meta(image, TOKYO, now=NOW)
    assert meta.taken is not None and meta.taken.local
    assert meta.taken.at == datetime(2026, 9, 17, 18, 0, tzinfo=TOKYO)
    assert not meta.has_location
    # A GPS IFD with its version only is no location.
    with opened(jpeg(gps_version_only=True)) as image:
        assert photos.read_image_meta(image, TOKYO, now=NOW) == photos.PhotoMeta(None, False)
    # No EXIF at all.
    with opened(jpeg()) as image:
        assert photos.read_image_meta(image, TOKYO, now=NOW) == photos.PhotoMeta(None, False)


def test_broken_exif_reads_as_none() -> None:
    clean = jpeg(xmp=False)
    # An APP1 "Exif" segment of garbage right after SOI.
    garbage = b"Exif\x00\x00II*\x00\xff\xff\xff\x7f" + b"\x00" * 20
    segment = b"\xff\xe1" + (len(garbage) + 2).to_bytes(2, "big") + garbage
    broken = clean[:2] + segment + clean[2:]
    with opened(broken) as image:
        meta = photos.read_image_meta(image, TOKYO, now=NOW)
    assert meta.taken is None and not meta.has_location
    meta, display = photos.read_image(broken, TOKYO, now=NOW)
    assert display is not None and (display.width, display.height) == (300, 200)


# --- the display image ---------------------------------------------------------------------------


@pytest.mark.parametrize("orientation", [1, 2, 3, 4, 5, 6, 7, 8])
def test_display_applies_each_orientation(orientation: int) -> None:
    data = jpeg((300, 200), orientation=orientation)
    _, display = photos.read_image(data, TOKYO, now=NOW)
    assert display is not None
    upright = (200, 300) if orientation in (5, 6, 7, 8) else (300, 200)
    assert (display.width, display.height) == upright
    assert opened(display.data).size == upright
    no_metadata(display.data)


def test_display_scales_the_long_edge_and_strips_metadata() -> None:
    data = jpeg((3000, 1500), original="2026:09:16 09:12:00", offset="+09:00", gps=True)
    meta, display = photos.read_image(data, TOKYO, now=NOW)
    assert meta.has_location and meta.taken is not None
    assert display is not None and (display.width, display.height) == (2048, 1024)
    no_metadata(display.data)
    # A rotated tall photo: the long edge is its height after the orientation.
    _, tall = photos.read_image(jpeg((3000, 1500), orientation=6), TOKYO, now=NOW)
    assert tall is not None and (tall.width, tall.height) == (1024, 2048)


def test_display_of_small_transparent_and_animated_images() -> None:
    small = jpeg((640, 480))
    _, display = photos.read_image(small, TOKYO, now=NOW)
    assert display is not None and (display.width, display.height) == (640, 480)
    png = io.BytesIO()
    Image.new("RGBA", (64, 32), (0, 0, 255, 100)).save(png, format="PNG")
    _, clear = photos.read_image(png.getvalue(), TOKYO, now=NOW)
    assert clear is not None and opened(clear.data).mode == "RGBA"
    gif = io.BytesIO()
    frames = [Image.new("RGB", (20, 20), (i * 80, 0, 255 - i * 80)) for i in range(3)]
    frames[0].save(gif, format="GIF", save_all=True, append_images=frames[1:], duration=50)
    _, animated = photos.read_image(gif.getvalue(), TOKYO, now=NOW)
    assert animated is None


def alpha_at(image: Image.Image, xy: tuple[int, int]) -> int:
    pixel = image.getpixel(xy)
    assert isinstance(pixel, tuple)
    return int(pixel[3])


def test_display_keeps_transparency_for_the_viewers_checkerboard() -> None:
    """The viewers draw squares behind a picture with alpha (PREVIEWS.md §15): the WebP keeps it."""
    rgba = io.BytesIO()
    picture = Image.new("RGBA", (40, 20), (255, 0, 0, 255))
    picture.paste((0, 0, 0, 0), (0, 0, 20, 20))  # the left half fully transparent
    picture.save(rgba, format="PNG")
    _, shown = photos.read_image(rgba.getvalue(), TOKYO, now=NOW)
    assert shown is not None
    decoded = opened(shown.data)
    assert decoded.mode == "RGBA"
    assert alpha_at(decoded, (5, 10)) == 0 and alpha_at(decoded, (35, 10)) == 255
    # A palette PNG with a transparent index, and a grey one with alpha.
    palette = Image.new("P", (16, 16), 1)
    palette.putpalette([0, 0, 0, 255, 255, 255] + [0] * 762)
    palette.paste(0, (0, 0, 8, 16))
    indexed = io.BytesIO()
    palette.save(indexed, format="PNG", transparency=0)
    _, shown = photos.read_image(indexed.getvalue(), TOKYO, now=NOW)
    assert shown is not None and alpha_at(opened(shown.data), (2, 2)) == 0
    grey = io.BytesIO()
    Image.new("LA", (16, 16), (128, 0)).save(grey, format="PNG")
    _, shown = photos.read_image(grey.getvalue(), TOKYO, now=NOW)
    assert shown is not None and alpha_at(opened(shown.data), (2, 2)) == 0
    # An opaque PNG stays without alpha (the viewers keep the black).
    plain = io.BytesIO()
    Image.new("RGB", (16, 16), (0, 128, 0)).save(plain, format="PNG")
    _, shown = photos.read_image(plain.getvalue(), TOKYO, now=NOW)
    assert shown is not None and opened(shown.data).mode == "RGB"


def test_display_refuses_past_the_pixel_limit_but_reads_the_metadata() -> None:
    huge = io.BytesIO()
    image = Image.new("L", (8000, 7000), 128)
    exif = Image.Exif()
    exif.get_ifd(ExifTags.IFD.Exif)[ExifTags.Base.DateTimeOriginal] = "2026:09:16 09:12:00"
    image.save(huge, format="JPEG", exif=exif, quality=10)
    del image
    with pytest.raises(ImageTooLarge):
        photos.read_image(huge.getvalue(), TOKYO, now=NOW)
    meta = photos.read_image_meta_only(huge.getvalue(), TOKYO, now=NOW)
    assert meta.taken is not None and meta.taken.local


# --- a video's tags ------------------------------------------------------------------------------


def test_video_meta_prefers_the_quicktime_date_and_sees_a_location() -> None:
    raw = (
        b'{"streams": [{"tags": {"creation_time": "2026-09-16T00:00:00.000000Z"}}],'
        b' "format": {"tags": {"com.apple.quicktime.creationdate": "2026-09-16T18:12:00+0900",'
        b' "creation_time": "2026-09-16T09:12:00.000000Z;2026-09-16T09:12:00Z",'
        b' "com.apple.quicktime.location.ISO6709": "+35.6812+139.7671+040.000/"}}}'
    )
    meta = photos.parse_video_meta(raw, now=NOW)
    assert meta.taken is not None and meta.taken.at == datetime(2026, 9, 16, 9, 12, tzinfo=UTC)
    assert meta.has_location
    plain = photos.parse_video_meta(
        b'{"format": {"tags": {"creation_time": "2026-09-16T09:12:00.000000Z;x",'
        b' "location": "nowhere"}}}',
        now=NOW,
    )
    assert plain.taken is not None and plain.taken.at == datetime(2026, 9, 16, 9, 12, tzinfo=UTC)
    assert not plain.has_location
    zero = photos.parse_video_meta(
        b'{"format": {"tags": {"creation_time": "1970-01-01T00:00:00.000000Z"}}}', now=NOW
    )
    assert zero == photos.PhotoMeta(None, False)
    assert photos.parse_video_meta(b"not json", now=NOW) == photos.PhotoMeta(None, False)
    assert photos.parse_video_meta(None, now=NOW) == photos.PhotoMeta(None, False)


# --- helpers for the API -------------------------------------------------------------------------


async def upload_photo(
    client: AsyncClient,
    parent_id: str,
    name: str,
    data: bytes,
    *,
    modified: datetime | None = None,
    on_conflict: str = "rename",
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "client_upload_id": str(uuid.uuid4()),
        "parent_id": parent_id,
        "name": name,
        "size_bytes": len(data),
        "on_conflict": on_conflict,
    }
    if modified is not None:
        body["content_modified_ms"] = int(modified.timestamp() * 1000)
    started = await client.post(f"{API}/drive/uploads", json=body)
    assert started.status_code == 201, started.text
    session = started.json()
    await send_parts(client, session, data)
    done = await complete(client, session["id"])
    assert done.status_code == 200, done.text
    item: dict[str, Any] = done.json()["item"]
    return item


async def run_media(app: FastAPI) -> int:
    done = 0
    while await media.process_due(
        app.state.db.session_factory, app.state.settings, app.state.blobs
    ):
        done += 1
    return done


async def make_album(client: AsyncClient, **body: Any) -> Response:
    return await client.post(f"{API}/drive/albums", json=body)


async def album_in(client: AsyncClient, parent_id: str, name: str, **body: Any) -> dict[str, Any]:
    made = await make_album(client, parent_id=parent_id, name=name, **body)
    assert made.status_code == 201, made.text
    out: dict[str, Any] = made.json()
    return out


async def item(client: AsyncClient, item_id: str) -> dict[str, Any]:
    got = await client.get(f"{API}/drive/items/{item_id}")
    assert got.status_code == 200, got.text
    out: dict[str, Any] = got.json()["item"]
    return out


async def detail(client: AsyncClient, folder_id: str, **params: Any) -> dict[str, Any]:
    got = await client.get(f"{API}/drive/albums/{folder_id}", params=params)
    assert got.status_code == 200, got.text
    out: dict[str, Any] = got.json()
    return out


async def changed_events(db: AsyncSession) -> list[dict[str, Any]]:
    rows = (
        await db.execute(
            select(OutboxEvent)
            .where(OutboxEvent.event_type == "drive.changed")
            .order_by(OutboxEvent.id)
        )
    ).scalars()
    return [dict(row.payload) for row in rows]


def code(response: Response) -> str:
    return str(response.json()["error"]["code"])


async def fresh(app: FastAPI, model: Any, key: Any) -> Any:
    async with app.state.db.session_factory() as session:
        return await session.get(model, key)


async def make_channel(
    client: AsyncClient, name: str, members: list[User], kind: str = "public"
) -> dict[str, Any]:
    made = await client.post(f"{API}/channels", json={"name": name, "type": kind})
    assert made.status_code == 201, made.text
    channel: dict[str, Any] = made.json()
    for person in members:
        added = await client.post(
            f"{API}/channels/{channel['id']}/members", json={"user_id": str(person.id)}
        )
        assert added.status_code == 200, added.text
    return channel


async def post_photo(
    client: AsyncClient, channel_id: str, name: str, data: bytes
) -> dict[str, Any]:
    uploaded = await client.post(
        f"{API}/attachments", files={"file": (name, data, "application/octet-stream")}
    )
    assert uploaded.status_code == 201, uploaded.text
    sent = await client.post(
        f"{API}/channels/{channel_id}/messages",
        json={
            "client_msg_id": str(uuid.uuid4()),
            "body": "photos",
            "attachment_ids": [uploaded.json()["id"]],
        },
    )
    assert sent.status_code in (200, 201), sent.text
    message: dict[str, Any] = sent.json()
    return message


# --- the media loop ------------------------------------------------------------------------------


async def test_media_loop_reads_the_photo_and_makes_its_display_image(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    as_user(await make_user(db, "aiko"))
    root = await workspace_root(client)
    data = jpeg((3000, 2000), original="2026:09:16 09:12:00", offset="+09:00", gps=True)
    photo = await upload_photo(client, root, "IMG_0001.jpg", data)
    assert photo["file"]["taken_at"] is None and photo["file"]["has_display"] is False
    assert await run_media(app) == 1
    shown = (await item(client, photo["id"]))["file"]
    assert shown["taken_at"].startswith("2026-09-16T00:12:00")
    assert shown["has_location"] is True and shown["has_display"] is True
    assert (shown["display_width"], shown["display_height"]) == (2048, 1365)
    row = await fresh(app, DriveItem, uuid.UUID(photo["id"]))
    assert row.taken_at == datetime(2026, 9, 16, 0, 12, tzinfo=UTC)
    attachment = await fresh(app, Attachment, uuid.UUID(shown["attachment_id"]))
    assert attachment.taken_at_local is False and attachment.photo_probed_at is not None
    assert attachment.display_key == attachments.display_key(attachment.id)

    got = await client.get(f"{API}/attachments/{shown['attachment_id']}/display")
    assert got.status_code == 200
    assert got.headers["content-type"] == "image/webp"
    assert got.headers["cache-control"] == "private, max-age=86400"
    assert got.headers["x-content-type-options"] == "nosniff"
    assert opened(got.content).size == (2048, 1365)
    assert len(got.content) == attachment.display_bytes
    no_metadata(got.content)
    # The original keeps its EXIF and GPS inside the lab.
    original = await client.get(f"{API}/drive/items/{photo['id']}/content")
    assert original.content == data
    # The quota counts the original only (the display image is a derived object).
    workspace = (
        await db.execute(
            select(DriveLocation)
            .where(DriveLocation.kind == "workspace")
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert workspace.used_bytes == len(data)
    # The GC's and verify-attachments' derived keys include it.
    assert attachment.display_key in attachments._derived_keys(attachment)
    await app.state.blobs.delete(attachment.display_key)
    missing = await attachments.verify(db, app.state.blobs)
    assert (attachment.id, attachment.display_key) in missing


async def test_display_falls_back_to_the_original_and_queues_an_old_photo(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    as_user(await make_user(db, "aiko"))
    root = await workspace_root(client)
    data = jpeg((500, 400), original="2026:09:16 09:12:00")
    photo = await upload_photo(client, root, "old.jpg", data)
    await run_media(app)
    attachment_id = uuid.UUID(photo["file"]["attachment_id"])
    # As if stored before AL1: read for its thumbnail, never as a photo.
    await db.execute(
        update(Attachment)
        .where(Attachment.id == attachment_id)
        .values(display_key=None, photo_probed_at=None, taken_at=None, display_bytes=None)
    )
    await db.execute(
        update(DriveItem).where(DriveItem.id == uuid.UUID(photo["id"])).values(taken_at=None)
    )
    await db.commit()
    got = await client.get(f"{API}/attachments/{attachment_id}/display")
    assert got.status_code == 200 and got.content == data
    assert got.headers["content-type"] == "image/jpeg"
    version = await fresh(app, DriveFileVersion, uuid.UUID(photo["file"]["version_id"]))
    assert version.processed_at is None  # queued again for the media loop
    assert await run_media(app) == 1
    again = await client.get(f"{API}/attachments/{attachment_id}/display")
    assert again.headers["content-type"] == "image/webp"
    # A file that is no image has no display image.
    text = await upload_photo(client, root, "notes.txt", b"hello " * 50)
    await run_media(app)
    none = await client.get(f"{API}/attachments/{text['file']['attachment_id']}/display")
    assert none.status_code == 404 and code(none) == "display_not_found"


async def test_video_capture_time_and_location_from_the_probe(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    drive_settings(app)
    as_user(await make_user(db, "aiko"))
    root = await workspace_root(client)

    async def probe(path: str, settings: Any) -> videos.VideoInfo:
        return videos.VideoInfo(
            width=640,
            height=360,
            duration_ms=4200,
            poster=None,
            taken_at=datetime(2026, 9, 16, 9, 12, tzinfo=UTC),
            has_location=True,
        )

    monkeypatch.setattr(videos, "tools", lambda settings: ("ffprobe", "ffmpeg"))
    monkeypatch.setattr(videos, "probe_video", probe)
    from pathlib import Path

    clip = (Path(__file__).parent / "fixtures" / "video" / "sample.mp4").read_bytes()
    video = await upload_photo(client, root, "clip.mp4", clip)
    await run_media(app)
    shown = (await item(client, video["id"]))["file"]
    assert shown["taken_at"].startswith("2026-09-16T09:12:00")
    assert shown["has_location"] is True and shown["has_display"] is False
    assert (await fresh(app, DriveItem, uuid.UUID(video["id"]))).taken_at is not None


async def test_backfill_reads_stored_photos_a_bounded_number_a_run(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    as_user(await make_user(db, "aiko"))
    root = await workspace_root(client)
    made = [
        await upload_photo(client, root, f"p{i}.jpg", jpeg(original=f"2026:09:1{i} 10:00:00"))
        for i in range(3)
    ]
    await run_media(app)
    ids = [uuid.UUID(p["file"]["attachment_id"]) for p in made]
    await db.execute(
        update(Attachment)
        .where(Attachment.id.in_(ids))
        .values(display_key=None, photo_probed_at=None, taken_at=None)
    )
    await db.execute(update(DriveItem).values(taken_at=None))
    await db.commit()
    factory, settings, blobs = app.state.db.session_factory, app.state.settings, app.state.blobs
    counted = await drive_photos.backfill(factory, settings, blobs, limit=10, dry_run=True)
    assert counted.pending == 3 and counted.pending_bytes > 0
    first = await drive_photos.backfill(factory, settings, blobs, limit=2)
    assert (first.read, first.dated, first.displays, first.remaining) == (2, 2, 2, True)
    second = await drive_photos.backfill(factory, settings, blobs, limit=2)
    assert (second.read, second.remaining) == (1, False)
    assert (await drive_photos.backfill(factory, settings, blobs, limit=2)).read == 0
    for photo in made:
        shown = (await item(client, photo["id"]))["file"]
        assert shown["has_display"] and shown["taken_at"] is not None
        assert (await fresh(app, DriveItem, uuid.UUID(photo["id"]))).taken_at is not None
    # --rebuild: a display image lost from the store is made again; the others are skipped.
    row = await fresh(app, Attachment, ids[0])
    await blobs.delete(row.display_key)
    rebuilt = await drive_photos.backfill(factory, settings, blobs, limit=10, rebuild=True)
    assert (rebuilt.read, rebuilt.displays) == (1, 1)
    assert await blobs.exists(row.display_key)


# --- albums: making, changing, unmaking ----------------------------------------------------------


async def test_album_made_in_the_locations_albums_folder_and_idempotent(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    as_user(await make_user(db, "aiko"))
    root = await workspace_root(client)
    workspace = (await client.get(f"{API}/drive/locations")).json()["locations"][0]
    op = str(uuid.uuid4())
    made = await make_album(
        client,
        location_id=workspace["id"],
        name="応用物理学会 2026",
        description="  名古屋で\n4 日間 ",
        starts_on="2026-09-16",
        ends_on="2026-09-19",
        client_op_id=op,
    )
    assert made.status_code == 201, made.text
    body = made.json()
    album, folder_out = body["album"], body["folder"]
    assert folder_out["name"] == "応用物理学会 2026" and folder_out["album"] == album
    assert album["description"] == "名古屋で\n4 日間"
    assert (album["sort"], album["sort_order"]) == ("taken", "asc")
    assert (album["starts_on"], album["ends_on"]) == ("2026-09-16", "2026-09-19")
    assert album["photo_count"] == 0 and album["cover"] is None
    parent = await item(client, folder_out["parent_id"])
    assert parent["name"] == "アルバム" and parent["parent_id"] == root
    again = await make_album(
        client, location_id=workspace["id"], name="応用物理学会 2026", client_op_id=op
    )
    assert again.status_code == 200 and again.json()["folder"]["id"] == folder_out["id"]
    # A second album goes into the same 「アルバム」 folder; a taken name is 409.
    second = await make_album(client, location_id=workspace["id"], name="合宿")
    assert second.json()["folder"]["parent_id"] == parent["id"]
    taken = await make_album(client, parent_id=parent["id"], name="合宿")
    assert taken.status_code == 409 and code(taken) == "drive_name_taken"
    wrong = await make_album(
        client, parent_id=root, name="x", starts_on="2026-09-19", ends_on="2026-09-16"
    )
    assert wrong.status_code == 422 and code(wrong) == "drive_album_invalid"
    long = await make_album(client, parent_id=root, name="y", description="あ" * 2001)
    assert long.status_code == 422 and code(long) == "drive_album_invalid"
    both = await make_album(client, parent_id=root, location_id=workspace["id"], name="z")
    assert both.status_code == 422


async def test_albums_folder_has_its_role_and_is_an_ordinary_folder(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """§23: the 「アルバム」 folder is marked 'albums' (item, crumbs) but renamed, moved and trashed
    like any folder; trashed or moved to another location it is a plain folder again."""
    drive_settings(app)
    as_user(await make_user(db, "aiko"))
    root = await workspace_root(client)
    workspace = (await client.get(f"{API}/drive/locations")).json()["locations"][0]
    first = (await make_album(client, location_id=workspace["id"], name="合宿")).json()
    albums_id = first["folder"]["parent_id"]
    albums = await item(client, albums_id)
    assert albums["name"] == "アルバム" and albums["system_role"] == "albums"
    got = await client.get(f"{API}/drive/items/{first['folder']['id']}")
    assert [c.get("system_role") for c in got.json()["path"]] == [None, "albums"]
    listed = await client.get(f"{API}/drive/folders/{root}/children")
    row = next(i for i in listed.json()["items"] if i["id"] == albums_id)
    assert row["system_role"] == "albums"
    # Not an album itself; albums can be made in it by parent_id too.
    refused = await client.put(f"{API}/drive/folders/{albums_id}/album", json={})
    assert refused.status_code == 422 and code(refused) == "drive_album_invalid"
    assert (await make_album(client, parent_id=albums_id, name="学会")).status_code == 201
    # Renamed and moved inside the location: still the folder new albums go into.
    renamed = await client.patch(f"{API}/drive/items/{albums_id}", json={"name": "写真"})
    assert renamed.status_code == 200 and renamed.json()["system_role"] == "albums"
    shelf = await folder(client, root, "共有")
    moved = await client.post(
        f"{API}/drive/items/move", json={"item_ids": [albums_id], "target_folder_id": shelf}
    )
    assert moved.json()["results"][0]["ok"] is True
    again = (await make_album(client, location_id=workspace["id"], name="卒業式")).json()
    assert again["folder"]["parent_id"] == albums_id
    # Trashed: a plain folder; the next album makes a new 「アルバム」 with the role.
    trashed = await client.post(f"{API}/drive/items/trash", json={"item_ids": [shelf]})
    assert trashed.json()["results"][0]["ok"] is True
    assert (await fresh(app, DriveItem, uuid.UUID(albums_id))).system_role is None
    third = (await make_album(client, location_id=workspace["id"], name="花見")).json()
    new_albums = await item(client, third["folder"]["parent_id"])
    assert new_albums["id"] != albums_id and new_albums["system_role"] == "albums"
    assert new_albums["parent_id"] == root and new_albums["name"] == "アルバム"
    restored = await client.post(f"{API}/drive/items/{shelf}/restore", json={})
    assert restored.status_code == 200, restored.text
    assert (await item(client, albums_id))["system_role"] is None
    # Moved to another location: a plain folder there.
    mine = await location(client, "me")
    across = await client.post(
        f"{API}/drive/items/move",
        json={"item_ids": [new_albums["id"]], "target_folder_id": mine["root_id"]},
    )
    assert across.json()["results"][0]["ok"] is True, across.text
    gone = await item(client, new_albums["id"])
    assert gone["location_id"] == mine["id"] and gone["system_role"] is None
    # My drive's own 「アルバム」: the moved folder lies right under its top, so it is adopted.
    adopted = (await make_album(client, location_id=mine["id"], name="旅行")).json()
    assert adopted["folder"]["parent_id"] == new_albums["id"]
    assert (await item(client, new_albums["id"]))["system_role"] == "albums"


async def test_albums_folder_adopts_one_a_person_made(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    as_user(await make_user(db, "aiko"))
    root = await workspace_root(client)
    workspace = (await client.get(f"{API}/drive/locations")).json()["locations"][0]
    mine = await folder(client, root, "アルバム")
    assert (await item(client, mine))["system_role"] is None
    before = len(await changed_events(db))
    count = (await fresh(app, DriveLocation, uuid.UUID(workspace["id"]))).item_count
    made = (await make_album(client, location_id=workspace["id"], name="合宿")).json()
    assert made["folder"]["parent_id"] == mine
    assert (await item(client, mine))["system_role"] == "albums"
    events = (await changed_events(db))[before:]
    assert any(root in e["folder_ids"] for e in events)
    # One new folder (the album), not two.
    after = (await fresh(app, DriveLocation, uuid.UUID(workspace["id"]))).item_count
    assert after == count + 1


async def test_folder_made_an_album_changed_and_unmade(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    as_user(await make_user(db, "aiko"))
    root = await workspace_root(client)
    trip = await folder(client, root, "合宿")
    photo = await upload_photo(client, trip, "a.jpg", jpeg(original="2026:08:01 10:00:00"))
    elsewhere = await upload_photo(client, root, "b.jpg", jpeg())
    notes = await upload_photo(client, trip, "notes.txt", b"x" * 100)
    await run_media(app)
    before = len(await changed_events(db))
    put = await client.put(f"{API}/drive/folders/{trip}/album", json={"description": "夏"})
    assert put.status_code == 200, put.text
    # No new event: drive.changed for the folder and its parent.
    events = await changed_events(db)
    assert len(events) == before + 1
    assert set(events[-1]["folder_ids"]) == {trip, root}
    assert put.json()["description"] == "夏" and put.json()["photo_count"] == 1
    for bad in ({"cover_item_id": elsewhere["id"]}, {"cover_item_id": notes["id"]}):
        refused = await client.put(f"{API}/drive/folders/{trip}/album", json=bad)
        assert refused.status_code == 422 and code(refused) == "drive_album_invalid"
    changed = await client.put(
        f"{API}/drive/folders/{trip}/album",
        json={
            "cover_item_id": photo["id"],
            "sort": "name",
            "sort_order": "desc",
            "starts_on": "2026-08-01",
        },
    )
    assert changed.status_code == 200
    out = changed.json()
    assert out["cover"]["item_id"] == photo["id"] and out["cover_item_id"] == photo["id"]
    assert (out["sort"], out["sort_order"], out["starts_on"]) == ("name", "desc", "2026-08-01")
    assert out["description"] == "夏"  # not sent: kept
    backwards = await client.put(
        f"{API}/drive/folders/{trip}/album", json={"ends_on": "2026-07-01"}
    )
    assert backwards.status_code == 422
    # Not a folder that can be an album: the root, a file.
    for target in (root, photo["id"]):
        refused = await client.put(f"{API}/drive/folders/{target}/album", json={})
        assert refused.status_code == 422 and code(refused) == "drive_album_invalid"
    # The cover's photo leaves: the first photo again (none here).
    moved = await client.post(
        f"{API}/drive/items/move", json={"item_ids": [photo["id"]], "target_folder_id": root}
    )
    assert moved.json()["results"][0]["ok"]
    assert (await item(client, trip))["album"]["cover"] is None
    gone = await client.delete(f"{API}/drive/folders/{trip}/album")
    assert gone.status_code == 204
    assert (await item(client, trip))["album"] is None
    assert [
        i["name"]
        for i in (await client.get(f"{API}/drive/folders/{trip}/children")).json()["items"]
    ] == ["notes.txt"]
    not_album = await client.get(f"{API}/drive/albums/{trip}")
    assert not_album.status_code == 404 and code(not_album) == "drive_album_not_found"
    # Unmaking twice is fine.
    assert (await client.delete(f"{API}/drive/folders/{trip}/album")).status_code == 204


async def test_album_rights_follow_the_location(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    aiko = await make_user(db, "aiko")
    ben = await make_user(db, "ben")
    gus = await make_user(db, "gus", role="guest")
    outsider = await make_user(db, "olga")
    as_user(aiko)
    root = await workspace_root(client)
    lab = await album_in(client, root, "研究室の行事")
    channel = await make_channel(client, "共同研究", [ben, gus], kind="private")
    channel_drive = await location(client, "channel", channel_id=channel["id"])
    joint = await album_in(client, channel_drive["root_id"], "学会")
    mine = await location(client, "me")
    private = await album_in(client, mine["root_id"], "自分だけ")

    async def listed() -> set[str]:
        got = await client.get(f"{API}/drive/albums")
        assert got.status_code == 200, got.text
        return {entry["folder"]["name"] for entry in got.json()["items"]}

    assert await listed() == {"研究室の行事", "学会", "自分だけ"}
    one = await client.get(f"{API}/drive/albums", params={"location_id": channel_drive["id"]})
    assert [e["album"]["folder_id"] for e in one.json()["items"]] == [joint["folder"]["id"]]
    entry = one.json()["items"][0]
    assert (
        entry["location_kind"] == "channel" and entry["path"][0]["id"] == channel_drive["root_id"]
    )

    as_user(ben)  # a member: reads and writes the lab's and the channel's, not aiko's own
    assert await listed() == {"研究室の行事", "学会"}
    assert (
        await client.put(
            f"{API}/drive/folders/{lab['folder']['id']}/album", json={"description": "b"}
        )
    ).status_code == 200
    assert (await client.get(f"{API}/drive/albums/{private['folder']['id']}")).status_code == 404
    as_user(gus)  # a guest member of the channel: its album only, and may change it there
    assert await listed() == {"学会"}
    assert (await client.get(f"{API}/drive/albums/{lab['folder']['id']}")).status_code == 404
    assert (
        await client.put(
            f"{API}/drive/folders/{joint['folder']['id']}/album", json={"description": "g"}
        )
    ).status_code == 200
    guest_new = await make_album(client, parent_id=root, name="guest")
    assert guest_new.status_code == 404
    as_user(outsider)  # neither the channel's nor anyone's My Drive
    assert await listed() == {"研究室の行事"}
    for folder_id in (joint["folder"]["id"], private["folder"]["id"]):
        assert (await client.get(f"{API}/drive/albums/{folder_id}")).status_code == 404
        put = await client.put(f"{API}/drive/folders/{folder_id}/album", json={})
        assert put.status_code == 404
        assert (await client.delete(f"{API}/drive/folders/{folder_id}/album")).status_code == 404
    # Archived channel: read only.
    as_user(aiko)
    archived = await client.post(f"{API}/channels/{channel['id']}/archive")
    assert archived.status_code == 200, archived.text
    refused = await client.put(f"{API}/drive/folders/{joint['folder']['id']}/album", json={})
    assert refused.status_code == 403


# --- the order and the card ---------------------------------------------------------------------


async def test_album_order_by_capture_time_with_missing_dates_and_cursor(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    as_user(await make_user(db, "aiko"))
    root = await workspace_root(client)
    album = await album_in(client, root, "学会")
    folder_id = album["folder"]["id"]
    late = await upload_photo(
        client, folder_id, "c.jpg", jpeg(original="2026:09:16 11:00:00", offset="+09:00")
    )
    early = await upload_photo(
        client, folder_id, "b.jpg", jpeg(original="2026:09:16 09:00:00", offset="+09:00")
    )
    # No EXIF: the file's own time (09:30 in Tokyo) stands for it.
    undated = await upload_photo(
        client, folder_id, "a.jpg", jpeg(), modified=datetime(2026, 9, 16, 0, 30, tzinfo=UTC)
    )
    await upload_photo(client, folder_id, "slides.pdf", b"%PDF-1.4\n" + b"x" * 300)
    await folder(client, folder_id, "二日目")
    await run_media(app)

    page = await detail(client, folder_id)
    assert [i["name"] for i in page["items"]] == ["b.jpg", "a.jpg", "c.jpg"]
    assert (page["folder_count"], page["other_count"], page["can_write"]) == (1, 1, True)
    assert page["path"][-1]["id"] == root and page["location_kind"] == "workspace"
    down = await detail(client, folder_id, order="desc")
    assert [i["name"] for i in down["items"]] == ["c.jpg", "a.jpg", "b.jpg"]
    by_name = await detail(client, folder_id, sort="name")
    assert [i["name"] for i in by_name["items"]] == ["a.jpg", "b.jpg", "c.jpg"]
    walked: list[str] = []
    cursor = None
    while True:
        params: dict[str, Any] = {"limit": 1}
        if cursor:
            params["cursor"] = cursor
        step = await detail(client, folder_id, **params)
        walked += [i["name"] for i in step["items"]]
        cursor = step["next_cursor"]
        if cursor is None:
            break
    assert walked == ["b.jpg", "a.jpg", "c.jpg"]
    # The album's own order is kept: desc.
    await client.put(f"{API}/drive/folders/{folder_id}/album", json={"sort_order": "desc"})
    assert [i["name"] for i in (await detail(client, folder_id))["items"]] == [
        "c.jpg",
        "a.jpg",
        "b.jpg",
    ]
    # The children list with sort=taken (folders first).
    children = await client.get(
        f"{API}/drive/folders/{folder_id}/children", params={"sort": "taken", "limit": 2}
    )
    assert children.status_code == 200
    first = children.json()
    assert [i["name"] for i in first["items"]] == ["二日目", "b.jpg"]
    rest = await client.get(
        f"{API}/drive/folders/{folder_id}/children",
        params={"sort": "taken", "limit": 10, "cursor": first["next_cursor"]},
    )
    # The PDF has neither a capture time nor its own time: when it was put there (now, after
    # the photos of 2026-09).
    assert [i["name"] for i in rest.json()["items"]] == ["a.jpg", "c.jpg", "slides.pdf"]
    # The card: counts, the range, four thumbnails at most (the first in the order first).
    card = (await item(client, folder_id))["album"]
    assert (card["photo_count"], card["video_count"]) == (3, 0)
    assert card["taken_from"].startswith("2026-09-16T00:00:00")
    assert card["taken_to"].startswith("2026-09-16T02:00:00")
    assert card["cover"]["item_id"] == late["id"]  # desc now
    assert card["preview_attachment_ids"][0] == late["file"]["attachment_id"]
    assert set(card["preview_attachment_ids"]) == {
        p["file"]["attachment_id"] for p in (late, early, undated)
    }
    assert card["size_bytes"] == sum(p["size_bytes"] for p in (late, early, undated))


async def test_card_shows_four_thumbnails_and_the_chosen_cover_first(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    as_user(await make_user(db, "aiko"))
    root = await workspace_root(client)
    album = await album_in(client, root, "多い")
    folder_id = album["folder"]["id"]
    made = [
        await upload_photo(client, folder_id, f"{i}.jpg", jpeg(original=f"2026:09:1{i} 10:00:00"))
        for i in range(6)
    ]
    await run_media(app)
    card = (await item(client, folder_id))["album"]
    assert card["photo_count"] == 6
    assert card["preview_attachment_ids"] == [p["file"]["attachment_id"] for p in made[:4]]
    await client.put(
        f"{API}/drive/folders/{folder_id}/album", json={"cover_item_id": made[5]["id"]}
    )
    card = (await item(client, folder_id))["album"]
    assert card["cover"] == {
        "item_id": made[5]["id"],
        "attachment_id": made[5]["file"]["attachment_id"],
    }
    assert card["preview_attachment_ids"] == [made[5]["file"]["attachment_id"]] + [
        p["file"]["attachment_id"] for p in made[:3]
    ]
    # Into the trash: not counted, not the cover any more.
    await client.post(f"{API}/drive/items/trash", json={"item_ids": [made[5]["id"]]})
    card = (await item(client, folder_id))["album"]
    assert card["photo_count"] == 5 and card["cover"]["item_id"] == made[0]["id"]


# --- adding photos -------------------------------------------------------------------------------


async def test_posted_photo_moves_into_an_album_of_its_channel_drive(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    aiko = await make_user(db, "aiko")
    ben = await make_user(db, "ben")
    as_user(aiko)
    channel = await make_channel(client, "学会", [ben])
    message = await post_photo(
        client, channel["id"], "IMG_1.jpg", jpeg(original="2026:09:16 09:00:00")
    )
    attachment = message["attachments"][0]
    assert attachment["drive"]["state"] == "available"
    await run_media(app)  # a posted photo is read as a photo too
    posted_row = await fresh(app, Attachment, uuid.UUID(attachment["id"]))
    assert posted_row.display_key is not None and posted_row.taken_at is not None
    channel_drive = await location(client, "channel", channel_id=channel["id"])
    album = await album_in(client, channel_drive["root_id"], "学会の写真")
    folder_id = album["folder"]["id"]
    op = str(uuid.uuid4())
    added = await client.post(
        f"{API}/drive/albums/{folder_id}/add",
        json={"attachment_ids": [attachment["id"]], "client_op_id": op},
    )
    assert added.status_code == 200, added.text
    result = added.json()["results"][0]
    assert result == {
        "source_id": attachment["id"],
        "ok": True,
        "error": None,
        "item_id": attachment["drive"]["item_id"],
        "action": "moved",
    }
    moved = await item(client, attachment["drive"]["item_id"])
    assert moved["parent_id"] == folder_id
    row = await fresh(app, Attachment, uuid.UUID(attachment["id"]))
    assert row.drive_state == "available" and row.message_id is not None
    shown = await client.get(f"{API}/messages/{message['id']}")
    assert shown.status_code == 200
    assert shown.json()["attachments"][0]["drive"]["state"] == "available"
    # Again: nothing more (it is there already), no copy.
    again = await client.post(
        f"{API}/drive/albums/{folder_id}/add",
        json={"attachment_ids": [attachment["id"]], "client_op_id": op},
    )
    assert again.json()["results"][0]["ok"] and again.json()["results"][0]["action"] == "moved"
    assert (await detail(client, folder_id))["album"]["photo_count"] == 1
    # mode copy: a copy beside it, the posted item stays.
    copied = await client.post(
        f"{API}/drive/albums/{folder_id}/add",
        json={
            "attachment_ids": [attachment["id"]],
            "mode": "copy",
            "client_op_id": str(uuid.uuid4()),
        },
    )
    out = copied.json()["results"][0]
    assert (
        out["ok"] and out["action"] == "copied" and out["item_id"] != attachment["drive"]["item_id"]
    )
    names = sorted(i["name"] for i in (await detail(client, folder_id))["items"])
    assert names == ["IMG_1 (1).jpg", "IMG_1.jpg"]


async def test_posted_photo_is_copied_into_an_album_elsewhere_and_plain_ones_copied(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    aiko = await make_user(db, "aiko")
    ben = await make_user(db, "ben")
    as_user(aiko)
    channel = await make_channel(client, "学会", [ben])
    message = await post_photo(client, channel["id"], "IMG_2.jpg", jpeg())
    attachment = message["attachments"][0]
    root = await workspace_root(client)
    album = await album_in(client, root, "研究室の写真")
    folder_id = album["folder"]["id"]
    op = str(uuid.uuid4())
    added = await client.post(
        f"{API}/drive/albums/{folder_id}/add",
        json={"attachment_ids": [attachment["id"]], "client_op_id": op},
    )
    out = added.json()["results"][0]
    assert out["ok"] and out["action"] == "copied"
    assert out["item_id"] != attachment["drive"]["item_id"]
    # The posted file stays in the channel's drive.
    assert (await item(client, attachment["drive"]["item_id"]))["location_id"] != album["folder"][
        "location_id"
    ]
    # The same request again makes no second copy.
    again = await client.post(
        f"{API}/drive/albums/{folder_id}/add",
        json={"attachment_ids": [attachment["id"]], "client_op_id": op},
    )
    assert again.json()["results"][0]["item_id"] == out["item_id"]
    assert len((await detail(client, folder_id))["items"]) == 1
    # A DM's photo (no drive): copied, whatever the mode.
    dm = await client.post(f"{API}/dms", json={"user_ids": [str(ben.id)]})
    assert dm.status_code in (200, 201), dm.text
    dm_message = await post_photo(client, dm.json()["id"], "dm.jpg", jpeg())
    plain = await client.post(
        f"{API}/drive/albums/{folder_id}/add",
        json={"attachment_ids": [dm_message["attachments"][0]["id"]], "mode": "move"},
    )
    assert plain.json()["results"][0]["action"] == "copied"
    # Drive items: moved within the location.
    loose = await upload_photo(client, root, "loose.jpg", jpeg())
    moved = await client.post(
        f"{API}/drive/albums/{folder_id}/add", json={"item_ids": [loose["id"]]}
    )
    assert moved.json()["results"][0]["action"] == "moved"
    assert (await item(client, loose["id"]))["parent_id"] == folder_id
    # Something I cannot read: one failed result, the rest go on.
    missing = await client.post(
        f"{API}/drive/albums/{folder_id}/add",
        json={"attachment_ids": [str(uuid.uuid4())], "item_ids": [str(uuid.uuid4())]},
    )
    assert [r["error"] for r in missing.json()["results"]] == [
        "attachment_not_found",
        "drive_item_not_found",
    ]
    # A folder that is not an album.
    plain_folder = await folder(client, root, "ふつう")
    refused = await client.post(
        f"{API}/drive/albums/{plain_folder}/add", json={"item_ids": [loose["id"]]}
    )
    assert refused.status_code == 404 and code(refused) == "drive_album_not_found"


# --- external links ------------------------------------------------------------------------------


def visitor(app: FastAPI) -> AsyncClient:
    return AsyncClient(
        transport=ASGITransport(app=app, client=("203.0.113.9", 40000)),
        base_url="http://testserver",
    )


async def test_album_link_hands_out_display_images_only_by_default(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    as_user(await make_user(db, "aiko"))
    root = await workspace_root(client)
    album = await album_in(client, root, "合宿", description="山の上")
    folder_id = album["folder"]["id"]
    data = jpeg((2600, 1300), original="2026:08:01 10:00:00", offset="+09:00", gps=True)
    photo = await upload_photo(client, folder_id, "IMG_0001.JPG", data)
    gif = io.BytesIO()
    frames = [Image.new("RGB", (10, 10), (i * 80, 0, 0)) for i in range(3)]
    frames[0].save(gif, format="GIF", save_all=True, append_images=frames[1:], duration=50)
    small_gif = await upload_photo(client, folder_id, "anim.gif", gif.getvalue())
    pdf = await upload_photo(client, folder_id, "plan.pdf", b"%PDF-1.4\n" + b"y" * 200)
    await run_media(app)
    made = await client.post(f"{API}/drive/items/{folder_id}/links", json={})
    assert made.status_code == 201, made.text
    link = made.json()
    assert link["link"]["originals"] is False
    token = link["path"].removeprefix("/s/")
    async with visitor(app) as v:
        info = (await v.get(f"{API}/shares/{token}")).json()
        assert info["originals"] is False
        assert info["album"]["description"] == "山の上" and info["album"]["photo_count"] == 2
        listed = (await v.get(f"{API}/shares/{token}/folders/{folder_id}/children")).json()
        shown = {i["name"]: i for i in listed["items"]}
        assert shown["IMG_0001.JPG"]["has_display"] is True
        assert shown["IMG_0001.JPG"]["taken_at"].startswith("2026-08-01T01:00:00")
        assert "has_location" not in shown["IMG_0001.JPG"]
        assert listed["album"]["photo_count"] == 2
        for item_id in (photo["id"], pdf["id"]):
            refused = await v.get(f"{API}/shares/{token}/items/{item_id}/content")
            assert refused.status_code == 403 and code(refused) == "share_originals_disabled"
        whole = await v.get(f"{API}/shares/{token}/zip")
        assert whole.status_code == 403 and code(whole) == "share_originals_disabled"
        shown_photo = await v.get(f"{API}/shares/{token}/items/{photo['id']}/display")
        assert (
            shown_photo.status_code == 200 and shown_photo.headers["content-type"] == "image/webp"
        )
        assert shown_photo.headers["cache-control"] == "no-store"
        no_metadata(shown_photo.content)
        plain_gif = await v.get(f"{API}/shares/{token}/items/{small_gif['id']}/display")
        assert plain_gif.status_code == 200 and plain_gif.headers["content-type"] == "image/gif"
        no_pdf = await v.get(f"{API}/shares/{token}/items/{pdf['id']}/display")
        assert no_pdf.status_code == 404
        light = await v.get(f"{API}/shares/{token}/zip", params={"size": "display"})
        assert light.status_code == 200, light.text
        assert int(light.headers["content-length"]) == len(light.content)
        with zipfile.ZipFile(io.BytesIO(light.content)) as archive:
            entries = {n: archive.read(n) for n in archive.namelist()}
        assert set(entries) == {"合宿/", "合宿/IMG_0001.webp", "合宿/anim.gif"}
        no_metadata(entries["合宿/IMG_0001.webp"])
        assert opened(entries["合宿/IMG_0001.webp"]).size == (2048, 1024)
        assert data not in light.content
    # The creator turns the originals on: the original file and the ZIP again.
    patched = await client.patch(
        f"{API}/drive/links/{link['link']['id']}", json={"originals": True}
    )
    assert patched.status_code == 200 and patched.json()["originals"] is True
    audit = (
        await db.execute(select(AuditLog).where(AuditLog.action == "drive.link_updated"))
    ).scalar_one()
    assert audit.details["from"]["originals"] is False and audit.details["to"]["originals"] is True
    async with visitor(app) as v:
        original = await v.get(f"{API}/shares/{token}/items/{photo['id']}/content")
        assert original.status_code == 200 and original.content == data
        assert (await v.get(f"{API}/shares/{token}/zip")).status_code == 200


async def test_other_links_keep_originals_and_albums_may_opt_in(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    as_user(await make_user(db, "aiko"))
    root = await workspace_root(client)
    plain = await folder(client, root, "資料")
    album = await album_in(client, root, "写真")
    plain_link = await client.post(f"{API}/drive/items/{plain}/links", json={})
    assert plain_link.json()["link"]["originals"] is True
    opted = await client.post(
        f"{API}/drive/items/{album['folder']['id']}/links", json={"originals": True}
    )
    assert opted.json()["link"]["originals"] is True
    created = (
        (await db.execute(select(AuditLog).where(AuditLog.action == "drive.link_created")))
        .scalars()
        .all()
    )
    assert sorted(bool(row.details["originals"]) for row in created) == [True, True]


async def test_videos_play_through_a_link_without_originals(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    from pathlib import Path

    drive_settings(app)
    as_user(await make_user(db, "aiko"))
    root = await workspace_root(client)
    album = await album_in(client, root, "動画")
    clip = (Path(__file__).parent / "fixtures" / "video" / "sample.mp4").read_bytes()
    video = await upload_photo(client, album["folder"]["id"], "clip.mp4", clip)
    link = (await client.post(f"{API}/drive/items/{album['folder']['id']}/links", json={})).json()
    token = link["path"].removeprefix("/s/")
    async with visitor(app) as v:
        played = await v.get(f"{API}/shares/{token}/items/{video['id']}/content")
        assert played.status_code == 200 and played.content == clip


# --- the trash, moves, the search ----------------------------------------------------------------


async def test_album_goes_with_its_folder(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    aiko = await make_user(db, "aiko")
    as_user(aiko)
    root = await workspace_root(client)
    holder = await folder(client, root, "2026")
    album = await album_in(client, holder, "学会")
    folder_id = album["folder"]["id"]

    async def names() -> list[str]:
        return [
            e["folder"]["name"] for e in (await client.get(f"{API}/drive/albums")).json()["items"]
        ]

    assert await names() == ["学会"]
    await client.post(f"{API}/drive/items/trash", json={"item_ids": [holder]})
    assert await names() == []
    assert await fresh(app, DriveAlbum, uuid.UUID(folder_id)) is not None
    await client.post(f"{API}/drive/items/{holder}/restore")
    assert await names() == ["学会"]
    mine = await location(client, "me")
    moved = await client.post(
        f"{API}/drive/items/move",
        json={"item_ids": [folder_id], "target_folder_id": mine["root_id"]},
    )
    assert moved.json()["results"][0]["ok"]
    entry = (await client.get(f"{API}/drive/albums")).json()["items"][0]
    assert entry["location_kind"] == "user"
    # Purged for good: the album row goes too.
    await client.post(f"{API}/drive/items/trash", json={"item_ids": [folder_id]})
    assert (await client.delete(f"{API}/drive/items/{folder_id}")).status_code == 204
    assert await fresh(app, DriveAlbum, uuid.UUID(folder_id)) is None


async def test_albums_listed_newest_first_with_a_cursor(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    as_user(await make_user(db, "aiko"))
    root = await workspace_root(client)
    for name, day in (("春", "2026-04-10"), ("夏", "2026-08-01"), ("秋", "2026-09-16")):
        await album_in(client, root, name, starts_on=day)
    first = (await client.get(f"{API}/drive/albums", params={"limit": 2})).json()
    assert [e["folder"]["name"] for e in first["items"]] == ["秋", "夏"]
    rest = (
        await client.get(f"{API}/drive/albums", params={"limit": 2, "cursor": first["next_cursor"]})
    ).json()
    assert [e["folder"]["name"] for e in rest["items"]] == ["春"] and rest["next_cursor"] is None
    bad = await client.get(f"{API}/drive/albums", params={"cursor": "nope"})
    assert bad.status_code == 400


async def test_search_finds_albums_by_name_or_description(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    as_user(await make_user(db, "aiko"))
    root = await workspace_root(client)
    await album_in(client, root, "応用物理学会", description="名古屋の会場で")
    await album_in(client, root, "合宿", description="長野")
    await folder(client, root, "名古屋の資料")

    async def found(q: str) -> list[str]:
        got = await client.get(f"{API}/search/drive", params={"q": q, "kind": "album"})
        assert got.status_code == 200, got.text
        return [hit["item"]["name"] for hit in got.json()["items"]]

    assert await found("名古屋") == ["応用物理学会"]
    assert await found("合宿") == ["合宿"]
    hit = (await client.get(f"{API}/search/drive", params={"q": "長野", "kind": "album"})).json()
    assert hit["items"][0]["item"]["album"]["description"] == "長野"
    assert await found("資料") == []


async def test_copy_and_restore_carry_the_photo_information(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    as_user(await make_user(db, "aiko"))
    root = await workspace_root(client)
    target = await folder(client, root, "写し")
    photo = await upload_photo(
        client, root, "p.jpg", jpeg(original="2026:09:16 09:00:00", offset="+09:00")
    )
    await run_media(app)
    copied = await client.post(
        f"{API}/drive/items/copy", json={"item_ids": [photo["id"]], "target_folder_id": target}
    )
    new_id = copied.json()["results"][0]["new_id"]
    shown = (await item(client, new_id))["file"]
    assert shown["has_display"] and shown["taken_at"].startswith("2026-09-16T00:00:00")
    assert (await fresh(app, DriveItem, uuid.UUID(new_id))).taken_at == datetime(
        2026, 9, 16, tzinfo=UTC
    )
    copy_row = await fresh(app, Attachment, uuid.UUID(shown["attachment_id"]))
    assert await app.state.blobs.exists(copy_row.display_key)
    assert (
        copy_row.display_key
        != (await fresh(app, Attachment, uuid.UUID(photo["file"]["attachment_id"]))).display_key
    )
