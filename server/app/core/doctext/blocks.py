"""M149 (docs/WIKI.md §22.5, CANVAS.md §4.2): the container lines of the canvas dialect.

A callout is the lines from ``::: callout [icon]`` to a line ``:::``, a toggle from
``::: toggle [title]`` to ``:::`` (the syntax: the ``containers`` section of
apps/shared/canvas_markdown.json). What a reader sees of them is their content: the icon or the
title and the lines inside, never the ``:::`` lines. The search indexes (CONTAINER_SQL) and the
plain-text readings of a body (search snippets, mention excerpts) drop them; the Markdown export
keeps them (it is an export of the dialect).

Pure functions, no imports from the modules (as markers.py).
"""

import re

from app.core.doctext import markers

# The opener `::: callout 💡` / `::: toggle 見出し` (lower case; the rest of the line is the icon
# or the title) and the close `:::` (canvas_markdown.json `containers`).
OPENER = re.compile(r"^:::[ \t]*(callout|toggle)(?:[ \t]+(.*?))?[ \t]*$")
CLOSE = re.compile(r"^:::[ \t]*$")
_FENCE = re.compile(r"^\s*(```|~~~)")

# The same for PostgreSQL's regexp_replace with the flags 'gn' (newline-sensitive: ^ and $ match
# at every line): an opener's keyword (the icon / title after it stays: it is content) and a
# close line (left empty). Used with MARKER_SQL in one pattern (BODY_SQL) by the search indexes
# canvases_search_idx and wiki_pages_search_idx (migration 0109); unlike the Python reading it
# does not know fenced code (a `:::` line in code is not found by a search, which is fine).
# A capturing group on purpose: in `(?:callout` SQLAlchemy's text() reads `:callout` as a bind
# parameter (the migration runs through op.execute, the tests EXPLAIN through text()).
CONTAINER_SQL = r"^:::[ \t]*(callout|toggle)(?=[ \t]|$)|^:::[ \t]*$"
# The task markers and the container lines in one pattern (flags 'gn').
BODY_SQL = f"{markers.MARKER_SQL}|{CONTAINER_SQL}"


def strip_container_markers(text: str) -> str:
    """The text without the container lines: an opener becomes its icon or title (or goes when
    it has none), a close goes. Lines in fenced code are kept as they are."""
    if ":::" not in text:
        return text
    out: list[str] = []
    fence: str | None = None
    for line in text.split("\n"):
        m = _FENCE.match(line)
        if fence is not None:
            if m and m.group(1) == fence:
                fence = None
            out.append(line)
            continue
        if m:
            fence = m.group(1)
            out.append(line)
            continue
        opener = OPENER.match(line)
        if opener is not None:
            rest = (opener.group(2) or "").strip()
            if rest:
                out.append(rest)
            continue
        if CLOSE.match(line):
            continue
        out.append(line)
    return "\n".join(out)


def reading_text(body: str) -> str:
    """A body as a reader sees it in plain text: without task markers and container lines."""
    return strip_container_markers(markers.strip(body))
