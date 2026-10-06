"""Fractional indexes for the order of sibling pages (docs/WIKI.md §3.2).

A key is a non-empty string of base-62 digits (`0-9A-Za-z`, which sorts the same in Python and in
PostgreSQL's COLLATE "C") that never ends in "0", so there is always room between two keys.
Clients never make keys: they say "before / after this sibling" and the server calls key_between
here (one place), so a reorder rewrites one row and sends one event.

Appending at the end (the common case) steps the last digit (V, W, … z, zV, …), so a list of a
thousand appended pages has keys of about thirty characters; inserting between two keys takes
their midpoint.
"""

DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
BASE = len(DIGITS)
_INDEX = {d: i for i, d in enumerate(DIGITS)}
FIRST = DIGITS[BASE // 2]  # "V"


def valid(key: str) -> bool:
    return bool(key) and key[-1] != "0" and all(ch in _INDEX for ch in key)


def _midpoint(a: str, b: str | None) -> str:
    """A key strictly between a and b (a may be "", b None for +∞); neither ends in "0"."""
    if b is not None:
        n = 0
        while n < len(b) and (a[n] if n < len(a) else "0") == b[n]:
            n += 1
        if n > 0:
            return b[:n] + _midpoint(a[n:], b[n:])
    da = _INDEX[a[0]] if a else 0
    db = _INDEX[b[0]] if b is not None else BASE
    if db - da > 1:
        return DIGITS[(da + db + 1) // 2] if b is None else DIGITS[(da + db) // 2]
    if b is not None and len(b) > 1:
        return b[:1]
    return DIGITS[da] + _midpoint(a[1:], None)


def _after(a: str) -> str:
    """A key after a that stays short when appending again and again."""
    last = _INDEX[a[-1]]
    if last < BASE - 1:
        return a[:-1] + DIGITS[last + 1]
    return a + FIRST


def key_between(before: str | None, after: str | None) -> str:
    """A key that sorts after `before` and before `after` (None: no neighbour on that side)."""
    if before is not None and after is not None and not before < after:
        raise ValueError(f"{before!r} is not before {after!r}")
    if before is None and after is None:
        return FIRST
    if after is None:
        assert before is not None
        return _after(before)
    return _midpoint(before or "", after)
