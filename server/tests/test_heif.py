"""AL5 (docs/ALBUMS.md §19): HEIC / HEIF photos get a thumbnail, a display image and their EXIF
capture time and location mark, decoded by ffmpeg (heif.py).

The fixtures were made with macOS `sips -s format heic` from JPEGs of four coloured quadrants
(stored: red top left, green top right, blue bottom left, yellow bottom right):

- grid.heic: 1024 x 768 as a grid of 512 px tiles, EXIF Orientation 6 (sips writes irot 270),
  DateTimeOriginal 2026-10-20 14:05:06 +09:00 and a GPS position. Shown: 768 x 1024, B R / Y G.
- single.heic: 320 x 240, one item, EXIF Orientation 5 (irot 90 then imir 0), no date. Shown:
  240 x 320, R B / G Y (as `sips` and ffmpeg 9 show it).

The box parsing and the ffmpeg command are tested everywhere; the decoding only where the
installed ffmpeg reads HEIF tile grids (7.1 and later: the app image on Debian trixie, a Mac's
Homebrew ffmpeg). CI's runner may have an older one or none: those tests are skipped there.
"""

import io
import json
import shutil
import subprocess
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.modules.attachments import heif, photos, sniff, videos
from app.modules.attachments.models import Attachment
from app.modules.attachments.photo_kinds import is_image, photo_kind
from app.modules.drive import photos as drive_photos
from app.modules.drive import uploads
from app.modules.drive.models import DriveFileVersion, DriveItem
from app.modules.users.models import User
from tests.drive_helpers import act_as, drive_settings, workspace_root
from tests.helpers import make_user
from tests.test_albums import fresh, item, run_media, upload_photo

API = "/api/v1"
HEIC = Path(__file__).parent / "fixtures" / "heic"
GRID = (HEIC / "grid.heic").read_bytes()
SINGLE = (HEIC / "single.heic").read_bytes()
TOKYO = ZoneInfo("Asia/Tokyo")
NOW = datetime(2026, 10, 29, tzinfo=UTC)
COLOURS = {"R": (255, 0, 0), "G": (0, 255, 0), "B": (0, 0, 255), "Y": (255, 255, 0)}


def _reads_tile_grids() -> bool:
    """Whether the installed ffprobe sees the grid of a HEIC (ffmpeg 7.1 and later)."""
    ffprobe = shutil.which("ffprobe")
    if ffprobe is None or shutil.which("ffmpeg") is None:
        return False
    try:
        done = subprocess.run(
            [ffprobe, "-v", "error", "-show_stream_groups", "-of", "json", str(HEIC / "grid.heic")],
            capture_output=True,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return done.returncode == 0 and b"Tile Grid" in done.stdout


needs_heif_ffmpeg = pytest.mark.skipif(
    not _reads_tile_grids(), reason="the installed ffmpeg does not read HEIF tile grids"
)


@pytest.fixture
def as_user(app: FastAPI) -> Callable[[User], None]:
    return act_as(app)


def distance(a: tuple[int, ...], b: tuple[Any, ...]) -> int:
    return sum((x - y) ** 2 for x, y in zip(a, b[:3], strict=True))


def corners(image: Image.Image) -> str:
    """The quadrants' colours as shown: top left, top right, bottom left, bottom right."""
    rgb = image.convert("RGB")
    w, h = rgb.size
    out = ""
    for x, y in (
        (w // 4, h // 4),
        (3 * w // 4, h // 4),
        (w // 4, 3 * h // 4),
        (3 * w // 4, 3 * h // 4),
    ):
        pixel = rgb.getpixel((x, y))
        assert isinstance(pixel, tuple)
        out += min(COLOURS, key=lambda c: distance(COLOURS[c], pixel))
    return out


def parsed(data: bytes) -> heif.HeifInfo | None:
    return heif.parse(io.BytesIO(data))


# --- the boxes -----------------------------------------------------------------------------------


def test_parse_reads_the_grid_its_turn_and_its_exif() -> None:
    info = parsed(GRID)
    assert info is not None
    assert (info.width, info.height, info.grid) == (1024, 768, True)
    assert info.transforms == (("irot", 270),)
    assert info.upright_size == (768, 1024)
    exif = heif.read_exif(info)
    assert exif is not None and exif.get(0x0112) == 6  # informative only: irot governs
    meta = photos.read_exif_meta(exif, TOKYO, now=NOW)
    assert meta.has_location is True
    assert meta.taken is not None and meta.taken.local is False
    assert meta.taken.at == datetime(2026, 10, 20, 5, 5, 6, tzinfo=UTC)


def test_parse_keeps_the_order_of_rotation_and_mirror() -> None:
    info = parsed(SINGLE)
    assert info is not None
    assert (info.width, info.height, info.grid) == (320, 240, False)
    assert info.transforms == (("irot", 90), ("imir", 0))
    assert info.upright_size == (240, 320)
    meta = photos.read_exif_meta(heif.read_exif(info), TOKYO, now=NOW)
    assert meta.taken is None and meta.has_location is False


@pytest.mark.parametrize(
    "data",
    [
        b"",
        b"\xff\xd8\xff\xe0 not a heif at all",
        GRID[:40],  # cut inside the meta box
    ],
)
def test_parse_of_cut_or_foreign_files(data: bytes) -> None:
    assert parsed(data) is None


def test_parse_refuses_absurd_boxes() -> None:
    # A box claiming to be larger than the file, and one of size 4 (< its own header).
    assert parsed(b"\x7f\xff\xff\xffmeta" + b"\x00" * 64) is None
    assert parsed(b"\x00\x00\x00\x04meta" + b"\x00" * 64) is None
    # meta boxes nested a thousand deep: read no deeper than meta > iinf / iprp.
    nested = b""
    for _ in range(1000):
        nested = (
            (len(nested) + 16).to_bytes(4, "big") + b"meta" + b"\x00" * 4 + nested + b"\x00" * 4
        )
    assert parsed(nested) is None


def test_parse_groups_reads_the_tiles_or_the_default_stream() -> None:
    grid = {
        "stream_groups": [
            {
                "type": "Tile Grid",
                "components": [
                    {
                        "width": 1000,
                        "height": 700,
                        "horizontal_offset": 0,
                        "vertical_offset": 0,
                        "subcomponents": [
                            {
                                "stream_index": i,
                                "tile_horizontal_offset": x,
                                "tile_vertical_offset": y,
                            }
                            for i, (x, y) in enumerate([(0, 0), (512, 0), (0, 512), (512, 512)])
                        ],
                    }
                ],
            }
        ]
    }
    tiles = heif.parse_groups(json.dumps(grid).encode())
    assert isinstance(tiles, heif._Tiles)
    assert tiles.streams[3] == (3, 512, 512) and tiles.crop == (1000, 700, 0, 0)
    single = {
        "streams": [
            {"index": 0, "codec_type": "video", "disposition": {"default": 0}},
            {"index": 1, "codec_type": "video", "disposition": {"default": 1}},
        ]
    }
    assert heif.parse_groups(json.dumps(single).encode()) == 1
    assert heif.parse_groups(b"not json") is None
    assert (
        heif.parse_groups(b'{"stream_groups": [{"type": "Tile Grid", "components": [{}]}]}') is None
    )
    many = {"streams": [{"index": 0, "codec_type": "video"}, {"index": 1, "codec_type": "video"}]}
    assert heif.parse_groups(json.dumps(many).encode()) is None  # which one is the photo?


def test_decode_command_joins_tiles_then_turns_in_the_files_order() -> None:
    info = parsed(SINGLE)
    assert info is not None
    argv = heif.decode_argv("ffmpeg", "/tmp/x.heic", info, 0, 2048)
    graph = argv[argv.index("-vf") + 1]
    assert graph.index("transpose=2") < graph.index("vflip") < graph.index("scale=")
    assert "-noautorotate" in argv and argv.index("-noautorotate") < argv.index("-i")
    assert argv[argv.index("-format_whitelist") + 1] == "mov,mp4,m4a,3gp,3g2,mj2"
    assert argv[argv.index("-protocol_whitelist") + 1] == "file"
    tiles = heif._Tiles(streams=[(0, 0, 0), (1, 512, 0)], crop=(1000, 500, 0, 0))
    argv = heif.decode_argv("ffmpeg", "/tmp/x.heic", info, tiles, 2048)
    graph = argv[argv.index("-filter_complex") + 1]
    assert graph.startswith("[0:0][0:1]xstack=inputs=2:layout=0_0|512_0,crop=1000:500:0:0,")
    assert argv[argv.index("-map") + 1] == "[out]"


def test_heic_counts_as_a_photo() -> None:
    for kind in ("image/heic", "image/heif", "IMAGE/HEIC"):
        assert heif.is_heif(kind) and is_image(kind) and photo_kind(kind)
    assert not heif.is_heif("image/jpeg")


# --- the type of the bytes (§23) -----------------------------------------------------------------


def branded(data: bytes, major: bytes, compatible: list[bytes] | None = None) -> bytes:
    """`data` (a HEIC from sips: a 36-byte ftyp first) with another ftyp of the same length."""
    size = int.from_bytes(data[:4], "big")
    assert data[4:8] == b"ftyp" and size == 36
    brands = compatible if compatible is not None else [b"mif1", b"MiPr", b"miaf", b"MiHB", major]
    assert len(brands) == 5
    return data[:8] + major + data[12:16] + b"".join(brands) + data[size:]


@pytest.mark.parametrize("major", [b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx"])
def test_hevc_brands_are_heic(major: bytes) -> None:
    for data in (SINGLE, GRID):
        changed = branded(data, major)
        assert sniff.content_type(changed[:8192]) == "image/heic"
        assert uploads.sniffed_type(changed) == "image/heic"
        assert parsed(changed) is not None  # the box reader does not look at the brand


def test_generic_heif_brands() -> None:
    plain = [b"mif1", b"MiPr", b"miaf", b"MiHB", b"miaf"]
    # A generic mif1 / msf1 with an HEVC brand among the compatible ones.
    assert sniff.content_type(branded(SINGLE, b"mif1", [*plain[:4], b"heix"])) == "image/heic"
    assert sniff.content_type(branded(SINGLE, b"msf1", [*plain[:4], b"hevc"])) == "image/heic"
    # No HEVC brand: the primary item in the meta box decides.
    assert sniff.content_type(branded(SINGLE, b"mif1", plain)) == "image/heif"
    assert sniff.content_type(branded(GRID, b"mif1", plain)) == "image/heif"
    av1 = branded(SINGLE, b"mif1", plain).replace(b"hvc1", b"av01")
    assert heif.sniff(av1) is None
    # An AVIF is not ours (filetype's).
    assert heif.sniff(branded(SINGLE, b"mif1", [*plain[:4], b"avif"])) is None
    assert heif.sniff(branded(SINGLE, b"avif", plain)) is None


@pytest.mark.parametrize(
    "data",
    [
        b"",
        b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2",  # an MP4
        b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42hevc",  # an HEVC video
        b"\x00\x00\x00\x14ftypheic",  # an ftyp longer than the bytes
        b"\x00\x00\x00\x11ftypheic\x00\x00\x00\x00\x00",  # not a whole number of brands
        b"\x00\x00\x10\x00ftypheic" + b"\x00" * 5000,  # an absurd ftyp
        b"\x89PNG\r\n\x1a\n" + b"\x00" * 32,
    ],
)
def test_other_files_are_not_heif(data: bytes) -> None:
    assert heif.sniff(data) is None


def test_the_sniffer_still_knows_everything_else() -> None:
    mp4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + b"\x00" * 16
    assert sniff.content_type(mp4) == "video/mp4"
    assert sniff.content_type(b"%PDF-1.7\n" + b"\x00" * 16) == "application/pdf"
    assert sniff.content_type(b"hello") == "application/octet-stream"
    assert sniff.content_type(b"") == "application/octet-stream"


async def test_posted_heix_is_a_heic(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app, video_probe_enabled=False)  # a copy: never the shared settings
    as_user(await make_user(db, "aiko"))
    uploaded = await client.post(
        f"{API}/attachments",
        files={"file": ("IMG_0002.HEIC", branded(GRID, b"heix"), "application/octet-stream")},
    )
    assert uploaded.status_code == 201, uploaded.text
    assert uploaded.json()["content_type"] == "image/heic"


@needs_heif_ffmpeg
async def test_posted_heix_gets_its_thumbnail(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    as_user(await make_user(db, "aiko"))
    uploaded = await client.post(
        f"{API}/attachments",
        files={"file": ("IMG_0002.HEIC", branded(GRID, b"heix"), "application/octet-stream")},
    )
    assert uploaded.status_code == 201, uploaded.text
    out = uploaded.json()
    assert out["content_type"] == "image/heic" and out["has_thumbnail"] is True
    assert (out["width"], out["height"]) == (768, 1024)


async def test_without_ffmpeg_nothing_is_tried(tmp_path: Path) -> None:
    path = tmp_path / "a.heic"
    path.write_bytes(GRID)
    settings = Settings(video_probe_enabled=False)
    assert await heif.read(str(path), settings, TOKYO, now=NOW) is None


async def test_past_the_pixel_limit_only_the_metadata(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "a.heic"
    path.write_bytes(GRID)
    monkeypatch.setattr(videos, "tools", lambda settings: ("ffprobe", "ffmpeg"))
    monkeypatch.setattr(heif, "MAX_PIXELS", 1000)

    async def never(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("decoded past the limit")

    monkeypatch.setattr(heif, "decode", never)
    got = await heif.read(str(path), Settings(), TOKYO, now=NOW)
    assert got is not None and got.thumbnail is None and got.display is None
    assert got.meta.taken is not None and got.meta.has_location is True


# --- decoding (an ffmpeg that reads HEIF grids) ---------------------------------------------


@needs_heif_ffmpeg
async def test_grid_heic_is_joined_turned_and_scaled(tmp_path: Path) -> None:
    path = tmp_path / "grid.heic"
    path.write_bytes(GRID)
    got = await heif.read(str(path), Settings(), TOKYO, now=NOW)
    assert got is not None and got.thumbnail is not None and got.display is not None
    thumb, width, height = got.thumbnail
    assert (width, height) == (768, 1024)  # the full upright size, as an image's
    small = Image.open(io.BytesIO(thumb))
    assert small.format == "JPEG" and small.size == (384, 512)
    assert corners(small) == "BRYG"
    shown = Image.open(io.BytesIO(got.display.data))
    assert shown.format == "WEBP" and shown.size == (768, 1024)
    assert (got.display.width, got.display.height) == (768, 1024)
    assert corners(shown) == "BRYG"
    assert "exif" not in shown.info and b"Exif" not in got.display.data
    assert got.meta.has_location is True and got.meta.taken is not None


@needs_heif_ffmpeg
async def test_single_heic_mirrored_and_turned(tmp_path: Path) -> None:
    path = tmp_path / "single.heic"
    path.write_bytes(SINGLE)
    got = await heif.read(str(path), Settings(), TOKYO, now=NOW, display=False)
    assert got is not None and got.thumbnail is not None and got.display is None
    thumb, width, height = got.thumbnail
    assert (width, height) == (240, 320)
    assert corners(Image.open(io.BytesIO(thumb))) == "RBGY"


@needs_heif_ffmpeg
async def test_broken_heic_reads_as_metadata_only(tmp_path: Path) -> None:
    # The meta box intact, the tiles' data gone.
    path = tmp_path / "cut.heic"
    path.write_bytes(GRID[: len(GRID) // 2])
    got = await heif.read(str(path), Settings(), TOKYO, now=NOW)
    assert got is not None and got.thumbnail is None and got.display is None


@needs_heif_ffmpeg
async def test_posted_heic_gets_its_thumbnail_at_upload(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    as_user(await make_user(db, "aiko"))
    uploaded = await client.post(
        f"{API}/attachments", files={"file": ("IMG_0001.HEIC", GRID, "application/octet-stream")}
    )
    assert uploaded.status_code == 201, uploaded.text
    out = uploaded.json()
    assert out["content_type"] == "image/heic"
    assert out["has_thumbnail"] is True
    assert (out["width"], out["height"]) == (768, 1024)
    thumb = await client.get(f"{API}/attachments/{out['id']}/thumbnail")
    assert thumb.status_code == 200
    assert corners(Image.open(io.BytesIO(thumb.content))) == "BRYG"


async def test_posted_heic_without_ffmpeg_stays_a_file(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app, video_probe_enabled=False)  # a copy: never the shared settings
    as_user(await make_user(db, "aiko"))
    uploaded = await client.post(
        f"{API}/attachments", files={"file": ("IMG_0001.HEIC", GRID, "application/octet-stream")}
    )
    assert uploaded.status_code == 201, uploaded.text
    out = uploaded.json()
    assert out["content_type"] == "image/heic" and out["has_thumbnail"] is False


@needs_heif_ffmpeg
async def test_drive_heic_gets_thumbnail_display_and_capture_time(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    as_user(await make_user(db, "aiko"))
    root = await workspace_root(client)
    photo = await upload_photo(client, root, "IMG_0002.HEIC", GRID)
    assert photo["file"]["has_thumbnail"] is False
    assert await run_media(app) == 1
    shown = (await item(client, photo["id"]))["file"]
    assert shown["has_thumbnail"] is True and shown["has_display"] is True
    assert (shown["width"], shown["height"]) == (768, 1024)
    assert (shown["display_width"], shown["display_height"]) == (768, 1024)
    assert shown["taken_at"].startswith("2026-10-20T05:05:06")
    assert shown["has_location"] is True
    row = await fresh(app, DriveItem, uuid.UUID(photo["id"]))
    assert row.taken_at == datetime(2026, 10, 20, 5, 5, 6, tzinfo=UTC)
    got = await client.get(f"{API}/attachments/{shown['attachment_id']}/display")
    assert got.status_code == 200 and got.headers["content-type"] == "image/webp"
    assert corners(Image.open(io.BytesIO(got.content))) == "BRYG"
    # The original stays the HEIC it was.
    original = await client.get(f"{API}/drive/items/{photo['id']}/content")
    assert original.content == GRID


@needs_heif_ffmpeg
async def test_old_drive_heic_read_by_the_backfill_and_the_lazy_path(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    as_user(await make_user(db, "aiko"))
    root = await workspace_root(client)
    first = await upload_photo(client, root, "a.heic", GRID)
    second = await upload_photo(client, root, "b.heic", SINGLE)
    await run_media(app)
    ids = [uuid.UUID(p["file"]["attachment_id"]) for p in (first, second)]
    # As if stored before AL5: read for its checksum, never as a photo.
    await db.execute(
        update(Attachment)
        .where(Attachment.id.in_(ids))
        .values(
            thumbnail_key=None,
            width=None,
            height=None,
            display_key=None,
            display_bytes=None,
            photo_probed_at=None,
            taken_at=None,
            has_location=False,
        )
    )
    await db.execute(update(DriveItem).values(taken_at=None))
    await db.commit()
    # The viewer asks for a display image: 404 (no HEIC is shown as is), the file queued.
    asked = await client.get(f"{API}/attachments/{ids[1]}/display")
    assert asked.status_code == 404
    version = await fresh(app, DriveFileVersion, uuid.UUID(second["file"]["version_id"]))
    assert version.processed_at is None
    assert await run_media(app) == 1
    assert (await item(client, second["id"]))["file"]["has_thumbnail"] is True
    # The other one through `drive-photos`.
    factory, settings, blobs = app.state.db.session_factory, app.state.settings, app.state.blobs
    counted = await drive_photos.backfill(factory, settings, blobs, limit=10, dry_run=True)
    assert counted.pending == 1
    done = await drive_photos.backfill(factory, settings, blobs, limit=10)
    assert (done.read, done.dated, done.located, done.displays) == (1, 1, 1, 1)
    shown = (await item(client, first["id"]))["file"]
    assert shown["has_thumbnail"] and shown["has_display"] and shown["taken_at"]


async def test_drive_heic_without_ffmpeg_is_left_for_later(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app, video_probe_enabled=False)
    as_user(await make_user(db, "aiko"))
    root = await workspace_root(client)
    photo = await upload_photo(client, root, "a.heic", GRID)
    await run_media(app)
    attachment = await fresh(app, Attachment, uuid.UUID(photo["file"]["attachment_id"]))
    assert attachment.photo_probed_at is None and attachment.thumbnail_key is None
    factory, settings, blobs = app.state.db.session_factory, app.state.settings, app.state.blobs
    done = await drive_photos.backfill(factory, settings, blobs, limit=10)
    assert (done.read, done.skipped_videos) == (0, 1)
