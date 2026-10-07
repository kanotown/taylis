"""In-app calls on LiveKit (M130, docs/CALLS.md).

A call belongs to a conversation (at most one open call each). Starting one writes the `calls` row
and the call message (seq, outbox, push, as any post) in one transaction, creates the LiveKit room,
then commits. Clients get short access tokens for the room from here; LiveKit's webhooks tell who
came and went (`call_participants`), and a reconcile loop corrects what a lost webhook left behind
and cuts off people who may no longer be in the conversation (§3.3, §7.2).

M117's meeting links are retired (§11): `POST /channels/{id}/calls` always answers 409.
"""

import asyncio
import logging
import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, conflict, forbidden, not_found
from app.core.time import utcnow
from app.events.envelope import Audience
from app.events.models import OutboxEvent
from app.events.outbox import write_outbox
from app.modules.calls.events import CALL_ENDED, CALL_STARTED, CALL_UPDATED, CallEventData
from app.modules.calls.livekit import (
    ALL_SOURCES,
    LiveKitConfig,
    LiveKitGateway,
    LiveKitUnavailable,
    access_token,
    parse_timestamp,
)
from app.modules.calls.models import Call, CallParticipant
from app.modules.calls.schemas import CallJoinOut, CallOut, CallParticipantOut
from app.modules.channels import service as channels
from app.modules.channels.events import CHANNEL_ARCHIVED, CHANNEL_MEMBER_REMOVED
from app.modules.channels.models import Channel, ChannelMember
from app.modules.messages import repository as messages_repo
from app.modules.messages import service as messages
from app.modules.messages.models import Message
from app.modules.messages.schemas import MessageCreate
from app.modules.moderation import blocks
from app.modules.moderation.events import BLOCK_UPDATED
from app.modules.users.events import USER_DEACTIVATED
from app.modules.users.models import User
from app.modules.workspace import service as workspace

log = logging.getLogger("app.calls")

# §3.3: a call whose room LiveKit does not list is ended only after this long (the room is created
# before the call commits, so this is slack for clocks and slow commits).
MISSING_ROOM_GRACE = timedelta(seconds=30)
# §3.3: warn when LiveKit has been unreachable this long.
UNREACHABLE_WARNING = timedelta(minutes=5)
# Events after which someone may have to be cut off a call (§7.2).
WAKE_EVENTS = {CHANNEL_ARCHIVED, CHANNEL_MEMBER_REMOVED, USER_DEACTIVATED, BLOCK_UPDATED}


@dataclass
class CallsRuntime:
    """LiveKit for this process: built by app.main when LIVEKIT_* are all set (§3.4)."""

    config: LiveKitConfig
    gateway: LiveKitGateway
    # PUBLIC_BASE_URL without the final "/" ("" when unset).
    public_base_url: str = ""
    # Set to run the reconcile loop at once (a membership changed, a block, an archive).
    wake: asyncio.Event = field(default_factory=asyncio.Event)
    unreachable_since: datetime | None = None


def calls_disabled() -> AppError:
    return conflict("calls_disabled", "Calls are turned off in this workspace")


def calls_unavailable() -> AppError:
    return AppError(503, "calls_unavailable", "The call server cannot be reached")


def call_page(public_base_url: str, call_id: uuid.UUID) -> str:
    """The call's page in the web client (§5.4). Never null: an M117 Android client cannot read a
    null `call.url`; a server without PUBLIC_BASE_URL gets the bare path."""
    return f"{public_base_url}/call/{call_id}"


def call_body(url: str) -> str:
    """What clients before M130 show (the workspace's language, docs/I18N.md §1); new clients draw
    the card from `message.call`. An absolute link only: a bare path is no use in a body."""
    lead = "🎧 通話を始めました"
    return f"{lead}\n{url}" if url.startswith(("https://", "http://")) else lead


# --- reading ------------------------------------------------------------------------------------


async def get_call(
    db: AsyncSession, call_id: uuid.UUID, *, for_update: bool = False
) -> Call | None:
    stmt = select(Call).where(Call.id == call_id)
    if for_update:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    return (await db.execute(stmt)).scalar_one_or_none()


async def open_call_in(db: AsyncSession, channel_id: uuid.UUID) -> Call | None:
    stmt = select(Call).where(Call.channel_id == channel_id, Call.ended_at.is_(None))
    return (await db.execute(stmt)).scalar_one_or_none()


async def _present(
    db: AsyncSession, call_ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, list[CallParticipantOut]]:
    """Who is in each call now: one entry per person (their earliest open connection)."""
    ids = list(call_ids)
    if not ids:
        return {}
    rows = (
        await db.execute(
            select(CallParticipant.call_id, CallParticipant.user_id, CallParticipant.joined_at)
            .where(CallParticipant.call_id.in_(ids), CallParticipant.left_at.is_(None))
            .order_by(CallParticipant.joined_at, CallParticipant.id)
        )
    ).all()
    present: dict[uuid.UUID, dict[uuid.UUID, CallParticipantOut]] = {i: {} for i in ids}
    for call_id, user_id, joined_at in rows:
        present[call_id].setdefault(
            user_id, CallParticipantOut(user_id=user_id, joined_at=joined_at)
        )
    return {i: list(people.values()) for i, people in present.items()}


async def calls_out(db: AsyncSession, calls: list[Call]) -> list[CallOut]:
    present = await _present(db, [c.id for c in calls if c.ended_at is None])
    return [
        CallOut(
            id=c.id,
            channel_id=c.channel_id,
            message_id=c.message_id,
            started_by=c.started_by,
            started_at=c.started_at,
            ended_at=c.ended_at,
            participants=present.get(c.id, []),
            participant_count=c.participant_count,
            peak_participants=c.peak_participants,
        )
        for c in calls
    ]


async def call_out(db: AsyncSession, call: Call) -> CallOut:
    return (await calls_out(db, [call]))[0]


async def require_call(db: AsyncSession, actor: User, call_id: uuid.UUID) -> tuple[Call, Channel]:
    """A call of a conversation the actor is in (404 call_not_found, 403 not_a_member)."""
    call = await get_call(db, call_id)
    if call is None:
        raise not_found("call_not_found", "Call not found")
    channel, _ = await channels.require_member(db, actor.id, call.channel_id)
    return call, channel


async def active_calls(db: AsyncSession, actor: User) -> list[CallOut]:
    """GET /calls?active=true and the bootstrap: the open calls of my conversations."""
    stmt = (
        select(Call)
        .join(
            ChannelMember,
            (ChannelMember.channel_id == Call.channel_id) & (ChannelMember.user_id == actor.id),
        )
        .where(Call.ended_at.is_(None))
        .order_by(Call.started_at)
    )
    return await calls_out(db, list((await db.execute(stmt)).scalars().all()))


# --- who may start and join (§5.2, §7.2) --------------------------------------------------------


async def _require_can_join(db: AsyncSession, actor: User, channel: Channel) -> None:
    if actor.role == "bot":
        raise forbidden("forbidden", "Bots cannot take part in calls")
    channels.require_writable(channel)
    if channel.type == "dm":
        # A 1:1 DM where either side blocked the other: no call (a voice cannot be folded away).
        others = [uid for uid in await channels.member_ids_of(db, channel.id) if uid != actor.id]
        if len(others) == 1 and (
            await blocks.is_blocked(db, others[0], actor.id)
            or await blocks.is_blocked(db, actor.id, others[0])
        ):
            raise channels.dm_unavailable()


async def _require_room_for(db: AsyncSession, call: Call, actor: User, cap: int) -> None:
    present = (await _present(db, [call.id]))[call.id]
    if actor.id not in {p.user_id for p in present} and len(present) >= cap:
        raise conflict("call_full", "This call is full", details={"max": cap})


def _sources(platform: str | None, settings_video: bool, settings_screen: bool) -> tuple[str, ...]:
    """§7.1: what a client may publish. Screen sharing is Desktop / Web only in v1."""
    sources = ["microphone"]
    if settings_video:
        sources.append("camera")
    if settings_screen and platform not in ("ios", "android"):
        sources += ["screen_share", "screen_share_audio"]
    return tuple(s for s in ALL_SOURCES if s in sources)


async def _join_out(
    db: AsyncSession, rt: CallsRuntime, call: Call, actor: User, platform: str | None
) -> CallJoinOut:
    state = await workspace.in_app_calls(db)
    # A call in progress stays open to its members when the switch is turned off (§5.1); then
    # the media follow what the server can do.
    video = state.video or not state.enabled
    screen = state.screen_share or not state.enabled
    avatar = int(actor.avatar_updated_at.timestamp()) if actor.avatar_updated_at else None
    token = access_token(
        rt.config,
        room=str(call.id),
        identity=str(actor.id),
        name=actor.display_name,
        sources=_sources(platform, video, screen),
        metadata={"avatar_version": avatar},
    )
    return CallJoinOut(url=rt.config.url, token=token.token, expires_at=token.expires_at)


# --- starting, joining, leaving -----------------------------------------------------------------


@dataclass
class Huddle:
    call: Call
    message: Message
    join: CallJoinOut
    created: bool


async def huddle(
    db: AsyncSession,
    rt: CallsRuntime | None,
    actor: User,
    channel_id: uuid.UUID,
    client_msg_id: uuid.UUID,
    platform: str | None = None,
) -> Huddle:
    """POST /channels/{id}/huddle: start the conversation's call, or join the one in progress."""
    existing = await messages_repo.get_by_client_msg_id(db, actor.id, client_msg_id)
    if existing is not None:
        if existing.channel_id != channel_id or existing.call_id is None:
            raise conflict(
                "idempotency_conflict", "client_msg_id was already used for another message"
            )
        # A retry: the same call and message, with a new token.
        if rt is None:
            raise calls_disabled()
        call, channel = await require_call(db, actor, existing.call_id)
        if call.ended_at is not None:
            raise conflict("call_ended", "This call has ended")
        await _require_can_join(db, actor, channel)
        await _require_room_for(db, call, actor, rt.config.max_participants)
        return Huddle(call, existing, await _join_out(db, rt, call, actor, platform), False)

    if rt is None or not (await workspace.in_app_calls(db)).enabled:
        raise calls_disabled()
    channel, membership = await channels.require_member(db, actor.id, channel_id)
    await _require_can_join(db, actor, channel)
    running = await open_call_in(db, channel_id)
    if running is not None:
        return await _join_running(db, rt, actor, running, platform)
    if channel.posting_policy == "owners" and not actor.is_admin and membership.role != "owner":
        # An announcement channel: its owners and administrators start calls, everyone joins.
        raise forbidden("posting_restricted", "Only owners and administrators can post here")

    call = Call(id=uuid.uuid4(), channel_id=channel_id, started_by=actor.id, started_at=utcnow())
    try:
        async with db.begin_nested():
            db.add(call)
            await db.flush()
    except IntegrityError:
        # Someone else started this conversation's call a moment ago: join theirs.
        running = await open_call_in(db, channel_id)
        if running is None:
            raise
        return await _join_running(db, rt, actor, running, platform)
    url = call_page(rt.public_base_url, call.id)
    message, created = await messages.create_message(
        db,
        actor,
        channel_id,
        MessageCreate(client_msg_id=client_msg_id, body=call_body(url)),
        commit=False,
        call_url=url,
        call=call,
    )
    if not created:  # the same key raced in another request: that one wins
        await db.rollback()
        return await huddle(db, rt, actor, channel_id, client_msg_id, platform)
    call.message_id = message.id
    await db.flush()
    await _announce(db, call, CALL_STARTED)
    try:
        await rt.gateway.create_room(str(call.id))
    except LiveKitUnavailable:
        await db.rollback()  # nothing posted, nobody notified
        log.warning("LiveKit cannot be reached: a call was not started", exc_info=True)
        raise calls_unavailable() from None
    await db.commit()
    return Huddle(call, message, await _join_out(db, rt, call, actor, platform), True)


async def _join_running(
    db: AsyncSession, rt: CallsRuntime, actor: User, call: Call, platform: str | None
) -> Huddle:
    await _require_room_for(db, call, actor, rt.config.max_participants)
    message = await messages_repo.get_message(db, call.message_id) if call.message_id else None
    if message is None:
        raise not_found("call_not_found", "Call not found")
    return Huddle(call, message, await _join_out(db, rt, call, actor, platform), False)


async def join(
    db: AsyncSession,
    rt: CallsRuntime | None,
    actor: User,
    call_id: uuid.UUID,
    platform: str | None = None,
) -> tuple[Call, CallJoinOut]:
    """POST /calls/{id}/join: a token to (re)connect. Turning the switch off stops new calls only:
    joining one in progress still works while the server has LiveKit."""
    if rt is None:
        raise calls_disabled()
    call, channel = await require_call(db, actor, call_id)
    if call.ended_at is not None:
        raise conflict("call_ended", "This call has ended")
    await _require_can_join(db, actor, channel)
    await _require_room_for(db, call, actor, rt.config.max_participants)
    return call, await _join_out(db, rt, call, actor, platform)


async def leave(db: AsyncSession, rt: CallsRuntime | None, actor: User, call_id: uuid.UUID) -> None:
    """POST /calls/{id}/leave: the client hung up. LiveKit is told to drop the connection too (in
    case the client could not), and the open rows close; a late webhook changes nothing."""
    call, _ = await require_call(db, actor, call_id)
    if call.ended_at is not None:
        return
    if rt is not None:
        try:
            await rt.gateway.remove_participant(str(call.id), str(actor.id))
        except LiveKitUnavailable:
            log.warning("LiveKit cannot be reached: a participant was not removed", exc_info=True)
    locked = await get_call(db, call_id, for_update=True)
    assert locked is not None
    if locked.ended_at is None and await _close_rows(db, locked, user_id=actor.id):
        await _recount(db, locked)
        await _announce(db, locked, CALL_UPDATED)
    await db.commit()


# --- state changes ------------------------------------------------------------------------------


async def _announce(db: AsyncSession, call: Call, event_type: str) -> None:
    await write_outbox(
        db,
        event_type=event_type,
        audience_type="channel",
        channel_id=call.channel_id,
        payload=CallEventData(call=await call_out(db, call)).model_dump(mode="json"),
    )


async def _close_rows(
    db: AsyncSession, call: Call, *, user_id: uuid.UUID | None = None, sids: Iterable[str] = ()
) -> int:
    """Close open connections: all of them, one person's, or these sids."""
    stmt = (
        update(CallParticipant)
        .where(CallParticipant.call_id == call.id, CallParticipant.left_at.is_(None))
        .values(left_at=utcnow())
    )
    if user_id is not None:
        stmt = stmt.where(CallParticipant.user_id == user_id)
    sid_list = list(sids)
    if sid_list:
        stmt = stmt.where(CallParticipant.livekit_sid.in_(sid_list))
    result = await db.execute(stmt)
    return int(result.rowcount or 0)  # type: ignore[attr-defined]


async def _recount(db: AsyncSession, call: Call) -> None:
    everyone = await db.scalar(
        select(func.count(func.distinct(CallParticipant.user_id))).where(
            CallParticipant.call_id == call.id
        )
    )
    now_in = await db.scalar(
        select(func.count(func.distinct(CallParticipant.user_id))).where(
            CallParticipant.call_id == call.id, CallParticipant.left_at.is_(None)
        )
    )
    call.participant_count = int(everyone or 0)
    call.peak_participants = max(call.peak_participants, int(now_in or 0))
    await db.flush()


async def _add_connection(
    db: AsyncSession,
    call: Call,
    user_id: uuid.UUID,
    sid: str,
    joined_at: datetime | None,
    *,
    left: bool = False,
) -> bool:
    """A connection LiveKit reported: a row unless that sid has one (any state). True if added."""
    known = await db.scalar(select(CallParticipant.id).where(CallParticipant.livekit_sid == sid))
    if known is not None:
        return False
    if await db.get(User, user_id) is None:
        return False  # not one of ours
    now = utcnow()
    try:
        async with db.begin_nested():
            db.add(
                CallParticipant(
                    call_id=call.id,
                    user_id=user_id,
                    livekit_sid=sid,
                    joined_at=joined_at or now,
                    left_at=now if left else None,
                )
            )
            await db.flush()
    except IntegrityError:
        return False  # the same webhook in parallel
    return True


async def end_call_in_tx(db: AsyncSession, call: Call, reason: str) -> None:
    """The call is over: open connections close, its message shows the summary (message.updated,
    change "call", a new seq) and the members get call.ended. The caller holds the call's row lock
    and commits."""
    if call.ended_at is not None:
        return
    call.ended_at = utcnow()
    call.end_reason = reason
    await _close_rows(db, call)
    await _recount(db, call)
    if call.message_id is not None:
        await messages.announce_change_by_id_in_tx(db, call.message_id, "call")
    await _announce(db, call, CALL_ENDED)


def _user_id(identity: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(identity))
    except ValueError:
        return None


async def handle_webhook(db: AsyncSession, event: dict[str, Any]) -> str:
    """A verified LiveKit webhook (§3.2). Idempotent; unknown rooms and events are ignored.
    Returns what was done (for the log)."""
    kind = str(event.get("event") or "")
    if kind not in ("participant_joined", "participant_left", "room_finished"):
        return "ignored"
    room = event.get("room") or {}
    call_id = _user_id(room.get("name"))
    call = await get_call(db, call_id, for_update=True) if call_id else None
    if call is None or call.ended_at is not None:
        await db.rollback()
        return "unknown room"
    if kind == "room_finished":
        await end_call_in_tx(db, call, "empty")
        await db.commit()
        return "ended"
    participant = event.get("participant") or {}
    user_id = _user_id(participant.get("identity"))
    sid = str(participant.get("sid") or "")
    if user_id is None or not sid:
        await db.rollback()
        return "unknown participant"
    joined_at = parse_timestamp(participant.get("joinedAt"))
    if kind == "participant_joined":
        changed = await _add_connection(db, call, user_id, sid, joined_at)
    else:
        # Left before its join was seen: the row is made closed.
        changed = await _add_connection(db, call, user_id, sid, joined_at, left=True)
        changed = bool(await _close_rows(db, call, sids=[sid])) or changed
    if changed:
        await _recount(db, call)
        await _announce(db, call, CALL_UPDATED)
    await db.commit()
    return "updated" if changed else "duplicate"


# --- reconciling (§3.3) -------------------------------------------------------------------------


async def _allowed_users(db: AsyncSession, channel: Channel) -> set[uuid.UUID]:
    """Who may be in a call of this conversation now: active, non-bot members; nobody in a 1:1
    DM with a block either way; nobody once it is archived."""
    if channel.is_archived:
        return set()
    member_ids = await channels.member_ids_of(db, channel.id)
    rows = (
        await db.execute(
            select(User.id).where(
                User.id.in_(member_ids), User.deactivated_at.is_(None), User.role != "bot"
            )
        )
    ).scalars()
    allowed = set(rows)
    if channel.type == "dm" and len(member_ids) == 2:
        a, b = member_ids
        if await blocks.is_blocked(db, a, b) or await blocks.is_blocked(db, b, a):
            return set()
    return allowed


async def reconcile(
    db: AsyncSession, gateway: LiveKitGateway, *, now: datetime | None = None
) -> int:
    """Puts `calls` / `call_participants` right against LiveKit and cuts off whoever may no longer
    be in a call. Nothing is ended while LiveKit cannot be reached (LiveKitUnavailable propagates).
    Returns how many calls changed."""
    open_calls = (
        await db.execute(
            select(Call.id, Call.channel_id, Call.started_at)
            .where(Call.ended_at.is_(None))
            .order_by(Call.started_at)
        )
    ).all()
    await db.rollback()  # no transaction held over the network calls
    if not open_calls:
        return 0
    clock = now or utcnow()
    rooms = {r.name for r in await gateway.list_rooms()}
    changed_calls = 0
    for call_id, channel_id, started_at in open_calls:
        room = str(call_id)
        channel = await channels.find_channel(db, channel_id)
        archived = channel is None or channel.is_archived
        allowed = await _allowed_users(db, channel) if channel is not None else set()
        await db.rollback()
        reason: str | None = None
        present: dict[str, uuid.UUID] = {}
        if archived:
            reason = "archived"
        elif room not in rooms:
            if clock - started_at >= MISSING_ROOM_GRACE:
                reason = "reconciled"
        else:
            for p in await gateway.list_participants(room):
                uid = _user_id(p.identity)
                if uid is not None and uid in allowed:
                    present[p.sid] = uid
                else:
                    await gateway.remove_participant(room, p.identity)
        call = await get_call(db, call_id, for_update=True)
        if call is None or call.ended_at is not None:
            await db.rollback()
            continue
        changed = False
        if reason is None and room in rooms:
            open_rows = (
                (
                    await db.execute(
                        select(CallParticipant).where(
                            CallParticipant.call_id == call.id, CallParticipant.left_at.is_(None)
                        )
                    )
                )
                .scalars()
                .all()
            )
            gone = [r.livekit_sid for r in open_rows if r.livekit_sid not in present]
            if gone and await _close_rows(db, call, sids=gone):
                changed = True
            for sid, uid in present.items():
                if await _add_connection(db, call, uid, sid, None):
                    changed = True
            if not present:
                last_left = await db.scalar(
                    select(func.max(CallParticipant.left_at)).where(
                        CallParticipant.call_id == call.id
                    )
                )
                quiet_since = max(call.started_at, last_left or call.started_at)
                if clock - quiet_since >= timedelta(seconds=120):
                    reason = "reconciled"
        if reason is not None:
            if room in rooms:
                await gateway.delete_room(room)
            await end_call_in_tx(db, call, reason)
            changed_calls += 1
        elif changed:
            await _recount(db, call)
            await _announce(db, call, CALL_UPDATED)
            changed_calls += 1
        await db.commit()
    return changed_calls


async def has_open_calls(db: AsyncSession) -> bool:
    return bool(
        await db.scalar(select(func.count()).select_from(Call).where(Call.ended_at.is_(None)))
    )


class CallsWakeHandler:
    """Outbox handler: after an archive, a removal, a deactivation or a block, the reconcile loop
    runs at once (instead of within a minute) to cut off whoever may no longer be in a call."""

    def __init__(self, rt: CallsRuntime) -> None:
        self.rt = rt

    async def handle(self, db: AsyncSession, event: OutboxEvent, audience: Audience) -> None:
        if event.event_type in WAKE_EVENTS:
            self.rt.wake.set()
