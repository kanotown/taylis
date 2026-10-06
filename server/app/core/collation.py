"""The Japanese name order of the sidebar (apps/shared/sidebar-order.json "names"), as a sort key.

The clients sort sidebars themselves (desktop ui/channels.ts compareNames, iOS, Android); the
server sorts a wiki database's text columns (docs/WIKI.md §5.4: 「サイドバーの日本語の名前順と同じ
キー」) so all three clients show one order. Level 1: NFKD without combining and voicing marks,
element by element (class 0 symbols, 1 a run of digits as a number, 2 Latin letters case folded,
3 kana (katakana as hiragana, small as large), 4 kanji in JIS X 0208 order then other ideographs,
5 the rest); level 2: NFKC with A-Z lower-cased and katakana as hiragana; level 3: the raw text;
levels 2 and 3 by UTF-16 code unit. tests/test_collation.py reads the shared cases.
"""

import unicodedata
from functools import lru_cache


def _jis_kanji() -> dict[int, int]:
    """JIS X 0208 rows 16-84 in JIS order (apps/shared/gen_jis_kanji.py, from the EUC-JP codec)."""
    rank: dict[int, int] = {}
    for row in range(16, 85):
        for cell in range(1, 95):
            try:
                ch = bytes([0xA0 + row, 0xA0 + cell]).decode("euc_jp")
            except UnicodeDecodeError:
                continue
            rank.setdefault(ord(ch), len(rank))
    return rank


_JIS = _jis_kanji()
_LARGE_KANA = {
    0x3041: 0x3042,
    0x3043: 0x3044,
    0x3045: 0x3046,
    0x3047: 0x3048,
    0x3049: 0x304A,
    0x3063: 0x3064,
    0x3083: 0x3084,
    0x3085: 0x3086,
    0x3087: 0x3088,
    0x308E: 0x308F,
    0x3095: 0x304B,
    0x3096: 0x3051,
}

Element = tuple[int, int, str]
Key = tuple[tuple[Element, ...], bytes, bytes]


def _ideograph(c: int) -> bool:
    return (
        0x3400 <= c <= 0x4DBF
        or 0x4E00 <= c <= 0x9FFF
        or 0xF900 <= c <= 0xFAFF
        or 0x20000 <= c <= 0x3FFFF
    )


def _elements(name: str) -> tuple[Element, ...]:
    codes = [ord(ch) for ch in unicodedata.normalize("NFKD", name)]
    out: list[Element] = []
    i = 0
    while i < len(codes):
        c = codes[i]
        if 0x300 <= c <= 0x36F or c in (0x3099, 0x309A):
            i += 1
            continue
        if 0x30 <= c <= 0x39:
            j = i
            while j < len(codes) and 0x30 <= codes[j] <= 0x39:
                j += 1
            digits = "".join(chr(d) for d in codes[i:j]).lstrip("0") or "0"
            out.append((1, len(digits), digits))
            i = j
            continue
        rank = _JIS.get(c)
        if 0x41 <= c <= 0x5A:
            out.append((2, c + 0x20, ""))
        elif 0x61 <= c <= 0x7A:
            out.append((2, c, ""))
        elif 0x3041 <= c <= 0x3096 or 0x30A1 <= c <= 0x30F6:
            hiragana = c - 0x60 if c >= 0x30A1 else c
            out.append((3, _LARGE_KANA.get(hiragana, hiragana), ""))
        elif rank is not None:
            out.append((4, rank, ""))
        elif _ideograph(c):
            out.append((4, 10000 + c, ""))
        elif c < 0x3040 or 0x309B <= c <= 0x30A0 or 0x30FB <= c <= 0x30FF or 0xFF00 <= c <= 0xFFEF:
            out.append((0, c, ""))
        else:
            out.append((5, c, ""))
        i += 1
    return tuple(out)


def _level2(name: str) -> str:
    out = []
    for ch in unicodedata.normalize("NFKC", name):
        c = ord(ch)
        if 0x41 <= c <= 0x5A:
            out.append(chr(c + 0x20))
        elif 0x30A1 <= c <= 0x30F6:
            out.append(chr(c - 0x60))
        else:
            out.append(ch)
    return "".join(out)


def _units(text: str) -> bytes:
    """UTF-16 code units, compared as bytes (big-endian keeps their order)."""
    return text.encode("utf-16-be", "surrogatepass")


@lru_cache(maxsize=65536)
def name_key(name: str) -> Key:
    """Sort by this to get compareNames' order (equal keys: the same text)."""
    return (_elements(name), _units(_level2(name)), _units(name))
