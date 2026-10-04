#!/usr/bin/env python3
"""The emoji the three clients offer (M11f): emoji.json, and the per-platform tables generated from it.

    python3 apps/shared/gen_emoji.py            # emoji.json → the tables (after editing the JSON by hand)
    python3 apps/shared/gen_emoji.py --update   # rebuild emoji.json from the pinned sources below, then the tables

`--update` (2026-10-04: the hand-made list had 253 emoji, no 🎓) reads every fully-qualified emoji of Unicode's
emoji-test.txt (version EMOJI_VERSION) except the skin-tone variants and the components, in Unicode's order and
groups. The shortcode is the one the list had (old messages' `:shortcode:` keep showing), else Slack's (iamcal
emoji-data), else one made from the English CLDR name. The keywords are the list's own words, Slack's other names
and the English and Japanese CLDR annotations, so 「卒業」「帽子」 find 🎓. A glyph that a reaction would refuse
(server is_plain_emoji: keycaps start with ASCII, ℹ️ is a letter) is left out. `--cache DIR` keeps the downloads.
"""

from __future__ import annotations

import argparse
import json
import re
import tempfile
import unicodedata
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
JSON_PATH = Path(__file__).parent / "emoji.json"
HEADER = "Generated from apps/shared/emoji.json by apps/shared/gen_emoji.py; do not edit by hand."

# Pinned sources. 17.0 rather than 18.0 (2026-09): the systems' emoji fonts do not draw 18.0 yet.
EMOJI_VERSION = "17.0.0"
CLDR_VERSION = "48.2.3"
IAMCAL_VERSION = "v16.0.0"
_CLDR = f"https://raw.githubusercontent.com/unicode-org/cldr-json/{CLDR_VERSION}/cldr-json"
SOURCES = {
    "emoji-test.txt": f"https://unicode.org/Public/{EMOJI_VERSION}/emoji/emoji-test.txt",
    "cldr-ja.json": f"{_CLDR}/cldr-annotations-full/annotations/ja/annotations.json",
    "cldr-ja-derived.json": f"{_CLDR}/cldr-annotations-derived-full/annotationsDerived/ja/annotations.json",
    "cldr-en.json": f"{_CLDR}/cldr-annotations-full/annotations/en/annotations.json",
    "cldr-en-derived.json": f"{_CLDR}/cldr-annotations-derived-full/annotationsDerived/en/annotations.json",
    "iamcal.json": f"https://raw.githubusercontent.com/iamcal/emoji-data/{IAMCAL_VERSION}/emoji.json",
}

# Unicode's groups → the pickers' categories (Component is left out).
GROUPS = {
    "Smileys & Emotion": ("smileys", "顔"),
    "People & Body": ("people", "人・手"),
    "Animals & Nature": ("nature", "動物・自然"),
    "Food & Drink": ("food", "食べ物"),
    "Travel & Places": ("travel", "場所・乗り物"),
    "Activities": ("activities", "活動"),
    "Objects": ("objects", "物"),
    "Symbols": ("symbols", "記号"),
    "Flags": ("flags", "旗"),
}
SKIN_TONES = {chr(c) for c in range(0x1F3FB, 0x1F400)}
SHORTCODE = re.compile(r"^[a-z0-9_+\-]{1,30}$")
# Words the sources lack that people here look for (2026-10-04: 「academic」 for 🎓).
EXTRA_KEYWORDS = {"🎓": "academic 学位 卒業式 大学"}


def is_plain_emoji(value: str) -> bool:
    """server/app/modules/users/schemas.py is_plain_emoji: what a reaction / quick reaction accepts."""
    if not 1 <= len(value) <= 16:
        return False
    symbol = False
    for char in value:
        category = unicodedata.category(char)
        if ord(char) < 0x80 or category[0] in "LNZ" or category in ("Cc", "Cs", "Co"):
            return False
        symbol = symbol or category[0] in "SP" or category == "Cn"
    return symbol


def bare(glyph: str) -> str:
    return glyph.replace("️", "")


def fetch(cache: Path) -> dict[str, Path]:
    cache.mkdir(parents=True, exist_ok=True)
    paths = {}
    for name, url in SOURCES.items():
        path = cache / f"{name}"
        if not path.exists():
            print(f"downloading {url}")
            urllib.request.urlretrieve(url, path)
        paths[name] = path
    return paths


def read_emoji_test(path: Path) -> list[tuple[str, str, str]]:
    """(glyph, group, English name) of each fully-qualified emoji, in Unicode's order."""
    rows = []
    group = ""
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("# group:"):
            group = line.split(":", 1)[1].strip()
            continue
        if not line or line.startswith("#"):
            continue
        points, rest = line.split(";", 1)
        status, comment = rest.split("#", 1)
        if status.strip() != "fully-qualified":
            continue
        glyph = "".join(chr(int(p, 16)) for p in points.split())
        name = re.sub(r"^\S+\s+E\d+\.\d+\s+", "", comment.strip())
        rows.append((glyph, group, name))
    return rows


def read_cldr(*paths: Path) -> dict[str, list[str]]:
    """Bare glyph → the annotation words and the spoken name."""
    out: dict[str, list[str]] = {}
    for path in paths:
        data = json.loads(path.read_text(encoding="utf-8"))
        table = data.get("annotations") or data.get("annotationsDerived")
        for glyph, entry in table["annotations"].items():
            out.setdefault(bare(glyph), []).extend(entry.get("tts", []) + entry.get("default", []))
    return out


def slug(name: str) -> str:
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-z0-9+\-]+", "_", ascii_name.lower()).strip("_")
    return text[:30].rstrip("_") or "emoji"


def words(*groups: list[str] | str) -> str:
    seen: list[str] = []
    for group in groups:
        # Single words (an annotation like 「thumbs up」 too): a second --update gives the same list.
        for word in (group if isinstance(group, str) else " ".join(group)).split():
            word = word.strip()
            if word and word not in seen:
                seen.append(word)
    return " ".join(seen)


def update(cache: Path) -> None:
    paths = fetch(cache)
    current = json.loads(JSON_PATH.read_text(encoding="utf-8"))
    curated = {bare(g): (s, k) for s, g, _c, k in current["emoji"]}
    en = read_cldr(paths["cldr-en.json"], paths["cldr-en-derived.json"])
    ja = read_cldr(paths["cldr-ja.json"], paths["cldr-ja-derived.json"])
    slack: dict[str, list[str]] = {}
    for row in json.loads(paths["iamcal.json"].read_text(encoding="utf-8")):
        glyph = "".join(chr(int(p, 16)) for p in row["unified"].split("-"))
        slack[bare(glyph)] = [n for n in row["short_names"] if SHORTCODE.match(n)]

    picked = []
    left_out = []
    for glyph, group, name in read_emoji_test(paths["emoji-test.txt"]):
        if group not in GROUPS or SKIN_TONES & set(glyph):
            continue
        if not is_plain_emoji(glyph):
            left_out.append(f"{glyph} {name}")
            continue
        picked.append((glyph, GROUPS[group][0], name))

    used = {s for s, _k in curated.values()}
    rows = []
    found_curated = set()
    for glyph, category, name in picked:
        key = bare(glyph)
        names = slack.get(key, [])
        if key in curated:
            shortcode, own = curated[key]
            found_curated.add(key)
        else:
            shortcode = next((n for n in names if n not in used), None)
            if shortcode is None:
                base = slug(name)
                shortcode, n = base, 2
                while shortcode in used:
                    shortcode = f"{base[:27]}_{n}"
                    n += 1
            used.add(shortcode)
            own = ""
        keywords = words(own, [n for n in names if n != shortcode], en.get(key, []), ja.get(key, []), EXTRA_KEYWORDS.get(key, ""))
        rows.append([shortcode, glyph, category, keywords])
    missing = [s for s, g, _c, _k in current["emoji"] if bare(g) not in found_curated]
    assert not missing, f"the old list's emoji are not in the new one: {missing}"

    out = {
        "_comment": "Emoji dataset shared by the three clients (M11f). Fields: shortcode (Slack / GitHub style), glyph, category, keywords (en + ja). Built by `gen_emoji.py --update` from the pinned sources in _sources (every fully-qualified emoji except the skin-tone variants, components and glyphs a reaction refuses); small hand edits are fine, then run gen_emoji.py.",
        "_sources": {"unicode_emoji": EMOJI_VERSION, "cldr_annotations": CLDR_VERSION, "slack_shortcodes_iamcal": IAMCAL_VERSION},
        "categories": [list(v) for v in GROUPS.values()],
        "emoji": rows,
    }
    text = json.dumps(out, ensure_ascii=False, indent=2)
    # One emoji per line, as before.
    text = re.sub(r"\[\n\s+(\"[^\n]*\",)\n\s+(\"[^\n]*\",)\n\s+(\"[^\n]*\",)\n\s+(\"[^\n]*\")\n\s+\]", r"[\1 \2 \3 \4]", text)
    text = re.sub(r"\[\n\s+(\"[^\n]*\",)\n\s+(\"[^\n]*\")\n\s+\]", r"[\1 \2]", text)
    JSON_PATH.write_text(text + "\n", encoding="utf-8")
    print(f"emoji.json: {len(rows)} emoji (Unicode {EMOJI_VERSION}); left out (a reaction refuses them): {', '.join(left_out)}")


DATA: dict = {}


def ts() -> str:
    lines = [f"// {HEADER}", "", "export interface EmojiEntry {", "  shortcode: string;", "  glyph: string;", "  category: string;", "  keywords: string;", "}", "",
             "export const EMOJI_CATEGORIES: Array<[string, string]> = ["]
    lines += [f'  ["{key}", "{label}"],' for key, label in DATA["categories"]]
    lines += ["];", "", "export const EMOJI: EmojiEntry[] = ["]
    lines += [f'  {{ shortcode: {json.dumps(s, ensure_ascii=False)}, glyph: "{g}", category: "{c}", keywords: {json.dumps(k, ensure_ascii=False)} }},' for s, g, c, k in DATA["emoji"]]
    lines += ["];", ""]
    return "\n".join(lines)


def swift() -> str:
    lines = [f"// {HEADER}", "", "struct EmojiEntry: Hashable {", "    let shortcode: String", "    let glyph: String", "    let category: String", "    let keywords: String", "}", "",
             "enum EmojiData {", "    static let categories: [(key: String, label: String)] = ["]
    lines += [f'        ("{key}", "{label}"),' for key, label in DATA["categories"]]
    lines += ["    ]", "", "    static let all: [EmojiEntry] = ["]
    lines += [f'        EmojiEntry(shortcode: {json.dumps(s, ensure_ascii=False)}, glyph: "{g}", category: "{c}", keywords: {json.dumps(k, ensure_ascii=False)}),' for s, g, c, k in DATA["emoji"]]
    lines += ["    ]", "}", ""]
    return "\n".join(lines)


# A JVM method holds at most 64 KB of bytecode: the Kotlin list is built in parts.
KOTLIN_PART = 200


def kotlin() -> str:
    rows = DATA["emoji"]
    parts = [rows[i:i + KOTLIN_PART] for i in range(0, len(rows), KOTLIN_PART)]
    lines = ["package jp.chikuwachat.android.ui", "", f"// {HEADER}", "",
             "data class EmojiEntry(val shortcode: String, val glyph: String, val category: String, val keywords: String)", "",
             "object EmojiData {", "    val categories: List<Pair<String, String>> = listOf("]
    lines += [f'        "{key}" to "{label}",' for key, label in DATA["categories"]]
    lines += ["    )", "", f"    val all: List<EmojiEntry> = {' + '.join(f'part{i}()' for i in range(len(parts)))}"]
    for i, part in enumerate(parts):
        lines += ["", f"    private fun part{i}(): List<EmojiEntry> = listOf("]
        lines += [f'        EmojiEntry({json.dumps(s, ensure_ascii=False)}, "{g}", "{c}", {json.dumps(k, ensure_ascii=False)}),' for s, g, c, k in part]
        lines += ["    )"]
    lines += ["}", ""]
    return "\n".join(lines)


def generate() -> None:
    DATA.clear()
    DATA.update(json.loads(JSON_PATH.read_text(encoding="utf-8")))
    shortcodes = [s for s, *_ in DATA["emoji"]]
    assert len(shortcodes) == len(set(shortcodes)), "duplicate shortcode"
    assert all(SHORTCODE.match(s) for s in shortcodes), "a shortcode the clients cannot read"
    glyphs = [g for _s, g, *_ in DATA["emoji"]]
    assert len(glyphs) == len(set(glyphs)), "duplicate glyph"
    assert all(is_plain_emoji(g) for g in glyphs), "a glyph a reaction refuses"
    (ROOT / "apps/desktop/src/ui/emojiData.ts").write_text(ts(), encoding="utf-8")
    (ROOT / "apps/ios/ChikuwaChat/UI/EmojiData.swift").write_text(swift(), encoding="utf-8")
    (ROOT / "apps/android/app/src/main/java/jp/chikuwachat/android/ui/EmojiData.kt").write_text(kotlin(), encoding="utf-8")
    print(f"wrote {len(shortcodes)} emoji to 3 platforms")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--update", action="store_true", help="rebuild emoji.json from the pinned sources first")
    parser.add_argument("--cache", type=Path, help="where to keep the downloaded sources (default: a temporary folder)")
    args = parser.parse_args()
    if args.update:
        if args.cache:
            update(args.cache)
        else:
            with tempfile.TemporaryDirectory() as tmp:
                update(Path(tmp))
    generate()


if __name__ == "__main__":
    main()
