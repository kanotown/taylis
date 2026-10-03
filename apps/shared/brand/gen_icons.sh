#!/bin/sh
# Make every app and site icon from appicon.png (macOS: needs uv, npm ci in apps/desktop, sips,
# iconutil). Run from anywhere; commit what it writes:
#   iOS      apps/ios/ChikuwaChat/Resources/Assets.xcassets/AppIcon.appiconset/icon-1024.png
#   Android  apps/android/app/src/main/res/drawable-*dpi/ic_launcher_{foreground,monochrome}.png,
#            the background colour in res/values/colors.xml
#   Desktop  apps/desktop/src-tauri/icons/* (PNGs and .ico from `tauri icon`, .icns from iconutil)
#   Web      apps/desktop/public/{favicon.ico,favicon-16.png,favicon-32.png,icon-192.png,apple-touch-icon.png}
set -eu
BRAND=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$BRAND/../../.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

uv run --with pillow --with numpy python "$BRAND/gen_icons.py" "$WORK"

# Desktop: Windows / Linux icons from the square artwork. `tauri icon` also writes iOS / Android
# sets, which this repo does not use, so only the files the bundle config names are copied.
ICONS="$ROOT/apps/desktop/src-tauri/icons"
(cd "$ROOT/apps/desktop" && npx tauri icon "$WORK/square-1024.png" -o "$WORK/tauri" >/dev/null)
for f in 32x32.png 64x64.png 128x128.png 128x128@2x.png icon.png icon.ico \
  Square30x30Logo.png Square44x44Logo.png Square71x71Logo.png Square89x89Logo.png \
  Square107x107Logo.png Square142x142Logo.png Square150x150Logo.png Square284x284Logo.png \
  Square310x310Logo.png StoreLogo.png; do
  cp "$WORK/tauri/$f" "$ICONS/$f"
done

# macOS: the rounded square with Apple's margin, so the Dock icon matches the other apps.
SET="$WORK/icon.iconset"
mkdir "$SET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$WORK/macos-1024.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d "$WORK/macos-1024.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o "$ICONS/icon.icns"
echo "icons written"
