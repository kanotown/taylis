"""The plain-text excerpt of a canvas search hit (CANVAS.md §4.8): made after the LIMIT, only for
the page returned (making it before the sort took 1,187 ms on 5,000 canvases, §7)."""

import unicodedata

CONTEXT = 60
# How far into a body the slow, width-folding look for a keyword goes (NFKC per character).
FOLD_LIMIT = 20_000
ELLIPSIS = "…"
# The drive snippets (§29): at most this many characters of an English word cut at an end go.
WORD_TRIM = 15


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


def fold_keyword(word: str) -> str:
    """A keyword as the drive's stored text is folded (NFKC, docs/DRIVE.md §29), lower case."""
    return unicodedata.normalize("NFKC", word).lower()


def mark(text: str, keywords: list[str]) -> list[tuple[str, bool]]:
    """`text` in pieces, the keywords' occurrences (folded like PGroonga's normaliser: NFKC,
    lower case) marked True; the longest keyword wins where two overlap."""
    words = sorted({fold_keyword(k) for k in keywords if k.strip()}, key=len, reverse=True)
    if not text or not words:
        return [(text, False)] if text else []
    folded, where = _fold(text)
    spans: list[tuple[int, int]] = []
    taken = [False] * len(folded)
    for word in words:
        at = folded.find(word)
        while at >= 0:
            end = at + len(word)
            if not any(taken[at:end]):
                for i in range(at, end):
                    taken[i] = True
                spans.append((where[at], where[end - 1] + 1))
            at = folded.find(word, end)
    spans.sort()
    out: list[tuple[str, bool]] = []
    cursor = 0
    for start, end in spans:
        if start < cursor:
            continue
        if start > cursor:
            out.append((text[cursor:start], False))
        out.append((text[start:end], True))
        cursor = end
    if cursor < len(text):
        out.append((text[cursor:], False))
    return out


def window_snippet(
    piece: str, *, cut_before: bool, cut_after: bool, keywords: list[str]
) -> list[tuple[str, bool]]:
    """A drive text's window (cut around the first keyword by the database) as marked pieces:
    spaces and line breaks folded, "…" where the text goes on (docs/DRIVE.md §29)."""
    flat = " ".join(piece.split())
    # An English word cut at either end is left out ("…sults." reads badly); a short way only,
    # so the word found (about 30 characters in) always stays.
    if cut_before and flat[:1].isascii() and flat[:1].isalnum():
        space = flat.find(" ")
        if 0 < space <= WORD_TRIM:
            flat = flat[space + 1 :]
    if cut_after and flat[-1:].isascii() and flat[-1:].isalnum():
        space = flat.rfind(" ")
        if 0 < space and len(flat) - WORD_TRIM <= space:
            flat = flat[:space]
    parts = mark(flat, keywords)
    if cut_before:
        parts.insert(0, (ELLIPSIS, False))
    if cut_after:
        parts.append((ELLIPSIS, False))
    # Neighbouring plain pieces as one.
    merged: list[tuple[str, bool]] = []
    for part, hit in parts:
        if merged and not hit and not merged[-1][1]:
            merged[-1] = (merged[-1][0] + part, False)
        else:
            merged.append((part, hit))
    return merged
