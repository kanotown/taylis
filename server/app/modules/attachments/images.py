"""Thumbnails (SECURITY.md §4: bounded pixel count, no EXIF in the output)."""

import io

from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 60_000_000  # decompression-bomb guard: PIL raises above this

IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}


def make_thumbnail(data: bytes, max_px: int) -> tuple[bytes, int, int]:
    """(JPEG bytes, original width, original height). Runs in a thread pool (CPU bound)."""
    with Image.open(io.BytesIO(data)) as image:
        # Phones store portrait photos as landscape pixels plus an EXIF orientation tag; honour it
        # so the thumbnail and the recorded width / height match what the sender saw.
        upright = ImageOps.exif_transpose(image) or image
        width, height = upright.size
        upright.thumbnail((max_px, max_px))
        canvas = upright.convert("RGB")  # drops alpha and, being a fresh image, all metadata
    out = io.BytesIO()
    canvas.save(out, format="JPEG", quality=80, optimize=True)
    return out.getvalue(), width, height
