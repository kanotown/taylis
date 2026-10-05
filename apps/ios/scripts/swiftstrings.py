"""A small Swift lexer for the localization scripts: finds the string literals in a source file (with interpolations,
nested literals, multi-line and raw strings), skipping comments.

Each literal: (start offset, end offset, line, byte column, text between the quotes, depth) — the line and the 1-based
UTF-8 column of the opening quote, as the compiler's .stringsdata report them.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

JAPANESE = re.compile(r"[぀-ヿ㐀-鿿！-｠　-〿]")


@dataclass
class Literal:
    start: int
    end: int  # one past the closing quote
    line: int
    column: int
    body: str
    depth: int  # 0 = top level, 1 = inside another literal's interpolation …
    multiline: bool
    raw: bool


def literals(src: str) -> list[Literal]:
    out: list[Literal] = []
    line_starts = [0]
    for m in re.finditer("\n", src):
        line_starts.append(m.end())

    def position(offset: int) -> tuple[int, int]:
        # binary search the line
        lo, hi = 0, len(line_starts) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if line_starts[mid] <= offset:
                lo = mid
            else:
                hi = mid - 1
        col = len(src[line_starts[lo]:offset].encode("utf-8")) + 1
        return lo + 1, col

    n = len(src)

    def skip_code(i: int, depth: int, until_paren: bool) -> int:
        """Scan code from i; returns the index after the matching ')' when until_paren, else n."""
        parens = 0
        while i < n:
            c = src[i]
            if src.startswith("//", i):
                j = src.find("\n", i)
                i = n if j < 0 else j
                continue
            if src.startswith("/*", i):
                level, i = 1, i + 2
                while i < n and level:
                    if src.startswith("/*", i):
                        level, i = level + 1, i + 2
                    elif src.startswith("*/", i):
                        level, i = level - 1, i + 2
                    else:
                        i += 1
                continue
            if c == '"' or (c == "#" and re.match(r'#+"', src[i:])):
                i = read_string(i, depth)
                continue
            if until_paren:
                if c == "(":
                    parens += 1
                elif c == ")":
                    if parens == 0:
                        return i + 1
                    parens -= 1
            i += 1
        return n

    def read_string(i: int, depth: int) -> int:
        start = i
        hashes = 0
        while src[i] == "#":
            hashes += 1
            i += 1
        multiline = src.startswith('"""', i)
        quote = '"""' if multiline else '"'
        i += len(quote)
        body_start = i
        close = quote + "#" * hashes
        escape = "\\" + "#" * hashes
        while i < n:
            if src.startswith(escape, i):
                k = i + len(escape)
                if k < n and src[k] == "(":
                    i = skip_code(k + 1, depth + 1, True)
                    continue
                i = k + 1
                continue
            if src.startswith(close, i):
                body = src[body_start:i]
                i += len(close)
                line, col = position(start)
                out.append(Literal(start, i, line, col, body, depth, multiline, hashes > 0))
                return i
            if not multiline and src[i] == "\n":  # broken literal; give up on it
                return i
            i += 1
        return n

    skip_code(0, 0, False)
    out.sort(key=lambda lit: lit.start)
    return out


def is_japanese(text: str) -> bool:
    return bool(JAPANESE.search(text))
