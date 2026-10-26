"""備品の知らせと見守り (equipment notices and watches, L3 = M169, docs/LENDING.md §6.7, §8).

A notice is an activity item of kind lending (`lending_notices`), one per person and key (§8.2's
table), written with a `lending.notice` event (the push, PushPlanner.handle_lending) in the
change's own transaction: nothing is sent after the commit. The text is written in the reader's
language (M115, app/i18n/messages.json "lending.*"); names and other typed values cannot call
anyone (escape_text).

- Borrowing an item that needs permission tells the teacher named (a to-do, `permission:<loan>`,
  done once they decide, or 14 days after the return); the borrower's own watch on it goes.
- The teacher's 「許可していない」 tells the borrower and the keepers (`denied:<loan>`).
- Returning tells the keepers when there was an issue, the borrower when a keeper recorded it,
  and everyone watching the item (their watches go). A keeper's new due date tells the borrower.
- The worker's `tick` (the scheduled loop, every 15 s) writes the morning reminders from the
  workspace's `notice_minute` on: the borrower the day before, on the due date and every morning
  after (no cap); the keepers one summary a morning of what `keeper_attention_count` counts. The
  keys hold today's date only, so after a downtime only today's reminder goes out.

The keepers are the active people on `keeper_ids`; with none, the administrators (§3.1). The actor
of a change is never told of their own act. This module does not import service.py (service.py
calls it for an item back from repair)."""

import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import (
    ColumnElement,
    String,
    and_,
    cast,
    delete,
    exists,
    func,
    literal,
    not_,
    or_,
    select,
    update,
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app import i18n
from app.core.errors import conflict, not_found
from app.core.roles import PERSON_ROLES, roles_with
from app.core.time import utcnow
from app.events.outbox import write_outbox
from app.modules.activity.events import ACTIVITY_UPDATED, ActivityUpdatedData
from app.modules.activity.models import item_read
from app.modules.lending import access
from app.modules.lending.events import LENDING_NOTICE, LendingNoticeData
from app.modules.lending.models import (
    LendingItem,
    LendingItemEvent,
    LendingLoan,
    LendingNotice,
    LendingSettings,
    LendingWatch,
)
from app.modules.lending.schemas import APPROVER_DAYS_AFTER_RETURN
from app.modules.users.models import User
from app.modules.workflows.render import escape_text

log = logging.getLogger(__name__)

# The worker takes this many loans per tick (the rest the next tick, 15 s later).
TICK_BATCH = 100
# The keepers' summary names this many loans, then 「ほか N 件」.
DIGEST_NAMES = 10
# A return note quoted in the keepers' notice, at most.
QUOTE_MAX = 200


# --- the change being made ------------------------------------------------------------------


@dataclass
class Change:
    now: datetime
    actor_id: uuid.UUID | None = None
    people: dict[uuid.UUID, User] = field(default_factory=dict)
    # Activity items marked done, per person (activity.updated before the commit).
    done: dict[uuid.UUID, list[uuid.UUID]] = field(default_factory=dict)

    async def person(self, db: AsyncSession, user_id: uuid.UUID | None) -> User | None:
        if user_id is None:
            return None
        if user_id not in self.people:
            found = await db.get(User, user_id)
            if found is None:
                return None
            self.people[user_id] = found
        return self.people[user_id]


def change_for(actor: User | None, now: datetime | None = None) -> Change:
    return Change(now=now or utcnow(), actor_id=actor.id if actor is not None else None)


# --- texts (§8.2) -----------------------------------------------------------------------------


def _who(person: User | None, lc: str) -> str:
    if person is None:
        return i18n.t("lending.unknown", lc)
    return i18n.t("lending.who", lc, name=escape_text(person.display_name))


def _item(item: LendingItem, lc: str) -> str:
    name = escape_text(item.name)
    if item.code:
        return i18n.t("lending.item_code", lc, name=name, code=escape_text(item.code))
    return name


def _date(day: date, lc: str) -> str:
    return i18n.t("lending.date", lc, month=day.month, day=day.day)


def _quote(text: str | None) -> str:
    one_line = " ".join((text or "").split())
    if len(one_line) > QUOTE_MAX:
        one_line = one_line[: QUOTE_MAX - 1] + "…"
    return escape_text(one_line)


Text = Callable[[str], str]


# --- writing one notice -----------------------------------------------------------------------


async def _exists(db: AsyncSession, user_id: uuid.UUID, key: str) -> bool:
    found = await db.scalar(
        select(LendingNotice.id).where(LendingNotice.user_id == user_id, LendingNotice.key == key)
    )
    return found is not None


async def notify(
    db: AsyncSession,
    change: Change,
    user_id: uuid.UUID,
    key: str,
    text: Text,
    *,
    role: str,
    item_id: uuid.UUID | None,
    loan_id: uuid.UUID | None,
) -> LendingNotice | None:
    """One activity item and its `lending.notice` for one person, once per key. Not for the
    actor (they see the page), nor for anyone who is not an active person. Two writers of the
    same key (two workers) meet at the unique (user_id, key): the second writes nothing."""
    if user_id == change.actor_id:
        return None
    person = await change.person(db, user_id)
    if person is None or not access.is_person(person):
        return None
    if await _exists(db, user_id, key):
        return None
    written = text(await i18n.text_locale(db, person))
    row = LendingNotice(
        user_id=user_id,
        item_id=item_id,
        loan_id=loan_id,
        key=key,
        role=role,
        text=written,
        at=change.now,
    )
    try:
        async with db.begin_nested():
            db.add(row)
            await db.flush()
    except IntegrityError:
        return None
    await write_outbox(
        db,
        event_type=LENDING_NOTICE,
        audience_type="user",
        audience_id=user_id,
        payload=LendingNoticeData(
            item_id=row.id,
            lending_item_id=item_id,
            loan_id=loan_id,
            role=role,  # type: ignore[arg-type]
            text=written,
            at=change.now,
        ).model_dump(mode="json"),
    )
    return row


async def announce_done(db: AsyncSession, change: Change) -> None:
    """activity.updated to whoever had items marked done (their badge and rows)."""
    for user_id, item_ids in change.done.items():
        await write_outbox(
            db,
            event_type=ACTIVITY_UPDATED,
            audience_type="user",
            audience_id=user_id,
            payload=ActivityUpdatedData(item_ids=sorted(item_ids)).model_dump(mode="json"),
        )
    change.done.clear()


async def keeper_ids(db: AsyncSession, settings: LendingSettings) -> list[uuid.UUID]:
    """Who the keepers' notices go to: the active people on keeper_ids (in their order); with
    none, the administrators (holders of lending.manage, §3.1)."""
    if settings.keeper_ids:
        rows = await db.execute(select(User).where(User.id.in_(settings.keeper_ids)))
        found = {u.id: u for u in rows.scalars().all()}
        able = [i for i in settings.keeper_ids if i in found and access.is_person(found[i])]
        if able:
            return able
    admins = await db.execute(
        select(User.id)
        .where(User.role.in_(roles_with("lending.manage")), User.deactivated_at.is_(None))
        .order_by(User.created_at, User.id)
    )
    return list(admins.scalars().all())


async def _notify_keepers(
    db: AsyncSession,
    change: Change,
    settings: LendingSettings,
    key: str,
    text: Text,
    *,
    item_id: uuid.UUID | None,
    loan_id: uuid.UUID | None,
) -> int:
    told = 0
    for uid in await keeper_ids(db, settings):
        row = await notify(
            db, change, uid, key, text, role="keeper", item_id=item_id, loan_id=loan_id
        )
        told += row is not None
    return told


async def _settings(db: AsyncSession) -> LendingSettings | None:
    return await db.get(LendingSettings, True, populate_existing=True)


# --- hooks into the loans' changes (§6.3-§6.6) ------------------------------------------------


async def on_borrow(
    db: AsyncSession, actor: User, item: LendingItem, loan: LendingLoan, change: Change
) -> None:
    """My watch on the item goes; the teacher I named gets the to-do."""
    await db.execute(
        delete(LendingWatch).where(
            LendingWatch.item_id == item.id, LendingWatch.user_id == actor.id
        )
    )
    if loan.permission_state != "claimed" or loan.approver_id is None:
        return
    who = await change.person(db, loan.borrower_id)

    def text(lc: str) -> str:
        return i18n.t(
            "lending.permission",
            lc,
            who=_who(who, lc),
            item=_item(item, lc),
            due=_date(loan.due_on, lc),
            purpose=_quote(loan.purpose),
        )

    await notify(
        db,
        change,
        loan.approver_id,
        f"permission:{loan.id}",
        text,
        role="approver",
        item_id=item.id,
        loan_id=loan.id,
    )


async def _tell_watchers(
    db: AsyncSession,
    change: Change,
    item: LendingItem,
    key: str,
    message: str,
    loan_id: uuid.UUID | None,
) -> None:
    rows = await db.execute(select(LendingWatch.user_id).where(LendingWatch.item_id == item.id))
    for uid in rows.scalars().all():
        await notify(
            db,
            change,
            uid,
            key,
            lambda lc: i18n.t(message, lc, item=_item(item, lc)),
            role="watcher",
            item_id=item.id,
            loan_id=loan_id,
        )
    await db.execute(delete(LendingWatch).where(LendingWatch.item_id == item.id))


async def on_return(
    db: AsyncSession,
    actor: User,
    item: LendingItem,
    loan: LendingLoan,
    settings: LendingSettings,
    change: Change,
) -> None:
    """An issue → the keepers; a keeper recorded it → the borrower; the watchers → told once,
    their watches go. The teacher's open to-do stays until they decide or 14 days pass (§8.2)."""
    borrower = await change.person(db, loan.borrower_id)
    by = await change.person(db, actor.id)
    if loan.return_condition == "issue":

        def issue(lc: str) -> str:
            return i18n.t(
                "lending.issue",
                lc,
                who=_who(borrower, lc),
                item=_item(item, lc),
                note=_quote(loan.return_note),
            )

        await _notify_keepers(
            db, change, settings, f"issue:{loan.id}", issue, item_id=item.id, loan_id=loan.id
        )
    if actor.id != loan.borrower_id:

        def recorded(lc: str) -> str:
            return i18n.t(
                "lending.returned_by_keeper", lc, keeper=_who(by, lc), item=_item(item, lc)
            )

        await notify(
            db,
            change,
            loan.borrower_id,
            f"returned_by_keeper:{loan.id}",
            recorded,
            role="borrower",
            item_id=item.id,
            loan_id=loan.id,
        )
    await _tell_watchers(
        db, change, item, f"watch:{item.id}:{loan.id}", "lending.watch.returned", loan.id
    )


async def on_due_changed(
    db: AsyncSession, actor: User, item: LendingItem, loan: LendingLoan, change: Change
) -> None:
    """A keeper moved someone's due date: the borrower hears of it."""
    by = await change.person(db, actor.id)

    def text(lc: str) -> str:
        return i18n.t(
            "lending.due_changed",
            lc,
            keeper=_who(by, lc),
            item=_item(item, lc),
            due=_date(loan.due_on, lc),
        )

    await notify(
        db,
        change,
        loan.borrower_id,
        f"due_changed:{loan.id}:{loan.due_on.isoformat()}",
        text,
        role="borrower",
        item_id=item.id,
        loan_id=loan.id,
    )


async def on_repaired(
    db: AsyncSession, actor: User, item: LendingItem, event_id: uuid.UUID
) -> None:
    """In repair → available: the watchers are told and their watches go (§6.7)."""
    change = change_for(actor)
    await _tell_watchers(
        db, change, item, f"watch:{item.id}:repair:{event_id}", "lending.watch.repaired", None
    )


async def on_decision(
    db: AsyncSession,
    actor: User,
    item: LendingItem,
    loan: LendingLoan,
    settings: LendingSettings,
    change: Change,
) -> None:
    """The teacher decided: their to-do is done; a denial tells the borrower and the keepers."""
    rows = await db.execute(
        select(LendingNotice).where(
            LendingNotice.loan_id == loan.id,
            LendingNotice.role == "approver",
            LendingNotice.done_at.is_(None),
        )
    )
    for row in rows.scalars().all():
        row.done_at, row.done_by = change.now, actor.id
        change.done.setdefault(row.user_id, []).append(row.id)
    if loan.permission_state != "denied":
        return
    borrower = await change.person(db, loan.borrower_id)
    teacher = await change.person(db, actor.id)
    note = loan.permission_note

    def to_borrower(lc: str) -> str:
        text = i18n.t("lending.denied.borrower", lc, who=_who(teacher, lc), item=_item(item, lc))
        return f"{text} {i18n.t('lending.note', lc, note=_quote(note))}" if note else text

    def to_keepers(lc: str) -> str:
        return i18n.t(
            "lending.denied.keeper",
            lc,
            borrower=_who(borrower, lc),
            approver=_who(teacher, lc),
            item=_item(item, lc),
            due=_date(loan.due_on, lc),
        )

    key = f"denied:{loan.id}"
    await notify(
        db,
        change,
        loan.borrower_id,
        key,
        to_borrower,
        role="borrower",
        item_id=item.id,
        loan_id=loan.id,
    )
    await _notify_keepers(db, change, settings, key, to_keepers, item_id=item.id, loan_id=loan.id)


# --- watches (§6.7) ---------------------------------------------------------------------------


async def watch(
    db: AsyncSession, actor: User, settings: LendingSettings, item_id: uuid.UUID
) -> None:
    """Idempotent. An item that is not retired; while it is available the watch waits for its
    next return (my own goes when I borrow it)."""
    item = await db.get(LendingItem, item_id)
    if item is None:
        raise not_found("lending_item_not_found", "No such item")
    if item.status == "retired":
        raise conflict("lending_item_unavailable", "The item is retired", {"status": item.status})
    already = await db.get(LendingWatch, (item.id, actor.id))
    if already is None:
        try:
            async with db.begin_nested():
                db.add(LendingWatch(item_id=item.id, user_id=actor.id, created_at=utcnow()))
                await db.flush()
        except IntegrityError:
            pass  # the same request twice at once: watched either way
    await db.commit()


async def unwatch(db: AsyncSession, actor: User, item_id: uuid.UUID) -> None:
    """Idempotent."""
    if await db.get(LendingItem, item_id) is None:
        raise not_found("lending_item_not_found", "No such item")
    await db.execute(
        delete(LendingWatch).where(
            LendingWatch.item_id == item_id, LendingWatch.user_id == actor.id
        )
    )
    await db.commit()


async def watched(
    db: AsyncSession, user_id: uuid.UUID, item_ids: list[uuid.UUID]
) -> set[uuid.UUID]:
    if not item_ids:
        return set()
    rows = await db.execute(
        select(LendingWatch.item_id).where(
            LendingWatch.user_id == user_id, LendingWatch.item_id.in_(item_ids)
        )
    )
    return set(rows.scalars().all())


async def watcher_count(db: AsyncSession, item_id: uuid.UUID) -> int:
    return (
        await db.scalar(
            select(func.count()).select_from(LendingWatch).where(LendingWatch.item_id == item_id)
        )
        or 0
    )


# --- the worker (§8.4) ------------------------------------------------------------------------


def _morning(settings: LendingSettings, today: date) -> datetime:
    zone = ZoneInfo(settings.tz)
    return datetime.combine(today, time(), zone) + timedelta(minutes=settings.notice_minute)


def _due_key() -> ColumnElement[str]:
    """due:<loan>:<due_on>: in SQL (the days, today - due_on, follow per query)."""
    return func.concat(
        "due:",
        cast(LendingLoan.id, String),
        ":",
        func.to_char(LendingLoan.due_on, "YYYY-MM-DD"),
        ":",
    )


def _due_text(item: LendingItem, loan: LendingLoan, days: int) -> Text:
    def text(lc: str) -> str:
        if days < 0:
            return i18n.t(
                "lending.due.before", lc, item=_item(item, lc), due=_date(loan.due_on, lc)
            )
        if days == 0:
            return i18n.t("lending.due.today", lc, item=_item(item, lc))
        return i18n.t(
            "lending.due.overdue", lc, item=_item(item, lc), due=_date(loan.due_on, lc), days=days
        )

    return text


async def _remind_borrowers(
    db: AsyncSession, settings: LendingSettings, now: datetime, today: date
) -> int:
    """The borrowers' reminders of today (the day before, the due date, every morning after) not
    written yet. A loan borrowed, or given its due date, after this morning's time waits for
    tomorrow (they have just chosen the date)."""
    morning = _morning(settings, today)
    days = literal(today) - LendingLoan.due_on
    key = func.concat(_due_key(), cast(days, String))
    moved_today = exists().where(
        LendingItemEvent.loan_id == LendingLoan.id,
        LendingItemEvent.kind.in_(("extended", "due_changed")),
        LendingItemEvent.at >= morning,
    )
    told = exists().where(
        LendingNotice.user_id == LendingLoan.borrower_id, LendingNotice.key == key
    )
    rows = await db.execute(
        select(LendingLoan.id)
        .join(User, User.id == LendingLoan.borrower_id)
        .where(
            LendingLoan.status == "active",
            LendingLoan.due_on <= today + timedelta(days=1),
            LendingLoan.borrowed_at < morning,
            User.deactivated_at.is_(None),
            User.role.in_(PERSON_ROLES),
            not_(moved_today),
            not_(told),
        )
        .order_by(LendingLoan.due_on, LendingLoan.id)
        .limit(TICK_BATCH)
    )
    candidates = list(rows.scalars().all())
    await db.rollback()
    written = 0
    for loan_id in candidates:
        try:
            loan = (
                await db.execute(
                    select(LendingLoan)
                    .where(LendingLoan.id == loan_id, LendingLoan.status == "active")
                    .with_for_update(skip_locked=True)
                    .execution_options(populate_existing=True)
                )
            ).scalar_one_or_none()
            if loan is None:  # returned meanwhile, or someone is changing it: next tick
                await db.rollback()
                continue
            item = await db.get(LendingItem, loan.item_id)
            assert item is not None
            n = today.toordinal() - loan.due_on.toordinal()
            if n < -1:  # extended since the query
                await db.rollback()
                continue
            row = await notify(
                db,
                Change(now=now),
                loan.borrower_id,
                f"due:{loan.id}:{loan.due_on.isoformat()}:{n}",
                _due_text(item, loan, n),
                role="borrower",
                item_id=item.id,
                loan_id=loan.id,
            )
            await db.commit()
            written += row is not None
        except Exception:
            await db.rollback()
            log.exception("lending loan %s: the reminder failed", loan_id)
    return written


async def attention_loans(
    db: AsyncSession, settings: LendingSettings, today: date
) -> list[tuple[LendingLoan, User]]:
    """What the keepers' summary lists and `keeper_attention_count` counts: the active loans at
    least keeper_overdue_days past due, and those of deactivated borrowers; longest overdue
    first."""
    cutoff = today - timedelta(days=settings.keeper_overdue_days)
    rows = await db.execute(
        select(LendingLoan, User)
        .join(User, User.id == LendingLoan.borrower_id)
        .where(
            LendingLoan.status == "active",
            or_(LendingLoan.due_on <= cutoff, User.deactivated_at.is_not(None)),
        )
        .order_by(LendingLoan.due_on, LendingLoan.id)
    )
    return [(loan, user) for loan, user in rows.all()]


async def _digest(db: AsyncSession, settings: LendingSettings, now: datetime, today: date) -> int:
    """One summary a morning to each keeper (the administrators without any) who has not had
    today's, while something needs them."""
    listed = await attention_loans(db, settings, today)
    if not listed:
        return 0
    key = f"overdue:{today.isoformat()}"
    recipients = await keeper_ids(db, settings)
    told_rows = await db.execute(
        select(LendingNotice.user_id).where(
            LendingNotice.key == key, LendingNotice.user_id.in_(recipients)
        )
    )
    told = set(told_rows.scalars().all())
    pending = [uid for uid in recipients if uid not in told]
    if not pending:
        return 0
    items = {
        i.id: i
        for i in (
            await db.execute(
                select(LendingItem).where(LendingItem.id.in_({loan.item_id for loan, _ in listed}))
            )
        )
        .scalars()
        .all()
    }
    threshold = settings.keeper_overdue_days
    mixed = any(not user.is_active for _, user in listed)

    def text(lc: str) -> str:
        entries = []
        for loan, user in listed[:DIGEST_NAMES]:
            days = max(0, today.toordinal() - loan.due_on.toordinal())
            item = _item(items[loan.item_id], lc)
            who = _who(user, lc)
            if user.is_active:
                entries.append(i18n.t("lending.overdue.entry", lc, who=who, item=item, days=days))
            elif days > 0:
                entries.append(
                    i18n.t("lending.overdue.entry_inactive_days", lc, who=who, item=item, days=days)
                )
            else:
                entries.append(i18n.t("lending.overdue.entry_inactive", lc, who=who, item=item))
        if len(listed) > DIGEST_NAMES:
            entries.append(i18n.t("lending.overdue.more", lc, count=len(listed) - DIGEST_NAMES))
        names = i18n.t("lending.list_sep", lc).join(entries)
        if mixed:
            return i18n.t("lending.overdue.digest_mixed", lc, count=len(listed), list=names)
        return i18n.t(
            "lending.overdue.digest", lc, count=len(listed), threshold=threshold, list=names
        )

    change = Change(now=now)
    written = 0
    for uid in pending:
        row = await notify(db, change, uid, key, text, role="keeper", item_id=None, loan_id=None)
        written += row is not None
    await db.commit()
    return written


async def _close_todos(db: AsyncSession, now: datetime) -> int:
    """The teachers' to-dos of loans returned more than 14 days ago are done (nobody did them)."""
    since = now - timedelta(days=APPROVER_DAYS_AFTER_RETURN)
    rows = await db.execute(
        update(LendingNotice)
        .where(
            LendingNotice.role == "approver",
            LendingNotice.done_at.is_(None),
            LendingNotice.loan_id.in_(
                select(LendingLoan.id).where(
                    LendingLoan.status == "returned", LendingLoan.returned_at < since
                )
            ),
        )
        .values(done_at=now)
        .returning(LendingNotice.id, LendingNotice.user_id)
        .execution_options(synchronize_session=False)
    )
    change = Change(now=now)
    for item_id, user_id in rows.all():
        change.done.setdefault(user_id, []).append(item_id)
    if not change.done:
        await db.rollback()
        return 0
    closed = sum(len(v) for v in change.done.values())
    await announce_done(db, change)
    await db.commit()
    return closed


async def tick(db: AsyncSession, *, now: datetime | None = None) -> int:
    """`lending.tick` (§8.4), in the scheduled loop. Nothing while the feature is off. Before
    this morning's `notice_minute` only the teachers' expired to-dos close; from then on, the
    borrowers' reminders and the keepers' summary of today. Returns how many notices were written
    (and to-dos closed). Each loan is its own transaction; a failure is logged and tried again
    the next tick."""
    now = now or utcnow()
    settings = await _settings(db)
    if not access.is_enabled(settings):
        await db.rollback()
        return 0
    assert settings is not None
    local = now.astimezone(ZoneInfo(settings.tz))
    today = local.date()
    morning = local.hour * 60 + local.minute >= settings.notice_minute
    done = 0
    try:
        done += await _close_todos(db, now)
    except Exception:
        await db.rollback()
        log.exception("lending: closing the teachers' to-dos failed")
    if not morning:
        await db.rollback()
        return done
    settings = await _settings(db)
    if not access.is_enabled(settings):
        await db.rollback()
        return done
    assert settings is not None
    done += await _remind_borrowers(db, settings, now, today)
    try:
        settings = await _settings(db)
        if access.is_enabled(settings):
            assert settings is not None
            done += await _digest(db, settings, now, today)
    except Exception:
        await db.rollback()
        log.exception("lending: the keepers' summary failed")
    await db.rollback()
    return done


# --- reading (the activity list, the badge, the push) ---------------------------------------


async def reader_scope(db: AsyncSession, actor: User) -> bool | None:
    """None: the reader sees no lending items (a guest, a bot, or the feature off). Else whether
    the keepers' notices are theirs to read now (names, items and overdue days of others)."""
    settings = await _settings(db)
    if not access.may_see_ledger(actor, settings):
        return None
    return access.can_keep(actor, settings)


def readable(user_id: uuid.UUID, keeper: bool):  # type: ignore[no-untyped-def]
    clause = LendingNotice.user_id == user_id
    if not keeper:
        clause = and_(clause, LendingNotice.role != "keeper")
    return clause


async def notices_for(
    db: AsyncSession, actor: User, *, before: datetime | None, limit: int
) -> list[tuple[LendingNotice, str | None]]:
    """The activity items of kind lending, newest first, with the item's name now."""
    keeper = await reader_scope(db, actor)
    if keeper is None:
        return []
    stmt = (
        select(LendingNotice, LendingItem.name)
        .outerjoin(LendingItem, LendingItem.id == LendingNotice.item_id)
        .where(readable(actor.id, keeper))
        .order_by(LendingNotice.at.desc(), LendingNotice.id.desc())
        .limit(limit)
    )
    if before is not None:
        stmt = stmt.where(LendingNotice.at < before)
    return [(row[0], row[1]) for row in (await db.execute(stmt)).all()]


def unread_notices(user_id: uuid.UUID, since: datetime, keeper: bool):  # type: ignore[no-untyped-def]
    """Not done, after the read position, not opened (2026-10-07), readable now."""

    return select(LendingNotice.id).where(
        readable(user_id, keeper),
        LendingNotice.at > since,
        LendingNotice.done_at.is_(None),
        ~item_read(user_id, LendingNotice.id, LendingNotice.at),
    )
