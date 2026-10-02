"""Canvases: Markdown documents that belong to a conversation (CANVAS.md, M41).

Access follows the conversation's membership (§4.7): members read (guests too), and what they may
change depends on the channel type, their role and the canvas's edit_policy. Saves send the whole
body with the version it was written on (`base_rev_id`); when someone else saved in between, the
server merges the two (merge.py) under a row lock on the canvas, so every save is serialised and
nothing is overwritten silently (§4.4). Every change writes an outbox row in the same
transaction: canvas.created / canvas.updated / canvas.deleted to the conversation's members, with
the metadata only (§4.6). Canvases do not use the channel's seq.

M42 added the rest of the server (CANVAS.md §11 "M42"): images and files referred to by the body
(`attachment:<uuid>`) are bound to the canvas when the uploader saves them (§4.10); sharing posts
an ordinary message with the permalink `<server>/c/<id>` whose thread holds the comments (§4.13);
and `housekeeping` (run by the hourly purge loop) thins old versions (§4.9), purges the trash
after 30 days (audited as canvas.purge) and lets go of images no version refers to any more.
Search lives in the search module (read-only access to canvases, ARCHITECTURE.md §5).

M72 (CANVAS.md §18.1): a save, a merge or a create whose body mentions someone (`<@id>`, or a
`<@group:id>` with them in it) who was not mentioned in the head before writes canvas.mentioned to
each such member of the conversation (not the author), in the same transaction; the push planner
notifies them. A restore or a tick never does. M76 (§20): the same people (not bots) get an
activity item (activity/canvas_mentions.py), one per canvas while unread.
"""

import asyncio
import re
import uuid
from collections import Counter
from collections.abc import Awaitable, Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from functools import partial
from zoneinfo import ZoneInfo

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, bad_request, conflict, forbidden, not_found
from app.core.ids import uuid7
from app.core.time import utcnow
from app.events.outbox import write_outbox
from app.modules.activity import canvas_mentions
from app.modules.attachments import service as attachments
from app.modules.audit import service as audit
from app.modules.canvases import markers, merge
from app.modules.canvases import repository as repo
from app.modules.canvases import templates as tpl
from app.modules.canvases.events import (
    CANVAS_CREATED,
    CANVAS_DELETED,
    CANVAS_MENTIONED,
    CANVAS_UPDATED,
)
from app.modules.canvases.models import Canvas, CanvasRevision, CanvasTemplate
from app.modules.canvases.schemas import (
    MAX_BODY_LENGTH,
    MAX_CANVASES_PER_CONVERSATION,
    MAX_TITLE_LENGTH,
    CanvasChange,
    CanvasConflictDetails,
    CanvasCreate,
    CanvasCreatedData,
    CanvasDeletedData,
    CanvasMentionedData,
    CanvasMeta,
    CanvasOut,
    CanvasPage,
    CanvasTemplateCreate,
    CanvasTemplateOut,
    CanvasTemplateUpdate,
    CanvasUpdate,
    CanvasUpdatedData,
    ConflictOut,
    ContentSave,
    RevisionMeta,
    RevisionOut,
    RevisionPage,
    RevisionRestore,
    RevisionUpdate,
    SaveOut,
    to_meta,
    to_out,
    to_revision_meta,
    to_revision_out,
    to_template_out,
)
from app.modules.channels import service as channels
from app.modules.channels.models import Channel, ChannelMember
from app.modules.groups import service as groups
from app.modules.messages import service as messages
from app.modules.messages.mentions import (
    MAX_MENTIONS,
    MENTION_GROUP,
    MENTION_USER,
    extract_group_mentions,
    extract_mentions,
)
from app.modules.messages.schemas import MessageCreate
from app.modules.users import service as users
from app.modules.users.models import User

DEFAULT_TITLE = "無題のキャンバス"
MAX_REVISION_PAGE = 100
# CANVAS.md §4.4 / §8: merges run off the event loop, a few at a time, within this budget.
MERGE_BUDGET_SECONDS = merge.DEFAULT_BUDGET_SECONDS
_merge_pool: ThreadPoolExecutor | None = None

# `- [ ] item` / `* [x] item`, nested with leading spaces (CANVAS.md §4.2), in markers.py.
TASK_LINE = markers.TASK_LINE
# An image or file in the body: `![説明](attachment:<uuid>)` (CANVAS.md §4.2, §4.10). Any case:
# a client may print the id in capitals (Swift's uuidString).
ATTACHMENT_REF = re.compile(
    r"attachment:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"
)

# CANVAS.md §4.9 / §4.14: every version of the last day stays (the bases of editing devices);
# after that side versions go and a run of one author's versions keeps the last of every ten
# minutes. The trash is purged after `trash_days` (settings.canvas_trash_retention_days).
KEEP_ALL_REVISIONS = timedelta(hours=24)
THIN_BUCKET = timedelta(minutes=10)
# Versions are thinned once, soon after they pass KEEP_ALL_REVISIONS: only this far back is read
# again each hour (a server that was down longer leaves a few extra versions, never fewer).
THIN_LOOKBACK = timedelta(days=7)
# An image no version refers to any more is let go this long after it was bound (by then every
# version that could refer to it is older than KEEP_ALL_REVISIONS or still kept).
IMAGE_GRACE = timedelta(hours=24)
PURGE_BATCH = 100


# M80 (CANVAS.md §22): what follows when a save ticks or unticks the box of an item linked to a
# task — tasks.service.follow_canvas_ticks, injected by main.py (tasks depends on canvases, not
# the other way round). Called in the save's transaction with {task_id: ticked}; it never fails
# the save (a task the saver may not change is left as it is).
TaskTicks = Callable[[AsyncSession, User, uuid.UUID, dict[uuid.UUID, bool]], Awaitable[None]]
_task_ticks: TaskTicks | None = None


def set_task_ticks_handler(handler: TaskTicks | None) -> None:
    global _task_ticks
    _task_ticks = handler


# --- body helpers --------------------------------------------------------------------------------


def clean_body(body: str) -> str:
    """One newline convention (\n), and the length limit (422 canvas_too_large)."""
    cleaned = body.replace("\r\n", "\n").replace("\r", "\n")
    if len(cleaned) > MAX_BODY_LENGTH:
        raise AppError(
            422,
            "canvas_too_large",
            f"A canvas holds at most {MAX_BODY_LENGTH} characters",
            details={"max_length": MAX_BODY_LENGTH},
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
    """True when `after` differs from `before` only in task boxes ([ ] ↔ [x]) (§4.7)."""
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


def permalink(base_url: str, canvas_id: uuid.UUID) -> str:
    """`<server>/c/<canvas_id>` (CANVAS.md §4.13), like a message's `<server>/m/<id>`."""
    return f"{base_url.rstrip('/')}/c/{canvas_id}"


def mention_tokens(body: str) -> tuple[set[uuid.UUID], set[uuid.UUID]]:
    """(users, groups) the body mentions (`<!channel>` / `<!here>` never notify in a canvas)."""
    return (
        {uuid.UUID(raw) for raw in MENTION_USER.findall(body)},
        {uuid.UUID(raw) for raw in MENTION_GROUP.findall(body)},
    )


async def _mentioned_people(db: AsyncSession, body: str) -> set[uuid.UUID]:
    user_ids, group_ids = mention_tokens(body)
    if group_ids:
        user_ids |= set(await groups.expand(db, sorted(group_ids)))
    return user_ids


async def _record_activity(
    db: AsyncSession,
    canvas: Canvas,
    actor: User,
    person: User,
    revision_id: uuid.UUID,
    groups_with_person: list[uuid.UUID],
    at: datetime,
) -> None:
    """M76 (CANVAS.md §20): the person's activity item, with the line around the mention (names
    as the person sees them)."""
    found = canvas_mentions.find_mention(markers.strip(canvas.body), person.id, groups_with_person)
    excerpt = ""
    if found is not None:
        line, position = found
        visible = await channels.visible_user_ids(db, person)
        shown = [uid for uid in extract_mentions(line)[0] if visible is None or uid in visible]
        names = {uid: user.display_name for uid, user in (await users.get_users(db, shown)).items()}
        names.update(await groups.names_for(db, extract_group_mentions(line)))
        excerpt = canvas_mentions.excerpt_around(line, position, names)
    await canvas_mentions.record(
        db,
        user_id=person.id,
        read_at=person.activity_read_at,
        canvas_id=canvas.id,
        rev_id=revision_id,
        actor_id=actor.id,
        excerpt=excerpt,
        at=at,
    )


async def _notify_mentions(
    db: AsyncSession, canvas: Canvas, actor: User, before: str, revision_id: uuid.UUID
) -> None:
    """canvas.mentioned to the members newly mentioned by this version (CANVAS.md §18.1)."""
    after_users, after_groups = mention_tokens(canvas.body)
    before_users, before_groups = mention_tokens(before)
    if after_users <= before_users and after_groups <= before_groups:
        return  # no mention was added
    added = await _mentioned_people(db, canvas.body) - await _mentioned_people(db, before)
    added.discard(actor.id)
    if not added:
        return
    members = set(await channels.member_ids_of(db, canvas.channel_id))
    people = await users.get_users(db, sorted(added & members))
    targets = sorted(uid for uid, user in people.items() if user.deactivated_at is None)
    group_members: dict[uuid.UUID, set[uuid.UUID]] | None = None
    now = utcnow()
    for user_id in targets[:MAX_MENTIONS]:
        person = people[user_id]
        if person.role != "bot":  # M76 (§20): the activity item; bots have no activity
            if group_members is None and f"<@{user_id}>" not in canvas.body:
                group_members = {
                    gid: set(await groups.expand(db, [gid])) for gid in sorted(after_groups)
                }
            await _record_activity(
                db,
                canvas,
                actor,
                person,
                revision_id,
                [gid for gid, ids in (group_members or {}).items() if user_id in ids],
                now,
            )
        data = CanvasMentionedData(
            canvas_id=canvas.id,
            channel_id=canvas.channel_id,
            rev_id=revision_id,
            title=canvas.title,
            by_user_id=actor.id,
        )
        await write_outbox(
            db,
            event_type=CANVAS_MENTIONED,
            audience_type="user",
            audience_id=user_id,
            channel_id=canvas.channel_id,
            payload=data.model_dump(mode="json"),
        )


async def _merge(base: str, ours: str, theirs: str, resolve: merge.Resolve) -> merge.MergeResult:
    global _merge_pool
    if _merge_pool is None:
        _merge_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="canvas-merge")
    call = partial(
        merge.merge3, base, ours, theirs, resolve=resolve, budget_seconds=MERGE_BUDGET_SECONDS
    )
    return await asyncio.get_running_loop().run_in_executor(_merge_pool, call)


# --- access (CANVAS.md §4.7) ---------------------------------------------------------------------


def _is_manager(actor: User, membership: ChannelMember) -> bool:
    return actor.is_admin or membership.role == "owner"


def _require_creator_rights(actor: User, channel: Channel, membership: ChannelMember) -> None:
    """Who may make a canvas here, and (edit_policy=members) change its body."""
    if channel.is_dm:
        return
    channels.require_not_guest(actor)
    if channel.posting_policy == "owners" and not _is_manager(actor, membership):
        raise forbidden(
            "posting_restricted", "Only owners and administrators can change canvases here"
        )


def _require_body_editor(
    actor: User, channel: Channel, membership: ChannelMember, canvas: Canvas
) -> None:
    if channel.is_dm:
        return
    if canvas.edit_policy == "owners":
        channels.require_not_guest(actor)
        if canvas.created_by != actor.id and not _is_manager(actor, membership):
            raise forbidden(
                "canvas_edit_restricted",
                "Only the creator, owners and administrators change this canvas",
            )
        return
    _require_creator_rights(actor, channel, membership)


def _may_edit_body(
    actor: User, channel: Channel, membership: ChannelMember, canvas: Canvas
) -> bool:
    try:
        _require_body_editor(actor, channel, membership, canvas)
    except AppError:
        return False
    return True


def _require_manager(
    actor: User, channel: Channel, membership: ChannelMember, canvas: Canvas
) -> None:
    """Title, edit_policy, the tab, trash and restore: in a DM its members (trash: the creator),
    elsewhere the creator, the channel's owners and administrators."""
    if channel.is_dm:
        return
    channels.require_not_guest(actor)
    if canvas.created_by != actor.id and not _is_manager(actor, membership):
        raise forbidden(
            "canvas_edit_restricted",
            "Only the creator, owners and administrators change this canvas",
        )


def _require_trasher(
    actor: User, channel: Channel, membership: ChannelMember, canvas: Canvas
) -> None:
    if channel.is_dm:
        if canvas.created_by != actor.id:
            raise forbidden("canvas_edit_restricted", "Only its creator deletes this canvas")
        return
    _require_manager(actor, channel, membership, canvas)


def _require_eraser(
    actor: User, channel: Channel, membership: ChannelMember, canvas: Canvas
) -> None:
    if channel.is_dm:
        if canvas.created_by != actor.id:
            raise forbidden("canvas_edit_restricted", "Only its creator erases versions")
        return
    if not _is_manager(actor, membership):
        raise forbidden("canvas_edit_restricted", "Only owners and administrators erase versions")


async def _load(
    db: AsyncSession,
    actor: User,
    canvas_id: uuid.UUID,
    *,
    lock: bool = False,
    trashed: bool = False,
) -> tuple[Canvas, Channel, ChannelMember]:
    """The canvas and the actor's membership of its conversation. A canvas in the trash is
    not found, except for `trashed` (restore)."""
    canvas = await repo.get(db, canvas_id, lock=lock)
    if canvas is None or canvas.is_deleted != trashed:
        raise not_found("canvas_not_found", "Canvas not found")
    channel, membership = await channels.require_member(db, actor.id, canvas.channel_id)
    return canvas, channel, membership


# --- events --------------------------------------------------------------------------------------


async def _emit_created(db: AsyncSession, canvas: Canvas) -> None:
    await write_outbox(
        db,
        event_type=CANVAS_CREATED,
        audience_type="channel",
        channel_id=canvas.channel_id,
        payload=CanvasCreatedData(canvas=to_meta(canvas)).model_dump(mode="json"),
    )


async def _emit_updated(db: AsyncSession, canvas: Canvas, change: CanvasChange) -> None:
    await write_outbox(
        db,
        event_type=CANVAS_UPDATED,
        audience_type="channel",
        channel_id=canvas.channel_id,
        payload=CanvasUpdatedData(canvas=to_meta(canvas), change=change).model_dump(mode="json"),
    )


def _touch(canvas: Canvas, actor: User) -> None:
    canvas.version += 1
    canvas.updated_by = actor.id
    canvas.updated_at = utcnow()


# --- reading -------------------------------------------------------------------------------------


async def list_for_channel(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, *, trashed: bool = False
) -> list[CanvasMeta]:
    await channels.require_member(db, actor.id, channel_id)
    rows = await repo.list_for_channel(db, channel_id, trashed=trashed)
    return [to_meta(row, trashed=trashed) for row in rows]


def _parse_cursor(cursor: str | None) -> tuple[datetime, uuid.UUID] | None:
    if cursor is None:
        return None
    try:
        raw_at, raw_id = cursor.split("|", 1)
        return datetime.fromisoformat(raw_at), uuid.UUID(raw_id)
    except ValueError as exc:
        raise bad_request("invalid_cursor", "Malformed cursor") from exc


async def list_mine(db: AsyncSession, actor: User, *, cursor: str | None, limit: int) -> CanvasPage:
    ids = await channels.member_channel_ids(db, actor.id)
    rows = await repo.list_for_channels(db, ids, before=_parse_cursor(cursor), limit=limit + 1)
    more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = f"{rows[-1].updated_at.isoformat()}|{rows[-1].id}" if more and rows else None
    return CanvasPage(items=[to_meta(r) for r in rows], next_cursor=next_cursor)


async def get(db: AsyncSession, actor: User, canvas_id: uuid.UUID) -> CanvasOut:
    canvas, _, _ = await _load(db, actor, canvas_id)
    return to_out(canvas)


async def tab_ids(db: AsyncSession, channel_ids: list[uuid.UUID]) -> dict[uuid.UUID, uuid.UUID]:
    """For bootstrap (sync): each conversation's canvas tab."""
    return await repo.tab_ids(db, channel_ids)


async def export_rows(db: AsyncSession, channel_id: uuid.UUID) -> list[CanvasOut]:
    """A conversation's live canvases for `cli export-channel` (CANVAS.md §4.14)."""
    return [to_out(row) for row in await repo.export_rows(db, channel_id)]


# --- creating ------------------------------------------------------------------------------------


async def _channel_label(db: AsyncSession, actor: User, channel: Channel) -> str:
    if channel.name:
        return str(channel.name)
    others = [uid for uid in await channels.member_ids_of(db, channel.id) if uid != actor.id]
    if not others:
        return actor.display_name
    users = await channels.load_users(db, others)
    return "、".join(sorted(u.display_name for u in users))


async def _existing_create(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, client_save_id: uuid.UUID
) -> CanvasOut | None:
    revision = await repo.revision_by_save_id(db, actor.id, client_save_id)
    if revision is None:
        return None
    canvas = await repo.get(db, revision.canvas_id)
    if revision.kind != "create" or canvas is None or canvas.channel_id != channel_id:
        raise conflict("idempotency_conflict", "client_save_id was already used for another save")
    await channels.require_member(db, actor.id, channel_id)
    if canvas.is_deleted:
        raise not_found("canvas_not_found", "Canvas not found")
    return to_out(canvas)


def _constraint(exc: IntegrityError) -> str:
    return str(exc.orig)


async def create(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, data: CanvasCreate, *, base_url: str
) -> tuple[CanvasOut, bool]:
    """(canvas, created). A retry with the same client_save_id returns the first one.

    `share_to_channel` posts the permalink (built on `base_url`, the server's address as the
    client reached it) to the conversation in the same transaction (CANVAS.md §4.13)."""
    existing = await _existing_create(db, actor, channel_id, data.client_save_id)
    if existing is not None:
        return existing, False
    channel, membership = await channels.require_member(db, actor.id, channel_id)
    channels.require_writable(channel)
    _require_creator_rights(actor, channel, membership)
    if await repo.count_live(db, channel_id) >= MAX_CANVASES_PER_CONVERSATION:
        raise conflict(
            "too_many_canvases",
            f"A conversation holds at most {MAX_CANVASES_PER_CONVERSATION} canvases",
        )
    template: CanvasTemplate | None = None
    if data.template_key is not None:
        template = await repo.template_by_key(db, data.template_key)
        if template is None or template.hidden:
            raise not_found("template_not_found", "Template not found")
    title, body = data.title, data.body
    if template is not None and (title is None or body is None):
        today = utcnow().astimezone(ZoneInfo(data.tz or "UTC")).date()
        ctx = tpl.Context(
            today=today,
            me_id=actor.id,
            me_name=actor.display_name,
            channel=await _channel_label(db, actor, channel),
        )
        if title is None:
            title = " ".join(tpl.expand(template.title, ctx, title=True).split())
        if body is None:
            body = tpl.expand(template.body, ctx, title=False)
    title = (title or DEFAULT_TITLE)[:MAX_TITLE_LENGTH]
    body = clean_body(body or "")
    if data.as_tab and await repo.tab_of(db, channel_id) is not None:
        raise conflict("canvas_tab_taken", "This conversation already has a canvas tab")

    total, done = count_tasks(body)
    revision_id = uuid7()
    canvas = Canvas(
        id=uuid7(),
        channel_id=channel_id,
        title=title,
        body=body,
        version=1,
        head_rev_id=revision_id,
        is_channel_tab=data.as_tab,
        edit_policy="members",
        template_key=template.key if template is not None else None,
        task_total=total,
        task_done=done,
        created_by=actor.id,
        updated_by=actor.id,
    )
    db.add(canvas)
    try:
        await db.flush()
        db.add(
            CanvasRevision(
                id=revision_id,
                canvas_id=canvas.id,
                version=1,
                kind="create",
                author_id=actor.id,
                title=title,
                body=body,
                client_save_id=data.client_save_id,
                lines_added=len(body.split("\n")) if body else 0,
            )
        )
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        if "canvases_tab_uniq" in _constraint(exc):
            raise conflict(
                "canvas_tab_taken", "This conversation already has a canvas tab"
            ) from exc
        # The same create running twice at once: the other one won.
        again = await _existing_create(db, actor, channel_id, data.client_save_id)
        if again is None:
            raise
        return again, False
    await _bind_images(db, actor, canvas)
    if data.share_to_channel:
        canvas.share_message_id = await _post_share(db, actor, canvas, base_url)
        await db.flush()
    await _emit_created(db, canvas)
    await _notify_mentions(db, canvas, actor, "", revision_id)
    await db.commit()
    return to_out(canvas), True


# --- images and sharing (CANVAS.md §4.10, §4.13) -------------------------------------------------


async def _bind_images(db: AsyncSession, actor: User, canvas: Canvas) -> None:
    """The actor's pending uploads that the body now refers to become the canvas's."""
    refs = attachment_refs(canvas.body)
    if refs:
        await attachments.bind_to_canvas_in_tx(
            db,
            actor.id,
            canvas_id=canvas.id,
            channel_id=canvas.channel_id,
            attachment_ids=refs,
        )


def share_body(canvas: Canvas, base_url: str) -> str:
    """The shared message: the title and the permalink (the apps show it as a card). `<` is
    made harmless so that a title never mentions anyone (`<!channel>`, `<@id>`) in the name of
    whoever shares it."""
    title = canvas.title.replace("<", "\uff1c")  # the full-width form
    return f"📄 {title}\n{permalink(base_url, canvas.id)}"


async def _post_share(db: AsyncSession, actor: User, canvas: Canvas, base_url: str) -> uuid.UUID:
    """An ordinary message in the conversation (unread, pushes and search as for any post),
    written in the caller's transaction."""
    message, _ = await messages.create_message(
        db,
        actor,
        canvas.channel_id,
        MessageCreate(client_msg_id=uuid.uuid4(), body=share_body(canvas, base_url)),
        commit=False,
    )
    return message.id


async def share(db: AsyncSession, actor: User, canvas_id: uuid.UUID, *, base_url: str) -> CanvasOut:
    """Share to the conversation, or nothing if its shared message still exists (idempotent: the
    row lock orders two at once). The comments are that message's thread, so a client opening
    the comments of a canvas that was never shared calls this first."""
    canvas, channel, _ = await _load(db, actor, canvas_id, lock=True)
    if canvas.share_message_id is not None and (
        await messages.live_bodies(db, [canvas.share_message_id])
    ):
        out = to_out(canvas)
        await db.commit()
        return out
    channels.require_writable(channel)
    canvas.share_message_id = await _post_share(db, actor, canvas, base_url)
    # Not an edit: updated_by / updated_at stay, only the version moves (the metadata changed).
    canvas.version += 1
    await db.flush()
    await _emit_updated(db, canvas, "settings")
    out = to_out(canvas)
    await db.commit()
    return out


# --- saving (CANVAS.md §4.4) ---------------------------------------------------------------------


def _conflict_details(
    canvas: Canvas, conflicts: tuple[merge.Conflict, ...] = (), *, timed_out: bool = False
) -> dict[str, object]:
    details = CanvasConflictDetails(
        head=to_out(canvas),
        conflicts=[
            ConflictOut(
                base=c.base,
                ours=c.ours,
                theirs=c.theirs,
                ours_line=c.ours_line,
                theirs_line=c.theirs_line,
            )
            for c in conflicts
        ],
        timed_out=timed_out,
    )
    return details.model_dump(mode="json")


def _revision(
    canvas: Canvas,
    actor: User,
    *,
    kind: str,
    body: str,
    parent: uuid.UUID | None,
    parent_body: str,
    version: int | None,
    client_save_id: uuid.UUID | None = None,
) -> CanvasRevision:
    added, removed = line_changes(parent_body, body)
    return CanvasRevision(
        id=uuid7(),
        canvas_id=canvas.id,
        version=version,
        kind=kind,
        parent_rev_id=parent,
        author_id=actor.id,
        title=canvas.title,
        body=body,
        client_save_id=client_save_id,
        lines_added=added,
        lines_removed=removed,
    )


async def _set_body(
    db: AsyncSession,
    canvas: Canvas,
    actor: User,
    body: str,
    *,
    kind: str,
    parent: uuid.UUID,
    client_save_id: uuid.UUID | None,
    change: CanvasChange,
    notify: bool = True,
) -> CanvasRevision:
    """A new head version: the revision, the canvas row and canvas.updated, in one transaction;
    `notify`: canvas.mentioned to whom it newly mentions (not for a restore, §18.1)."""
    before = canvas.body
    revision = _revision(
        canvas,
        actor,
        kind=kind,
        body=body,
        parent=parent,
        parent_body=canvas.body,
        version=canvas.version + 1,
        client_save_id=client_save_id,
    )
    db.add(revision)
    await db.flush()
    _touch(canvas, actor)
    canvas.body = body
    canvas.head_rev_id = revision.id
    canvas.task_total, canvas.task_done = count_tasks(body)
    await db.flush()
    await _bind_images(db, actor, canvas)
    await _emit_updated(db, canvas, change)
    if notify:
        await _notify_mentions(db, canvas, actor, before, revision.id)
    if kind in ("save", "merge") and _task_ticks is not None:
        # M80 (§22): a box ticked or unticked on a linked item; the task follows (as the saver).
        ticks = markers.ticks_changed(before, body)
        if ticks:
            await _task_ticks(db, actor, canvas.id, ticks)
    return revision


async def save_content(
    db: AsyncSession, actor: User, canvas_id: uuid.UUID, data: ContentSave
) -> SaveOut:
    body = clean_body(data.body)
    canvas, channel, membership = await _load(db, actor, canvas_id, lock=True)

    # A retry of a save that already landed: the state now, and the version it made.
    done = await repo.revision_by_save_id(db, actor.id, data.client_save_id)
    if done is not None:
        if done.canvas_id != canvas.id:
            raise conflict(
                "idempotency_conflict", "client_save_id was already used for another canvas"
            )
        out = to_out(canvas)
        await db.commit()
        return SaveOut(canvas=out, submitted_rev_id=done.id, merged=done.kind == "side")

    channels.require_writable(channel)
    base = await repo.get_revision(db, data.base_rev_id)
    if base is None or base.canvas_id != canvas.id or base.kind == "erased":
        raise conflict(
            "canvas_base_expired",
            "The version this was written on is gone; compare with the current one",
            _conflict_details(canvas),
        )
    # Ticking tasks is open to every member but guests, whatever the edit policy (§4.7).
    full_editor = _may_edit_body(actor, channel, membership, canvas)
    if not full_editor:
        if not only_tasks_toggled(base.body, body) or (not channel.is_dm and actor.is_guest):
            _require_body_editor(actor, channel, membership, canvas)  # raises the reason
        if data.on_conflict in ("ours", "both"):
            raise forbidden(
                "canvas_edit_restricted", "Only ticking tasks: keep the other version instead"
            )

    if base.id == canvas.head_rev_id or body == canvas.body:
        if body == canvas.body:
            return await _unchanged(db, canvas)
        revision = await _set_body(
            db,
            canvas,
            actor,
            body,
            kind="save",
            parent=base.id,
            client_save_id=data.client_save_id,
            change="content",
        )
        out = to_out(canvas)
        await db.commit()
        return SaveOut(canvas=out, submitted_rev_id=revision.id, merged=False)

    result = await _merge(base.body, body, canvas.body, data.on_conflict)
    if result.conflicts and data.on_conflict == "fail":
        details = _conflict_details(canvas, result.conflicts, timed_out=result.timed_out)
        await db.rollback()
        raise conflict("canvas_conflict", "Someone changed the same words", details)
    side = _revision(
        canvas,
        actor,
        kind="side",
        body=body,
        parent=base.id,
        parent_body=base.body,
        version=None,
        client_save_id=data.client_save_id,
    )
    db.add(side)
    await db.flush()
    merged_body = clean_body(result.text)
    if merged_body != canvas.body:
        await _set_body(
            db,
            canvas,
            actor,
            merged_body,
            kind="merge",
            parent=canvas.head_rev_id,
            client_save_id=None,
            change="content",
        )
    out = to_out(canvas)
    await db.commit()
    return SaveOut(canvas=out, submitted_rev_id=side.id, merged=True)


async def _unchanged(db: AsyncSession, canvas: Canvas) -> SaveOut:
    out = to_out(canvas)
    await db.commit()
    return SaveOut(canvas=out, submitted_rev_id=canvas.head_rev_id, merged=False)


# --- items linked to tasks (M80, CANVAS.md §22) ---------------------------------------------------


async def _tickable(db: AsyncSession, actor: User, canvas_id: uuid.UUID) -> Canvas | None:
    """The canvas, locked, when the actor may tick its boxes (a member, not a guest outside a DM,
    a conversation not archived, the canvas not in the trash, §4.7); else None."""
    canvas = await repo.get(db, canvas_id, lock=True)
    if canvas is None or canvas.is_deleted:
        return None
    if await channels.membership_of(db, actor.id, canvas.channel_id) is None:
        return None
    channel = await channels.require_channel(db, canvas.channel_id)
    if channel.is_archived or (not channel.is_dm and actor.is_guest):
        return None
    return canvas


async def link_task_in_tx(
    db: AsyncSession, actor: User, canvas_id: uuid.UUID, line: str, task_id: uuid.UUID
) -> bool:
    """A task was made from the checklist item `line` (§18.3): its marker goes at the end of that
    line, as a new version by the task's maker (kind task) on top of the head, under the canvas's
    lock — a device editing meanwhile merges it like anyone's save. The box is left as it is.
    Nothing happens (False) when the maker may not tick here or the item is gone by now."""
    canvas = await _tickable(db, actor, canvas_id)
    if canvas is None:
        return False
    index = markers.find_item(canvas.body, line)
    if index is None:
        return False
    body = markers.with_marker(canvas.body, index, task_id)
    if body == canvas.body:
        return True
    if len(body) > MAX_BODY_LENGTH:
        return False
    await _set_body(
        db,
        canvas,
        actor,
        body,
        kind="task",
        parent=canvas.head_rev_id,
        client_save_id=None,
        change="content",
        notify=False,
    )
    return True


async def follow_task_in_tx(
    db: AsyncSession, actor: User, canvas_id: uuid.UUID, task_id: uuid.UUID, done: bool
) -> bool:
    """The task was completed (done) or reopened: the boxes of the items carrying its marker
    follow, as a new version by whoever changed the task (kind task, on top of the head under the
    lock). Nothing (False) when no box changes, the items are gone, or that person may not tick
    in this canvas. A version of kind task never moves a task (no loop back)."""
    canvas = await _tickable(db, actor, canvas_id)
    if canvas is None:
        return False
    body = markers.set_box(canvas.body, task_id, done)
    if body == canvas.body:
        return False
    await _set_body(
        db,
        canvas,
        actor,
        body,
        kind="task",
        parent=canvas.head_rev_id,
        client_save_id=None,
        change="content",
        notify=False,
    )
    return True


# --- settings, trash -----------------------------------------------------------------------------


async def update(
    db: AsyncSession, actor: User, canvas_id: uuid.UUID, data: CanvasUpdate
) -> CanvasOut:
    canvas, channel, membership = await _load(db, actor, canvas_id, lock=True)
    channels.require_writable(channel)
    _require_manager(actor, channel, membership, canvas)
    changes: list[CanvasChange] = []
    if data.title is not None and data.title != canvas.title:
        canvas.title = data.title
        changes.append("title")
    if data.edit_policy is not None and data.edit_policy != canvas.edit_policy:
        await audit.record_in_tx(
            db,
            actor_id=actor.id,
            action="canvas.edit_policy",
            target_type="canvas",
            target_id=canvas.id,
            details={"from": canvas.edit_policy, "to": data.edit_policy},
        )
        canvas.edit_policy = data.edit_policy
        changes.append("settings")
    if data.is_channel_tab is not None and data.is_channel_tab != canvas.is_channel_tab:
        if data.is_channel_tab and await repo.tab_of(db, canvas.channel_id) is not None:
            raise conflict("canvas_tab_taken", "This conversation already has a canvas tab")
        canvas.is_channel_tab = data.is_channel_tab
        changes.append("settings")
    if not changes:
        out = to_out(canvas)
        await db.commit()
        return out
    _touch(canvas, actor)
    try:
        await db.flush()
    except IntegrityError as exc:  # the tab index, against a concurrent request
        await db.rollback()
        raise conflict("canvas_tab_taken", "This conversation already has a canvas tab") from exc
    await _emit_updated(db, canvas, "title" if changes == ["title"] else "settings")
    out = to_out(canvas)
    await db.commit()
    return out


async def delete(db: AsyncSession, actor: User, canvas_id: uuid.UUID) -> None:
    """To the trash (restorable; purged after 30 days, M42)."""
    canvas, channel, membership = await _load(db, actor, canvas_id, lock=True)
    channels.require_writable(channel)
    _require_trasher(actor, channel, membership, canvas)
    _touch(canvas, actor)
    canvas.deleted_at = canvas.updated_at
    canvas.deleted_by = actor.id
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="canvas.delete",
        target_type="canvas",
        target_id=canvas.id,
        details={"channel_id": str(canvas.channel_id), "title": canvas.title},
    )
    await write_outbox(
        db,
        event_type=CANVAS_DELETED,
        audience_type="channel",
        channel_id=canvas.channel_id,
        payload=CanvasDeletedData(canvas_id=canvas.id, channel_id=canvas.channel_id).model_dump(
            mode="json"
        ),
    )
    await db.commit()


async def restore(db: AsyncSession, actor: User, canvas_id: uuid.UUID) -> CanvasOut:
    """Back from the trash (as canvas.created to the members). It stops being the tab if the
    conversation has another one by now."""
    canvas, channel, membership = await _load(db, actor, canvas_id, lock=True, trashed=True)
    channels.require_writable(channel)
    _require_trasher(actor, channel, membership, canvas)
    if canvas.is_channel_tab and await repo.tab_of(db, canvas.channel_id) is not None:
        canvas.is_channel_tab = False
    _touch(canvas, actor)
    canvas.deleted_at = None
    canvas.deleted_by = None
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="canvas.restore",
        target_type="canvas",
        target_id=canvas.id,
        details={"channel_id": str(canvas.channel_id)},
    )
    try:
        await db.flush()
    except IntegrityError:  # another tab appeared at the same moment
        await db.rollback()
        return await restore(db, actor, canvas_id)
    await _emit_created(db, canvas)
    out = to_out(canvas)
    await db.commit()
    return out


# --- history (CANVAS.md §4.9) --------------------------------------------------------------------


async def _load_revision(
    db: AsyncSession, canvas: Canvas, revision_id: uuid.UUID
) -> CanvasRevision:
    revision = await repo.get_revision(db, revision_id)
    if revision is None or revision.canvas_id != canvas.id:
        raise not_found("canvas_revision_not_found", "Version not found")
    return revision


async def list_revisions(
    db: AsyncSession, actor: User, canvas_id: uuid.UUID, *, cursor: str | None, limit: int
) -> RevisionPage:
    canvas, _, _ = await _load(db, actor, canvas_id)
    rows = await repo.list_revisions(
        db, canvas.id, before=_parse_cursor(cursor), limit=min(limit, MAX_REVISION_PAGE) + 1
    )
    more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = f"{rows[-1].created_at.isoformat()}|{rows[-1].id}" if more and rows else None
    return RevisionPage(items=[to_revision_meta(r) for r in rows], next_cursor=next_cursor)


async def get_revision(
    db: AsyncSession, actor: User, canvas_id: uuid.UUID, revision_id: uuid.UUID
) -> RevisionOut:
    canvas, _, _ = await _load(db, actor, canvas_id)
    return to_revision_out(await _load_revision(db, canvas, revision_id))


async def restore_revision(
    db: AsyncSession,
    actor: User,
    canvas_id: uuid.UUID,
    revision_id: uuid.UUID,
    data: RevisionRestore,
) -> CanvasOut:
    """That version's body as a new version (kind restore; canvas.updated change=restore)."""
    canvas, channel, membership = await _load(db, actor, canvas_id, lock=True)
    done = await repo.revision_by_save_id(db, actor.id, data.client_save_id)
    if done is not None:
        if done.canvas_id != canvas.id:
            raise conflict(
                "idempotency_conflict", "client_save_id was already used for another canvas"
            )
        out = to_out(canvas)  # a retry
        await db.commit()
        return out
    channels.require_writable(channel)
    _require_body_editor(actor, channel, membership, canvas)
    revision = await _load_revision(db, canvas, revision_id)
    if revision.kind == "erased":
        raise conflict("canvas_revision_erased", "This version was erased")
    if revision.body != canvas.body:
        await _set_body(
            db,
            canvas,
            actor,
            revision.body,
            kind="restore",
            parent=canvas.head_rev_id,
            client_save_id=data.client_save_id,
            change="restore",
            notify=False,
        )
    out = to_out(canvas)
    await db.commit()
    return out


async def label_revision(
    db: AsyncSession,
    actor: User,
    canvas_id: uuid.UUID,
    revision_id: uuid.UUID,
    data: RevisionUpdate,
) -> RevisionMeta:
    canvas, channel, membership = await _load(db, actor, canvas_id)
    channels.require_writable(channel)
    _require_body_editor(actor, channel, membership, canvas)
    revision = await _load_revision(db, canvas, revision_id)
    if revision.kind == "side":
        raise not_found("canvas_revision_not_found", "Version not found")
    label = " ".join((data.label or "").split())
    revision.label = label or None
    await db.flush()
    out = to_revision_meta(revision)
    await db.commit()
    return out


async def erase_revision(
    db: AsyncSession, actor: User, canvas_id: uuid.UUID, revision_id: uuid.UUID
) -> RevisionMeta:
    """Erase a version's body (a secret pasted by mistake), audited. The current version cannot
    be erased: change the body first."""
    canvas, channel, membership = await _load(db, actor, canvas_id, lock=True)
    channels.require_writable(channel)
    _require_eraser(actor, channel, membership, canvas)
    revision = await _load_revision(db, canvas, revision_id)
    if revision.id == canvas.head_rev_id:
        raise conflict(
            "canvas_revision_is_head", "The current version cannot be erased; edit the body first"
        )
    if revision.kind != "erased":
        await audit.record_in_tx(
            db,
            actor_id=actor.id,
            action="canvas.revision_erased",
            target_type="canvas",
            target_id=canvas.id,
            details={"revision_id": str(revision.id), "kind": revision.kind},
        )
        revision.kind = "erased"
        revision.body = ""
        await db.flush()
    out = to_revision_meta(revision)
    await db.commit()
    return out


# --- housekeeping (CANVAS.md §4.9, §4.10, §4.14): the hourly purge loop ------------------------


async def prune_revisions(db: AsyncSession, *, now: datetime) -> int:
    """Versions older than a day: side versions go, runs of one author's versions keep the last
    of every ten minutes. create / restore / erased / labelled / head versions stay."""
    cutoff = now - KEEP_ALL_REVISIONS
    removed = await repo.delete_side_revisions(db, cutoff)
    removed += await repo.thin_revisions(
        db, before=cutoff, since=cutoff - THIN_LOOKBACK, bucket=THIN_BUCKET
    )
    await db.commit()
    return removed


async def purge_trash(db: AsyncSession, *, now: datetime, trash_days: int) -> int:
    """Canvases in the trash for `trash_days`: gone for good with their versions, their images
    marked deleted (the attachment GC removes the bytes), one canvas.purge audit entry each. The
    shared message stays in the conversation (the apps show 「表示できないキャンバス」)."""
    purged = 0
    while True:
        rows = await repo.trashed_before(db, now - timedelta(days=trash_days), PURGE_BATCH)
        if not rows:
            break
        ids = [row.id for row in rows]
        counts = await repo.revision_counts(db, ids)
        for row in rows:
            await audit.record_in_tx(
                db,
                actor_id=None,
                action="canvas.purge",
                target_type="canvas",
                target_id=row.id,
                details={
                    "channel_id": str(row.channel_id),
                    "title": row.title,
                    "deleted_at": row.deleted_at.isoformat() if row.deleted_at else None,
                    "deleted_by": str(row.deleted_by) if row.deleted_by else None,
                    "revisions": counts.get(row.id, 0),
                },
            )
        await attachments.mark_canvases_deleted_in_tx(db, ids)
        await repo.delete_canvases(db, ids)
        await db.commit()
        db.expunge_all()
        purged += len(rows)
        if len(rows) < PURGE_BATCH:
            break
    return purged


async def release_unreferenced_images(db: AsyncSession, *, now: datetime) -> int:
    """Images bound more than a day ago that neither the body nor any kept version refers to
    (removed from the body and the versions that had them thinned or erased)."""
    released = 0
    while True:
        ids = await repo.unreferenced_images(db, bound_before=now - IMAGE_GRACE, limit=500)
        if not ids:
            break
        released += await attachments.mark_ids_deleted_in_tx(db, ids)
        await db.commit()
        if len(ids) < 500:
            break
    return released


async def housekeeping(db: AsyncSession, *, now: datetime, trash_days: int) -> tuple[int, int, int]:
    """(versions pruned, canvases purged, images released), each step committed on its own."""
    pruned = await prune_revisions(db, now=now)
    purged = await purge_trash(db, now=now, trash_days=trash_days)
    released = await release_unreferenced_images(db, now=now)
    return pruned, purged, released


# --- templates (CANVAS.md §4.12) -----------------------------------------------------------------


def _require_admin(actor: User) -> None:
    if not actor.is_admin:
        raise forbidden("admin_required", "Only an administrator manages canvas templates")


async def list_templates(
    db: AsyncSession, actor: User, *, include_hidden: bool = False
) -> list[CanvasTemplateOut]:
    if include_hidden:
        _require_admin(actor)
    rows = await repo.list_templates(db, include_hidden=include_hidden)
    return [to_template_out(row) for row in rows]


async def ensure_builtin_templates(db: AsyncSession) -> int:
    """Put back a built-in template that is missing (migration 0046 seeds them; they cannot be
    deleted, so this only matters for a database emptied by hand). Returns how many."""
    added = 0
    for position, builtin in enumerate(tpl.BUILTINS):
        added += await repo.insert_template_if_missing(
            db,
            {
                "id": uuid7(),
                "key": builtin.key,
                "name": builtin.name,
                "description": builtin.description,
                "title": builtin.title,
                "body": builtin.body,
                "position": position,
                "builtin": True,
                "hidden": False,
            },
        )
    await db.commit()
    return added


async def _require_template(db: AsyncSession, template_id: uuid.UUID) -> CanvasTemplate:
    row = await repo.get_template(db, template_id)
    if row is None:
        raise not_found("template_not_found", "Template not found")
    return row


async def create_template(
    db: AsyncSession, actor: User, data: CanvasTemplateCreate
) -> CanvasTemplateOut:
    _require_admin(actor)
    key = data.key or f"custom_{uuid.uuid4().hex[:12]}"
    if await repo.template_by_key(db, key) is not None:
        raise conflict("template_key_taken", "A template with this key already exists")
    row = CanvasTemplate(
        key=key,
        name=data.name.strip(),
        description=data.description,
        title=data.title,
        body=clean_body(data.body),
        position=data.position
        if data.position is not None
        else await repo.next_template_position(db),
        builtin=False,
        hidden=False,
        created_by=actor.id,
    )
    db.add(row)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise conflict("template_key_taken", "A template with this key already exists") from exc
    out = to_template_out(row)
    await db.commit()
    return out


async def update_template(
    db: AsyncSession, actor: User, template_id: uuid.UUID, data: CanvasTemplateUpdate
) -> CanvasTemplateOut:
    _require_admin(actor)
    row = await _require_template(db, template_id)
    if data.name is not None:
        row.name = data.name.strip()
    if data.description is not None:
        row.description = data.description or None
    if data.title is not None:
        row.title = data.title
    if data.body is not None:
        row.body = clean_body(data.body)
    if data.position is not None:
        row.position = data.position
    if data.hidden is not None:
        row.hidden = data.hidden
    row.updated_at = utcnow()
    await db.flush()
    out = to_template_out(row)
    await db.commit()
    return out


async def delete_template(db: AsyncSession, actor: User, template_id: uuid.UUID) -> None:
    _require_admin(actor)
    row = await _require_template(db, template_id)
    if row.builtin:
        raise conflict("template_builtin", "A built-in template can be hidden but not deleted")
    await db.delete(row)
    await db.commit()
