#!/usr/bin/env python3
"""Generate the per-platform emoji tables from emoji.json (M11f). Run after editing the JSON:

    python3 apps/shared/gen_emoji.py
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = json.loads((Path(__file__).parent / "emoji.json").read_text())
HEADER = "Generated from apps/shared/emoji.json by apps/shared/gen_emoji.py; do not edit by hand."


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


def kotlin() -> str:
    lines = ["package jp.chikuwachat.android.ui", "", f"// {HEADER}", "",
             "data class EmojiEntry(val shortcode: String, val glyph: String, val category: String, val keywords: String)", "",
             "object EmojiData {", "    val categories: List<Pair<String, String>> = listOf("]
    lines += [f'        "{key}" to "{label}",' for key, label in DATA["categories"]]
    lines += ["    )", "", "    val all: List<EmojiEntry> = listOf("]
    lines += [f'        EmojiEntry({json.dumps(s, ensure_ascii=False)}, "{g}", "{c}", {json.dumps(k, ensure_ascii=False)}),' for s, g, c, k in DATA["emoji"]]
    lines += ["    )", "}", ""]
    return "\n".join(lines)


def main() -> None:
    shortcodes = [s for s, *_ in DATA["emoji"]]
    assert len(shortcodes) == len(set(shortcodes)), "duplicate shortcode"
    (ROOT / "apps/desktop/src/ui/emojiData.ts").write_text(ts())
    (ROOT / "apps/ios/ChikuwaChat/UI/EmojiData.swift").write_text(swift())
    (ROOT / "apps/android/app/src/main/java/jp/chikuwachat/android/ui/EmojiData.kt").write_text(kotlin())
    print(f"wrote {len(shortcodes)} emoji to 3 platforms")


if __name__ == "__main__":
    main()
