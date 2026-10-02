"""M80 (CANVAS.md §22): the hidden marker that ties a checklist item to the task made from it.

When a task is made from a checklist item (§18.3), the server appends ` <!--task:<task id>-->` to
that line of the canvas. The marker is an HTML comment, so any Markdown renderer hides it; the
apps hide it everywhere they show or edit the text and keep it through edits. With it the server
finds the item again however the canvas was edited since, and keeps the box and the task's
completion the same both ways (service.py, tasks/service.py).

Pure functions on the body, without imports from other modules (activity, search and tasks use
them too). Lines inside fenced code blocks are never items (as count_tasks).
"""

import re
import uuid

# The lower-case id the server writes; the space before it goes with it when it is taken out.
MARKER = re.compile(r" ?<!--task:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-->")
# The same, for PostgreSQL's regexp_replace (the canvas search index, migration 0068).
MARKER_SQL = " ?<!--task:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-->"
# `- [ ] item` / `* [x] item`, nested with leading spaces (service.TASK_LINE).
TASK_LINE = re.compile(r"^([ \t]*[-*] \[)([ xX])(\](?: .*)?)$")


def marker(task_id: uuid.UUID) -> str:
    return f"<!--task:{task_id}-->"


def strip(text: str) -> str:
    """The text without markers (what a reader sees)."""
    return MARKER.sub("", text) if "<!--task:" in text else text


def _items(body: str) -> list[tuple[int, str]]:
    """(index, line) of the checklist items outside fenced code blocks."""
    out: list[tuple[int, str]] = []
    fenced = False
    for index, line in enumerate(body.split("\n")):
        if line.lstrip().startswith("```"):
            fenced = not fenced
            continue
        if not fenced and TASK_LINE.match(line):
            out.append((index, line))
    return out


def task_ids(line: str) -> list[uuid.UUID]:
    return [uuid.UUID(raw) for raw in MARKER.findall(line)]


def box_states(body: str) -> dict[uuid.UUID, bool]:
    """Each linked task's box (ticked or not); the first item carrying a marker counts."""
    states: dict[uuid.UUID, bool] = {}
    if "<!--task:" not in body:
        return states
    for _, line in _items(body):
        match = TASK_LINE.match(line)
        assert match is not None
        for task_id in task_ids(line):
            states.setdefault(task_id, match.group(2) != " ")
    return states


def ticks_changed(before: str, after: str) -> dict[uuid.UUID, bool]:
    """The linked tasks whose box a change ticked (True) or unticked (False). A marker that
    appears or goes away is no tick."""
    old, new = box_states(before), box_states(after)
    return {tid: done for tid, done in new.items() if tid in old and old[tid] != done}


def find_item(body: str, wanted: str) -> int | None:
    """The index of the checklist item `wanted` (as a client sent it, §18.3): the first line that
    is the same, else the same once markers and trailing spaces are taken out."""
    exact = wanted.rstrip()
    bare = strip(wanted).rstrip()
    items = _items(body)
    for index, line in items:
        if line.rstrip() == exact:
            return index
    for index, line in items:
        if strip(line).rstrip() == bare:
            return index
    return None


def with_marker(body: str, index: int, task_id: uuid.UUID) -> str:
    """The body with the task's marker at the end of line `index` (unchanged if it has it)."""
    lines = body.split("\n")
    line = lines[index]
    if task_id in task_ids(line):
        return body
    lines[index] = f"{line.rstrip()} {marker(task_id)}"
    return "\n".join(lines)


def set_box(body: str, task_id: uuid.UUID, done: bool) -> str:
    """The body with every item carrying the task's marker ticked (or unticked)."""
    if "<!--task:" not in body:
        return body
    lines = body.split("\n")
    for index, line in _items(body):
        if task_id not in task_ids(line):
            continue
        match = TASK_LINE.match(line)
        assert match is not None
        if (match.group(2) != " ") != done:
            lines[index] = f"{match.group(1)}{'x' if done else ' '}{match.group(3)}"
    return "\n".join(lines)
