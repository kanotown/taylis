"""Thumbnails of see-through images (docs/PREVIEWS.md §17, 2026-11-14): a WebP with the alpha, not a
JPEG that showed the hidden colours (black, or leftover noise) where the image was see-through."""

import io
import uuid
from collections.abc import Callable
from typing import Any

from fastapi import FastAPI
from httpx import AsyncClient
from PIL import Image
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.modules.attachments import service as attachments
from app.modules.attachments.images import make_thumbnail, thumbnail_bytes, thumbnail_type
from app.modules.attachments.thumb_backfill import rebuild_see_through_thumbnails
from app.modules.users.models import User
from tests.helpers import make_user


def encoded(image: Image.Image, fmt: str, **options: Any) -> bytes:
    out = io.BytesIO()
    image.save(out, format=fmt, **options)
    return out.getvalue()


def see_through_png(width: int = 64, height: int = 48) -> bytes:
    """Red on the right half; the left half see-through, with noise left under the transparency (a
    picture editor keeps whatever colour a cleared pixel had)."""
    picture = Image.new("RGBA", (width, height), (255, 0, 0, 255))
    for x in range(width // 2):
        for y in range(height):
            picture.putpixel((x, y), ((x * 37) % 256, (y * 91) % 256, (x * y) % 256, 0))
    return encoded(picture, "PNG")


def opened(data: bytes) -> Image.Image:
    image = Image.open(io.BytesIO(data))
    image.load()
    return image


def rgba_at(image: Image.Image, xy: tuple[int, int]) -> tuple[int, int, int, int]:
    pixel = image.convert("RGBA").getpixel(xy)
    assert isinstance(pixel, tuple)
    return (int(pixel[0]), int(pixel[1]), int(pixel[2]), int(pixel[3]))


def test_a_see_through_image_keeps_its_alpha() -> None:
    thumb, width, height = make_thumbnail(see_through_png(), 512)
    assert (width, height) == (64, 48)
    assert thumbnail_type(thumb) == "image/webp"
    decoded = opened(thumb)
    assert decoded.format == "WEBP" and decoded.mode == "RGBA"
    assert rgba_at(decoded, (4, 24))[3] == 0  # see-through, not black or noise
    red, green, blue, alpha = rgba_at(decoded, (60, 24))
    assert alpha == 255 and red > 200 and green < 60 and blue < 60
    assert decoded.info.get("exif") is None

    # Scaled down too, with the alpha.
    big, _, _ = make_thumbnail(see_through_png(1024, 512), 256)
    assert opened(big).size == (256, 128) and rgba_at(opened(big), (10, 64))[3] == 0


def test_every_way_an_image_can_be_see_through() -> None:
    # A palette with a transparent index (a GIF, an indexed PNG).
    palette = Image.new("P", (16, 16), 1)
    palette.putpalette([0, 0, 0, 255, 255, 255] + [0] * 762)
    palette.paste(0, (0, 0, 8, 16))
    for fmt in ("GIF", "PNG"):
        thumb, _, _ = make_thumbnail(encoded(palette, fmt, transparency=0), 512)
        assert thumbnail_type(thumb) == "image/webp", fmt
        assert rgba_at(opened(thumb), (2, 2))[3] == 0 and rgba_at(opened(thumb), (12, 2))[3] == 255
    # Grey with alpha.
    grey = Image.new("LA", (16, 16), (128, 255))
    grey.paste((128, 0), (0, 0, 8, 16))
    thumb, _, _ = make_thumbnail(encoded(grey, "PNG"), 512)
    assert thumbnail_type(thumb) == "image/webp" and rgba_at(opened(thumb), (2, 2))[3] == 0
    # An RGB PNG with a transparent colour (tRNS).
    keyed = Image.new("RGB", (16, 16), (0, 128, 0))
    keyed.paste((255, 255, 255), (0, 0, 8, 16))
    thumb, _, _ = make_thumbnail(encoded(keyed, "PNG", transparency=(255, 255, 255)), 512)
    assert thumbnail_type(thumb) == "image/webp" and rgba_at(opened(thumb), (2, 2))[3] == 0
    # A WebP with alpha.
    thumb, _, _ = make_thumbnail(encoded(opened(see_through_png()), "WEBP", lossless=True), 512)
    assert thumbnail_type(thumb) == "image/webp" and rgba_at(opened(thumb), (4, 24))[3] == 0


def test_an_opaque_image_stays_a_jpeg() -> None:
    # An alpha channel with nothing see-through in it (a screenshot saved as RGBA).
    solid = Image.new("RGBA", (32, 32), (0, 0, 255, 255))
    for source in (encoded(solid, "PNG"), encoded(solid.convert("RGB"), "PNG")):
        thumb, _, _ = make_thumbnail(source, 512)
        assert thumbnail_type(thumb) == "image/jpeg" and opened(thumb).format == "JPEG"
    # HEIC stills go through thumbnail_bytes with RGB pixels.
    assert thumbnail_type(thumbnail_bytes(Image.new("RGB", (8, 8)), 512)) == "image/jpeg"
    assert thumbnail_type(b"") == "image/jpeg"
    assert thumbnail_type(b"RIFF\x00\x00\x00\x00WAVE") == "image/jpeg"


async def test_the_thumbnail_is_served_as_what_it_is(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    uploaded = await client.post(
        "/api/v1/attachments", files={"file": ("logo.png", see_through_png(), "image/png")}
    )
    assert uploaded.status_code == 201, uploaded.text
    meta = uploaded.json()
    assert meta["has_thumbnail"] is True and (meta["width"], meta["height"]) == (64, 48)
    thumb = await client.get(f"/api/v1/attachments/{meta['id']}/thumbnail")
    assert thumb.status_code == 200 and thumb.headers["content-type"] == "image/webp"
    assert thumb.headers["x-content-type-options"] == "nosniff"
    assert rgba_at(opened(thumb.content), (4, 24))[3] == 0


async def _old_thumbnail(app: FastAPI, client: AsyncClient, name: str, data: bytes) -> str:
    """Uploads `data` and puts back the JPEG the server made before §17 (alpha dropped)."""
    meta = (
        await client.post("/api/v1/attachments", files={"file": (name, data, "image/png")})
    ).json()
    flattened = encoded(opened(data).convert("RGB"), "JPEG")
    key = attachments.thumbnail_key(uuid.UUID(meta["id"]))
    await app.state.blobs.put(key, flattened, "image/jpeg")
    return str(meta["id"])


async def rebuild(app: FastAPI, settings: Settings, **kwargs: Any) -> Any:
    async with app.state.db.session_factory() as session:
        return await rebuild_see_through_thumbnails(session, app.state.blobs, settings, **kwargs)


async def test_rebuild_remakes_only_the_flattened_see_through_ones(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    test_settings: Settings,
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    first = await _old_thumbnail(app, client, "a.png", see_through_png())
    opaque = await _old_thumbnail(app, client, "b.png", encoded(Image.new("RGB", (8, 8)), "PNG"))
    second = await _old_thumbnail(app, client, "c.png", see_through_png(20, 20))
    jpeg = (
        await client.post(
            "/api/v1/attachments",
            files={"file": ("d.jpg", encoded(Image.new("RGB", (8, 8)), "JPEG"), "image/jpeg")},
        )
    ).json()["id"]

    async def served(attachment_id: str) -> str:
        got = await client.get(f"/api/v1/attachments/{attachment_id}/thumbnail")
        assert got.status_code == 200
        return str(got.headers["content-type"])

    assert [await served(i) for i in (first, opaque, second)] == ["image/jpeg"] * 3

    dry = await rebuild(app, test_settings, dry_run=True)
    assert dry.pending == 3 and dry.pending_bytes > 0  # the JPEG cannot be see-through

    # One original a run: the run says where to go on.
    part = await rebuild(app, test_settings, limit=1)
    assert (part.read, part.rebuilt, part.remaining) == (1, 1, True)
    assert str(part.last) == first and await served(first) == "image/webp"
    rest = await rebuild(app, test_settings, after=part.last)
    assert (rest.checked, rest.read, rest.rebuilt, rest.remaining) == (2, 2, 1, False)
    assert await served(opaque) == "image/jpeg" and await served(second) == "image/webp"
    got = await client.get(f"/api/v1/attachments/{second}/thumbnail")
    assert rgba_at(opened(got.content), (2, 10))[3] == 0
    assert await served(jpeg) == "image/jpeg"

    # Again from the start: the WebPs are skipped without reading their originals.
    again = await rebuild(app, test_settings)
    assert (again.checked, again.read, again.rebuilt, again.failed) == (3, 1, 0, [])
