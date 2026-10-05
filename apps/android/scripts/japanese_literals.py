#!/usr/bin/env python3
"""List Japanese string literals left in the Android Kotlin sources (docs/I18N.md).

    python3 apps/android/scripts/japanese_literals.py [--check]

User-visible text belongs in res/values*/strings*.xml. A literal that is not UI text (a parser keyword, a regex, a
Japanese separator) stays in the code with an `i18n: keep` comment on its line or on the line above. Generated files
("Generated from apps/shared/...") are skipped. Comments are ignored. --check exits 1 when any literal is listed.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "app/src/main/java"
JP = re.compile(r"[　-〿぀-ゟ゠-ヿ一-鿿＀-￯]")
KEEP = "i18n: keep"


def literals(src: str):
    """(line, text) of each string literal outside comments; a template's expressions are scanned as code."""
    out, i, n = [], 0, len(src)

    def read_string(i: int, raw: bool):
        start = i
        i += 3 if raw else 1
        while i < n:
            if raw and src.startswith('"""', i):
                return i + 3
            c = src[i]
            if not raw and c == "\\":
                i += 2
                continue
            if not raw and c == '"':
                return i + 1
            if c == "$" and i + 1 < n and src[i + 1] == "{":
                i = skip_template(i + 2)
                continue
            i += 1
        raise ValueError(f"unterminated string at {start}")

    def skip_template(i: int) -> int:
        depth = 1
        while i < n:
            c = src[i]
            if c == '"':
                raw = src.startswith('"""', i)
                end = read_string(i, raw)
                out.append((src.count("\n", 0, i) + 1, src[i:end]))
                i = end
                continue
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return i + 1
            i += 1
        return i

    while i < n:
        if src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j < 0 else j
            continue
        if src.startswith("/*", i):
            depth, i = 1, i + 2
            while i < n and depth:
                if src.startswith("/*", i):
                    depth, i = depth + 1, i + 2
                elif src.startswith("*/", i):
                    depth, i = depth - 1, i + 2
                else:
                    i += 1
            continue
        c = src[i]
        if c == "'":
            j = i + 1
            j += 2 if src[j] == "\\" else 1
            while j < n and src[j] != "'":
                j += 1
            i = j + 1
            continue
        if c == '"':
            raw = src.startswith('"""', i)
            line = src.count("\n", 0, i) + 1
            end = read_string(i, raw)
            out.append((line, src[i:end]))
            i = end
            continue
        i += 1
    return out


def main() -> int:
    found = []
    for path in sorted(ROOT.rglob("*.kt")):
        src = path.read_text(encoding="utf-8")
        if "Generated from apps/shared/" in src[:400]:
            continue
        lines = src.split("\n")
        for line, text in literals(src):
            body = re.sub(r"\$\{[^}]*\}", "", text)
            if not JP.search(body):
                continue
            here = lines[line - 1]
            above = lines[line - 2] if line > 1 else ""
            if KEEP in here or KEEP in above:
                continue
            found.append(f"{path.relative_to(ROOT)}:{line}: {text[:100]}")
    for row in found:
        print(row)
    print(f"{len(found)} Japanese literal(s) outside resources", file=sys.stderr)
    return 1 if found and "--check" in sys.argv else 0


if __name__ == "__main__":
    sys.exit(main())
