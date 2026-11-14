"""Thumbnails (SECURITY.md §4: bounded pixel count, no EXIF in the output)."""

import io
from typing import IO

from PIL import Image, ImageOps

# The most pixels an image may have (width by height): read from the header before a single
# pixel is decoded, since decoding is what costs the memory (four bytes a pixel, twice over
# with the EXIF transpose). 50 Mpx covers a 48 Mpx phone photo; PIL's own guard below stays as a
# ceiling for the code paths that open images without this check.
MAX_PIXELS = 50_000_000
Image.MAX_IMAGE_PIXELS = 60_000_000  # decompression-bomb guard: PIL raises above twice this

IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}


class ImageTooLarge(ValueError):
    """More pixels than MAX_PIXELS; the caller answers 422 image_too_large."""


def open_checked(source: IO[bytes] | bytes) -> Image.Image:
    """Image.open (lazy: the header only) with the pixel count checked before anything decodes."""
    try:
        image = Image.open(io.BytesIO(source) if isinstance(source, bytes) else source)
    except Image.DecompressionBombError as exc:  # PIL's ceiling, from the header too
        raise ImageTooLarge(str(exc)) from exc
    width, height = image.size
    if width * height > MAX_PIXELS:
        image.close()
        raise ImageTooLarge(f"{width}x{height} exceeds {MAX_PIXELS} pixels")
    return image


def make_thumbnail(source: IO[bytes] | bytes, max_px: int) -> tuple[bytes, int, int]:
    """(thumbnail bytes, original width, original height): a JPEG, or a WebP for an image with
    see-through pixels (`thumbnail_bytes`). Runs in a thread pool (CPU bound)."""
    with open_checked(source) as image:
        # Phones store portrait photos as landscape pixels plus an EXIF orientation tag; honour it
        # so the thumbnail and the recorded width / height match what the sender saw.
        upright = ImageOps.exif_transpose(image) or image
        width, height = upright.size
        return thumbnail_bytes(upright, max_px), width, height


def thumbnail_bytes(upright: Image.Image, max_px: int) -> bytes:
    """The thumbnail of an upright image, which is scaled down in place: a JPEG, or a WebP with
    its alpha when some pixels are see-through (docs/PREVIEWS.md §17). Flattened into a JPEG, those
    pixels showed the colour they kept under the transparency: mostly black, else leftover noise."""
    rgba = _with_alpha(upright)
    if rgba is not None:
        rgba.thumbnail((max_px, max_px))  # Pillow scales RGBA premultiplied: no dark fringes
        lowest = rgba.getchannel("A").getextrema()[0]
        if not isinstance(lowest, tuple) and lowest < 255:  # one band: a number
            clean = Image.new("RGBA", rgba.size)  # a fresh image: none of the original's metadata
            clean.paste(rgba)
            out = io.BytesIO()
            clean.save(out, format="WEBP", quality=80, method=4)
            return out.getvalue()
        upright = rgba  # an alpha channel with nothing see-through in it: a JPEG
    upright.thumbnail((max_px, max_px))
    canvas = upright.convert("RGB")  # being a fresh image, it carries no metadata
    out = io.BytesIO()
    canvas.save(out, format="JPEG", quality=80, optimize=True)
    return out.getvalue()


def _with_alpha(image: Image.Image) -> Image.Image | None:
    """An RGBA copy of an image that can have see-through pixels (an alpha channel, a palette's or a
    PNG's transparent colour); None for an opaque one."""
    if image.mode in ("RGBA", "RGBa", "LA", "La", "PA") or "transparency" in image.info:
        return image.convert("RGBA")
    return None


def thumbnail_type(head: bytes) -> str:
    """A stored thumbnail's media type, from its first bytes: a see-through image's WebP, else a
    JPEG (every thumbnail and video poster made before 2026-11-14 is one)."""
    return "image/webp" if head[:4] == b"RIFF" and head[8:12] == b"WEBP" else "image/jpeg"
