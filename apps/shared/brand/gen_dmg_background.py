"""The background of the macOS .dmg window: an arrow from the app to Applications and
「Taylis を Applications にドラッグしてください」 (macOS: needs the Hiragino fonts, uv and tiffutil).

    uv run --with pillow python apps/shared/brand/gen_dmg_background.py

Writes (commit them):
- apps/shared/brand/dmg-background.png and dmg-background@2x.png (660 × 400 pt)
- apps/desktop/src-tauri/dmg-background.tiff, both in one file, which Finder shows sharp on a Retina screen; tauri.conf.json
  `bundle.macOS.dmg` uses it, and apps/desktop/scripts/release-desktop.sh lays out its notarised .dmg the same way.

The layout below must match tauri.conf.json `bundle.macOS.dmg` (window size, app and Applications positions, which
are the icons' centres in points).
"""

import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BRAND = Path(__file__).resolve().parent
ROOT = BRAND.parents[2]

WIDTH, HEIGHT = 660, 400
APP = (180, 170)
APPLICATIONS = (480, 170)
ICON = 128  # create-dmg's default icon size

BACKGROUND = (250, 246, 242)
ACCENT = (177, 134, 107)  # the app icon's brown (Android ic_launcher_background)
INK = (60, 48, 40)
MUTED = (120, 108, 98)
FONT_BOLD = "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc"
FONT = "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc"


def draw(scale: int) -> Image.Image:
    s = scale
    image = Image.new("RGB", (WIDTH * s, HEIGHT * s), BACKGROUND)
    d = ImageDraw.Draw(image)
    # The arrow between the two icons (their labels sit under them).
    y = APP[1] * s
    x0 = (APP[0] + ICON // 2 + 22) * s
    x1 = (APPLICATIONS[0] - ICON // 2 - 22) * s
    head = 18 * s
    d.line([(x0, y), (x1 - head // 2, y)], fill=ACCENT, width=7 * s)
    d.ellipse([x0 - 4 * s, y - 4 * s, x0 + 4 * s, y + 4 * s], fill=ACCENT)
    d.polygon([(x1, y), (x1 - head, y - head * 0.8), (x1 - head, y + head * 0.8)], fill=ACCENT)
    # The words, centred under the icons' labels.
    title = ImageFont.truetype(FONT_BOLD, 19 * s)
    sub = ImageFont.truetype(FONT, 13 * s)
    d.text((WIDTH * s / 2, 300 * s), "Taylis を Applications にドラッグしてください", font=title, fill=INK, anchor="mm")
    d.text((WIDTH * s / 2, 332 * s), "Drag Taylis to the Applications folder to install it", font=sub, fill=MUTED, anchor="mm")
    return image


def main() -> None:
    one = BRAND / "dmg-background.png"
    two = BRAND / "dmg-background@2x.png"
    draw(1).save(one, optimize=True, dpi=(72, 72))
    draw(2).save(two, optimize=True, dpi=(144, 144))
    tiff = ROOT / "apps/desktop/src-tauri/dmg-background.tiff"
    subprocess.run(["tiffutil", "-cathidpicheck", str(one), str(two), "-out", str(tiff)], check=True)
    print(f"wrote {one.name}, {two.name} and {tiff.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
