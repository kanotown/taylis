"""The canvases' three-way merge: lives in app/core/doctext/merge.py since M120 (docs/WIKI.md
§2.3), shared with wiki pages. Re-exported here so existing imports keep working."""

from app.core.doctext.merge import (
    DEFAULT_BUDGET_SECONDS,
    LARGE_GAP,
    SEPARATORS,
    SMALL_GAP,
    Conflict,
    MergeResult,
    Resolve,
    merge3,
    tokenize,
)

__all__ = [
    "DEFAULT_BUDGET_SECONDS",
    "LARGE_GAP",
    "SEPARATORS",
    "SMALL_GAP",
    "Conflict",
    "MergeResult",
    "Resolve",
    "merge3",
    "tokenize",
]
