"""Reservation pools (docs/RESERVATIONS.md): a channel's shared, limited seats with a queue.

Members press 「予約する」 and wait in order; the pool's operators hand a seat out by hand in the
resource's own console (e.g. Claude's admin console) and press 「割り当てた」 here. A holder keeps
the seat at least `min_hours`; once past it, a waiting member needs it: the holder is told the
seat goes after `grace_minutes`, then the operators are told they can swap (「入れ替えた」 = take
the holder out and assign the waiting member). A holder may return the seat (「返却する」), which
the operators confirm with 「外した」 once they took it out of the console.

Every change locks the pool's row first, so two operators pressing at once (or a press and the
worker) apply one after the other, and every action is idempotent: pressing 「割り当てた」 on a
member already holding a seat changes nothing. The channel's reservation bot (one per channel)
posts each change in the channel (the log, mentions off) and sends the people concerned a DM
(the push); the DMs go out after the commit, since opening a DM may commit by itself.
"""

import logging
import secrets
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, bad_request, conflict, forbidden, not_found
from app.core.time import utcnow
from app.events.outbox import write_outbox
from app.modules.admin import service as admin
from app.modules.audit import service as audit
from app.modules.channels import service as channels
from app.modules.channels.models import Channel
from app.modules.messages import service as messages
from app.modules.messages.schemas import MessageCreate
from app.modules.recurring.schedule import due_label
from app.modules.reservations import repository as repo
from app.modules.reservations.events import RESERVATION_UPDATED, ReservationUpdatedData
from app.modules.reservations.models import Reservation, ReservationBot, ReservationPool
from app.modules.reservations.plan import Plan, Seat, Waiter, make_plan
from app.modules.reservations.schemas import (
    PoolCreate,
    PoolOut,
    PoolUpdate,
    ReservationOut,
    SwapIn,
)
from app.modules.users import service as users
from app.modules.users.models import User
from app.modules.workflows.render import escape_text

log = logging.getLogger(__name__)

MAX_PER_CHANNEL = 5
BOT_NAME = "予約"
BOT_KIND = "reservation"  # users.bot_kind of a channel's reservation bot
# A DM's client_msg_id comes from the reservation and what it says: a retry finds the message.
_NOTE_NAMESPACE = uuid.UUID("6a0f3c52-8d71-4e0b-b2a9-5c3e1f7d9a14")
_POST_NAMESPACE = uuid.UUID("2f9d6b14-7a3e-4c58-9e01-b8c4d2a6f375")


# --- the change being made -----------------------------------------------------------------------


@dataclass
class _Note:
    """A DM from the pool's bot to one person, sent after the commit."""

    user_id: uuid.UUID
    text: str
    key: str


@dataclass
class _Change:
    pool: ReservationPool
    channel: Channel
    bot_id: uuid.UUID
    now: datetime
    actor_id: uuid.UUID | None = None
    notes: list[_Note] = field(default_factory=list)
    people: dict[uuid.UUID, User] = field(default_factory=dict)

    async def person(self, db: AsyncSession, user_id: uuid.UUID) -> User | None:
        if user_id not in self.people:
            found = (await users.get_users(db, [user_id])).get(user_id)
            if found is None:
                return None
            self.people[user_id] = found
        return self.people[user_id]


def _safe(text: str) -> str:
    return escape_text(text)


async def _name(db: AsyncSession, change: _Change, user_id: uuid.UUID) -> str:
    person = await change.person(db, user_id)
    return _safe(person.display_name) if person is not None else "(不明)"


async def _who(db: AsyncSession, change: _Change, user_id: uuid.UUID) -> str:
    """For the operators: the name and the address (to find the account in the console)."""
    person = await change.person(db, user_id)
    if person is None:
        return "(不明)"
    name = _safe(person.display_name)
    return f"{name} さん ({_safe(person.email)})" if person.email else f"{name} さん"


def _label(change: _Change, moment: datetime | None) -> str:
    return due_label(moment, change.pool.tz) if moment is not None else ""


def _where(change: _Change) -> str:
    return f"「{_safe(change.pool.name)}」(#{change.channel.name})"


# --- access -------------------------------------------------------------------------------------


async def _is_channel_owner(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> bool:
    membership = await channels.membership_of(db, actor.id, channel_id)
    return membership is not None and membership.role == "owner"


async def _can_manage(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> bool:
    return actor.is_admin or await _is_channel_owner(db, actor, channel_id)


async def _can_operate(db: AsyncSession, actor: User, pool: ReservationPool) -> bool:
    if actor.is_admin or await _is_channel_owner(db, actor, pool.channel_id):
        return True
    return (
        actor.id in pool.operator_ids
        and await channels.membership_of(db, actor.id, pool.channel_id) is not None
    )


def _pool_not_found() -> AppError:
    return not_found("reservation_pool_not_found", "Reservation pool not found")


async def _readable_pool(
    db: AsyncSession, actor: User, pool_id: uuid.UUID, *, lock: bool = False
) -> tuple[ReservationPool, Channel]:
    pool = await repo.get_pool(db, pool_id, for_update=lock)
    if pool is None:
        raise _pool_not_found()
    try:  # someone who cannot read the channel does not learn the pool exists
        channel = await channels.require_readable(db, actor, pool.channel_id)
    except AppError as exc:
        raise _pool_not_found() from exc
    return pool, channel


async def _locked_reservation(
    db: AsyncSession, actor: User, reservation_id: uuid.UUID
) -> tuple[Reservation, ReservationPool, Channel]:
    """The reservation with its pool locked (every change of a pool goes through the lock)."""
    row = await repo.get_reservation(db, reservation_id)
    if row is None:
        raise not_found("reservation_not_found", "Reservation not found")
    try:
        pool, channel = await _readable_pool(db, actor, row.pool_id, lock=True)
    except AppError as exc:
        raise not_found("reservation_not_found", "Reservation not found") from exc
    row = await repo.get_reservation(db, reservation_id)  # as it is under the lock
    if row is None:
        raise not_found("reservation_not_found", "Reservation not found")
    return row, pool, channel


def _require_operator(allowed: bool) -> None:
    if not allowed:
        raise forbidden(
            "reservation_operator_required",
            "Only the pool's operators, the channel's owners and administrators can",
        )


def _state_conflict(row: Reservation) -> AppError:
    return conflict(
        "reservation_state_conflict",
        "The reservation is not in a state for this",
        details={"status": row.status},
    )


# --- output ------------------------------------------------------------------------------------


def _plan(pool: ReservationPool, rows: list[Reservation], now: datetime) -> Plan:
    seats = [
        Seat(r.id, r.status, r.guarantee_until, r.returned_at)
        for r in rows
        if r.status in ("holding", "returning")
    ]
    waiters = [Waiter(r.id, r.requested_at) for r in rows if r.status == "waiting"]
    return make_plan(pool.capacity, seats, waiters, now)


def _holder_ready(row: Reservation, plan: Plan, now: datetime) -> bool:
    if row.status == "returning":
        return True
    return (
        row.id in plan.holder_pair
        and row.id in plan.evict_ids
        and row.evict_at is not None
        and row.evict_at <= now
    )


def _row_out(
    row: Reservation,
    position: int | None,
    plan: Plan,
    holders: list[Reservation],
    people: dict[uuid.UUID, User],
    operate: bool,
    now: datetime,
) -> ReservationOut:
    person = people.get(row.user_id)
    pair: uuid.UUID | None
    if row.status == "waiting":
        step = plan.steps.get(row.id, "wait")
        pair = plan.waiter_pair.get(row.id)
        pair_row = next((h for h in holders if h.id == pair), None)
        ready = step == "assign" or (pair_row is not None and _holder_ready(pair_row, plan, now))
    else:
        step = None
        pair = plan.holder_pair.get(row.id)
        ready = _holder_ready(row, plan, now)
    return ReservationOut(
        id=row.id,
        user_id=row.user_id,
        status=row.status,  # type: ignore[arg-type]
        requested_at=row.requested_at,
        assigned_at=row.assigned_at,
        guarantee_until=row.guarantee_until,
        returned_at=row.returned_at,
        evict_at=row.evict_at if row.evict_notice_at is not None else None,
        email=person.email if operate and person is not None else None,
        position=position,
        step=step,
        pair_id=pair,
        ready=ready,
    )


async def _outs(
    db: AsyncSession, actor: User, pools: list[ReservationPool], now: datetime | None = None
) -> list[PoolOut]:
    if not pools:
        return []
    now = now or utcnow()
    rows = await repo.active_rows(db, [p.id for p in pools])
    by_pool: dict[uuid.UUID, list[Reservation]] = {}
    for row in rows:
        by_pool.setdefault(row.pool_id, []).append(row)
    people = await users.get_users(db, list({r.user_id for r in rows}))
    bot = await repo.bot_row(db, pools[0].channel_id)
    out: list[PoolOut] = []
    can_manage = await _can_manage(db, actor, pools[0].channel_id)
    for pool in pools:
        mine = by_pool.get(pool.id, [])
        plan = _plan(pool, mine, now)
        operate = await _can_operate(db, actor, pool)
        holders = sorted(
            (r for r in mine if r.status in ("holding", "returning")),
            key=lambda r: (r.assigned_at or r.requested_at, r.id),
        )
        waiting = [r for r in mine if r.status == "waiting"]
        waiting.sort(key=lambda r: (r.requested_at, r.id))

        out.append(
            PoolOut(
                id=pool.id,
                channel_id=pool.channel_id,
                name=pool.name,
                capacity=pool.capacity,
                min_hours=pool.min_hours,
                grace_minutes=pool.grace_minutes,
                tz=pool.tz,
                enabled=pool.enabled,
                operator_ids=list(pool.operator_ids),
                bot_user_id=bot.bot_user_id if bot is not None else None,
                holders=[_row_out(r, None, plan, holders, people, operate, now) for r in holders],
                waiting=[
                    _row_out(r, i + 1, plan, holders, people, operate, now)
                    for i, r in enumerate(waiting)
                ],
                next_evict_id=plan.next_evict_id,
                my_reservation_id=next((r.id for r in mine if r.user_id == actor.id), None),
                can_manage=can_manage,
                can_operate=operate,
                created_at=pool.created_at,
                updated_at=pool.updated_at,
            )
        )
    return out


async def _one_out(db: AsyncSession, actor: User, pool: ReservationPool) -> PoolOut:
    return (await _outs(db, actor, [pool]))[0]


# --- the bot, posts and notes --------------------------------------------------------------------


async def _bot(db: AsyncSession, actor: User, channel: Channel) -> uuid.UUID:
    """The channel's reservation bot, active and in the channel; made with the first pool."""
    kept = await repo.bot_row(db, channel.id)
    if kept is not None:
        bot = await admin.update_bot_in_tx(db, kept.bot_user_id, reactivate=True)
        if await channels.membership_of(db, bot.id, channel.id) is None:
            await channels.add_member_in_tx(db, channel, bot.id)
        return bot.id
    bot = await admin.create_bot_in_tx(
        db,
        actor_id=actor.id,
        username=f"reserve-{secrets.token_hex(4)}",
        display_name=BOT_NAME,
        bot_kind=BOT_KIND,
    )
    await channels.add_member_in_tx(db, channel, bot.id)
    db.add(ReservationBot(channel_id=channel.id, bot_user_id=bot.id))
    await db.flush()
    return bot.id


async def _bot_id(db: AsyncSession, channel: Channel) -> uuid.UUID | None:
    kept = await repo.bot_row(db, channel.id)
    return kept.bot_user_id if kept is not None else None


async def _post(db: AsyncSession, change: _Change, text: str, key: str) -> None:
    """One line in the channel (the log). Mentions are off: names are text, not calls."""
    bot = await users.require_user(db, change.bot_id)
    if await channels.membership_of(db, bot.id, change.channel.id) is None:
        await channels.add_member_in_tx(db, change.channel, bot.id)
    try:
        async with db.begin_nested():
            await messages.create_message(
                db,
                bot,
                change.channel.id,
                MessageCreate(client_msg_id=uuid.uuid5(_POST_NAMESPACE, key), body=text),
                advance_read=False,
                commit=False,
                mentions=False,
            )
    except Exception:
        log.exception("reservation pool %s: posting failed", change.pool.id)


def _note(change: _Change, user_id: uuid.UUID, text: str, key: str) -> None:
    change.notes.append(_Note(user_id, text, key))


async def _operator_ids(db: AsyncSession, change: _Change) -> list[uuid.UUID]:
    """Who the operators' notes go to: the operators who are active members of the channel;
    without any, the channel's owners and the administrators among its members."""
    members = set(await channels.member_ids_of(db, change.pool.channel_id))
    chosen = [uid for uid in change.pool.operator_ids if uid in members]
    if not chosen:
        chosen = sorted(await channels.manager_ids_of(db, change.pool.channel_id))
    found = await users.get_users(db, chosen)
    return [uid for uid in chosen if uid in found and found[uid].is_active]


async def _note_operators(db: AsyncSession, change: _Change, text: str, key: str) -> None:
    for uid in await _operator_ids(db, change):
        if uid != change.actor_id:  # who pressed the button sees the card already
            _note(change, uid, text, f"{key}/{uid}")


async def _deliver(db: AsyncSession, bot_id: uuid.UUID, notes: list[_Note]) -> None:
    """The DMs, after the commit (opening a DM commits by itself). A note that cannot be sent
    is logged: the card and the channel's posts say the same."""
    for note in notes:
        try:
            sender = (await users.get_users(db, [bot_id])).get(bot_id)
            if sender is None or not sender.is_active:
                return
            person = (await users.get_users(db, [note.user_id])).get(note.user_id)
            if person is None or not person.is_active or person.role == "bot":
                continue
            dm, _ = await channels.get_or_create_dm(db, sender, [person])
            await messages.create_message(
                db,
                sender,
                dm.id,
                MessageCreate(client_msg_id=uuid.uuid5(_NOTE_NAMESPACE, note.key), body=note.text),
                advance_read=False,
                mentions=False,
            )
        except Exception:
            await db.rollback()
            log.exception("reservation note to %s failed", note.user_id)


async def _emit(db: AsyncSession, pool: ReservationPool, *, deleted: bool = False) -> None:
    await write_outbox(
        db,
        event_type=RESERVATION_UPDATED,
        audience_type="channel",
        channel_id=pool.channel_id,
        payload=ReservationUpdatedData(
            channel_id=pool.channel_id, pool_id=pool.id, deleted=deleted
        ).model_dump(mode="json"),
    )


# --- keeping the plan --------------------------------------------------------------------------


async def _reconcile(db: AsyncSession, change: _Change) -> bool:
    """Brings the notices in line with the plan (§4): waiting members who left the channel are
    dropped; holders a waiting member needs get the grace notice (and those no longer needed
    are told they keep the seat); the operators are told when a seat can be assigned or swapped.
    Returns whether a row changed."""
    pool, now = change.pool, change.now
    rows = await repo.active_rows(db, [pool.id])
    changed = False

    members = set(await channels.member_ids_of(db, pool.channel_id))
    found = await users.get_users(db, list({r.user_id for r in rows}))
    for row in rows:
        person = found.get(row.user_id)
        if row.status == "waiting" and (
            person is None or not person.is_active or row.user_id not in members
        ):
            row.status, row.ended_at, row.end_reason = "cancelled", now, "cancelled"
            row.updated_at = now
            changed = True
    rows = [r for r in rows if r.status in ("waiting", "holding", "returning")]

    plan = _plan(pool, rows, now)
    by_id = {r.id: r for r in rows}
    evict = set(plan.evict_ids)
    for row in rows:
        if row.status == "waiting":
            continue
        if row.id in evict and row.evict_notice_at is None:
            row.evict_notice_at = now
            row.evict_at = now + timedelta(minutes=pool.grace_minutes)
            row.updated_at = now
            changed = True
            _note(
                change,
                row.user_id,
                f"⏳ {_where(change)} の保証時間 ({_label(change, row.guarantee_until)} まで) が"
                "過ぎ、待っている人がいます。"
                f"{_label(change, row.evict_at)} 以降に担当者が外します。"
                "使い終わっていれば「返却する」を押してください。",
                f"{row.id}/evict/{now.isoformat()}",
            )
        elif row.id not in evict and row.evict_notice_at is not None:
            was_told = row.status == "holding"
            row.evict_notice_at = row.evict_at = None
            if row.status == "holding":
                row.ready_notified_at = None
            row.updated_at = now
            changed = True
            if was_told:
                _note(
                    change,
                    row.user_id,
                    f"👍 {_where(change)} を待つ人がいなくなったので、そのまま使えます。",
                    f"{row.id}/keep/{now.isoformat()}",
                )

    for row in rows:
        if row.status == "waiting" and plan.steps.get(row.id) == "assign":
            if row.ready_notified_at is None:
                row.ready_notified_at = now
                row.updated_at = now
                changed = True
                await _note_operators(
                    db,
                    change,
                    f"🙋 {await _who(db, change, row.user_id)} に{_where(change)} を割り当てて"
                    "ください (空きがあります)。割り当てたらチャンネルの枠で「割り当てた」を"
                    "押してください。",
                    f"{row.id}/assign",
                )
        elif row.status == "holding" and row.id in evict:
            if row.evict_at is not None and row.evict_at <= now and row.ready_notified_at is None:
                row.ready_notified_at = now
                row.updated_at = now
                changed = True
                waiter = by_id[plan.holder_pair[row.id]]
                await _note_operators(
                    db,
                    change,
                    f"🔁 {_where(change)} を入れ替えできます: {await _who(db, change, row.user_id)}"
                    f" を外して {await _who(db, change, waiter.user_id)} に割り当て、"
                    "「入れ替えた」を押してください。",
                    f"{row.id}/swap",
                )
    if changed:
        await db.flush()
    return changed


async def _change_for(
    db: AsyncSession, pool: ReservationPool, channel: Channel, actor: User | None
) -> _Change:
    bot_id = await _bot_id(db, channel)
    if bot_id is None:  # a pool made before its bot existed cannot happen; made now if so
        if actor is None:
            raise RuntimeError("reservation pool without a bot")
        bot_id = await _bot(db, actor, channel)
    return _Change(
        pool=pool,
        channel=channel,
        bot_id=bot_id,
        now=utcnow(),
        actor_id=actor.id if actor is not None else None,
    )


async def _finish(db: AsyncSession, actor: User, change: _Change) -> PoolOut:
    pool_id = change.pool.id
    await _reconcile(db, change)
    await _emit(db, change.pool)
    await db.commit()
    await _deliver(db, change.bot_id, change.notes)
    pool = await repo.get_pool(db, pool_id)
    if pool is None:
        raise _pool_not_found()
    return await _one_out(db, actor, pool)


# --- settings ----------------------------------------------------------------------------------


async def list_for_channel(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> list[PoolOut]:
    """Whoever reads the channel sees its pools (the bot's posts name the people anyway); only
    those who can operate a pool see the members' addresses."""
    await channels.require_readable(db, actor, channel_id)
    return await _outs(db, actor, await repo.pools_for_channel(db, channel_id))


def _require_manager(allowed: bool) -> None:
    if not allowed:
        raise forbidden(
            "reservation_manage_restricted",
            "Only the channel's owners and administrators can change its reservation pools",
        )


async def _check_operators(
    db: AsyncSession, channel_id: uuid.UUID, operator_ids: list[uuid.UUID]
) -> None:
    if not operator_ids:
        return
    members = set(await channels.member_ids_of(db, channel_id))
    found = await users.get_users(db, operator_ids)
    for uid in operator_ids:
        person = found.get(uid)
        if (
            person is None
            or not person.is_active
            or person.role in ("bot", "guest")
            or uid not in members
        ):
            raise bad_request(
                "reservation_operator_invalid",
                "Operators must be active members of the channel (not guests or bots)",
                details={"user_id": str(uid)},
            )


async def create_pool(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, data: PoolCreate
) -> PoolOut:
    channel = await channels.require_readable(db, actor, channel_id)
    if channel.is_dm:
        raise bad_request(
            "reservation_channel_unsupported", "Reservation pools are for channels, not DMs"
        )
    _require_manager(await _can_manage(db, actor, channel.id))
    if actor.is_admin and await channels.membership_of(db, actor.id, channel.id) is None:
        # The bot joins the channel: only its members bring one in (as the feeds and webhooks).
        raise forbidden("not_a_member", "You are not a member of this channel")
    channels.require_writable(channel)
    if await repo.count_for_channel(db, channel.id) >= MAX_PER_CHANNEL:
        raise conflict("too_many_reservation_pools", f"At most {MAX_PER_CHANNEL} pools per channel")
    await _check_operators(db, channel.id, data.operator_ids)
    await _bot(db, actor, channel)
    now = utcnow()
    pool = ReservationPool(
        channel_id=channel.id,
        name=data.name,
        capacity=data.capacity,
        min_hours=data.min_hours,
        grace_minutes=data.grace_minutes,
        tz=data.tz,
        operator_ids=data.operator_ids,
        enabled=data.enabled,
        created_by=actor.id,
        created_at=now,
        updated_at=now,
    )
    db.add(pool)
    await db.flush()
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="reservation_pool.created",
        target_type="reservation_pool",
        target_id=pool.id,
        details={"channel_id": str(channel.id), "name": pool.name, "capacity": pool.capacity},
    )
    await _emit(db, pool)
    await db.commit()
    return await _one_out(db, actor, pool)


async def update_pool(
    db: AsyncSession, actor: User, pool_id: uuid.UUID, data: PoolUpdate
) -> PoolOut:
    pool, channel = await _readable_pool(db, actor, pool_id, lock=True)
    _require_manager(await _can_manage(db, actor, channel.id))
    channels.require_writable(channel)
    fields = data.model_dump(exclude_unset=True, exclude_none=True)
    if "operator_ids" in fields:
        await _check_operators(db, channel.id, data.operator_ids or [])
    before = {key: getattr(pool, key) for key in fields}
    for key, value in fields.items():
        setattr(pool, key, value)
    change = await _change_for(db, pool, channel, actor)
    if fields:
        pool.updated_at = change.now
        await db.flush()
        await audit.record_in_tx(
            db,
            actor_id=actor.id,
            action="reservation_pool.updated",
            target_type="reservation_pool",
            target_id=pool.id,
            details={
                key: {"from": _plain(before[key]), "to": _plain(value)}
                for key, value in fields.items()
            },
        )
    return await _finish(db, actor, change)


def _plain(value: object) -> object:
    if isinstance(value, list):
        return [str(v) for v in value]
    return value


async def delete_pool(db: AsyncSession, actor: User, pool_id: uuid.UUID) -> None:
    """The pool and its rows go (the bot's posts stay). Seats still handed out in the
    resource's console are not touched there: the operators take them out by hand."""
    pool, channel = await _readable_pool(db, actor, pool_id, lock=True)
    _require_manager(await _can_manage(db, actor, channel.id))
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="reservation_pool.deleted",
        target_type="reservation_pool",
        target_id=pool.id,
        details={"channel_id": str(channel.id), "name": pool.name},
    )
    await _emit(db, pool, deleted=True)
    await db.delete(pool)
    await db.commit()


# --- members ------------------------------------------------------------------------------------


async def reserve(db: AsyncSession, actor: User, pool_id: uuid.UUID) -> PoolOut:
    """Join the queue (one request at a time per person; pressing again changes nothing)."""
    channels.require_not_guest(actor)
    pool, channel = await _readable_pool(db, actor, pool_id, lock=True)
    await channels.require_member(db, actor.id, channel.id)
    channels.require_writable(channel)
    rows = await repo.active_rows(db, [pool.id])
    if any(r.user_id == actor.id for r in rows):
        await db.commit()  # nothing to change (the lock goes)
        return await _one_out(db, actor, pool)
    if not pool.enabled:
        raise conflict("reservation_pool_disabled", "This pool takes no reservations now")
    change = await _change_for(db, pool, channel, actor)
    row = Reservation(
        pool_id=pool.id,
        channel_id=channel.id,
        user_id=actor.id,
        status="waiting",
        requested_at=change.now,
        created_at=change.now,
        updated_at=change.now,
    )
    db.add(row)
    try:
        await db.flush()
    except IntegrityError:  # the same person at the same moment (the lock makes it rare)
        await db.rollback()
        pool, _ = await _readable_pool(db, actor, pool_id)
        return await _one_out(db, actor, pool)
    plan = _plan(pool, [*rows, row], change.now)
    step = plan.steps.get(row.id, "wait")
    position = sum(1 for r in rows if r.status == "waiting") + 1
    name = await _name(db, change, actor.id)
    await _post(
        db,
        change,
        f"🙋 {name} さんが「{_safe(pool.name)}」を予約しました"
        + ("" if step == "assign" else f" (待ち {position} 人目)"),
        f"{row.id}/reserved",
    )
    if step != "assign":  # (a free seat: the plan tells the operators to assign it)
        await _note_operators(
            db,
            change,
            f"🙋 {await _who(db, change, actor.id)} が{_where(change)} を予約しました。"
            f"待ち {position} 人目です。",
            f"{row.id}/reserved",
        )
    change.actor_id = None  # the operators hear of a free seat even if one of them reserved
    return await _finish(db, actor, change)


async def cancel(db: AsyncSession, actor: User, reservation_id: uuid.UUID) -> PoolOut:
    """Leave the queue (the member), or drop someone's request (an operator)."""
    row, pool, channel = await _locked_reservation(db, actor, reservation_id)
    own = row.user_id == actor.id
    if not own:
        _require_operator(await _can_operate(db, actor, pool))
    if row.status == "cancelled":
        await db.commit()  # nothing to change (the lock goes)
        return await _one_out(db, actor, pool)
    if row.status != "waiting":
        raise _state_conflict(row)
    channels.require_writable(channel)
    change = await _change_for(db, pool, channel, actor)
    row.status, row.ended_at, row.ended_by = "cancelled", change.now, actor.id
    row.end_reason = "cancelled"
    row.updated_at = change.now
    await db.flush()
    name = await _name(db, change, row.user_id)
    if own:
        text = f"↩️ {name} さんが「{_safe(pool.name)}」の予約を取り消しました"
    else:
        text = (
            f"↩️ {await _name(db, change, actor.id)} さんが {name} さんの"
            f"「{_safe(pool.name)}」の予約を取り消しました"
        )
        _note(
            change,
            row.user_id,
            f"↩️ {_where(change)} の予約は担当者 ({await _name(db, change, actor.id)} さん) が"
            "取り消しました。",
            f"{row.id}/cancelled",
        )
    await _post(db, change, text, f"{row.id}/cancelled")
    return await _finish(db, actor, change)


async def give_back(db: AsyncSession, actor: User, reservation_id: uuid.UUID) -> PoolOut:
    """The holder is done with the seat: the operators take it out of the console and press
    「外した」; the next in the queue follows."""
    row, pool, channel = await _locked_reservation(db, actor, reservation_id)
    if row.user_id != actor.id:
        raise forbidden("reservation_not_yours", "Only the holder can return the seat")
    if row.status == "returning" or (row.status == "done" and row.end_reason == "returned"):
        await db.commit()  # nothing to change (the lock goes)
        return await _one_out(db, actor, pool)
    if row.status != "holding":
        raise _state_conflict(row)
    channels.require_writable(channel)
    change = await _change_for(db, pool, channel, actor)
    row.status, row.returned_at, row.ready_notified_at = "returning", change.now, change.now
    row.evict_notice_at = row.evict_at = None
    row.updated_at = change.now
    await db.flush()
    rows = await repo.active_rows(db, [pool.id])
    plan = _plan(pool, rows, change.now)
    nxt = plan.holder_pair.get(row.id)
    after = ""
    if nxt is not None:
        waiter = next(r for r in rows if r.id == nxt)
        after = f" 次は {await _who(db, change, waiter.user_id)} です。"
    await _post(
        db,
        change,
        f"🔙 {await _name(db, change, row.user_id)} さんが「{_safe(pool.name)}」を返却しました",
        f"{row.id}/returned",
    )
    await _note_operators(
        db,
        change,
        f"🔙 {await _who(db, change, row.user_id)} が{_where(change)} を返却しました。"
        f"管理画面で外して「外した」を押してください。{after}",
        f"{row.id}/returned",
    )
    return await _finish(db, actor, change)


# --- operators ----------------------------------------------------------------------------------


async def _holders_count(db: AsyncSession, pool: ReservationPool) -> int:
    rows = await repo.active_rows(db, [pool.id])
    return sum(1 for r in rows if r.status in ("holding", "returning"))


async def _assign(db: AsyncSession, change: _Change, row: Reservation, actor: User) -> None:
    pool = change.pool
    if await _holders_count(db, pool) >= pool.capacity:
        raise conflict(
            "reservation_pool_full",
            "Every seat is taken: take one out (外した) first, or swap (入れ替えた)",
        )
    row.status, row.assigned_at, row.assigned_by = "holding", change.now, actor.id
    row.guarantee_until = change.now + timedelta(hours=pool.min_hours)
    row.ready_notified_at = row.evict_notice_at = row.evict_at = None
    row.updated_at = change.now
    await db.flush()
    _note(
        change,
        row.user_id,
        f"✅ {_where(change)} が割り当てられました。{_label(change, row.guarantee_until)} までは"
        "外されません。使い終わったらチャンネルの枠で「返却する」を押してください。",
        f"{row.id}/assigned",
    )


async def _remove(db: AsyncSession, change: _Change, row: Reservation, actor: User) -> str:
    """Ends a holding; returns how it ended (returned / removed)."""
    reason = "returned" if row.status == "returning" else "removed"
    row.status, row.ended_at, row.ended_by, row.end_reason = "done", change.now, actor.id, reason
    row.updated_at = change.now
    await db.flush()
    if reason == "returned":
        text = f"⏹ {_where(change)} の返却が済みました。ありがとうございました。"
    else:
        text = f"⏹ {_where(change)} から外されました。また使うときは「予約する」を押してください。"
    _note(change, row.user_id, text, f"{row.id}/removed")
    return reason


async def assign(db: AsyncSession, actor: User, reservation_id: uuid.UUID) -> PoolOut:
    """「割り当てた」: the operator gave the member a seat in the console."""
    row, pool, channel = await _locked_reservation(db, actor, reservation_id)
    _require_operator(await _can_operate(db, actor, pool))
    if row.status in ("holding", "returning"):
        await db.commit()  # nothing to change (the lock goes)
        return await _one_out(db, actor, pool)
    if row.status != "waiting":
        raise _state_conflict(row)
    channels.require_writable(channel)
    change = await _change_for(db, pool, channel, actor)
    await _assign(db, change, row, actor)
    await _post(
        db,
        change,
        f"✅ {await _name(db, change, row.user_id)} さんに「{_safe(pool.name)}」を割り当てました"
        f" (保証 {_label(change, row.guarantee_until)} まで)",
        f"{row.id}/assigned",
    )
    return await _finish(db, actor, change)


async def remove(db: AsyncSession, actor: User, reservation_id: uuid.UUID) -> PoolOut:
    """「外した」: the operator took the seat back in the console (a return, or not)."""
    row, pool, channel = await _locked_reservation(db, actor, reservation_id)
    _require_operator(await _can_operate(db, actor, pool))
    if row.status == "done":
        await db.commit()  # nothing to change (the lock goes)
        return await _one_out(db, actor, pool)
    if row.status not in ("holding", "returning"):
        raise _state_conflict(row)
    channels.require_writable(channel)
    change = await _change_for(db, pool, channel, actor)
    reason = await _remove(db, change, row, actor)
    name = await _name(db, change, row.user_id)
    if reason == "returned":
        text = f"⏹ {name} さんの「{_safe(pool.name)}」の返却が済みました"
    else:
        text = f"⏹ {name} さんを「{_safe(pool.name)}」から外しました"
    await _post(db, change, text, f"{row.id}/removed")
    return await _finish(db, actor, change)


async def swap(db: AsyncSession, actor: User, pool_id: uuid.UUID, data: SwapIn) -> PoolOut:
    """「入れ替えた」: one holder out and one waiting member in, together."""
    pool, channel = await _readable_pool(db, actor, pool_id, lock=True)
    _require_operator(await _can_operate(db, actor, pool))
    out_row = await repo.get_reservation(db, data.remove_id)
    in_row = await repo.get_reservation(db, data.assign_id)
    if (
        out_row is None
        or in_row is None
        or out_row.pool_id != pool.id
        or in_row.pool_id != pool.id
        or out_row.id == in_row.id
    ):
        raise not_found("reservation_not_found", "Reservation not found")
    out_done = out_row.status == "done"
    in_done = in_row.status in ("holding", "returning")
    if out_done and in_done:
        await db.commit()  # nothing to change (the lock goes)
        return await _one_out(db, actor, pool)
    if not out_done and out_row.status not in ("holding", "returning"):
        raise _state_conflict(out_row)
    if not in_done and in_row.status != "waiting":
        raise _state_conflict(in_row)
    channels.require_writable(channel)
    change = await _change_for(db, pool, channel, actor)
    if not out_done:
        await _remove(db, change, out_row, actor)
    if not in_done:
        await _assign(db, change, in_row, actor)
    await _post(
        db,
        change,
        f"🔁 「{_safe(pool.name)}」を {await _name(db, change, out_row.user_id)} さんから"
        f" {await _name(db, change, in_row.user_id)} さんに入れ替えました"
        f" (保証 {_label(change, in_row.guarantee_until)} まで)",
        f"{out_row.id}/{in_row.id}/swapped",
    )
    return await _finish(db, actor, change)


# --- the worker ---------------------------------------------------------------------------------


async def tick(db: AsyncSession, *, now: datetime | None = None) -> int:
    """Time-driven notices (§4): a holder passing the guarantee while someone waits gets the
    grace notice; after the grace, the operators are told they can swap. Runs with the reminders'
    worker. Returns how many pools changed."""
    changed = 0
    for pool_id in await repo.pools_to_watch(db):
        try:
            pool = await repo.get_pool(db, pool_id, for_update=True, skip_locked=True)
            if pool is None:
                await db.rollback()
                continue
            channel = await channels.find_channel(db, pool.channel_id)
            bot_id = await _bot_id(db, channel) if channel is not None else None
            if channel is None or channel.is_archived or bot_id is None:
                await db.rollback()
                continue
            change = _Change(pool=pool, channel=channel, bot_id=bot_id, now=now or utcnow())
            if await _reconcile(db, change):
                await _emit(db, pool)
                await db.commit()
                await _deliver(db, bot_id, change.notes)
                changed += 1
            else:
                await db.rollback()
        except Exception:
            await db.rollback()
            log.exception("reservation pool %s: the worker failed", pool_id)
    return changed
