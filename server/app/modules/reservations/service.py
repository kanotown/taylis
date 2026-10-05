"""Reservation pools (docs/RESERVATIONS.md, M112): the workspace's shared, limited seats.

Members book a seat by the hour (start on the hour, 1 h up to the pool's `max_hours`, up to 14
days ahead, two bookings at a time) or queue for one right now (「今すぐ」, the walk-in queue of
M99). The pool's operators hand seats out by hand in the resource's own console (e.g. Claude's
admin console) and press 「割り当てた」 / 「外した」 / 「入れ替えた」 here. Who gets which seat
and when is plan.py's; this module keeps the rows, the notices and the log.

Every change locks the pool's row first, so two operators pressing at once (or a press and the
worker) apply one after the other, and every action is idempotent. Notices are activity items
(`reservation_notices`) written with a `reservation.notice` event (the push) in the change's
own transaction: nothing is sent after the commit. An operator to-do goes to every operator
under one key; once it is done (or no longer needed) every copy is marked done. A pool may name
a log channel, where the 「予約」 bot writes one line per change (mentions off); by default it
writes nothing anywhere.
"""

import inspect
import logging
import secrets
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from functools import partial
from zoneinfo import ZoneInfo

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app import i18n
from app.core.errors import AppError, bad_request, conflict, forbidden, not_found
from app.core.time import utcnow
from app.events.outbox import write_outbox
from app.modules.activity.events import ACTIVITY_UPDATED, ActivityUpdatedData
from app.modules.admin import service as admin
from app.modules.audit import service as audit
from app.modules.channels import service as channels
from app.modules.channels.models import Channel
from app.modules.groups.models import UserGroup
from app.modules.messages import service as messages
from app.modules.messages.schemas import MessageCreate
from app.modules.reservations import access
from app.modules.reservations import repository as repo
from app.modules.reservations.events import (
    RESERVATION_NOTICE,
    RESERVATION_UPDATED,
    ReservationNoticeData,
    ReservationUpdatedData,
)
from app.modules.reservations.models import (
    SEATED_STATUSES,
    Reservation,
    ReservationBot,
    ReservationNotice,
    ReservationPool,
)
from app.modules.reservations.plan import (
    HOUR,
    LEAD,
    Booking,
    Holder,
    Plan,
    Todo,
    Waiter,
    booking_conflict,
    free_until,
    make_plan,
)
from app.modules.reservations.schemas import (
    BookingIn,
    ExtendIn,
    PoolCreate,
    PoolOut,
    PoolUpdate,
    ReservationOut,
    SwapIn,
    TodoOut,
)
from app.modules.users import service as users
from app.modules.users.models import User
from app.modules.workflows.render import escape_text

log = logging.getLogger(__name__)

MAX_POOLS = 20
MAX_BOOKINGS_PER_PERSON = 2
HORIZON_DAYS = 14
BOT_NAME = "予約"
BOT_KIND = "reservation"  # users.bot_kind of a log channel's reservation bot
# A log line's client_msg_id comes from the change: a retry finds the message.
_POST_NAMESPACE = uuid.UUID("2f9d6b14-7a3e-4c58-9e01-b8c4d2a6f375")


# --- the change being made -----------------------------------------------------------------------


@dataclass
class _Change:
    pool: ReservationPool
    now: datetime
    actor_id: uuid.UUID | None = None
    people: dict[uuid.UUID, User] = field(default_factory=dict)
    # Activity items marked done, per person (activity.updated after the change).
    done: dict[uuid.UUID, list[uuid.UUID]] = field(default_factory=dict)

    async def person(self, db: AsyncSession, user_id: uuid.UUID) -> User | None:
        if user_id not in self.people:
            found = (await users.get_users(db, [user_id])).get(user_id)
            if found is None:
                return None
            self.people[user_id] = found
        return self.people[user_id]


def _safe(text: str) -> str:
    return escape_text(text)


# Texts: a log channel's lines are shared (ja); a notice is for one person, in their language
# (`lc`, M115, docs/I18N.md; app/i18n/messages.json "reservation.*").


async def _name(db: AsyncSession, change: _Change, user_id: uuid.UUID, lc: str = "ja") -> str:
    person = await change.person(db, user_id)
    return _safe(person.display_name) if person is not None else i18n.t("reservation.unknown", lc)


async def _who(db: AsyncSession, change: _Change, user_id: uuid.UUID, lc: str = "ja") -> str:
    """For the operators: the name and the address (to find the account in the console)."""
    person = await change.person(db, user_id)
    if person is None:
        return i18n.t("reservation.unknown", lc)
    name = _safe(person.display_name)
    if person.email:
        return i18n.t("reservation.who_email", lc, name=name, email=_safe(person.email))
    return i18n.t("reservation.who", lc, name=name)


def _label(change: _Change, moment: datetime | None, lc: str = "ja") -> str:
    """「13:00」 today, else 「10/9 (金) 13:00」, in the pool's zone."""
    if moment is None:
        return ""
    zone = ZoneInfo(change.pool.tz)
    local = moment.astimezone(zone)
    if local.date() == change.now.astimezone(zone).date():
        return f"{local:%H:%M}"
    return i18n.t(
        "reservation.on_day",
        lc,
        month=local.month,
        day=local.day,
        weekday=i18n.weekday(local.weekday(), lc),
        time=f"{local:%H:%M}",
    )


def _span(change: _Change, row: Reservation, lc: str = "ja") -> str:
    end = row.end_at.astimezone(ZoneInfo(change.pool.tz)) if row.end_at else None
    return f"{_label(change, row.start_at, lc)}〜{end:%H:%M}" if end is not None else ""


def _pool_name(change: _Change, lc: str = "ja") -> str:
    return i18n.t("reservation.pool", lc, name=_safe(change.pool.name))


# A notice's text: fixed, or written for the reader's language.
NoticeText = str | Callable[[str], str | Awaitable[str]]


# --- access -------------------------------------------------------------------------------------


@dataclass
class _Audience:
    """Who sees a pool (docs/RESERVATIONS.md §1): members (not guests) unless narrowed to a
    channel's or a group's members; its operators, its creator and administrators always."""

    pool: ReservationPool
    members: set[uuid.UUID] | None  # None: everyone

    def sees(self, user: User) -> bool:
        if not user.is_active or user.role == "bot":
            return False
        if user.is_admin or user.id == self.pool.created_by or user.id in self.pool.operator_ids:
            return True
        if user.is_guest:
            return False
        return self.members is None or user.id in self.members


async def _audience(db: AsyncSession, pool: ReservationPool) -> _Audience:
    if pool.visibility == "channel":
        cid = pool.visibility_channel_id
        return _Audience(pool, set(await channels.member_ids_of(db, cid)) if cid else set())
    if pool.visibility == "group":
        gid = pool.visibility_group_id
        return _Audience(pool, await repo.group_member_ids(db, gid) if gid else set())
    return _Audience(pool, None)


_can_manage = access.can_manage
_can_operate = access.can_operate


def _pool_not_found() -> AppError:
    return not_found("reservation_pool_not_found", "Reservation pool not found")


async def _visible_pool(
    db: AsyncSession, actor: User, pool_id: uuid.UUID, *, lock: bool = False
) -> ReservationPool:
    pool = await repo.get_pool(db, pool_id, for_update=lock)
    if pool is None or not (await _audience(db, pool)).sees(actor):
        raise _pool_not_found()  # someone who cannot see it does not learn it exists
    return pool


async def _locked_reservation(
    db: AsyncSession, actor: User, reservation_id: uuid.UUID
) -> tuple[Reservation, ReservationPool]:
    """The reservation with its pool locked (every change of a pool goes through the lock)."""
    row = await repo.get_reservation(db, reservation_id)
    if row is None:
        raise not_found("reservation_not_found", "Reservation not found")
    try:
        pool = await _visible_pool(db, actor, row.pool_id, lock=True)
    except AppError as exc:
        raise not_found("reservation_not_found", "Reservation not found") from exc
    row = await repo.get_reservation(db, reservation_id)  # as it is under the lock
    if row is None:
        raise not_found("reservation_not_found", "Reservation not found")
    return row, pool


def _require_operator(allowed: bool) -> None:
    if not allowed:
        raise forbidden(
            "reservation_operator_required",
            "Only the pool's operators, its creator and administrators can",
        )


def _state_conflict(row: Reservation) -> AppError:
    return conflict(
        "reservation_state_conflict",
        "The reservation is not in a state for this",
        details={"status": row.status},
    )


# --- the plan ----------------------------------------------------------------------------------


def _holder(row: Reservation) -> Holder:
    return Holder(
        id=row.id,
        kind="booking" if row.kind == "booking" else "walkin",
        status=row.status,
        guarantee_until=row.guarantee_until,
        start_at=row.start_at,
        end_at=row.end_at,
        returned_at=row.returned_at,
        evict_at=row.evict_at if row.evict_notice_at is not None else None,
    )


def _inputs(
    rows: list[Reservation], *, without: uuid.UUID | None = None
) -> tuple[list[Holder], list[Booking], list[Waiter]]:
    holders, bookings, waiters = [], [], []
    for r in rows:
        if r.id == without:
            continue
        if r.status in SEATED_STATUSES:
            holders.append(_holder(r))
        elif r.status == "booked" and r.start_at is not None and r.end_at is not None:
            bookings.append(Booking(r.id, r.start_at, r.end_at))
        elif r.status == "waiting":
            waiters.append(Waiter(r.id, r.requested_at))
    return holders, bookings, waiters


def _plan(pool: ReservationPool, rows: list[Reservation], now: datetime) -> Plan:
    holders, bookings, waiters = _inputs(rows)
    return make_plan(
        pool.capacity,
        holders,
        bookings,
        waiters,
        now,
        grace=timedelta(minutes=pool.grace_minutes),
        min_hours=pool.min_hours,
    )


def _day_start(pool: ReservationPool, now: datetime) -> datetime:
    zone = ZoneInfo(pool.tz)
    local = now.astimezone(zone)
    return local.replace(hour=0, minute=0, second=0, microsecond=0)


def _horizon_end(pool: ReservationPool, now: datetime) -> datetime:
    """Bookings end by the end of the 14th day after today (the pool's zone)."""
    start = _day_start(pool, now)
    day = (start + timedelta(days=HORIZON_DAYS + 1, hours=12)).date()
    return datetime(day.year, day.month, day.day, tzinfo=ZoneInfo(pool.tz))


def _can_extend(
    pool: ReservationPool, row: Reservation, rows: list[Reservation], now: datetime
) -> bool:
    if row.kind != "booking" or row.status not in ("booked", "holding"):
        return False
    if row.start_at is None or row.end_at is None:
        return False
    new_end = row.end_at + HOUR
    if new_end - row.start_at > timedelta(hours=pool.max_hours) or new_end > _horizon_end(
        pool, now
    ):
        return False
    holders, bookings, _ = _inputs(rows, without=row.id)
    return booking_conflict(pool.capacity, holders, bookings, row.end_at, new_end, now) is None


# --- output ------------------------------------------------------------------------------------


def _row_out(
    row: Reservation,
    plan: Plan,
    people: dict[uuid.UUID, User],
    *,
    operate: bool,
    position: int | None = None,
    can_extend: bool = False,
) -> ReservationOut:
    person = people.get(row.user_id)
    seated = row.status in SEATED_STATUSES
    return ReservationOut(
        id=row.id,
        user_id=row.user_id,
        kind="booking" if row.kind == "booking" else "walkin",
        status=row.status,  # type: ignore[arg-type]
        requested_at=row.requested_at,
        start_at=row.start_at,
        end_at=row.end_at,
        assigned_at=row.assigned_at,
        guarantee_until=row.guarantee_until,
        returned_at=row.returned_at,
        evict_at=row.evict_at if row.evict_notice_at is not None else None,
        email=person.email if operate and person is not None else None,
        position=position,
        step=None if seated else plan.steps.get(row.id),
        pair_id=plan.holder_pair.get(row.id) if seated else plan.claimant_pair.get(row.id),
        ready=row.id in plan.ready,
        until=None if seated else plan.until.get(row.id),
        can_extend=can_extend,
    )


def _todo_out(todo: Todo, *, upcoming: bool) -> TodoOut:
    return TodoOut(
        key=todo.key,
        action=todo.action,
        reason=todo.reason,
        assign_id=todo.assign_id,
        remove_id=todo.remove_id,
        due_at=todo.due_at,
        upcoming=upcoming,
    )


async def _outs(
    db: AsyncSession, actor: User, pools: list[ReservationPool], now: datetime | None = None
) -> list[PoolOut]:
    if not pools:
        return []
    now = now or utcnow()
    ids = [p.id for p in pools]
    rows = await repo.active_rows(db, ids)
    earliest = min(_day_start(p, now) for p in pools)
    done = await repo.done_bookings_since(db, ids, earliest)
    by_pool: dict[uuid.UUID, list[Reservation]] = {}
    for row in rows:
        by_pool.setdefault(row.pool_id, []).append(row)
    done_by_pool: dict[uuid.UUID, list[Reservation]] = {}
    for row in done:
        done_by_pool.setdefault(row.pool_id, []).append(row)
    people = await users.get_users(db, list({r.user_id for r in [*rows, *done]}))
    out: list[PoolOut] = []
    for pool in pools:
        mine = by_pool.get(pool.id, [])
        plan = _plan(pool, mine, now)
        operate = _can_operate(actor, pool)
        holders = sorted(
            (r for r in mine if r.status in SEATED_STATUSES),
            key=lambda r: (r.assigned_at or r.requested_at, r.id),
        )
        waiting = sorted(
            (r for r in mine if r.status == "waiting"), key=lambda r: (r.requested_at, r.id)
        )
        today = _day_start(pool, now)
        bookings = [r for r in mine if r.kind == "booking"]
        bookings += [r for r in done_by_pool.get(pool.id, []) if r.end_at and r.end_at > today]
        bookings.sort(key=lambda r: (r.start_at or now, r.id))

        extendable = {
            r.id for r in mine if r.user_id == actor.id and _can_extend(pool, r, mine, now)
        }

        def shaped(
            row: Reservation,
            position: int | None = None,
            plan: Plan = plan,
            operate: bool = operate,
            extendable: set[uuid.UUID] = extendable,
        ) -> ReservationOut:
            return _row_out(
                row,
                plan,
                people,
                operate=operate,
                position=position,
                can_extend=row.id in extendable,
            )

        todos: list[TodoOut] = []
        if operate:
            todos = [_todo_out(t, upcoming=False) for t in plan.todos]
            todos += [_todo_out(t, upcoming=True) for t in plan.upcoming]
        out.append(
            PoolOut(
                id=pool.id,
                name=pool.name,
                capacity=pool.capacity,
                min_hours=pool.min_hours,
                max_hours=pool.max_hours,
                grace_minutes=pool.grace_minutes,
                tz=pool.tz,
                enabled=pool.enabled,
                operator_ids=list(pool.operator_ids),
                log_channel_id=pool.log_channel_id,
                visibility=pool.visibility,  # type: ignore[arg-type]
                visibility_channel_id=pool.visibility_channel_id,
                visibility_group_id=pool.visibility_group_id,
                holders=[shaped(r) for r in holders],
                waiting=[shaped(r, i + 1) for i, r in enumerate(waiting)],
                bookings=[shaped(r) for r in bookings],
                todos=todos,
                next_evict_id=plan.next_evict_id,
                my_reservation_id=next(
                    (r.id for r in mine if r.user_id == actor.id and r.kind == "walkin"), None
                ),
                can_manage=_can_manage(actor, pool),
                can_operate=operate,
                horizon_days=HORIZON_DAYS,
                created_at=pool.created_at,
                updated_at=pool.updated_at,
            )
        )
    return out


async def _one_out(db: AsyncSession, actor: User, pool: ReservationPool) -> PoolOut:
    return (await _outs(db, actor, [pool]))[0]


# --- the log channel ------------------------------------------------------------------------------


async def _bot(db: AsyncSession, actor: User, channel: Channel) -> uuid.UUID:
    """The channel's reservation bot, active and in the channel; made the first time a pool
    logs there."""
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


async def _post(db: AsyncSession, change: _Change, text: str, key: str) -> None:
    """One line in the pool's log channel, if it has one (mentions off: names are text)."""
    cid = change.pool.log_channel_id
    if cid is None:
        return
    channel = await channels.find_channel(db, cid)
    kept = await repo.bot_row(db, cid)
    if channel is None or channel.is_archived or kept is None:
        return
    try:
        async with db.begin_nested():
            bot = await users.require_user(db, kept.bot_user_id)
            if not bot.is_active:
                return
            if await channels.membership_of(db, bot.id, channel.id) is None:
                await channels.add_member_in_tx(db, channel, bot.id)
            await messages.create_message(
                db,
                bot,
                channel.id,
                MessageCreate(client_msg_id=uuid.uuid5(_POST_NAMESPACE, key), body=text),
                advance_read=False,
                commit=False,
                mentions=False,
            )
    except Exception:
        log.exception("reservation pool %s: the log line failed", change.pool.id)


# --- notices (activity items + push) --------------------------------------------------------------


async def _notify(
    db: AsyncSession,
    change: _Change,
    user_id: uuid.UUID,
    key: str,
    text: NoticeText,
    *,
    operator: bool = False,
    reservation_id: uuid.UUID | None = None,
    silent: bool = False,
) -> None:
    """One activity item (and its push) for one person, once per key. `silent`: the operator
    who pressed the button gets their copy done already, without a push (the key counts as
    told). The text is written in the person's language (M115)."""
    person = await change.person(db, user_id)
    if person is None or not person.is_active or person.role == "bot":
        return
    if operator and not access.may_receive_operator_notice(person, change.pool):
        return  # an operator's to-do names people with their addresses (review v0.1.37 #2)
    if await repo.notice(db, user_id, key) is not None:
        return
    if not isinstance(text, str):
        written = text(await i18n.text_locale(db, person))
        text = await written if inspect.isawaitable(written) else written
    assert isinstance(text, str)
    kept = ReservationNotice(
        user_id=user_id,
        pool_id=change.pool.id,
        reservation_id=reservation_id,
        key=key,
        operator=operator,
        text=text,
        at=change.now,
        done_at=change.now if silent else None,
        done_by=user_id if silent else None,
    )
    db.add(kept)
    await db.flush()
    if silent:
        return
    await write_outbox(
        db,
        event_type=RESERVATION_NOTICE,
        audience_type="user",
        audience_id=user_id,
        payload=ReservationNoticeData(
            item_id=kept.id,
            pool_id=change.pool.id,
            reservation_id=reservation_id,
            text=text,
            operator=operator,
            at=change.now,
        ).model_dump(mode="json"),
    )


async def _operator_ids(db: AsyncSession, change: _Change) -> list[uuid.UUID]:
    """Who the to-dos go to: the pool's operators who can operate it now (the API's rule: not a
    guest, not deactivated); without any, its creator if they can; without them, the
    administrators. A to-do names people with their addresses (review v0.1.37 #2)."""
    pool = change.pool
    chosen = list(pool.operator_ids)
    found = await users.get_users(db, chosen)
    change.people.update(found)
    able = [
        uid
        for uid in chosen
        if uid in found and access.may_receive_operator_notice(found[uid], pool)
    ]
    if able:
        return able
    creator = await change.person(db, pool.created_by)
    if creator is not None and access.may_receive_operator_notice(creator, pool):
        return [creator.id]
    return await repo.admin_ids(db)


async def _notify_operators(
    db: AsyncSession, change: _Change, key: str, text: NoticeText, reservation_id: uuid.UUID | None
) -> None:
    for uid in await _operator_ids(db, change):
        await _notify(
            db,
            change,
            uid,
            key,
            text,
            operator=True,
            reservation_id=reservation_id,
            silent=uid == change.actor_id,  # who pressed the button sees the page already
        )


async def _todo_text(
    db: AsyncSession,
    change: _Change,
    todo: Todo,
    by_id: dict[uuid.UUID, Reservation],
    lc: str = "ja",
) -> str:
    name = _pool_name(change, lc)
    target = by_id.get(todo.assign_id) if todo.assign_id else None
    out = by_id.get(todo.remove_id) if todo.remove_id else None
    if todo.key.startswith("booking:") and target is not None:
        head = i18n.t(
            "reservation.todo.booking",
            lc,
            start=_label(change, target.start_at, lc),
            who=await _who(db, change, target.user_id, lc),
            pool=name,
            end=_span(change, target, lc).split("〜")[-1],
        )
        if out is not None:
            who_out = await _who(db, change, out.user_id, lc)
            return head + i18n.t("reservation.todo.booking_swap", lc, who=who_out)
        return head + i18n.t("reservation.todo.booking_later", lc)
    if todo.action == "assign" and target is not None:
        who = await _who(db, change, target.user_id, lc)
        if target.kind == "booking":
            span = _span(change, target, lc)
            return i18n.t("reservation.todo.booking_started", lc, who=who, span=span, pool=name)
        return i18n.t("reservation.todo.assign", lc, who=who, pool=name)
    if todo.action == "swap" and target is not None and out is not None:
        why = (
            i18n.t(f"reservation.why.{todo.reason}", lc)
            if todo.reason in ("returned", "booking_ended", "guarantee_over")
            else ""
        )
        return i18n.t(
            "reservation.todo.swap",
            lc,
            pool=name,
            out=await _who(db, change, out.user_id, lc),
            why=why,
            who=await _who(db, change, target.user_id, lc),
        )
    if todo.action == "remove" and out is not None:
        who = await _who(db, change, out.user_id, lc)
        if todo.reason == "returned":
            return i18n.t("reservation.todo.returned", lc, who=who, pool=name)
        end = _label(change, out.end_at, lc)
        return i18n.t("reservation.todo.ended", lc, who=who, pool=name, end=end)
    return i18n.t("reservation.todo.other", lc, pool=name)


def _expired_text(change: _Change, row: Reservation, lc: str) -> str:
    return i18n.t(
        "reservation.expired", lc, pool=_pool_name(change, lc), span=_span(change, row, lc)
    )


async def _emit(db: AsyncSession, pool_id: uuid.UUID, *, deleted: bool = False) -> None:
    await write_outbox(
        db,
        event_type=RESERVATION_UPDATED,
        audience_type="all",
        payload=ReservationUpdatedData(pool_id=pool_id, deleted=deleted).model_dump(mode="json"),
    )


# --- keeping the plan --------------------------------------------------------------------------


async def _reconcile(db: AsyncSession, change: _Change) -> bool:
    """Brings the rows and the notices in line with the plan (§4): requests of people who can no
    longer see the pool are dropped; bookings nobody assigned expire; walk-ins someone needs are
    told when their seat goes (and told when it no longer does); the operators get the to-dos and
    the to-dos that are gone are marked done. Returns whether anything changed."""
    pool, now = change.pool, change.now
    rows = await repo.active_rows(db, [pool.id])
    changed = False

    audience = await _audience(db, pool)
    found = await users.get_users(db, list({r.user_id for r in rows}))
    change.people.update(found)
    for row in rows:
        person = found.get(row.user_id)
        if row.status in ("waiting", "booked") and (person is None or not audience.sees(person)):
            row.status, row.ended_at, row.end_reason = "cancelled", now, "cancelled"
            row.updated_at = now
            changed = True
        elif row.status == "booked" and row.end_at is not None and row.end_at <= now:
            row.status, row.ended_at, row.end_reason = "done", now, "expired"
            row.updated_at = now
            changed = True
            await _notify(
                db,
                change,
                row.user_id,
                f"{row.id}/expired",
                partial(_expired_text, change, row),
                reservation_id=row.id,
            )
    rows = [r for r in rows if r.status in ("waiting", "booked", "holding", "returning")]

    plan = _plan(pool, rows, now)
    by_id = {r.id: r for r in rows}
    for row in rows:
        if row.status not in SEATED_STATUSES or row.kind != "walkin":
            continue
        goes = plan.evict.get(row.id)
        if goes is not None and row.evict_notice_at is None:
            row.evict_notice_at, row.evict_at, row.updated_at = now, goes, now
            changed = True
            claimant = by_id.get(plan.holder_pair.get(row.id) or row.id)
            by_booking = claimant is not None and claimant.kind == "booking"

            def text(
                lc: str,
                row: Reservation = row,
                goes: datetime = goes,
                by_booking: bool = by_booking,
            ) -> str:
                pool, at = _pool_name(change, lc), _label(change, goes, lc)
                if by_booking:
                    return i18n.t("reservation.evict_booking", lc, pool=pool, at=at)
                until = _label(change, row.guarantee_until, lc)
                return i18n.t("reservation.evict_waiting", lc, pool=pool, until=until, at=at)

            await _notify(
                db,
                change,
                row.user_id,
                f"{row.id}/evict/{now.isoformat()}",
                text,
                reservation_id=row.id,
            )
        elif goes is None and row.evict_notice_at is not None:
            row.evict_notice_at = row.evict_at = None
            row.updated_at = now
            changed = True
            if row.status == "holding":
                await _notify(
                    db,
                    change,
                    row.user_id,
                    f"{row.id}/keep/{now.isoformat()}",
                    lambda lc: i18n.t("reservation.keep", lc, pool=_pool_name(change, lc)),
                    reservation_id=row.id,
                )
    if changed:
        await db.flush()
        plan = _plan(pool, rows, now)

    # The operators' to-dos: each key once (the page shows it until it is done).
    told = await repo.operator_notice_keys(db, pool.id, await _operator_ids(db, change))
    booked = {r.id for r in rows if r.status == "booked"}
    keep = {t.key for t in plan.todos} | {t.key for t in plan.upcoming}
    keep |= {f"booking:{bid}" for bid in booked}
    for todo in [*plan.upcoming, *plan.todos]:
        if todo.key in told or (todo.assign_id in booked and f"booking:{todo.assign_id}" in told):
            continue  # (a booking told of before it started: the page shows the rest)
        reservation_id = todo.assign_id or todo.remove_id
        await _notify_operators(
            db,
            change,
            todo.key,
            partial(_todo_text, db, change, todo, by_id),
            reservation_id,
        )
        told.add(todo.key)
        changed = True
    for item in await repo.open_operator_notices(db, pool.id):
        if item.key not in keep:
            item.done_at, item.done_by = now, change.actor_id
            change.done.setdefault(item.user_id, []).append(item.id)
            changed = True
    if changed:
        await db.flush()
    return changed


async def _announce_done(db: AsyncSession, change: _Change) -> None:
    for user_id, item_ids in change.done.items():
        await write_outbox(
            db,
            event_type=ACTIVITY_UPDATED,
            audience_type="user",
            audience_id=user_id,
            payload=ActivityUpdatedData(item_ids=sorted(item_ids)).model_dump(mode="json"),
        )
    change.done.clear()


def _change_for(pool: ReservationPool, actor: User | None) -> _Change:
    return _Change(pool=pool, now=utcnow(), actor_id=actor.id if actor is not None else None)


async def _finish(db: AsyncSession, actor: User, change: _Change) -> PoolOut:
    pool_id = change.pool.id
    await _reconcile(db, change)
    await _announce_done(db, change)
    await _emit(db, pool_id)
    await db.commit()
    pool = await repo.get_pool(db, pool_id)
    if pool is None:
        raise _pool_not_found()
    return await _one_out(db, actor, pool)


# --- settings ----------------------------------------------------------------------------------


async def list_pools(db: AsyncSession, actor: User) -> list[PoolOut]:
    """The pools the caller sees, oldest first. Only those who can operate a pool see the
    members' addresses."""
    visible = []
    for pool in await repo.all_pools(db):
        if (await _audience(db, pool)).sees(actor):
            visible.append(pool)
    return await _outs(db, actor, visible)


async def get_pool(db: AsyncSession, actor: User, pool_id: uuid.UUID) -> PoolOut:
    return await _one_out(db, actor, await _visible_pool(db, actor, pool_id))


def _require_manager(allowed: bool) -> None:
    if not allowed:
        raise forbidden(
            "reservation_manage_restricted",
            "Only administrators (and a pool's creator) can change reservation pools",
        )


async def _check_operators(db: AsyncSession, operator_ids: list[uuid.UUID]) -> None:
    if not operator_ids:
        return
    found = await users.get_users(db, operator_ids)
    for uid in operator_ids:
        person = found.get(uid)
        if person is None or not person.is_active or person.role in ("bot", "guest"):
            raise bad_request(
                "reservation_operator_invalid",
                "Operators must be active members (not guests or bots)",
                details={"user_id": str(uid)},
            )


async def _check_log_channel(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> Channel:
    """A log channel: a channel (not a DM) the actor is a member of (the bot joins it, as the
    feeds and webhooks do), not archived."""
    channel = await channels.require_readable(db, actor, channel_id)
    if channel.is_dm:
        raise bad_request("reservation_channel_unsupported", "A log channel is a channel, not a DM")
    if await channels.membership_of(db, actor.id, channel.id) is None:
        raise forbidden("not_a_member", "You are not a member of this channel")
    channels.require_writable(channel)
    return channel


async def _check_visibility(
    db: AsyncSession,
    actor: User,
    visibility: str,
    channel_id: uuid.UUID | None,
    group_id: uuid.UUID | None,
) -> tuple[uuid.UUID | None, uuid.UUID | None]:
    if visibility == "channel":
        if channel_id is None:
            raise bad_request(
                "reservation_visibility_invalid", "Name the channel whose members see the pool"
            )
        channel = await channels.require_readable(db, actor, channel_id)
        if channel.is_dm:
            raise bad_request(
                "reservation_visibility_invalid", "Visibility goes by a channel, not a DM"
            )
        return channel.id, None
    if visibility == "group":
        if group_id is None or await db.get(UserGroup, group_id) is None:
            raise bad_request(
                "reservation_visibility_invalid", "Name the group whose members see the pool"
            )
        return None, group_id
    return None, None


async def create_pool(db: AsyncSession, actor: User, data: PoolCreate) -> PoolOut:
    _require_manager(actor.is_admin)
    if len(await repo.all_pools(db)) >= MAX_POOLS:
        raise conflict("too_many_reservation_pools", f"At most {MAX_POOLS} pools")
    await _check_operators(db, data.operator_ids)
    vis_channel, vis_group = await _check_visibility(
        db, actor, data.visibility, data.visibility_channel_id, data.visibility_group_id
    )
    if data.log_channel_id is not None:
        await _bot(db, actor, await _check_log_channel(db, actor, data.log_channel_id))
    now = utcnow()
    pool = ReservationPool(
        name=data.name,
        capacity=data.capacity,
        min_hours=data.min_hours,
        max_hours=data.max_hours,
        grace_minutes=data.grace_minutes,
        tz=data.tz,
        operator_ids=data.operator_ids,
        enabled=data.enabled,
        log_channel_id=data.log_channel_id,
        visibility=data.visibility,
        visibility_channel_id=vis_channel,
        visibility_group_id=vis_group,
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
        details={"name": pool.name, "capacity": pool.capacity},
    )
    await _emit(db, pool.id)
    await db.commit()
    return await _one_out(db, actor, pool)


def _plain(value: object) -> object:
    if isinstance(value, list):
        return [str(v) for v in value]
    if isinstance(value, uuid.UUID):
        return str(value)
    return value


async def update_pool(
    db: AsyncSession, actor: User, pool_id: uuid.UUID, data: PoolUpdate
) -> PoolOut:
    pool = await _visible_pool(db, actor, pool_id, lock=True)
    _require_manager(_can_manage(actor, pool))
    fields = data.model_dump(exclude_unset=True)
    nullable = {"log_channel_id", "visibility_channel_id", "visibility_group_id"}
    fields = {k: v for k, v in fields.items() if v is not None or k in nullable}
    if "operator_ids" in fields:
        await _check_operators(db, data.operator_ids or [])
    if fields.get("log_channel_id") is not None and fields["log_channel_id"] != pool.log_channel_id:
        await _bot(db, actor, await _check_log_channel(db, actor, fields["log_channel_id"]))
    if {"visibility", "visibility_channel_id", "visibility_group_id"} & fields.keys():
        visibility = fields.get("visibility", pool.visibility)
        vis_channel, vis_group = await _check_visibility(
            db,
            actor,
            visibility,
            fields.get("visibility_channel_id", pool.visibility_channel_id),
            fields.get("visibility_group_id", pool.visibility_group_id),
        )
        fields["visibility"] = visibility
        fields["visibility_channel_id"], fields["visibility_group_id"] = vis_channel, vis_group
    before = {key: getattr(pool, key) for key in fields}
    fields = {k: v for k, v in fields.items() if before[k] != v}
    for key, value in fields.items():
        setattr(pool, key, value)
    change = _change_for(pool, actor)
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


async def delete_pool(db: AsyncSession, actor: User, pool_id: uuid.UUID) -> None:
    """The pool, its rows and its notices go (log lines stay). Seats still handed out in the
    resource's console are not touched there: the operators take them out by hand."""
    pool = await _visible_pool(db, actor, pool_id, lock=True)
    _require_manager(_can_manage(actor, pool))
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="reservation_pool.deleted",
        target_type="reservation_pool",
        target_id=pool.id,
        details={"name": pool.name},
    )
    await _emit(db, pool.id, deleted=True)
    await db.delete(pool)
    await db.commit()


# --- members ------------------------------------------------------------------------------------


def _require_member(actor: User) -> None:
    if actor.is_guest:
        raise forbidden("guest_restricted", "Guests cannot do this")


async def reserve(db: AsyncSession, actor: User, pool_id: uuid.UUID) -> PoolOut:
    """「今すぐ」: join the walk-in queue (one at a time per person; pressing again changes
    nothing)."""
    _require_member(actor)
    pool = await _visible_pool(db, actor, pool_id, lock=True)
    rows = await repo.active_rows(db, [pool.id])
    if any(r.user_id == actor.id and r.kind == "walkin" for r in rows):
        await db.commit()  # nothing to change (the lock goes)
        return await _one_out(db, actor, pool)
    if not pool.enabled:
        raise conflict("reservation_pool_disabled", "This pool takes no reservations now")
    change = _change_for(pool, actor)
    row = Reservation(
        pool_id=pool.id,
        user_id=actor.id,
        kind="walkin",
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
        return await _one_out(db, actor, await _visible_pool(db, actor, pool_id))
    await _post(
        db,
        change,
        f"🙋 {await _name(db, change, actor.id)} さんが{_pool_name(change)}の順番待ちに入りました",
        f"{row.id}/reserved",
    )
    change.actor_id = None  # the operators hear of a free seat even if one of them queued
    return await _finish(db, actor, change)


def _invalid_booking(reason: str, message: str) -> AppError:
    return bad_request("reservation_booking_invalid", message, details={"reason": reason})


async def book(db: AsyncSession, actor: User, pool_id: uuid.UUID, data: BookingIn) -> PoolOut:
    """A booking: on the hour (the pool's zone), 1 h to max_hours, from the current hour to the
    end of the 14th day after today; at most two at a time per person; every hour must have a
    seat (bookings and walk-in guarantees below the capacity). Booking the same slot again
    changes nothing (a retry)."""
    _require_member(actor)
    pool = await _visible_pool(db, actor, pool_id, lock=True)
    now = utcnow()
    zone = ZoneInfo(pool.tz)
    start = data.start_at
    if start.tzinfo is None:
        raise _invalid_booking("grid", "start_at needs a time zone")
    local = start.astimezone(zone)
    if local.minute or local.second or local.microsecond:
        raise _invalid_booking("grid", "Bookings start on the hour")
    if data.hours > pool.max_hours:
        raise _invalid_booking("duration", f"At most {pool.max_hours} hours")
    end = start + timedelta(hours=data.hours)
    hour_now = now.astimezone(zone).replace(minute=0, second=0, microsecond=0)
    if start < hour_now:
        raise _invalid_booking("past", "The slot has passed")
    if end > _horizon_end(pool, now):
        raise _invalid_booking("horizon", f"Bookings reach {HORIZON_DAYS} days ahead")
    rows = await repo.active_rows(db, [pool.id])
    mine = [r for r in rows if r.user_id == actor.id and r.kind == "booking"]
    if any(r.start_at == start and r.end_at == end for r in mine):
        await db.commit()  # a retry (the lock goes)
        return await _one_out(db, actor, pool)
    if not pool.enabled:
        raise conflict("reservation_pool_disabled", "This pool takes no reservations now")
    if any(r.start_at and r.end_at and r.start_at < end and r.end_at > start for r in mine):
        raise conflict("reservation_overlap", "You already have a booking at that time")
    if len(mine) >= MAX_BOOKINGS_PER_PERSON:
        raise conflict(
            "too_many_bookings",
            f"At most {MAX_BOOKINGS_PER_PERSON} bookings at a time per pool",
            details={"max": MAX_BOOKINGS_PER_PERSON},
        )
    holders, bookings, _ = _inputs(rows)
    full = booking_conflict(pool.capacity, holders, bookings, start, end, now)
    if full is not None:
        raise conflict(
            "reservation_slot_full",
            "Every seat is booked at that time",
            details={"at": full.isoformat()},
        )
    change = _Change(pool=pool, now=now, actor_id=actor.id)
    row = Reservation(
        pool_id=pool.id,
        user_id=actor.id,
        kind="booking",
        status="booked",
        requested_at=now,
        start_at=start,
        end_at=end,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    await db.flush()
    await _post(
        db,
        change,
        f"🗓 {await _name(db, change, actor.id)} さんが{_pool_name(change)}を予約しました"
        f" ({_span(change, row)})",
        f"{row.id}/booked",
    )
    change.actor_id = None  # an operator booking for themself still gets the to-do
    return await _finish(db, actor, change)


async def extend(
    db: AsyncSession, actor: User, reservation_id: uuid.UUID, data: ExtendIn
) -> PoolOut:
    """A booking grows by `hours` if those hours have a seat, within max_hours and the 14 days
    (the booker, or an operator)."""
    row, pool = await _locked_reservation(db, actor, reservation_id)
    if row.user_id != actor.id:
        _require_operator(_can_operate(actor, pool))
    if row.kind != "booking" or row.status not in ("booked", "holding"):
        raise _state_conflict(row)
    assert row.start_at is not None and row.end_at is not None
    change = _change_for(pool, actor)
    new_end = row.end_at + timedelta(hours=data.hours)
    if new_end - row.start_at > timedelta(hours=pool.max_hours):
        raise _invalid_booking("duration", f"At most {pool.max_hours} hours")
    if new_end > _horizon_end(pool, change.now):
        raise _invalid_booking("horizon", f"Bookings reach {HORIZON_DAYS} days ahead")
    rows = await repo.active_rows(db, [pool.id])
    holders, bookings, _ = _inputs(rows, without=row.id)
    full = booking_conflict(pool.capacity, holders, bookings, row.end_at, new_end, change.now)
    if full is not None:
        raise conflict(
            "reservation_slot_full",
            "Every seat is booked at that time",
            details={"at": full.isoformat()},
        )
    old_end = row.end_at
    row.end_at = new_end
    if row.status == "holding":
        row.guarantee_until = new_end
    row.updated_at = change.now
    await db.flush()
    await _post(
        db,
        change,
        f"⏩ {await _name(db, change, row.user_id)} さんが{_pool_name(change)}の予約を"
        f"{_label(change, new_end)} まで延長しました",
        f"{row.id}/extended/{old_end.isoformat()}",
    )
    return await _finish(db, actor, change)


async def cancel(db: AsyncSession, actor: User, reservation_id: uuid.UUID) -> PoolOut:
    """Leave the queue or drop a booking not yet on a seat (the member), or someone's (an
    operator)."""
    row, pool = await _locked_reservation(db, actor, reservation_id)
    own = row.user_id == actor.id
    if not own:
        _require_operator(_can_operate(actor, pool))
    if row.status == "cancelled":
        await db.commit()  # nothing to change (the lock goes)
        return await _one_out(db, actor, pool)
    if row.status not in ("waiting", "booked"):
        raise _state_conflict(row)
    change = _change_for(pool, actor)
    row.status, row.ended_at, row.ended_by = "cancelled", change.now, actor.id
    row.end_reason = "cancelled"
    row.updated_at = change.now
    await db.flush()
    name = await _name(db, change, row.user_id)
    what = "の順番待ち" if row.kind == "walkin" else f"の予約 ({_span(change, row)})"
    if own:
        text = f"↩️ {name} さんが{_pool_name(change)}{what}を取り消しました"
    else:
        by = await _name(db, change, actor.id)
        text = f"↩️ {by} さんが {name} さんの{_pool_name(change)}{what}を取り消しました"
        walkin = row.kind == "walkin"

        def cancelled(lc: str) -> str:
            pool = _pool_name(change, lc)
            if walkin:
                return i18n.t("reservation.cancelled_by_operator_walkin", lc, pool=pool, by=by)
            span = _span(change, row, lc)
            return i18n.t(
                "reservation.cancelled_by_operator_booking", lc, pool=pool, span=span, by=by
            )

        await _notify(
            db, change, row.user_id, f"{row.id}/cancelled", cancelled, reservation_id=row.id
        )
    await _post(db, change, text, f"{row.id}/cancelled")
    return await _finish(db, actor, change)


async def give_back(db: AsyncSession, actor: User, reservation_id: uuid.UUID) -> PoolOut:
    """The holder is done with the seat: the operators take it out of the console and press
    「外した」; the next one follows."""
    row, pool = await _locked_reservation(db, actor, reservation_id)
    if row.user_id != actor.id:
        raise forbidden("reservation_not_yours", "Only the holder can return the seat")
    if row.status == "returning" or (row.status == "done" and row.end_reason == "returned"):
        await db.commit()  # nothing to change (the lock goes)
        return await _one_out(db, actor, pool)
    if row.status != "holding":
        raise _state_conflict(row)
    change = _change_for(pool, actor)
    row.status, row.returned_at = "returning", change.now
    row.evict_notice_at = row.evict_at = None
    row.updated_at = change.now
    await db.flush()
    await _post(
        db,
        change,
        f"🔙 {await _name(db, change, row.user_id)} さんが{_pool_name(change)}を返却しました",
        f"{row.id}/returned",
    )
    return await _finish(db, actor, change)


# --- operators ----------------------------------------------------------------------------------


async def _assign(db: AsyncSession, change: _Change, row: Reservation, actor: User) -> None:
    pool, now = change.pool, change.now
    rows = await repo.active_rows(db, [pool.id])
    if sum(1 for r in rows if r.status in SEATED_STATUSES) >= pool.capacity:
        raise conflict(
            "reservation_pool_full",
            "Every seat is taken: take one out (外した) first, or swap (入れ替えた)",
        )
    if row.kind == "booking":
        assert row.start_at is not None and row.end_at is not None
        if now < row.start_at - LEAD:
            raise conflict(
                "reservation_too_early",
                "A booking is assigned from 10 minutes before its start",
                details={"start_at": row.start_at.isoformat()},
            )
        if now >= row.end_at:
            raise _state_conflict(row)
        guarantee = row.end_at
    else:
        holders, bookings, _ = _inputs(rows, without=row.id)
        cap = now + timedelta(hours=pool.min_hours)
        guarantee = free_until(pool.capacity, holders, bookings, now, cap)
    row.status, row.assigned_at, row.assigned_by = "holding", now, actor.id
    row.guarantee_until = guarantee
    row.evict_notice_at = row.evict_at = None
    row.updated_at = now
    await db.flush()

    def text(lc: str) -> str:
        pool = _pool_name(change, lc)
        if row.kind == "booking":
            return i18n.t(
                "reservation.assigned_booking", lc, pool=pool, span=_span(change, row, lc)
            )
        until = _label(change, guarantee, lc)
        return i18n.t("reservation.assigned_walkin", lc, pool=pool, until=until)

    await _notify(db, change, row.user_id, f"{row.id}/assigned", text, reservation_id=row.id)


async def _remove(db: AsyncSession, change: _Change, row: Reservation, actor: User) -> str:
    """Ends a holding; returns how it ended (returned / removed)."""
    reason = "returned" if row.status == "returning" else "removed"
    row.status, row.ended_at, row.ended_by, row.end_reason = "done", change.now, actor.id, reason
    row.updated_at = change.now
    await db.flush()
    key = "reservation.returned_done" if reason == "returned" else "reservation.removed"
    await _notify(
        db,
        change,
        row.user_id,
        f"{row.id}/removed",
        lambda lc: i18n.t(key, lc, pool=_pool_name(change, lc)),
        reservation_id=row.id,
    )
    return reason


async def assign(db: AsyncSession, actor: User, reservation_id: uuid.UUID) -> PoolOut:
    """「割り当てた」: the operator gave the member a seat in the console."""
    row, pool = await _locked_reservation(db, actor, reservation_id)
    _require_operator(_can_operate(actor, pool))
    if row.status in SEATED_STATUSES:
        await db.commit()  # nothing to change (the lock goes)
        return await _one_out(db, actor, pool)
    if row.status not in ("waiting", "booked"):
        raise _state_conflict(row)
    change = _change_for(pool, actor)
    await _assign(db, change, row, actor)
    await _post(
        db,
        change,
        f"✅ {await _name(db, change, row.user_id)} さんに{_pool_name(change)}を割り当てました"
        f" ({_label(change, row.guarantee_until)} まで)",
        f"{row.id}/assigned",
    )
    return await _finish(db, actor, change)


async def remove(db: AsyncSession, actor: User, reservation_id: uuid.UUID) -> PoolOut:
    """「外した」: the operator took the seat back in the console (a return, or not)."""
    row, pool = await _locked_reservation(db, actor, reservation_id)
    _require_operator(_can_operate(actor, pool))
    if row.status == "done":
        await db.commit()  # nothing to change (the lock goes)
        return await _one_out(db, actor, pool)
    if row.status not in SEATED_STATUSES:
        raise _state_conflict(row)
    change = _change_for(pool, actor)
    reason = await _remove(db, change, row, actor)
    name = await _name(db, change, row.user_id)
    if reason == "returned":
        text = f"⏹ {name} さんの{_pool_name(change)}の返却が済みました"
    else:
        text = f"⏹ {name} さんを{_pool_name(change)}から外しました"
    await _post(db, change, text, f"{row.id}/removed")
    return await _finish(db, actor, change)


async def swap(db: AsyncSession, actor: User, pool_id: uuid.UUID, data: SwapIn) -> PoolOut:
    """「入れ替えた」: one holder out and one claimant (walk-in or started booking) in."""
    pool = await _visible_pool(db, actor, pool_id, lock=True)
    _require_operator(_can_operate(actor, pool))
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
    in_done = in_row.status in SEATED_STATUSES
    if out_done and in_done:
        await db.commit()  # nothing to change (the lock goes)
        return await _one_out(db, actor, pool)
    if not out_done and out_row.status not in SEATED_STATUSES:
        raise _state_conflict(out_row)
    if not in_done and in_row.status not in ("waiting", "booked"):
        raise _state_conflict(in_row)
    change = _change_for(pool, actor)
    if not out_done:
        await _remove(db, change, out_row, actor)
    if not in_done:
        await _assign(db, change, in_row, actor)
    await _post(
        db,
        change,
        f"🔁 {_pool_name(change)}を {await _name(db, change, out_row.user_id)} さんから"
        f" {await _name(db, change, in_row.user_id)} さんに入れ替えました"
        f" ({_label(change, in_row.guarantee_until)} まで)",
        f"{out_row.id}/{in_row.id}/swapped",
    )
    return await _finish(db, actor, change)


# --- the worker ---------------------------------------------------------------------------------


async def tick(db: AsyncSession, *, now: datetime | None = None) -> int:
    """Time-driven changes (§4): bookings starting (the operators hear 10 minutes before, the
    walk-in it replaces is told), bookings ending, walk-ins past their guarantee while someone
    waits (the grace notice, then the swap to-do), bookings nobody assigned expiring. Runs with
    the reminders' worker. Returns how many pools changed."""
    changed = 0
    for pool_id in await repo.pools_to_watch(db):
        try:
            pool = await repo.get_pool(db, pool_id, for_update=True, skip_locked=True)
            if pool is None:
                await db.rollback()
                continue
            change = _Change(pool=pool, now=now or utcnow())
            if await _reconcile(db, change):
                await _announce_done(db, change)
                await _emit(db, pool.id)
                await db.commit()
                changed += 1
            else:
                await db.rollback()
        except Exception:
            await db.rollback()
            log.exception("reservation pool %s: the worker failed", pool_id)
    return changed
