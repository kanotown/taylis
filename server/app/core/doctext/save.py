"""The save flow of a Markdown document (CANVAS.md §4.4, WIKI.md §7.1), shared by canvases and
wiki pages (docs/WIKI.md §2.3, M120).

A device sends the whole body with the version it was written on (`base`). The module that owns
the document has already locked its row, answered a retry of the same `client_save_id`, found the
base version and checked access; this decides the rest:

- the body is the head's: nothing changes (the head is the submitted version);
- the base is the head: the body becomes the new head (kind save);
- else the two are merged (doctext.merge, off the event loop): a conflict with `fail` is refused
  (the module's `refuse`), otherwise the submitted body is kept as a side version (the base of that
  device's next save) and the merged text becomes the new head (kind merge) when it differs.

Writing versions, the row and the events stays with the module (`write_head`, `write_side`).
"""

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from functools import partial
from typing import Literal, NoReturn

from app.core.doctext import merge

_pool: ThreadPoolExecutor | None = None


async def run_merge(
    base: str,
    ours: str,
    theirs: str,
    resolve: merge.Resolve,
    *,
    budget_seconds: float = merge.DEFAULT_BUDGET_SECONDS,
) -> merge.MergeResult:
    """CANVAS.md §4.4 / §8: merges run off the event loop, a few at a time, within the budget."""
    global _pool
    if _pool is None:
        _pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="doc-merge")
    call = partial(merge.merge3, base, ours, theirs, resolve=resolve, budget_seconds=budget_seconds)
    return await asyncio.get_running_loop().run_in_executor(_pool, call)


@dataclass(frozen=True)
class SaveOutcome:
    # unchanged: the body was the head's; saved: it became the head; merged: merged with the head.
    kind: Literal["unchanged", "saved", "merged"]
    # The version holding exactly the submitted body.
    submitted_rev_id: uuid.UUID


# (body, kind "save" | "merge", parent version, client_save_id) → the new head version's id.
WriteHead = Callable[[str, str, uuid.UUID, uuid.UUID | None], Awaitable[uuid.UUID]]
# (submitted body, its base version, the base's body, client_save_id) → the side version's id.
WriteSide = Callable[[str, uuid.UUID, str, uuid.UUID], Awaitable[uuid.UUID]]
# (the merge's conflicts, whether it timed out) → raises the module's 409.
Refuse = Callable[[tuple[merge.Conflict, ...], bool], Awaitable[NoReturn]]
Merge = Callable[[str, str, str, merge.Resolve], Awaitable[merge.MergeResult]]


async def save_flow(
    *,
    head_body: str,
    head_rev_id: uuid.UUID,
    base_rev_id: uuid.UUID,
    base_body: str,
    body: str,
    client_save_id: uuid.UUID,
    on_conflict: merge.Resolve,
    write_head: WriteHead,
    write_side: WriteSide,
    refuse: Refuse,
    clean: Callable[[str], str],
    run: Merge | None = None,
) -> SaveOutcome:
    """The steps after the base is known (see the module's docstring). `clean` is the module's
    clean_body (the merged text is checked against the limit too)."""
    if base_rev_id == head_rev_id or body == head_body:
        if body == head_body:
            return SaveOutcome("unchanged", head_rev_id)
        revision_id = await write_head(body, "save", base_rev_id, client_save_id)
        return SaveOutcome("saved", revision_id)

    result = await (run or run_merge)(base_body, body, head_body, on_conflict)
    if result.conflicts and on_conflict == "fail":
        await refuse(result.conflicts, result.timed_out)
    side_id = await write_side(body, base_rev_id, base_body, client_save_id)
    merged_body = clean(result.text)
    if merged_body != head_body:
        await write_head(merged_body, "merge", head_rev_id, None)
    return SaveOutcome("merged", side_id)
