#!/usr/bin/env python3
"""Replaces the Google Play store-listing screenshots of one language with the images in a directory.

    apps/android/scripts/play-listing.py --screenshots DIR --language ja-JP [--type phoneScreenshots] [--dry-run]

Opens an edit, deletes every image of that type for the language (imagesDeleteAll), uploads the files of DIR in
name order (01.png, 02.png, ...), commits and prints the new images. Texts, the icon, the feature graphic and the
tracks are not touched. The files are checked before anything is sent: 2-8 images, PNG (no alpha) or JPEG, at most
8 MB, 320-3840 px per side and the long side at most 2.3x the short one (Play accepted 1080x2424 phone shots).
--dry-run checks the files and lists the images Play has now, then deletes the edit without changes.

Authentication is play-upload.py's: the service account key in $TAYLIS_PLAY_SERVICE_ACCOUNT, else
~/.config/taylis/play-service-account.json (never commit it). The account needs "manage store presence".
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("play_upload", os.path.join(HERE, "play-upload.py"))
pu = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pu)

TYPES = ("phoneScreenshots", "sevenInchScreenshots", "tenInchScreenshots", "tvScreenshots", "wearScreenshots")
MAX_BYTES = 8 * 1024 * 1024
MAX_RATIO = 2.3


def image_info(path: str) -> tuple[str, int, int, bool]:
    """(mime, width, height, has_alpha) from the file header; standard library only."""
    with open(path, "rb") as f:
        head = f.read(32)
        if head[:8] == b"\x89PNG\r\n\x1a\n" and head[12:16] == b"IHDR":
            w, h = struct.unpack(">II", head[16:24])
            color_type = head[25]
            return "image/png", w, h, color_type in (4, 6)
        if head[:2] == b"\xff\xd8":
            f.seek(2)
            while True:
                marker = f.read(2)
                if len(marker) < 2 or marker[0] != 0xFF:
                    break
                if marker[1] in (0xD8, 0x01) or 0xD0 <= marker[1] <= 0xD7:
                    continue
                (length,) = struct.unpack(">H", f.read(2))
                if 0xC0 <= marker[1] <= 0xCF and marker[1] not in (0xC4, 0xC8, 0xCC):
                    h, w = struct.unpack(">xHH", f.read(5))
                    return "image/jpeg", w, h, False
                f.seek(length - 2, 1)
    sys.exit(f"play-listing: {path} is not a PNG or JPEG image")


def check(files: list[str]) -> list[tuple[str, str]]:
    if not 2 <= len(files) <= 8:
        sys.exit(f"play-listing: {len(files)} images; Play takes 2-8 screenshots per type")
    out = []
    for path in files:
        mime, w, h, alpha = image_info(path)
        size = os.path.getsize(path)
        problems = []
        if alpha:
            problems.append("PNG with alpha (Play wants 24-bit PNG)")
        if size > MAX_BYTES:
            problems.append(f"{size} bytes > 8 MB")
        if min(w, h) < 320 or max(w, h) > 3840:
            problems.append(f"{w}x{h} outside 320-3840 px")
        if max(w, h) / min(w, h) > MAX_RATIO:
            problems.append(f"{w}x{h} aspect above {MAX_RATIO}")
        if problems:
            sys.exit(f"play-listing: {path}: " + "; ".join(problems))
        print(f"  {os.path.basename(path)}  {mime}  {w}x{h}  {size // 1024} KB")
        out.append((path, mime))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--screenshots", required=True, metavar="DIR")
    ap.add_argument("--language", required=True, help="a listing language such as ja-JP")
    ap.add_argument("--type", default="phoneScreenshots", choices=TYPES)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    files = sorted(
        os.path.join(args.screenshots, n)
        for n in os.listdir(args.screenshots)
        if n.lower().endswith((".png", ".jpg", ".jpeg")) and not n.startswith(".")
    )
    print(f"==> {args.type} for {args.language} from {args.screenshots}" + (" (dry run)" if args.dry_run else ""))
    images = check(files)
    key_path = os.environ.get("TAYLIS_PLAY_SERVICE_ACCOUNT") or os.path.expanduser(
        "~/.config/taylis/play-service-account.json"
    )
    if not os.path.isfile(key_path):
        sys.exit(f"play-listing: no service account key at {key_path}")
    token = pu.access_token(key_path)
    edit_id = pu.call(token, "POST", f"{pu.API}/edits", {})["id"]
    path = f"edits/{edit_id}/listings/{args.language}/{args.type}"
    committed = False
    try:
        current = pu.call(token, "GET", f"{pu.API}/{path}").get("images", [])
        print(f"  on Play now: {len(current)} images", [i.get("sha256", "")[:12] for i in current])
        if args.dry_run:
            return
        pu.call(token, "DELETE", f"{pu.API}/{path}")
        for file, mime in images:
            with open(file, "rb") as f:
                res = pu.call(token, "POST", f"{pu.UPLOAD}/{path}?uploadType=media", data=f.read(), ctype=mime)
            img = res.get("image", {})
            print(f"  uploaded {os.path.basename(file)}: id {img.get('id')} sha256 {img.get('sha256', '')[:12]}")
        pu.call(token, "POST", f"{pu.API}/edits/{edit_id}:commit")
        committed = True
        print(f"  committed: {len(images)} {args.type} for {args.language}")
    finally:
        if not committed:
            try:
                pu.call(token, "DELETE", f"{pu.API}/edits/{edit_id}")
            except BaseException as e:  # call() exits on HTTP errors; network errors raise
                print(f"play-listing: could not delete edit {edit_id} ({e}); it expires on its own", file=sys.stderr)


if __name__ == "__main__":
    main()
