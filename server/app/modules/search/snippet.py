"""The plain-text excerpt of a canvas search hit (CANVAS.md §4.8): made after the LIMIT, only for
the page returned (making it before the sort took 1,187 ms on 5,000 canvases, §7)."""

import unicodedata

CONTEXT = 60
# How far into a body the slow, width-folding look for a keyword goes (NFKC per character).
FOLD_LIMIT = 20_000
ELLIPSIS = "…"


def _fold(text: str) -> tuple[str, list[int]]:
    """`text` folded like PGroonga's normalizer (NFKC, lower case), with each folded character's
    position in `text`."""
    out: list[str] = []
    where: list[int] = []
    for i, ch in enumerate(text):
        folded = unicodedata.normalize("NFKC", ch).lower()
        out.append(folded)
        where.extend([i] * len(folded))
    return "".join(out), where


def _find(text: str, keywords: list[str]) -> tuple[int, int] | None:
    """(start, end) in `text` of the earliest keyword."""
    words = [k for k in keywords if k.strip()]
    if not words:
        return None
    lowered = text.lower()
    if len(lowered) == len(text):
        found = [(lowered.find(w.lower()), len(w)) for w in words]
        hits = [(at, at + size) for at, size in found if at >= 0]
        if hits:
            return min(hits)
    folded, where = _fold(text[:FOLD_LIMIT])
    best: tuple[int, int] | None = None
    for word in words:
        needle = unicodedata.normalize("NFKC", word).lower()
        at = folded.find(needle)
        if at < 0 or not needle:
            continue
        span = (where[at], where[at + len(needle) - 1] + 1)
        if best is None or span < best:
            best = span
    return best


def make_snippet(body: str, keywords: list[str], *, context: int = CONTEXT) -> str:
    """About `context` characters on each side of the first keyword in the body, whitespace and
    newlines folded to single spaces; the start of the body when no keyword is in it (a title
    hit)."""
    flat = " ".join(body.split())
    span = _find(flat, keywords)
    if span is None:
        start, end = 0, min(len(flat), 2 * context)
    else:
        start, end = max(0, span[0] - context), min(len(flat), span[1] + context)
    head = ELLIPSIS if start > 0 else ""
    tail = ELLIPSIS if end < len(flat) else ""
    return f"{head}{flat[start:end]}{tail}"
