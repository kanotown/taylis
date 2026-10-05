#!/usr/bin/env python3
"""Localization checks for the iOS app (Localizable.xcstrings, Japanese source + en + zh-Hans).

  python3 apps/ios/scripts/i18n_check.py leftovers [--stringsdata DIR]
      Japanese string literals in ChikuwaChat/**/*.swift that the compiler did not extract into the catalog (not a
      Text / Button … key, not String(localized:)): what a user would still read in Japanese in English or Chinese.
      DIR holds the build's .stringsdata files (SWIFT_EMIT_LOC_STRINGS); without it the script builds the app for the
      simulator into a scratch DerivedData first. A literal that is data, not UI (a parser's word, a native language
      name), carries `i18n-ignore` in a comment on its line. Exit status 1 when there are leftovers.

  python3 apps/ios/scripts/i18n_check.py sync [--stringsdata DIR]
      Adds the extracted keys to Localizable.xcstrings (xcstringstool sync) — what Xcode does on a build in the IDE.

  python3 apps/ios/scripts/i18n_check.py missing
      Catalog keys without an English or Simplified Chinese translation (the unit test LocalizationTests checks the same).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from swiftstrings import is_japanese, literals  # noqa: E402

IOS = Path(__file__).resolve().parent.parent
SOURCES = IOS / "ChikuwaChat"
CATALOG = SOURCES / "Resources" / "Localizable.xcstrings"
# Generated data, not UI text: the emoji names in Japanese for the picker's search, the error tables (their own languages).
EXCLUDED = {"EmojiData.swift", "ErrorMessages.swift"}
LANGUAGES = ("en", "zh-Hans")


def own_text(body: str) -> str:
    """A literal's text without its interpolations (whose nested literals are checked on their own)."""
    out, i, n = [], 0, len(body)
    while i < n:
        if body.startswith("\\(", i):
            depth, i, quoted = 1, i + 2, False
            while i < n and depth:
                c = body[i]
                if c == '"' and body[i - 1] != "\\":
                    quoted = not quoted
                elif not quoted and c == "(":
                    depth += 1
                elif not quoted and c == ")":
                    depth -= 1
                i += 1
            out.append("%@")
            continue
        out.append(body[i])
        i += 1
    return "".join(out)


def japanese_literals():
    for path in sorted(SOURCES.rglob("*.swift")):
        if path.name in EXCLUDED:
            continue
        src = path.read_text()
        lines = src.split("\n")
        for lit in literals(src):
            if not is_japanese(own_text(lit.body)):
                continue
            if "i18n-ignore" in lines[lit.line - 1]:
                continue
            yield path, lit, lines[lit.line - 1]


def build(derived: Path) -> Path:
    cmd = ["xcodebuild", "-project", str(IOS / "ChikuwaChat.xcodeproj"), "-scheme", "ChikuwaChat",
           "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", str(derived),
           "CODE_SIGNING_ALLOWED=NO", "build"]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL)
    return derived


def stringsdata_files(directory: Path) -> list[Path]:
    files = [p for p in directory.rglob("*.stringsdata") if "ChikuwaChatTests" not in str(p)]
    if not files:
        sys.exit(f"no .stringsdata under {directory} (build with SWIFT_EMIT_LOC_STRINGS=YES)")
    return files


def extracted_locations(files: list[Path]) -> set[tuple[str, int, int]]:
    seen = set()
    for f in files:
        data = json.loads(f.read_text())
        source = str(Path(data["source"]).resolve())
        for table in data.get("tables", {}).values():
            for entry in table:
                loc = entry.get("location")
                if loc:
                    seen.add((source, loc["startingLine"], loc["startingColumn"]))
    return seen


def resolve_stringsdata(arg: str | None) -> list[Path]:
    if arg:
        return stringsdata_files(Path(arg))
    return stringsdata_files(build(Path(tempfile.mkdtemp(prefix="i18n-dd-"))))


def leftovers(args) -> int:
    seen = extracted_locations(resolve_stringsdata(args.stringsdata))
    left = [(p, lit, line) for p, lit, line in japanese_literals() if (str(p.resolve()), lit.line, lit.column) not in seen]
    for path, lit, line in left:
        print(f"{path.relative_to(IOS)}:{lit.line}:{lit.column}: {line.strip()[:160]}")
    print(f"{len(left)} Japanese literal(s) outside the catalog", file=sys.stderr)
    # String(localized:) keeps the language the app was launched in; tr("…") follows the in-app choice at once.
    launched = [(p, n) for p in sorted(SOURCES.rglob("*.swift")) for n, l in enumerate(p.read_text().split("\n"), 1)
                if "String(localized: \"" in l and not l.lstrip().startswith("//")]
    for path, n in launched:
        print(f"{path.relative_to(IOS)}:{n}: String(localized:) — use tr(\"…\")")
    return 1 if left or launched else 0


def sync(args) -> int:
    files = resolve_stringsdata(args.stringsdata)
    subprocess.run(["xcrun", "xcstringstool", "sync", str(CATALOG), "--stringsdata", *map(str, files)], check=True)
    return 0


def missing(_args) -> int:
    catalog = json.loads(CATALOG.read_text())
    bad = []
    for key, entry in catalog["strings"].items():
        if entry.get("shouldTranslate") is False:
            continue
        locs = entry.get("localizations", {})
        for lang in LANGUAGES:
            loc = locs.get(lang)
            if not loc or not (loc.get("stringUnit", {}).get("value") or loc.get("variations")):
                bad.append((lang, key))
    for lang, key in bad:
        print(f"{lang}: {key!r}")
    print(f"{len(bad)} missing translation(s) of {len(catalog['strings'])} keys", file=sys.stderr)
    return 1 if bad else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("leftovers", "sync"):
        p = sub.add_parser(name)
        p.add_argument("--stringsdata", help="directory with the build's .stringsdata files")
    sub.add_parser("missing")
    args = parser.parse_args()
    return {"leftovers": leftovers, "sync": sync, "missing": missing}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
