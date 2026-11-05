"""Link cards under a message (M185, docs/LINK_PREVIEWS.md).

- The cards of `<server>/m/<id>` links: POST /messages/previews answers what the caller may see of
  each linked message, with the same rule as GET /messages/{id} (channels.require_readable), in a
  constant number of queries whatever the number of ids.
- The keys of the cards a sender removed (messages.hidden_previews): a link's normalized URL, the
  same rule on the server and the three clients (§4.1).
"""

import re
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.attachments import service as attachments
from app.modules.attachments.schemas import AttachmentOut
from app.modules.channels import service as channels
from app.modules.channels.models import Channel
from app.modules.messages import repository as repo
from app.modules.messages.models import Message
from app.modules.messages.schemas import MessagePreviewOut
from app.modules.users.models import User

# §3.2: the excerpt's size. Clients show three or four lines of it.
EXCERPT_LINES = 6
EXCERPT_CHARS = 300
ATTACHMENT_TYPES_MAX = 10

# §4.1: a link's key. Scheme and host (with any port) in lower case, the fragment dropped, an
# empty path is "/"; the path and the query stay as written. No percent-decoding, no IDN: plain
# string work that Swift, Kotlin and TypeScript do the same way.
_LINK_KEY = re.compile(r"(https?)://([^/?#\s]+)([^#\s]*)(?:#\S*)?", re.IGNORECASE)
# The clients' links (2026-11-05, apps/shared/inline-format.json): the links a body shows, as its
# tokenizer reads them. A `[label](url)` link's URL; a bare URL up to a space, `<`, `>` or a
# full-width / CJK mark, without trailing `.,:;!?'"…` or a `)` / `]` it does not open itself, and a
# Taylis link (`/m/` `/c/` … and a UUID) ending at its UUID unless `/` `?` `#` follows. Read here
# from every `http(s)://` in the body, code included: a superset is fine (the body only has to
# contain the link a client removes).
_START = re.compile(r"https?://", re.IGNORECASE)
_BARE = re.compile(r"https?://[^\s<>　-〿＀-￯]+", re.IGNORECASE)
_LABELLED = re.compile(r"\[[^\]\n]+\]\((https?://[^\s)]+)\)")
_OWN_LINK = re.compile(
    r"(https?://\S*?/(?:m|c|p|e|d|eq)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"
    r"(?![/?#])",
    re.IGNORECASE,
)
_CLOSING = ".,:;!?'\"…"
# The links before 2026-11-05 (up to a space, `<`, `>`, `)` or `]`, these marks dropped at the
# end): keys a client computed then stay keys of the body (migration 0132 moved the stored ones).
_LEGACY_LINK = re.compile(r"https?://[^\s<>)\]]+", re.IGNORECASE)
_LEGACY_TRAILING = ".,!?;:。、」』）"
# Mention tokens an excerpt must not cut through (DATA_MODEL.md 本文の形式).
_TOKEN = re.compile(r"<@group:[0-9a-f-]{36}>|<@[0-9a-f-]{36}>|<!(?:channel|here)>")


def preview_key(url: str) -> str | None:
    """The key of a link's card, or None for anything but an http(s) URL."""
    match = _LINK_KEY.fullmatch(url.strip())
    if match is None:
        return None
    scheme, host, rest = match.groups()
    if not rest.startswith("/"):
        rest = "/" + rest
    return f"{scheme.lower()}://{host.lower()}{rest}"


def bare_url(match: str) -> str:
    """What of a bare URL match is the URL (the clients' bareUrl, inline-format.json)."""
    own = _OWN_LINK.match(match)
    if own is not None:
        return own.group(1)
    url = match
    while url:
        last = url[-1]
        if last in _CLOSING or (
            (last == ")" and url.count(")") > url.count("("))
            or (last == "]" and url.count("]") > url.count("["))
        ):
            url = url[:-1]
        else:
            break
    return url


def link_keys(body: str) -> set[str]:
    """The keys of every link in a body, as the clients read it now and as they did before
    2026-11-05 (a superset)."""
    keys: set[str] = set()

    def add(url: str) -> None:
        key = preview_key(url)
        if key is not None:
            keys.add(key)

    for start in _START.finditer(body):
        bare = _BARE.match(body, start.start())
        if bare is not None:
            add(bare_url(bare.group(0)))
        legacy = _LEGACY_LINK.match(body, start.start())
        if legacy is not None:
            add(legacy.group(0))
            add(legacy.group(0).rstrip(_LEGACY_TRAILING))
    for labelled in _LABELLED.finditer(body):
        add(labelled.group(1))
    return keys


def excerpt(body: str) -> tuple[str, bool]:
    """The first EXCERPT_LINES lines, at most EXCERPT_CHARS characters, without cutting a mention
    token in half; (text, whether anything was left out)."""
    text = body.strip()
    lines = text.split("\n")
    cut = "\n".join(lines[:EXCERPT_LINES])
    truncated = len(lines) > EXCERPT_LINES
    if len(cut) > EXCERPT_CHARS:
        end = EXCERPT_CHARS
        for token in _TOKEN.finditer(cut):
            if token.start() < end < token.end():
                end = token.start()
                break
        cut = cut[:end]
        truncated = True
    return cut.rstrip(), truncated


def _thumbnail(files: list[AttachmentOut]) -> uuid.UUID | None:
    """The first photo or video poster the reader can load: a posted file moved out of the
    channel's drive or in its trash answers 404 to them (SECURITY.md §4), so it is skipped."""
    for file in files:
        if not (file.has_thumbnail or file.has_poster):
            continue
        if file.drive is not None and file.drive.state != "available":
            continue
        return file.id
    return None


def _unavailable(message_id: uuid.UUID) -> MessagePreviewOut:
    return MessagePreviewOut(id=message_id, state="unavailable")


async def previews(db: AsyncSession, actor: User, ids: list[uuid.UUID]) -> list[MessagePreviewOut]:
    """§3.2: one item per distinct id, in order. Readable is GET /messages/{id}'s rule: a member
    of the conversation, or anyone but a guest in a public channel while the preview before
    joining is on (M27, M88). Unreadable, missing and deleted-and-unreadable are all
    `unavailable`."""
    wanted = list(dict.fromkeys(ids))
    rows = (await db.execute(select(Message).where(Message.id.in_(wanted)))).scalars().all()
    by_id = {m.id: m for m in rows}
    channel_ids = {m.channel_id for m in rows}
    found = (
        (await db.execute(select(Channel).where(Channel.id.in_(channel_ids)))).scalars().all()
        if channel_ids
        else []
    )
    channel_of = {c.id: c for c in found}
    member_of = await repo.member_channel_ids(db, actor.id, channel_ids)
    preview_on: bool | None = None

    async def readable(channel: Channel) -> bool:
        nonlocal preview_on
        if channel.id in member_of:
            return True
        if channel.type != "public" or actor.is_guest:
            return False
        if preview_on is None:
            preview_on = await channels.preview_allowed(db)
        return preview_on

    allowed: list[Message] = []
    for row in by_id.values():
        channel = channel_of.get(row.channel_id)
        if channel is not None and await readable(channel):
            allowed.append(row)
    readable_ids = {m.id for m in allowed}
    files = await attachments.for_messages(db, [m.id for m in allowed if not m.is_deleted])

    out: list[MessagePreviewOut] = []
    for message_id in wanted:
        message = by_id.get(message_id)
        if message is None or message_id not in readable_ids:
            out.append(_unavailable(message_id))
            continue
        if message.is_deleted:
            out.append(MessagePreviewOut(id=message_id, state="deleted"))
            continue
        channel = channel_of[message.channel_id]
        text, truncated = excerpt(message.body)
        attached = files.get(message.id, [])
        out.append(
            MessagePreviewOut(
                id=message_id,
                state="ok",
                channel_id=channel.id,
                channel_type=channel.type,  # type: ignore[arg-type]
                channel_name=channel.name if channel.type in ("public", "private") else None,
                parent_id=message.parent_id,
                sender_id=message.sender_id,
                created_at=message.created_at,
                edited_at=message.edited_at,
                excerpt=text,
                excerpt_truncated=truncated,
                attachment_count=len(attached),
                attachment_types=[a.content_type for a in attached[:ATTACHMENT_TYPES_MAX]],
                thumbnail_attachment_id=_thumbnail(attached),
            )
        )
    return out
