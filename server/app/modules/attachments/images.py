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
    """(JPEG bytes, original width, original height). Runs in a thread pool (CPU bound)."""
    with open_checked(source) as image:
        # Phones store portrait photos as landscape pixels plus an EXIF orientation tag; honour it
        # so the thumbnail and the recorded width / height match what the sender saw.
        upright = ImageOps.exif_transpose(image) or image
        width, height = upright.size
        return thumbnail_jpeg(upright, max_px), width, height


def thumbnail_jpeg(upright: Image.Image, max_px: int) -> bytes:
    """The thumbnail JPEG of an upright image, which is scaled down in place."""
    upright.thumbnail((max_px, max_px))
    canvas = upright.convert("RGB")  # drops alpha and, being a fresh image, all metadata
    out = io.BytesIO()
    canvas.save(out, format="JPEG", quality=80, optimize=True)
    return out.getvalue()
