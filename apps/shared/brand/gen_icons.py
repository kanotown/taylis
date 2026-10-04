"""Make the app and site icons from appicon.png (run through gen_icons.sh, which also runs
`tauri icon` and iconutil).

The source is a flat squirrel on a flat brown background, square, no alpha. Writes:

- iOS: the 1024 px AppIcon (no alpha; iOS rounds the corners itself)
- Android: the adaptive icon layers. The background is the brown sampled from the source's
  corner (colors.xml); the foreground is the squirrel cut out of the source, scaled so that it
  sits inside the 66 dp safe circle of the 108 dp layer (so no launcher mask clips the ears or
  the tail); the monochrome layer (themed icons, Android 13+) is the squirrel's silhouette cut
  by lines around its white parts
- Web: favicon.ico (16/32/48) and PNGs, apple-touch-icon; the small sizes use a tighter crop
  so the squirrel stays readable at 16 px
- Scratch files for gen_icons.sh: the square source for `tauri icon` and a macOS-style icon
  (rounded square with the usual margin) for the .icns
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

BRAND = Path(__file__).resolve().parent
ROOT = BRAND.parents[2]
SRC = BRAND / "appicon.png"
LANCZOS = Image.Resampling.LANCZOS

# Android: the layer is 108 dp; the safe zone is a 66 dp circle. Keep the squirrel 1 dp inside it.
LAYER_DP = 108
SAFE_RADIUS_DP = 32
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}


def main(scratch: Path) -> None:
    src = flatten(Image.open(SRC).convert("RGB"))
    px = np.asarray(src).astype(int)
    size = src.width
    bg = np.median(px[:40, :40].reshape(-1, 3), axis=0).astype(int)
    bg_hex = "#{:02X}{:02X}{:02X}".format(*bg)

    # The squirrel: pixels clearly off the background.
    diff = np.abs(px - bg).max(axis=2)
    ys, xs = np.nonzero(diff > 20)
    cx, cy, radius = enclosing_circle(xs, ys)
    print(f"background {bg_hex}; squirrel circle ({cx}, {cy}) r={radius:.0f} px of {size}")

    # iOS
    ios = ROOT / "apps/ios/ChikuwaChat/Resources/Assets.xcassets/AppIcon.appiconset/icon-1024.png"
    src.resize((1024, 1024), LANCZOS).save(ios, optimize=True)

    # Android foreground: the source pixels inside the squirrel grown by a few pixels (the edge
    # blends with the brown, which matches the background layer), transparent elsewhere.
    grown = Image.fromarray(((diff > 12) * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(9))
    grown = grown.filter(ImageFilter.GaussianBlur(2))
    fg = src.convert("RGBA")
    fg.putalpha(grown)
    mono = Image.new("RGBA", src.size, (255, 255, 255, 0))
    mono.putalpha(silhouette(px, diff))

    res = ROOT / "apps/android/app/src/main/res"
    # Source pixels per dp so that the squirrel's circle is SAFE_RADIUS_DP.
    per_dp = radius / SAFE_RADIUS_DP
    box_half = per_dp * LAYER_DP / 2
    box = (cx - box_half, cy - box_half, cx + box_half, cy + box_half)
    for name, scale in DENSITIES.items():
        out = round(LAYER_DP * scale)
        folder = res / f"drawable-{name}"
        folder.mkdir(exist_ok=True)
        layer(fg, box, out).save(folder / "ic_launcher_foreground.png", optimize=True)
        layer(mono, box, out).save(folder / "ic_launcher_monochrome.png", optimize=True)
    colors = res / "values/colors.xml"
    text = colors.read_text()
    tag = '<color name="ic_launcher_background">'
    start = text.index(tag) + len(tag)
    end = text.index("</color>", start)
    colors.write_text(text[:start] + bg_hex + text[end:])

    # Web
    public = ROOT / "apps/desktop/public"
    public.mkdir(exist_ok=True)
    half = max(xs.max() - xs.min(), ys.max() - ys.min()) / 2 * 1.08
    mx, my = (xs.max() + xs.min()) / 2, (ys.max() + ys.min()) / 2
    tight = src.crop((round(mx - half), round(my - half), round(mx + half), round(my + half)))
    # Rounded tiles (2026-10-04: a hard square read as a block in browser tabs); drawn at 8x, then reduced.
    small = {n: rounded_tile(tight, n) for n in (16, 32, 48)}
    small[48].save(
        public / "favicon.ico",
        sizes=[(16, 16), (32, 32), (48, 48)],
        append_images=[small[16], small[32]],
    )
    small[16].save(public / "favicon-16.png", optimize=True)
    small[32].save(public / "favicon-32.png", optimize=True)
    rounded_tile(src, 192).save(public / "icon-192.png", optimize=True)
    src.resize((180, 180), LANCZOS).save(public / "apple-touch-icon.png", optimize=True)

    # For gen_icons.sh: the square source for `tauri icon`, and the macOS icon (824 px rounded
    # square on a 1024 px transparent canvas, as in Apple's template).
    scratch.mkdir(parents=True, exist_ok=True)
    # Windows (.ico and the PNGs `tauri icon` makes): a rounded square with a small margin, like the
    # other apps on Windows 11, instead of a hard-edged block.
    win = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    win.alpha_composite(rounded_tile(src, 984), (20, 20))
    win.save(scratch / "square-1024.png")
    mac = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    body = src.convert("RGBA").resize((824, 824), LANCZOS)
    body.putalpha(rounded_mask(824, 185))
    mac.alpha_composite(body, (100, 100))
    mac.save(scratch / "macos-1024.png")


def flatten(img: Image.Image) -> Image.Image:
    """Snap the source's faint grain to its few flat colours (edges stay as they are). The
    artwork is flat, and grain-free PNGs are a fraction of the size."""
    px = np.asarray(img).astype(int)
    q = img.quantize(64, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    counts = np.bincount(np.asarray(q).ravel(), minlength=64)
    palette = np.array(q.getpalette()[: 64 * 3]).reshape(-1, 3)
    flat: list[np.ndarray] = []
    for i in np.argsort(-counts):
        if counts[i] < 2000:  # anti-aliased edges, not an area
            break
        if all(np.abs(palette[i] - f).max() > 14 for f in flat):
            flat.append(palette[i])
    colors = np.array(flat)
    dist = np.abs(px[:, :, None, :] - colors[None, None]).max(axis=-1)
    snapped = np.where((dist.min(axis=-1) <= 12)[..., None], colors[dist.argmin(axis=-1)], px)
    return Image.fromarray(snapped.astype(np.uint8))


def silhouette(px: np.ndarray, diff: np.ndarray) -> Image.Image:
    """The squirrel as one filled shape (some of its patches are close to the background brown, so
    the holes are filled) cut by thin lines around its white parts (face, eye, belly, tail curl),
    anti-aliased: a stencil that still reads as this squirrel in one colour."""
    sums = px.sum(axis=2)
    shape = closed(diff > 20)
    ImageDraw.floodfill(shape, (0, 0), 128)  # the outside
    filled = np.asarray(shape) != 128
    light = np.asarray(closed(sums > 560, opening=True)) > 0
    dark = sums < 300
    stray_dark = dark & ~(np.asarray(closed(dark, opening=True)) > 0)  # hairlines at patch edges
    light_img = Image.fromarray((light * 255).astype(np.uint8))
    outline = (np.asarray(light_img.filter(ImageFilter.MaxFilter(15))) > 0) & ~(
        np.asarray(light_img.filter(ImageFilter.MinFilter(15))) > 0
    )
    result = filled & ~outline & ~stray_dark
    return Image.fromarray((result * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1))


def closed(mask: np.ndarray, opening: bool = False) -> Image.Image:
    """Morphological close (or open) with a 5 px square, as an L image."""
    img = Image.fromarray((mask * 255).astype(np.uint8))
    grow, shrink = ImageFilter.MaxFilter(5), ImageFilter.MinFilter(5)
    return img.filter(shrink).filter(grow) if opening else img.filter(grow).filter(shrink)


def enclosing_circle(xs: np.ndarray, ys: np.ndarray) -> tuple[int, int, float]:
    """A near-smallest circle around the points (a coarse-to-fine search is plenty here)."""
    pts = np.stack([xs, ys], axis=1)
    best = (int(xs.mean()), int(ys.mean()))
    step = 32
    while step >= 1:
        cands = [
            (best[0] + dx * step, best[1] + dy * step) for dx in (-1, 0, 1) for dy in (-1, 0, 1)
        ]
        best = min(cands, key=lambda c: ((pts - c) ** 2).sum(axis=1).max())
        if best == cands[4]:
            step //= 2
    radius = float(np.sqrt(((pts - best) ** 2).sum(axis=1).max()))
    return best[0], best[1], radius


def layer(img: Image.Image, box: tuple[float, float, float, float], out: int) -> Image.Image:
    """Crop `box` (past the edges the crop is transparent) and scale it to out x out."""
    return img.crop(tuple(round(v) for v in box)).resize((out, out), LANCZOS)


def rounded_tile(img: Image.Image, size: int, corner: float = 0.22) -> Image.Image:
    """The image as a size x size tile with rounded corners (radius = corner x size), transparent
    outside, drawn at 8x and reduced so small favicons keep smooth corners."""
    big = img.convert("RGBA").resize((size * 8, size * 8), LANCZOS)
    big.putalpha(rounded_mask(size * 8, round(size * 8 * corner)))
    return big.resize((size, size), LANCZOS)


def rounded_mask(size: int, radius: int) -> Image.Image:
    big = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(big).rounded_rectangle((0, 0, size * 4 - 1, size * 4 - 1), radius * 4, fill=255)
    return big.resize((size, size), LANCZOS)


if __name__ == "__main__":
    main(Path(sys.argv[1]))
