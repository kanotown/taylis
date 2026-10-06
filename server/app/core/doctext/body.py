"""Body helpers shared by canvases and wiki pages (docs/WIKI.md §2.3, M120).

Moved from app/modules/canvases/service.py without change of behaviour: one newline convention
and the length limit, task counts, "only boxes ticked", line counts for the history, the
attachments and mentions a body refers to. Pages add page links (`[title](page:<uuid>)` and the
permalink `<server>/p/<uuid>`).
"""

import re
import uuid
from collections import Counter

from app.core.doctext import markers
from app.core.errors import AppError

# CANVAS.md §4.3 / WIKI.md §7.1: a body holds at most this many characters.
MAX_BODY_LENGTH = 100_000

# `- [ ] item` / `* [x] item`, nested with leading spaces (CANVAS.md §4.2), in markers.py.
TASK_LINE = markers.TASK_LINE

_UUID = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
# An image or file in the body: `![説明](attachment:<uuid>)` (CANVAS.md §4.2, §4.10). Any case:
# a client may print the id in capitals (Swift's uuidString).
ATTACHMENT_REF = re.compile(rf"attachment:({_UUID})")
# WIKI.md §2.3: a link to a page, `[title](page:<uuid>)`, or its permalink `<server>/p/<uuid>`.
PAGE_REF = re.compile(rf"(?:\bpage:|https?://[^\s()<>]+/p/)({_UUID})(?![0-9a-fA-F-])")

# The mention tokens of messages (app/modules/messages/mentions.py, DATA_MODEL.md "本文の形式");
# repeated here so that core never imports a module (tests/test_doctext.py keeps them equal).
MENTION_USER = re.compile(r"<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>")
MENTION_GROUP = re.compile(
    r"<@group:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>"
)


def clean_body(
    body: str,
    *,
    max_length: int = MAX_BODY_LENGTH,
    code: str = "canvas_too_large",
    what: str = "A canvas",
) -> str:
    """One newline convention (\\n), and the length limit (422 `code`)."""
    cleaned = body.replace("\r\n", "\n").replace("\r", "\n")
    if len(cleaned) > max_length:
        raise AppError(
            422,
            code,
            f"{what} holds at most {max_length} characters",
            details={"max_length": max_length},
        )
    return cleaned


def count_tasks(body: str) -> tuple[int, int]:
    """(total, done) task items, outside fenced code blocks."""
    total = done = 0
    fenced = False
    for line in body.split("\n"):
        if line.lstrip().startswith("```"):
            fenced = not fenced
            continue
        if fenced:
            continue
        match = TASK_LINE.match(line)
        if match:
            total += 1
            done += match.group(2) != " "
    return total, done


def only_tasks_toggled(before: str, after: str) -> bool:
    """True when `after` differs from `before` only in task boxes ([ ] ↔ [x]) (CANVAS.md §4.7)."""
    old, new = before.split("\n"), after.split("\n")
    if len(old) != len(new):
        return False
    for a, b in zip(old, new, strict=True):
        if a == b:
            continue
        ma, mb = TASK_LINE.match(a), TASK_LINE.match(b)
        if ma is None or mb is None:
            return False
        if ma.group(1) != mb.group(1) or ma.group(3) != mb.group(3):
            return False
    return True


def line_changes(before: str, after: str) -> tuple[int, int]:
    """(added, removed) lines, counted as multisets: cheap and good enough for a history list."""
    old, new = Counter(before.split("\n")), Counter(after.split("\n"))
    return sum((new - old).values()), sum((old - new).values())


def attachment_refs(body: str) -> list[uuid.UUID]:
    """The attachments the body refers to, in order, each once."""
    return list(dict.fromkeys(uuid.UUID(m.group(1)) for m in ATTACHMENT_REF.finditer(body)))


def page_refs(body: str) -> list[uuid.UUID]:
    """The wiki pages the body links to (`page:<uuid>` or `<server>/p/<uuid>`), each once."""
    return list(dict.fromkeys(uuid.UUID(m.group(1)) for m in PAGE_REF.finditer(body)))


def mention_tokens(body: str) -> tuple[set[uuid.UUID], set[uuid.UUID]]:
    """(users, groups) the body mentions (`<!channel>` / `<!here>` never notify in a document)."""
    return (
        {uuid.UUID(raw) for raw in MENTION_USER.findall(body)},
        {uuid.UUID(raw) for raw in MENTION_GROUP.findall(body)},
    )
