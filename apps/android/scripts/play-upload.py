#!/usr/bin/env python3
"""Uploads a signed AAB (and its R8 mapping) to a Google Play track with the Play Developer API.

    apps/android/scripts/play-upload.py AAB [--mapping FILE] [--track internal] [--notes-ja FILE] [--notes-en FILE]
                                         [--dry-run]

The service account key is read from $TAYLIS_PLAY_SERVICE_ACCOUNT, else ~/.config/taylis/play-service-account.json
(never commit it). The account needs "release to testing tracks" for the app in Play Console (docs/STORE_RELEASE.md).
Only the standard library and the `openssl` command are used (RS256 for the OAuth JWT), like the iOS release script.
The release goes out with status "completed" on the given track; production is left to Play Console on purpose.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

PACKAGE = "jp.chikuwachat.android"
API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/" + PACKAGE
UPLOAD = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/" + PACKAGE
SCOPE = "https://www.googleapis.com/auth/androidpublisher"


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def access_token(key_path: str) -> str:
    with open(key_path) as f:
        key = json.load(f)
    now = int(time.time())
    header = b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claims = b64url(
        json.dumps(
            {"iss": key["client_email"], "scope": SCOPE, "aud": key["token_uri"], "iat": now, "exp": now + 3600}
        ).encode()
    )
    signing_input = f"{header}.{claims}".encode()
    # The private key only lives in a 0600 temp file for the openssl call.
    fd, pem = tempfile.mkstemp(suffix=".pem")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(key["private_key"])
        sig = subprocess.run(
            ["openssl", "dgst", "-sha256", "-sign", pem], input=signing_input, capture_output=True, check=True
        ).stdout
    finally:
        os.remove(pem)
    jwt = f"{header}.{claims}.{b64url(sig)}"
    body = f"grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion={jwt}".encode()
    req = urllib.request.Request(key["token_uri"], data=body, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    with urllib.request.urlopen(req) as res:
        return json.load(res)["access_token"]


def call(token: str, method: str, url: str, body=None, data: bytes | None = None, ctype="application/json"):
    payload = data if data is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=payload, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    if payload is not None:
        req.add_header("Content-Type", ctype)
    try:
        with urllib.request.urlopen(req, timeout=600) as res:
            text = res.read()
            return json.loads(text) if text else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        sys.exit(f"play-upload: {method} {url.split('/applications/')[-1]} failed: HTTP {e.code}\n{detail}")


def version_code(aab: str) -> int:
    """Reads versionCode from the bundle's manifest via bundletool-free parsing is not trivial (protobuf), so the
    caller passes it in the file name taylis-<name>-<code>.aab (release-android.sh's naming)."""
    stem = os.path.basename(aab)[: -len(".aab")] if aab.endswith(".aab") else os.path.basename(aab)
    try:
        return int(stem.rsplit("-", 1)[1])
    except (IndexError, ValueError):
        sys.exit(f"play-upload: cannot read the versionCode from {aab} (expected taylis-<name>-<code>.aab)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("aab")
    ap.add_argument("--mapping")
    ap.add_argument("--track", default="internal")
    ap.add_argument("--notes-ja")
    ap.add_argument("--notes-en")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not zipfile.is_zipfile(args.aab):
        sys.exit(f"play-upload: not an AAB: {args.aab}")
    code = version_code(args.aab)
    key_path = os.environ.get("TAYLIS_PLAY_SERVICE_ACCOUNT") or os.path.expanduser(
        "~/.config/taylis/play-service-account.json"
    )
    if not os.path.isfile(key_path):
        sys.exit(f"play-upload: no service account key at {key_path}")
    notes = []
    for lang, path in (("ja-JP", args.notes_ja), ("en-US", args.notes_en)):
        if path:
            with open(path) as f:
                text = f.read().strip()
            if len(text) > 500:
                sys.exit(f"play-upload: {lang} release notes are {len(text)} characters (Play allows 500)")
            notes.append({"language": lang, "text": text})

    print(f"==> {PACKAGE} versionCode {code} → track {args.track}" + (" (dry run)" if args.dry_run else ""))
    token = access_token(key_path)
    edit = call(token, "POST", f"{API}/edits", {})
    edit_id = edit["id"]
    try:
        if args.dry_run:
            track = call(token, "GET", f"{API}/edits/{edit_id}/tracks/{args.track}")
            print("  current releases:", [(r.get("name"), r.get("versionCodes"), r.get("status")) for r in track.get("releases", [])])
            return
        with open(args.aab, "rb") as f:
            bundle = call(token, "POST", f"{UPLOAD}/edits/{edit_id}/bundles?uploadType=media", data=f.read(),
                          ctype="application/octet-stream")
        print(f"  uploaded bundle versionCode {bundle.get('versionCode')}")
        if int(bundle.get("versionCode", -1)) != code:
            sys.exit(f"play-upload: Play read versionCode {bundle.get('versionCode')}, the file name says {code}")
        if args.mapping:
            with open(args.mapping, "rb") as f:
                call(token, "POST",
                     f"{UPLOAD}/edits/{edit_id}/apks/{code}/deobfuscationFiles/proguard?uploadType=media",
                     data=f.read(), ctype="application/octet-stream")
            print("  uploaded the R8 mapping")
        release = {"versionCodes": [str(code)], "status": "completed"}
        if notes:
            release["releaseNotes"] = notes
        call(token, "PUT", f"{API}/edits/{edit_id}/tracks/{args.track}", {"track": args.track, "releases": [release]})
        call(token, "POST", f"{API}/edits/{edit_id}:commit")
        print(f"  committed: versionCode {code} is on the {args.track} track")
    finally:
        if args.dry_run:
            call(token, "DELETE", f"{API}/edits/{edit_id}")


if __name__ == "__main__":
    main()
