"""Three-way merge of document bodies (CANVAS.md §4.4): lines first, then words.

Shared by canvases and wiki pages (docs/WIKI.md §2.3, M120); moved here from
app/modules/canvases/merge.py unchanged (that module re-exports it).

Pure and deterministic: no database, no I/O. The only outside input is the time budget, and a
merge that runs out of it gives up with one whole-document conflict instead of a slow answer.

The rules (CANVAS.md §4.4 "マージの規則", fixtures in tests/fixtures/canvas_merge/):

1. Split the three bodies into lines and align base↔ours and base↔theirs (common prefix / suffix,
   then difflib for small gaps and unique-line anchors for large ones).
2. Walk the regions between lines that both sides kept (diff3). A region only one side changed
   takes that side; both changed it the same way → once.
3. Both inserted lines at the same place → both, theirs first (two people appending to the same
   list). When one insertion contains the other at its start or end, the longer one.
4. Both changed a region with the same number of lines → line by line: a line changed on both
   sides is split into words (``tokenize``) and merged with the same rules. A region whose line
   counts differ is merged word by word as a whole (newlines are words).
   At the word level, two different insertions at the same place are kept (theirs first) only
   when both are detached from the neighbouring words (they start or end at a space, punctuation
   or the line's edge); otherwise they could glue into one word, and that is a conflict.
5. What still overlaps is a conflict. ``resolve`` settles each conflicting region: ``ours``,
   ``theirs``, or ``both`` (their lines, then ours quoted with ``> ``). With ``fail`` the text
   holds theirs in the conflicting regions (the caller refuses the save anyway).
"""

import time
import unicodedata
from bisect import bisect_left
from collections import Counter
from collections.abc import Callable, Hashable, Sequence
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Literal

Resolve = Literal["fail", "ours", "theirs", "both"]

# Gaps up to this many cell comparisons (len(a) * len(b)) go to difflib; larger gaps are split at
# anchors first, so a long document never meets difflib's quadratic worst case.
SMALL_GAP = 25_000
# A gap without anchors up to this size still goes to difflib; beyond it the gap counts as
# replaced (a conflict if the other side changed it too).
LARGE_GAP = 250_000
DEFAULT_BUDGET_SECONDS = 0.2

# A word boundary on both sides of these: CANVAS.md's Japanese punctuation (。、 and the
# full-width comma, full stop, ! and ?) and spaces, plus brackets and ASCII punctuation, so that
# `[ ]` → `[x]` is one word. Full-width forms are written as escapes (they look like ASCII).
SEPARATORS = frozenset(
    "。、「」『』【】・,.!?;:()[]/\uff0c\uff0e\uff01\uff1f\uff1a\uff1b\uff08\uff09\u3014\u3015"
)


class _Timeout(Exception):
    pass


@dataclass(frozen=True)
class Conflict:
    """A region both sides changed differently: its text in base, ours and theirs.

    `ours_line` / `theirs_line`: the region's first line (0-based) in the submitted body and in
    the head, for the client to point at it."""

    base: str
    ours: str
    theirs: str
    ours_line: int
    theirs_line: int


@dataclass(frozen=True)
class MergeResult:
    text: str
    conflicts: tuple[Conflict, ...]
    timed_out: bool = False


# --- words -------------------------------------------------------------------------------------


def _char_class(ch: str) -> str:
    """The script of a character, for word boundaries in text without spaces (Japanese)."""
    code = ord(ch)
    if 0x3040 <= code <= 0x309F:
        return "hiragana"
    if 0x30A0 <= code <= 0x30FF or 0x31F0 <= code <= 0x31FF or 0xFF66 <= code <= 0xFF9D:
        return "katakana"  # includes ー and half-width katakana
    if (
        0x4E00 <= code <= 0x9FFF
        or 0x3400 <= code <= 0x4DBF
        or 0xF900 <= code <= 0xFAFF
        or 0x20000 <= code <= 0x3FFFF
        or ch in "々〆ヶ"
    ):
        return "kanji"
    category = unicodedata.category(ch)
    if category[0] in "LN" or ch in "_'":
        return "word"  # Latin (and other alphabets) and digits, full-width too
    return "symbol"


def tokenize(text: str) -> list[str]:
    """Split text into words such that ``"".join(tokenize(t)) == t``.

    A token is a newline, a run of other whitespace, one separator character (SEPARATORS), or a
    run of characters of one script: kanji, hiragana, katakana, letters / digits, other symbols.
    So 「研究計画を来週までに提出する。」 is 研究計画 / を / 来週 / までに / 提出 / する / 。 and
    "- [ ] item" is - / ␠ / [ / ␠ / ] / ␠ / item.
    """
    tokens: list[str] = []
    current = ""
    current_kind = ""
    for ch in text:
        if ch == "\n":
            kind = "newline"
        elif ch.isspace():
            kind = "space"
        elif ch in SEPARATORS:
            kind = "separator"
        else:
            kind = _char_class(ch)
        if current and kind == current_kind and kind not in ("newline", "separator"):
            current += ch
            continue
        if current:
            tokens.append(current)
        current, current_kind = ch, kind
    if current:
        tokens.append(current)
    return tokens


def _is_separator(token: str) -> bool:
    return token.isspace() or token in SEPARATORS


# --- alignment ---------------------------------------------------------------------------------


def _lis(pairs: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """The longest run of pairs (sorted by the first index) whose second index increases."""
    tails: list[int] = []  # the smallest second index ending a run of each length
    tail_at: list[int] = []  # index into pairs of that end
    back: list[int] = [-1] * len(pairs)
    for n, (_, j) in enumerate(pairs):
        k = bisect_left(tails, j)
        if k == len(tails):
            tails.append(j)
            tail_at.append(n)
        else:
            tails[k] = j
            tail_at[k] = n
        back[n] = tail_at[k - 1] if k > 0 else -1
    out: list[tuple[int, int]] = []
    n = tail_at[-1] if tail_at else -1
    while n >= 0:
        out.append(pairs[n])
        n = back[n]
    out.reverse()
    return out


def _anchors(
    a: Sequence[Hashable], b: Sequence[Hashable], a0: int, a1: int, b0: int, b1: int
) -> list[tuple[int, int]]:
    """Pairs of equal elements to split a large gap at: elements that occur once on each side
    (patience diff); failing those, elements that occur equally often on both sides, paired in
    order (a document of many alike lines where a few changed)."""
    count_a = Counter(a[a0:a1])
    count_b = Counter(b[b0:b1])
    unique_b = {b[j]: j for j in range(b0, b1) if count_b[b[j]] == 1}
    pairs = [(i, unique_b[a[i]]) for i in range(a0, a1) if count_a[a[i]] == 1 and a[i] in unique_b]
    if not pairs:
        positions: dict[Hashable, list[int]] = {}
        for j in range(b0, b1):
            if count_a.get(b[j], 0) == count_b[b[j]]:
                positions.setdefault(b[j], []).append(j)
        seen: Counter[Hashable] = Counter()
        for i in range(a0, a1):
            slots = positions.get(a[i])
            if slots is not None:
                pairs.append((i, slots[seen[a[i]]]))
                seen[a[i]] += 1
    return _lis(pairs)


def _align(
    a: Sequence[Hashable], b: Sequence[Hashable], check: Callable[[], None]
) -> dict[int, int]:
    """Which element of b each kept element of a became (increasing on both sides)."""
    matches: dict[int, int] = {}

    def gap(a0: int, a1: int, b0: int, b1: int) -> None:
        check()
        while a0 < a1 and b0 < b1 and a[a0] == b[b0]:
            matches[a0] = b0
            a0 += 1
            b0 += 1
        while a0 < a1 and b0 < b1 and a[a1 - 1] == b[b1 - 1]:
            a1 -= 1
            b1 -= 1
            matches[a1] = b1
        if a0 == a1 or b0 == b1:
            return
        size = (a1 - a0) * (b1 - b0)
        if size > SMALL_GAP:
            anchors = _anchors(a, b, a0, a1, b0, b1)
            if anchors:
                prev_a, prev_b = a0, b0
                for i, j in anchors:
                    gap(prev_a, i, prev_b, j)
                    matches[i] = j
                    prev_a, prev_b = i + 1, j + 1
                gap(prev_a, a1, prev_b, b1)
                return
            if size > LARGE_GAP:
                return  # replaced as a whole
        matcher = SequenceMatcher(None, a[a0:a1], b[b0:b1], autojunk=False)
        for block in matcher.get_matching_blocks():
            for n in range(block.size):
                matches[a0 + block.a + n] = b0 + block.b + n

    gap(0, len(a), 0, len(b))
    return matches


@dataclass(frozen=True)
class _Region:
    """A stretch between kept elements: base[b0:b1], ours[o0:o1], theirs[t0:t1]."""

    b0: int
    b1: int
    o0: int
    o1: int
    t0: int
    t1: int
    stable: bool


def _diff3(
    base: Sequence[Hashable],
    ours: Sequence[Hashable],
    theirs: Sequence[Hashable],
    check: Callable[[], None],
) -> list[_Region]:
    to_ours = _align(base, ours, check)
    to_theirs = _align(base, theirs, check)
    regions: list[_Region] = []
    i = j = k = 0
    n = len(base)
    while True:
        start = i
        while i < n and to_ours.get(i) == j and to_theirs.get(i) == k:
            i, j, k = i + 1, j + 1, k + 1
        if i > start:
            regions.append(_Region(start, i, j - (i - start), j, k - (i - start), k, True))
        stop = i
        while stop < n and (stop not in to_ours or stop not in to_theirs):
            stop += 1
        if stop < n:
            next_j, next_k = to_ours[stop], to_theirs[stop]
        else:
            next_j, next_k = len(ours), len(theirs)
        if (stop, next_j, next_k) != (i, j, k):
            regions.append(_Region(i, stop, j, next_j, k, next_k, False))
        if stop >= n:
            return regions
        i, j, k = stop, next_j, next_k


def _contains_at_edge(longer: Sequence[str], shorter: Sequence[str]) -> bool:
    size = len(shorter)
    return len(longer) >= size and (
        list(longer[:size]) == list(shorter) or list(longer[len(longer) - size :]) == list(shorter)
    )


def _one_side(base: list[str], ours: list[str], theirs: list[str]) -> list[str] | None:
    """The region's result when at most one side really changed it (rule 2), else None."""
    if ours == base:
        return theirs
    if theirs == base or ours == theirs:
        return ours
    return None


def _both_inserted(ours: list[str], theirs: list[str]) -> list[str]:
    if _contains_at_edge(ours, theirs):
        return ours
    if _contains_at_edge(theirs, ours):
        return theirs
    return theirs + ours


# --- words within lines ------------------------------------------------------------------------


def _detached(inserted: list[str], before: str | None, after: str | None) -> bool:
    start = before is None or _is_separator(before) or _is_separator(inserted[0])
    end = after is None or _is_separator(after) or _is_separator(inserted[-1])
    return start and end


def _merge_words(base: str, ours: str, theirs: str, check: Callable[[], None]) -> str | None:
    """The word-level merge of one region's text, or None when words overlap."""
    b, o, t = tokenize(base), tokenize(ours), tokenize(theirs)
    out: list[str] = []
    for region in _diff3(b, o, t, check):
        rb, ro, rt = b[region.b0 : region.b1], o[region.o0 : region.o1], t[region.t0 : region.t1]
        if region.stable:
            out.extend(rb)
            continue
        merged = _one_side(rb, ro, rt)
        if merged is None and not rb and ro and rt:
            before = b[region.b0 - 1] if region.b0 > 0 else None
            after = b[region.b0] if region.b0 < len(b) else None
            if _contains_at_edge(ro, rt) or _contains_at_edge(rt, ro):
                merged = _both_inserted(ro, rt)
            elif _detached(ro, before, after) and _detached(rt, before, after):
                merged = rt + ro
        if merged is None:
            return None
        out.extend(merged)
    return "".join(out)


# --- lines -------------------------------------------------------------------------------------


def _quote(lines: list[str]) -> list[str]:
    return [f"> {line}" if line else ">" for line in lines]


def _settle(resolve: Resolve, base: list[str], ours: list[str], theirs: list[str]) -> list[str]:
    del base
    if resolve == "ours":
        return ours
    if resolve == "both":
        return theirs + _quote(ours)
    return theirs  # "theirs", and "fail" (the caller refuses the save)


def _lines_text(lines: list[str]) -> str:
    return "".join(f"{line}\n" for line in lines)


def _merge_lines(
    base: str, ours: str, theirs: str, resolve: Resolve, check: Callable[[], None]
) -> MergeResult:
    b, o, t = base.split("\n"), ours.split("\n"), theirs.split("\n")
    out: list[str] = []
    conflicts: list[Conflict] = []

    def conflict(rb: list[str], ro: list[str], rt: list[str], o_at: int, t_at: int) -> None:
        conflicts.append(Conflict("\n".join(rb), "\n".join(ro), "\n".join(rt), o_at, t_at))
        out.extend(_settle(resolve, rb, ro, rt))

    for region in _diff3(b, o, t, check):
        rb, ro, rt = b[region.b0 : region.b1], o[region.o0 : region.o1], t[region.t0 : region.t1]
        if region.stable:
            out.extend(rb)
            continue
        merged = _one_side(rb, ro, rt)
        if merged is not None:
            out.extend(merged)
        elif not rb:
            out.extend(_both_inserted(ro, rt))
        elif len(rb) == len(ro) == len(rt):
            for n, (lb, lo, lt) in enumerate(zip(rb, ro, rt, strict=True)):
                line = _one_side([lb], [lo], [lt])
                if line is not None:
                    out.extend(line)
                    continue
                words = _merge_words(lb, lo, lt, check)
                if words is not None and "\n" not in words:
                    out.append(words)
                else:
                    conflict([lb], [lo], [lt], region.o0 + n, region.t0 + n)
        else:
            # Newline-terminated so that "no lines" and "one empty line" stay different.
            words = _merge_words(_lines_text(rb), _lines_text(ro), _lines_text(rt), check)
            if words is not None and (words == "" or words.endswith("\n")):
                out.extend(words[:-1].split("\n") if words else [])
            else:
                conflict(rb, ro, rt, region.o0, region.t0)
    return MergeResult("\n".join(out), tuple(conflicts))


def merge3(
    base: str,
    ours: str,
    theirs: str,
    *,
    resolve: Resolve = "fail",
    budget_seconds: float = DEFAULT_BUDGET_SECONDS,
) -> MergeResult:
    """Merge `ours` (the submitted body) and `theirs` (the head) made from `base`.

    Within `budget_seconds` (CANVAS.md §4.4: 200 ms); past it the whole document is one conflict
    and `timed_out` is set.
    """
    deadline = time.monotonic() + budget_seconds

    def check() -> None:
        if time.monotonic() > deadline:
            raise _Timeout

    try:
        return _merge_lines(base, ours, theirs, resolve, check)
    except _Timeout:
        whole = Conflict(base, ours, theirs, 0, 0)
        settled = _settle(resolve, base.split("\n"), ours.split("\n"), theirs.split("\n"))
        return MergeResult("\n".join(settled), (whole,), timed_out=True)
