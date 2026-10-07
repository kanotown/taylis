"""The state of what the 操作ボタン operate (M143, docs/ACTIONS.md §12).

One button per group may provide the group's state: Taylis asks its relay with a signed
`action.status` request (the same signing and sender as a press) and shows the answer to everyone
who may press something in the group. Reading a state never operates anything, so it is cached
(ACTION_STATUS_CACHE_SECONDS, per process) and asked once at a time per button however many people
look; a refresh skips the cache (rate-limited per person by the router). A few seconds after a
successful press the group's state is asked again and sent to its viewers
(`actions.status_updated`).

Status requests are not presses: no `action_invocations` row and no audit; a failure is logged at
warning level.
"""

import asyncio
import json
import logging
import time
import unicodedata
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.roles import PERSON_ROLES
from app.core.settings import Settings
from app.core.time import utcnow
from app.events.envelope import Audience
from app.events.models import OutboxEvent
from app.events.outbox import AudienceResolver, write_outbox
from app.modules.actions import service
from app.modules.actions.models import Action
from app.modules.actions.schemas import (
    STATUS_DETAIL_LABEL_MAX,
    STATUS_DETAIL_VALUE_MAX,
    STATUS_DETAILS_MAX,
    STATUS_TEXT_MAX,
    ActionStatusDetail,
    ActionStatusListOut,
    ActionStatusOut,
    ActionStatusUpdatedData,
    ActionStatusValue,
)
from app.modules.groups.models import UserGroupMember
from app.modules.outbound import signed
from app.modules.users.models import User
from app.modules.workspace import service as workspace

log = logging.getLogger("app.actions.status")

EVENT_STATUS = "action.status"
ACTIONS_STATUS_UPDATED = "actions.status_updated"
# The outbox audience of a group's state: who may press something in it (audience_id: the status
# button).
AUDIENCE_TYPE: Final = "action"
TONES = ("ok", "warn", "alert", "neutral")
_STATE_CHARS = set("abcdefghijklmnopqrstuvwxyz0123456789_-")


# --- the relay's answer --------------------------------------------------------------------


def _plain(raw: Any, limit: int) -> str | None:
    """A string as one line of plain text (control characters out, spaces collapsed), cut."""
    if not isinstance(raw, str):
        return None
    kept = "".join(
        " " if unicodedata.category(ch) in ("Cc", "Cf", "Zl", "Zp") else ch for ch in raw
    )
    return " ".join(kept.split())[:limit] or None


def _state(raw: Any) -> str | None:
    if not isinstance(raw, str):
        return None
    word = raw.strip().lower()
    if not word or len(word) > 32 or not set(word) <= _STATE_CHARS or word[0] in "_-":
        return None
    return word


def parse_status(raw: Any) -> ActionStatusValue | None:
    """`{"text", "tone", "state"?, "details"?}` cleaned, or None without a usable text. An
    unknown tone reads as neutral; details past the sixth, or without a label or value, are
    dropped."""
    if not isinstance(raw, dict):
        return None
    text = _plain(raw.get("text"), STATUS_TEXT_MAX)
    if text is None:
        return None
    tone = raw.get("tone")
    details: list[ActionStatusDetail] = []
    if isinstance(raw.get("details"), list):
        for item in raw["details"]:
            if len(details) >= STATUS_DETAILS_MAX:
                break
            if not isinstance(item, dict):
                continue
            label = _plain(item.get("label"), STATUS_DETAIL_LABEL_MAX)
            value = _plain(item.get("value"), STATUS_DETAIL_VALUE_MAX)
            if label and value:
                details.append(ActionStatusDetail(label=label, value=value))
    return ActionStatusValue(
        text=text,
        tone=tone if tone in TONES else "neutral",
        state=_state(raw.get("state")),
        details=details,
    )


def _json_of(answer: signed.Answer) -> Any:
    if not answer.body:
        return None
    try:
        return json.loads(answer.text(service.ANSWER_MAX_BYTES))
    except ValueError:
        return None


@dataclass(frozen=True)
class Source:
    """What is needed to ask a status button's relay (read out of the session)."""

    id: uuid.UUID
    group_label: str | None
    action_key: str
    url: str
    secret_name: str

    @classmethod
    def of(cls, row: Action) -> "Source":
        return cls(row.id, row.group_label, row.action_key, row.url, row.secret_name)


def _person(user: User) -> dict[str, Any]:
    return {
        "id": str(user.id),
        "username": user.username,
        "email": user.email,
        "display_name": user.display_name,
        "role": user.role,
    }


def to_status_out(source: Source, answer: signed.Answer, fetched_at: datetime) -> ActionStatusOut:
    data = _json_of(answer)
    if answer.ok:
        value = parse_status(data.get("status")) if isinstance(data, dict) else None
        error = None if value is not None else "invalid_answer"
        message = None
    else:
        value = None
        error = service._error_of(answer)
        message = service.clean_message(data.get("message")) if isinstance(data, dict) else None
    return ActionStatusOut(
        action_id=source.id,
        group_label=source.group_label,
        ok=value is not None,
        status=value,
        error=error,
        message=message,
        fetched_at=fetched_at,
    )


async def ask(
    factory: async_sessionmaker[AsyncSession],
    source: Source,
    person: dict[str, Any],
    settings: Settings,
    post: signed.Poster,
) -> ActionStatusOut:
    """One `action.status` request to the button's relay (bounded as a whole like a press; never
    retried). Not recorded; a failure is logged at warning level."""
    request_id = uuid.uuid4()
    async with factory() as db:
        workspace_id = await workspace.workspace_id(db)
    body = {
        "type": EVENT_STATUS,
        "request_id": str(request_id),
        "action_id": str(source.id),
        "action_key": source.action_key,
        "user": person,
        "workspace": {
            "id": str(workspace_id) if workspace_id else None,
            "name": settings.workspace_display_name,
        },
        "at": service._iso(utcnow()),
    }
    secret = signed.read_secret(settings.action_secrets_dir, source.secret_name)
    if secret is None:
        answer = signed.Answer(None, "secret_missing")
    else:
        payload = signed.body_bytes(body)
        headers = signed.signed_headers(
            EVENT_STATUS, request_id, secret, payload, user_agent=service.USER_AGENT
        )
        try:
            answer = await post(source.url, headers, payload)
        except Exception as exc:  # a bug in sending must not break the page
            log.exception("action %s: asking the state failed", source.id)
            answer = signed.Answer(None, f"network: {type(exc).__name__}")
    out = to_status_out(source, answer, utcnow())
    if not out.ok:
        log.warning(
            "action %s: the state could not be read (%s, HTTP %s)",
            source.id,
            out.error,
            answer.status_code,
        )
    return out


# --- the cache -----------------------------------------------------------------------------


@dataclass
class _Entry:
    out: ActionStatusOut
    expires: float  # time.monotonic()


class StatusCache:
    """Per process: the last answer per status button, the request in flight per button (later
    lookers wait for it instead of asking again), and the background re-reads after presses."""

    def __init__(self) -> None:
        self.entries: dict[uuid.UUID, _Entry] = {}
        self.inflight: dict[uuid.UUID, asyncio.Future[ActionStatusOut]] = {}
        self.background: set[asyncio.Task[None]] = set()

    def fresh(self, action_id: uuid.UUID) -> ActionStatusOut | None:
        entry = self.entries.get(action_id)
        if entry is None or entry.expires <= time.monotonic():
            return None
        return entry.out

    def forget(self, action_id: uuid.UUID | None = None) -> None:
        """One button's answer (or all of them: a button or the switch changed)."""
        if action_id is None:
            self.entries.clear()
        else:
            self.entries.pop(action_id, None)

    async def drain(self) -> None:
        """Waits for the background re-reads (tests; shutdown cancels them instead)."""
        while self.background:
            await asyncio.gather(*list(self.background), return_exceptions=True)

    def cancel(self) -> None:
        for task in list(self.background):
            task.cancel()


def _same(a: ActionStatusOut, b: ActionStatusOut) -> bool:
    return a.ok == b.ok and a.status == b.status


async def fetch(
    cache: StatusCache,
    factory: async_sessionmaker[AsyncSession],
    source: Source,
    person: dict[str, Any],
    settings: Settings,
    post: signed.Poster,
    *,
    refresh: bool = False,
    announce: bool = False,
) -> ActionStatusOut:
    """The group's state: from the cache unless `refresh`; otherwise one request to the relay
    (shared with anyone asking at the same moment). A successful answer is sent to the group's
    viewers when `announce` or when it differs from the last one."""
    if not refresh:
        cached = cache.fresh(source.id)
        if cached is not None:
            return cached
    pending = cache.inflight.get(source.id)
    if pending is not None:
        return await asyncio.shield(pending)
    future: asyncio.Future[ActionStatusOut] = asyncio.get_running_loop().create_future()
    cache.inflight[source.id] = future
    try:
        out = await ask(factory, source, person, settings, post)
        before = cache.entries.get(source.id)
        cache.entries[source.id] = _Entry(
            out, time.monotonic() + settings.action_status_cache_seconds
        )
        changed = before is not None and before.out.ok and not _same(before.out, out)
        if out.ok and (announce or changed):
            await _announce(factory, out)
        future.set_result(out)
        return out
    except BaseException as exc:
        if not future.done():
            if isinstance(exc, asyncio.CancelledError):
                future.cancel()
            else:
                future.set_exception(exc)
                future.exception()  # retrieved: nobody may be waiting
        raise
    finally:
        cache.inflight.pop(source.id, None)


async def _announce(factory: async_sessionmaker[AsyncSession], out: ActionStatusOut) -> None:
    try:
        async with factory() as db:
            await write_outbox(
                db,
                event_type=ACTIONS_STATUS_UPDATED,
                audience_type="action",
                audience_id=out.action_id,
                payload=ActionStatusUpdatedData(**out.model_dump()).model_dump(mode="json"),
            )
            await db.commit()
    except Exception:
        log.exception("action %s: the state could not be sent out", out.action_id)


# --- who sees which state ------------------------------------------------------------------


def _sources_by_group(rows: list[Action]) -> dict[str, tuple[list[Action], Action | None]]:
    """Enabled buttons per group (in order) and the group's enabled status button, if any."""
    groups: dict[str, tuple[list[Action], Action | None]] = {}
    for row in rows:
        if not row.enabled:
            continue
        key = service.group_key(row)
        members, source = groups.get(key, ([], None))
        members.append(row)
        if source is None and row.provides_status:
            source = row
        groups[key] = (members, source)
    return groups


async def visible_sources(db: AsyncSession, user: User) -> list[Source]:
    """The status buttons of the groups I may press something in (none while off, and never for
    guests or bots)."""
    if not await service.is_enabled(db) or not service._is_person(user):
        return []
    my_groups = await service._group_ids_of(db, user.id)
    out: list[Source] = []
    for members, source in _sources_by_group(await service._ordered(db)).values():
        if source is not None and any(service.may_press(user, a, my_groups) for a in members):
            out.append(Source.of(source))
    return out


async def source_for(db: AsyncSession, action_id: uuid.UUID) -> Source | None:
    """The status button of a button's group (enabled; while the feature is on), if any."""
    if not await service.is_enabled(db):
        return None
    action = await db.get(Action, action_id)
    if action is None:
        return None
    key = service.group_key(action)
    for row in await service._ordered(db):
        if row.enabled and row.provides_status and service.group_key(row) == key:
            return Source.of(row)
    return None


async def viewers(db: AsyncSession, source_id: uuid.UUID) -> list[uuid.UUID]:
    """Who may press something in the status button's group (people only)."""
    if not await service.is_enabled(db):
        return []
    rows = await service._ordered(db)
    source = next((r for r in rows if r.id == source_id), None)
    if source is None:
        return []
    key = service.group_key(source)
    members = [r for r in rows if r.enabled and service.group_key(r) == key]
    people = (
        (
            await db.execute(
                select(User).where(User.deactivated_at.is_(None), User.role.in_(PERSON_ROLES))
            )
        )
        .scalars()
        .all()
    )
    memberships: dict[uuid.UUID, set[uuid.UUID]] = {}
    for user_id, group_id in (
        await db.execute(select(UserGroupMember.user_id, UserGroupMember.group_id))
    ).all():
        memberships.setdefault(user_id, set()).add(group_id)
    return [
        p.id
        for p in people
        if any(service.may_press(p, a, memberships.get(p.id, set())) for a in members)
    ]


def audience_resolver(fallback: AudienceResolver) -> AudienceResolver:
    """The relay's resolver: `action` audiences here, everything else as before."""

    async def resolve(db: AsyncSession, event: OutboxEvent) -> Audience:
        if event.audience_type == AUDIENCE_TYPE and event.audience_id is not None:
            return Audience(kind="users", ids=tuple(await viewers(db, event.audience_id)))
        return await fallback(db, event)

    return resolve


# --- the API's work ------------------------------------------------------------------------


async def statuses_for(
    cache: StatusCache,
    factory: async_sessionmaker[AsyncSession],
    user: User,
    settings: Settings,
    post: signed.Poster,
    *,
    refresh: bool = False,
) -> ActionStatusListOut:
    """GET /actions/status: every visible group's state, asked concurrently (each bounded by the
    send's own timeout)."""
    async with factory() as db:
        enabled = await service.is_enabled(db)
        sources = await visible_sources(db, user)
    if not enabled:
        return ActionStatusListOut(enabled=False)
    person = _person(user)
    statuses = await asyncio.gather(
        *(fetch(cache, factory, s, person, settings, post, refresh=refresh) for s in sources)
    )
    return ActionStatusListOut(enabled=True, statuses=list(statuses))


async def check_status(
    factory: async_sessionmaker[AsyncSession],
    actor: User,
    action_id: uuid.UUID,
    settings: Settings,
    post: signed.Poster,
) -> ActionStatusOut:
    """「状態を確認」 in the admin form: an `action.status` for this button now, whether or not it
    provides its group's state, the button is on or the feature is (not cached)."""
    async with factory() as db:
        source = Source.of(await service._action(db, action_id))
    return await ask(factory, source, _person(actor), settings, post)


def after_press(
    cache: StatusCache,
    factory: async_sessionmaker[AsyncSession],
    source: Source,
    user: User,
    settings: Settings,
    post: signed.Poster,
) -> None:
    """After a successful press: forget the group's state now, ask again a few seconds later (a
    lock's motor takes a moment) and send the answer to the group's viewers."""
    cache.forget(source.id)
    person = _person(user)

    async def later() -> None:
        try:
            await asyncio.sleep(settings.action_status_after_invoke_seconds)
            await fetch(cache, factory, source, person, settings, post, refresh=True, announce=True)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("action %s: reading the state after a press failed", source.id)

    task = asyncio.create_task(later(), name=f"action-status-{source.id}")
    cache.background.add(task)
    task.add_done_callback(cache.background.discard)
