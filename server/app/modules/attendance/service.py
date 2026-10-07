"""在室状況 (attendance, M140, docs/PRESENCE.md): who is where.

One row per person (attendance_current) with an appended log; the states are the workspace's
(administrators) and personal ones (people the rule allows). Every change writes the row, the log
and an `attendance.updated` outbox event in one transaction; the webhook planner (webhooks.py)
turns that event into deliveries. Guests and bots are never on the board and never see it.
"""

import hashlib
import secrets
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app import i18n
from app.core.errors import AppError, bad_request, conflict, forbidden, not_found, unauthorized
from app.core.security import hash_token
from app.core.settings import Settings
from app.core.time import utcnow
from app.events.outbox import write_outbox
from app.modules.attendance.events import ATTENDANCE_CONFIG_UPDATED, ATTENDANCE_UPDATED
from app.modules.attendance.models import (
    AttendanceCurrent,
    AttendanceDelivery,
    AttendanceIntegration,
    AttendanceLog,
    AttendanceSettings,
    AttendanceState,
)
from app.modules.attendance.schemas import (
    AttendanceAdminSettingsOut,
    AttendanceBoardOut,
    AttendanceConfigUpdatedData,
    AttendanceEntryOut,
    AttendanceInbound,
    AttendanceInboundOut,
    AttendanceIntegrationCreate,
    AttendanceIntegrationCreated,
    AttendanceIntegrationOut,
    AttendanceIntegrationUpdate,
    AttendanceLogPage,
    AttendanceSet,
    AttendanceSettingsUpdate,
    AttendanceStateCreate,
    AttendanceStateOrder,
    AttendanceStateOut,
    AttendanceStateUpdate,
    AttendanceTokenOut,
    AttendanceUpdatedData,
    Kind,
    to_entry_out,
    to_integration_out,
    to_log_out,
    to_state_out,
)
from app.modules.audit import service as audit
from app.modules.groups.models import UserGroup, UserGroupMember
from app.modules.link_previews.fetcher import UrlNotAllowed, check_url_shape
from app.modules.users.models import User

MAX_WORKSPACE_STATES = 20
MAX_PERSONAL_STATES = 10
KIND_ORDER: tuple[Kind, ...] = ("in_room", "on_site", "off_site", "gone")
# The states made when the board is first enabled (docs/PRESENCE.md §1): kind, emoji, colour.
DEFAULT_STATES: tuple[tuple[Kind, str, str], ...] = (
    ("in_room", "🟢", "green"),
    ("on_site", "🏫", "blue"),
    ("off_site", "🚶", "orange"),
    ("gone", "🏠", "gray"),
)
# How far back an outside system may date a change (docs/PRESENCE.md §6).
INBOUND_MAX_AGE = timedelta(hours=24)


# --- settings ------------------------------------------------------------------------------


async def _settings_row(db: AsyncSession, *, for_update: bool = False) -> AttendanceSettings | None:
    stmt = select(AttendanceSettings)
    if for_update:
        stmt = stmt.with_for_update()
    return (await db.execute(stmt)).scalar_one_or_none()


async def is_enabled(db: AsyncSession) -> bool:
    row = await _settings_row(db)
    return row is not None and row.enabled


async def _require_enabled(db: AsyncSession) -> AttendanceSettings:
    row = await _settings_row(db)
    if row is None or not row.enabled:
        raise conflict("attendance_disabled", "The attendance board is turned off")
    return row


def _on_board(user: User) -> bool:
    """Who has a place on the board (and may see it): active people, not guests, not bots."""
    return user.is_active and user.role in ("admin", "member")


def _require_board_user(user: User) -> None:
    if user.is_guest:
        raise forbidden("guest_restricted", "Guests cannot use the attendance board")
    if not _on_board(user):
        raise forbidden("forbidden", "Forbidden")


async def _group_ids_of(db: AsyncSession, user_id: uuid.UUID) -> set[uuid.UUID]:
    rows = await db.execute(
        select(UserGroupMember.group_id).where(UserGroupMember.user_id == user_id)
    )
    return set(rows.scalars().all())


async def can_personalize(
    db: AsyncSession, user: User, row: AttendanceSettings | None = None
) -> bool:
    row = row if row is not None else await _settings_row(db)
    if row is None or not _on_board(user):
        return False
    if row.personal_rule == "everyone":
        return True
    if row.personal_rule == "admins":
        return user.is_admin
    if row.personal_rule == "groups":
        return bool(set(row.personal_group_ids) & await _group_ids_of(db, user.id))
    return False


async def _config_changed(db: AsyncSession) -> None:
    await write_outbox(
        db,
        event_type=ATTENDANCE_CONFIG_UPDATED,
        audience_type="all",
        payload=AttendanceConfigUpdatedData().model_dump(mode="json"),
    )


# --- states --------------------------------------------------------------------------------


async def workspace_states(db: AsyncSession) -> list[AttendanceState]:
    stmt = (
        select(AttendanceState)
        .where(AttendanceState.owner_id.is_(None), AttendanceState.archived_at.is_(None))
        .order_by(AttendanceState.position, AttendanceState.created_at)
    )
    return list((await db.execute(stmt)).scalars().all())


async def _personal_states(db: AsyncSession, owner_id: uuid.UUID) -> list[AttendanceState]:
    stmt = (
        select(AttendanceState)
        .where(AttendanceState.owner_id == owner_id, AttendanceState.archived_at.is_(None))
        .order_by(AttendanceState.position, AttendanceState.created_at)
    )
    return list((await db.execute(stmt)).scalars().all())


async def _state(db: AsyncSession, state_id: uuid.UUID) -> AttendanceState | None:
    return await db.get(AttendanceState, state_id)


def _same_label(a: str, b: str) -> bool:
    return a.casefold() == b.casefold()


async def _seed_defaults(db: AsyncSession, locale: str | None) -> None:
    now = utcnow()
    for position, (kind, emoji, color) in enumerate(DEFAULT_STATES):
        db.add(
            AttendanceState(
                owner_id=None,
                label=i18n.t(f"attendance.default.{kind}", locale),
                emoji=emoji,
                color=color,
                kind=kind,
                position=position,
                created_at=now,
                updated_at=now,
            )
        )
    await db.flush()


# --- the board -----------------------------------------------------------------------------


async def _board_users(db: AsyncSession) -> dict[uuid.UUID, User]:
    rows = await db.execute(
        select(User).where(User.role.in_(("admin", "member")), User.deactivated_at.is_(None))
    )
    return {u.id: u for u in rows.scalars().all()}


async def board(db: AsyncSession, actor: User) -> AttendanceBoardOut:
    """GET /attendance (docs/PRESENCE.md §3.1). 403 for guests; `enabled: false` while off."""
    _require_board_user(actor)
    row = await _settings_row(db)
    if row is None or not row.enabled:
        return AttendanceBoardOut(enabled=False)
    people = await _board_users(db)
    entries = [
        c
        for c in (await db.execute(select(AttendanceCurrent))).scalars().all()
        if c.user_id in people
    ]
    in_use = {c.state_id for c in entries}
    states = (
        (
            await db.execute(
                select(AttendanceState).order_by(
                    AttendanceState.owner_id.is_not(None),
                    AttendanceState.owner_id,
                    AttendanceState.position,
                    AttendanceState.created_at,
                )
            )
        )
        .scalars()
        .all()
    )
    shown = [
        s
        for s in states
        if (s.owner_id is None or s.owner_id in people)
        and (s.archived_at is None or s.id in in_use)
    ]
    return AttendanceBoardOut(
        enabled=True,
        states=[to_state_out(s) for s in shown],
        entries=[to_entry_out(c) for c in sorted(entries, key=lambda c: c.since)],
        can_personalize=await can_personalize(db, actor, row),
    )


async def bootstrap(db: AsyncSession, actor: User) -> AttendanceBoardOut | None:
    """The bootstrap's `attendance`: null for guests (and bots) and while the board is off."""
    if not _on_board(actor) or not await is_enabled(db):
        return None
    return await board(db, actor)


# --- changing someone's state --------------------------------------------------------------


@dataclass(frozen=True)
class Applied:
    entry: AttendanceEntryOut
    applied: bool
    reason: str | None = None


async def _lock_person(db: AsyncSession, user_id: uuid.UUID) -> None:
    """Serialises the changes of one person (the first row has nothing to lock yet)."""
    key = int.from_bytes(hashlib.sha256(b"attendance:" + user_id.bytes).digest()[:8], "big")
    await db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": key - (1 << 63)})


async def _apply(
    db: AsyncSession,
    *,
    user: User,
    state: AttendanceState,
    note: str | None,
    source: str,
    actor_id: uuid.UUID | None,
    integration_id: uuid.UUID | None = None,
    at: datetime | None = None,
) -> Applied:
    """Sets the state in the caller's transaction (it commits). Unchanged state and note: nothing
    happens. An `at` older than the current since is stale and ignored (docs/PRESENCE.md §6)."""
    await _lock_person(db, user.id)
    now = utcnow()
    current = await db.get(AttendanceCurrent, user.id, with_for_update=True, populate_existing=True)
    if current is not None:
        if current.state_id == state.id and (current.note or None) == (note or None):
            return Applied(to_entry_out(current), applied=False, reason="unchanged")
        if at is not None and at < current.since:
            return Applied(to_entry_out(current), applied=False, reason="stale")
    moment = min(at, now) if at is not None else now
    from_state = current.state_id if current is not None else None
    if current is None:
        current = AttendanceCurrent(
            user_id=user.id,
            state_id=state.id,
            since=moment,
            note=note,
            source=source,
            actor_id=actor_id,
            integration_id=integration_id,
            updated_at=now,
        )
        db.add(current)
    else:
        if current.state_id != state.id:
            current.since = moment
        current.state_id = state.id
        current.note = note
        current.source = source
        current.actor_id = actor_id
        current.integration_id = integration_id
        current.updated_at = now
    log_row = AttendanceLog(
        user_id=user.id,
        from_state_id=from_state,
        to_state_id=state.id,
        note=note,
        at=moment,
        source=source,
        actor_id=actor_id,
        integration_id=integration_id,
    )
    db.add(log_row)
    await db.flush()
    entry = to_entry_out(current)
    await write_outbox(
        db,
        event_type=ATTENDANCE_UPDATED,
        audience_type="all",
        payload=AttendanceUpdatedData(
            user_id=entry.user_id,
            state_id=entry.state_id,
            since=entry.since,
            note=entry.note,
            source=entry.source,
            log_id=log_row.id,
        ).model_dump(mode="json"),
    )
    return Applied(entry, applied=True)


def _usable_by(state: AttendanceState | None, user_id: uuid.UUID) -> bool:
    return (
        state is not None
        and state.archived_at is None
        and (state.owner_id is None or state.owner_id == user_id)
    )


async def set_mine(db: AsyncSession, actor: User, data: AttendanceSet) -> AttendanceEntryOut:
    """PUT /attendance/me: my own state (a workspace state or one of mine)."""
    _require_board_user(actor)
    await _require_enabled(db)
    state = await _state(db, data.state_id)
    if not _usable_by(state, actor.id):
        raise AppError(422, "attendance_state_invalid", "This state cannot be chosen")
    assert state is not None
    result = await _apply(
        db, user=actor, state=state, note=data.note, source="app", actor_id=actor.id
    )
    await db.commit()
    return result.entry


async def _board_person(db: AsyncSession, user_id: uuid.UUID) -> User:
    user = await db.get(User, user_id)
    if user is None or not _on_board(user):
        raise not_found("attendance_user_not_found", "No such person on the attendance board")
    return user


async def set_for(
    db: AsyncSession, actor: User, user_id: uuid.UUID, data: AttendanceSet
) -> AttendanceEntryOut:
    """PUT /admin/attendance/users/{id}: an administrator sets someone's state (audited)."""
    await _require_enabled(db)
    user = await _board_person(db, user_id)
    state = await _state(db, data.state_id)
    if not _usable_by(state, user.id):
        raise AppError(422, "attendance_state_invalid", "This state cannot be chosen")
    assert state is not None
    result = await _apply(
        db, user=user, state=state, note=data.note, source="admin", actor_id=actor.id
    )
    if result.applied:
        await audit.record_in_tx(
            db,
            actor_id=actor.id,
            action="attendance.set_by_admin",
            target_type="user",
            target_id=user.id,
            details={"state_id": str(state.id), "label": state.label},
        )
    await db.commit()
    return result.entry


async def log_page(
    db: AsyncSession,
    actor: User,
    user_id: uuid.UUID | None,
    before_id: int | None,
    limit: int,
) -> AttendanceLogPage:
    """Mine for anyone; everyone's (or one other person's) for administrators."""
    _require_board_user(actor)
    if user_id is not None and user_id != actor.id and not actor.is_admin:
        raise forbidden("admin_required", "Administrator role required")
    if user_id is None and not actor.is_admin:
        user_id = actor.id
    stmt = select(AttendanceLog).order_by(AttendanceLog.id.desc()).limit(limit + 1)
    if user_id is not None:
        stmt = stmt.where(AttendanceLog.user_id == user_id)
    if before_id is not None:
        stmt = stmt.where(AttendanceLog.id < before_id)
    rows = list((await db.execute(stmt)).scalars().all())
    more = len(rows) > limit
    rows = rows[:limit]
    return AttendanceLogPage(
        items=[to_log_out(r) for r in rows],
        next_before_id=rows[-1].id if more and rows else None,
    )


# --- personal states -----------------------------------------------------------------------


async def _label_free(
    db: AsyncSession,
    label: str,
    *,
    owner_id: uuid.UUID | None,
    except_id: uuid.UUID | None = None,
) -> None:
    """Workspace labels are unique among the workspace's; a personal label is unique among the
    owner's and must not be a workspace label (the inbound API maps labels)."""
    scopes: list[Sequence[AttendanceState]] = [await workspace_states(db)]
    if owner_id is not None:
        scopes.append(await _personal_states(db, owner_id))
    for scope in scopes:
        for state in scope:
            if state.id != except_id and _same_label(state.label, label):
                raise conflict("attendance_label_taken", "A state with this name exists already")


async def create_mine(
    db: AsyncSession, actor: User, data: AttendanceStateCreate
) -> AttendanceStateOut:
    _require_board_user(actor)
    settings_row = await _require_enabled(db)
    if not await can_personalize(db, actor, settings_row):
        raise forbidden("attendance_personal_not_allowed", "You cannot add your own states")
    await _lock_person(db, actor.id)
    mine = await _personal_states(db, actor.id)
    if len(mine) >= MAX_PERSONAL_STATES:
        raise conflict("attendance_state_limit", "Too many states")
    await _label_free(db, data.label, owner_id=actor.id)
    now = utcnow()
    row = AttendanceState(
        owner_id=actor.id,
        label=data.label,
        emoji=data.emoji,
        color=data.color,
        kind=data.kind,
        position=max((s.position for s in mine), default=-1) + 1,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    await db.flush()
    await _config_changed(db)
    await db.commit()
    return to_state_out(row)


def _apply_update(row: AttendanceState, data: AttendanceStateUpdate) -> None:
    if data.label is not None:
        row.label = data.label
    if "emoji" in data.model_fields_set:
        row.emoji = data.emoji
    if data.color is not None:
        row.color = data.color
    if data.kind is not None:
        row.kind = data.kind
    row.updated_at = utcnow()


async def _my_state(db: AsyncSession, actor: User, state_id: uuid.UUID) -> AttendanceState:
    row = await _state(db, state_id)
    if row is None or row.owner_id != actor.id or row.archived_at is not None:
        raise not_found("attendance_state_not_found", "State not found")
    return row


async def update_mine(
    db: AsyncSession, actor: User, state_id: uuid.UUID, data: AttendanceStateUpdate
) -> AttendanceStateOut:
    _require_board_user(actor)
    settings_row = await _require_enabled(db)
    row = await _my_state(db, actor, state_id)
    if not await can_personalize(db, actor, settings_row):
        raise forbidden("attendance_personal_not_allowed", "You cannot change your own states")
    if data.label is not None:
        await _label_free(db, data.label, owner_id=actor.id, except_id=row.id)
    _apply_update(row, data)
    await _config_changed(db)
    await db.commit()
    return to_state_out(row)


async def delete_mine(db: AsyncSession, actor: User, state_id: uuid.UUID) -> None:
    """Archives it; whoever is in it (only me) stays until the next change."""
    _require_board_user(actor)
    row = await _my_state(db, actor, state_id)
    row.archived_at = utcnow()
    row.updated_at = row.archived_at
    await _config_changed(db)
    await db.commit()


# --- administration ------------------------------------------------------------------------


async def _admin_out(
    db: AsyncSession, row: AttendanceSettings | None
) -> AttendanceAdminSettingsOut:
    return AttendanceAdminSettingsOut(
        enabled=row is not None and row.enabled,
        personal_rule=row.personal_rule if row is not None else "nobody",  # type: ignore[arg-type]
        personal_group_ids=list(row.personal_group_ids) if row is not None else [],
        log_retention_days=row.log_retention_days if row is not None else 365,
        states=[to_state_out(s) for s in await workspace_states(db)],
    )


async def admin_settings(db: AsyncSession) -> AttendanceAdminSettingsOut:
    return await _admin_out(db, await _settings_row(db))


async def update_settings(
    db: AsyncSession, actor: User, data: AttendanceSettingsUpdate
) -> AttendanceAdminSettingsOut:
    row = await _settings_row(db, for_update=True)
    if row is None:
        row = AttendanceSettings(
            singleton=True,
            enabled=False,
            personal_rule="nobody",
            personal_group_ids=[],
            log_retention_days=365,
        )
        db.add(row)
        await db.flush()
    changes: dict[str, object] = {}
    if data.personal_group_ids is not None:
        wanted = list(dict.fromkeys(data.personal_group_ids))
        known = set(
            (await db.execute(select(UserGroup.id).where(UserGroup.id.in_(wanted)))).scalars()
        )
        unknown = [str(g) for g in wanted if g not in known]
        if unknown:
            raise bad_request("validation_error", "Unknown groups", {"group_ids": unknown})
        if wanted != list(row.personal_group_ids):
            changes["personal_group_ids"] = [str(g) for g in wanted]
            row.personal_group_ids = wanted
    if data.personal_rule is not None and data.personal_rule != row.personal_rule:
        changes["personal_rule"] = data.personal_rule
        row.personal_rule = data.personal_rule
    if data.log_retention_days is not None and data.log_retention_days != row.log_retention_days:
        changes["log_retention_days"] = data.log_retention_days
        row.log_retention_days = data.log_retention_days
    if data.enabled is not None and data.enabled != row.enabled:
        changes["enabled"] = data.enabled
        row.enabled = data.enabled
        if data.enabled and not await workspace_states(db):
            await _seed_defaults(db, actor.locale)
    if changes:
        row.updated_at = utcnow()
        row.updated_by = actor.id
        await audit.record_in_tx(
            db,
            actor_id=actor.id,
            action="attendance.settings_updated",
            target_type="attendance",
            target_id=None,
            details=changes,
        )
        await _config_changed(db)
    await db.commit()
    return await _admin_out(db, row)


async def create_state(
    db: AsyncSession, actor: User, data: AttendanceStateCreate
) -> AttendanceStateOut:
    states = await workspace_states(db)
    if len(states) >= MAX_WORKSPACE_STATES:
        raise conflict("attendance_state_limit", "Too many states")
    await _label_free(db, data.label, owner_id=None)
    now = utcnow()
    row = AttendanceState(
        owner_id=None,
        label=data.label,
        emoji=data.emoji,
        color=data.color,
        kind=data.kind,
        position=max((s.position for s in states), default=-1) + 1,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    await db.flush()
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="attendance.state_created",
        target_type="attendance_state",
        target_id=row.id,
        details={"label": row.label, "kind": row.kind},
    )
    await _config_changed(db)
    await db.commit()
    return to_state_out(row)


async def _workspace_state(db: AsyncSession, state_id: uuid.UUID) -> AttendanceState:
    row = await _state(db, state_id)
    if row is None or row.owner_id is not None or row.archived_at is not None:
        raise not_found("attendance_state_not_found", "State not found")
    return row


async def update_state(
    db: AsyncSession, actor: User, state_id: uuid.UUID, data: AttendanceStateUpdate
) -> AttendanceStateOut:
    row = await _workspace_state(db, state_id)
    if data.label is not None:
        await _label_free(db, data.label, owner_id=None, except_id=row.id)
    _apply_update(row, data)
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="attendance.state_updated",
        target_type="attendance_state",
        target_id=row.id,
        details=data.model_dump(exclude_unset=True, mode="json"),
    )
    await _config_changed(db)
    await db.commit()
    return to_state_out(row)


async def delete_state(db: AsyncSession, actor: User, state_id: uuid.UUID) -> None:
    row = await _workspace_state(db, state_id)
    if len(await workspace_states(db)) <= 1:
        raise conflict("attendance_last_state", "The last state cannot be deleted")
    row.archived_at = utcnow()
    row.updated_at = row.archived_at
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="attendance.state_deleted",
        target_type="attendance_state",
        target_id=row.id,
        details={"label": row.label},
    )
    await _config_changed(db)
    await db.commit()


async def reorder_states(
    db: AsyncSession, actor: User, data: AttendanceStateOrder
) -> AttendanceAdminSettingsOut:
    states = await workspace_states(db)
    if len(data.ids) != len(set(data.ids)) or set(data.ids) != {s.id for s in states}:
        raise bad_request("validation_error", "Send every state once, in the new order")
    by_id = {s.id: s for s in states}
    for position, state_id in enumerate(data.ids):
        by_id[state_id].position = position
    await _config_changed(db)
    await db.commit()
    return await admin_settings(db)


# --- retention -----------------------------------------------------------------------------


async def purge(db: AsyncSession, *, now: datetime, delivery_days: int) -> tuple[int, int]:
    """The log older than the retention (0 = kept) and webhook deliveries older than
    `delivery_days`. Returns (log rows, deliveries) removed."""
    row = await _settings_row(db)
    logs = 0
    if row is not None and row.log_retention_days > 0:
        result = await db.execute(
            delete(AttendanceLog)
            .where(AttendanceLog.at < now - timedelta(days=row.log_retention_days))
            .returning(AttendanceLog.id)
        )
        logs = len(result.all())
    result = await db.execute(
        delete(AttendanceDelivery)
        .where(AttendanceDelivery.created_at < now - timedelta(days=delivery_days))
        .returning(AttendanceDelivery.id)
    )
    deliveries = len(result.all())
    await db.commit()
    return logs, deliveries


# --- integrations --------------------------------------------------------------------------


def private_targets_allowed(settings: Settings) -> bool:
    """docs/PRESENCE.md §5.4: the dev flag, never in production."""
    return settings.attendance_webhook_allow_private and settings.environment != "production"


def check_target(url: str, settings: Settings) -> None:
    """The shape of a webhook URL (DNS is checked at each send)."""
    if private_targets_allowed(settings):
        if not url.startswith(("https://", "http://")):
            raise bad_request("attendance_url_not_allowed", "Only http(s) URLs can be used")
        return
    if not url.startswith("https://"):
        raise bad_request("attendance_url_not_allowed", "Only https URLs can be used")
    try:
        check_url_shape(url)
    except UrlNotAllowed as exc:
        raise bad_request("attendance_url_not_allowed", str(exc)) from exc


async def list_integrations(db: AsyncSession) -> list[AttendanceIntegrationOut]:
    rows = await db.execute(
        select(AttendanceIntegration).order_by(AttendanceIntegration.created_at)
    )
    return [to_integration_out(r) for r in rows.scalars().all()]


def _new_token() -> str:
    return "tya_" + secrets.token_urlsafe(32)


async def create_integration(
    db: AsyncSession, actor: User, data: AttendanceIntegrationCreate, settings: Settings
) -> AttendanceIntegrationCreated:
    if data.url is not None:
        check_target(data.url, settings)
    token = _new_token() if data.inbound else None
    now = utcnow()
    row = AttendanceIntegration(
        name=data.name,
        url=data.url,
        secret_name=data.secret_name,
        token_hash=hash_token(token) if token else None,
        enabled=True,
        created_by=actor.id,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    await db.flush()
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="attendance.integration_created",
        target_type="attendance_integration",
        target_id=row.id,
        details={
            "name": row.name,
            "url": row.url,
            "secret_name": row.secret_name,
            "inbound": token is not None,
        },
    )
    await db.commit()
    return AttendanceIntegrationCreated(integration=to_integration_out(row), token=token)


async def _integration(db: AsyncSession, integration_id: uuid.UUID) -> AttendanceIntegration:
    row = await db.get(AttendanceIntegration, integration_id, with_for_update=True)
    if row is None:
        raise not_found("attendance_integration_not_found", "Integration not found")
    return row


async def update_integration(
    db: AsyncSession,
    actor: User,
    integration_id: uuid.UUID,
    data: AttendanceIntegrationUpdate,
    settings: Settings,
) -> AttendanceIntegrationOut:
    row = await _integration(db, integration_id)
    sent = data.model_fields_set
    if data.name is not None:
        row.name = data.name
    if "url" in sent:
        if data.url is not None:
            check_target(data.url, settings)
        row.url = data.url
    if data.secret_name is not None:
        row.secret_name = data.secret_name
    if row.url is not None and row.secret_name is None:
        raise bad_request(
            "validation_error", "A webhook URL needs the name of its signing key file"
        )
    if data.enabled is not None:
        row.enabled = data.enabled
    row.updated_at = utcnow()
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="attendance.integration_updated",
        target_type="attendance_integration",
        target_id=row.id,
        details=data.model_dump(exclude_unset=True, mode="json"),
    )
    await db.commit()
    return to_integration_out(row)


async def delete_integration(db: AsyncSession, actor: User, integration_id: uuid.UUID) -> None:
    row = await _integration(db, integration_id)
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="attendance.integration_deleted",
        target_type="attendance_integration",
        target_id=row.id,
        details={"name": row.name},
    )
    await db.delete(row)
    await db.commit()


async def rotate_token(
    db: AsyncSession, actor: User, integration_id: uuid.UUID
) -> AttendanceTokenOut:
    row = await _integration(db, integration_id)
    token = _new_token()
    row.token_hash = hash_token(token)
    row.updated_at = utcnow()
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="attendance.integration_token_created",
        target_type="attendance_integration",
        target_id=row.id,
        details={"name": row.name},
    )
    await db.commit()
    return AttendanceTokenOut(integration=to_integration_out(row), token=token)


async def revoke_token(
    db: AsyncSession, actor: User, integration_id: uuid.UUID
) -> AttendanceIntegrationOut:
    row = await _integration(db, integration_id)
    row.token_hash = None
    row.updated_at = utcnow()
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="attendance.integration_token_revoked",
        target_type="attendance_integration",
        target_id=row.id,
        details={"name": row.name},
    )
    await db.commit()
    return to_integration_out(row)


# --- inbound (docs/PRESENCE.md §6) ---------------------------------------------------------


async def resolve_token(db: AsyncSession, token: str) -> AttendanceIntegration:
    """The enabled integration with this inbound token; anything else is 401."""
    if not token or len(token) > 200:
        raise unauthorized("invalid_token", "Invalid integration token")
    row = (
        await db.execute(
            select(AttendanceIntegration).where(
                AttendanceIntegration.token_hash == hash_token(token)
            )
        )
    ).scalar_one_or_none()
    if row is None or not row.enabled:
        raise unauthorized("invalid_token", "Invalid integration token")
    return row


async def _inbound_person(db: AsyncSession, data: AttendanceInbound) -> User:
    stmt = select(User)
    if data.user_id is not None:
        stmt = stmt.where(User.id == data.user_id)
    elif data.email is not None:
        stmt = stmt.where(func.lower(User.email) == data.email.strip().lower())
    else:
        assert data.username is not None
        stmt = stmt.where(func.lower(User.username) == data.username.strip().lower())
    user = (await db.execute(stmt)).scalar_one_or_none()
    if user is None or not _on_board(user):
        raise not_found("attendance_user_not_found", "No such person on the attendance board")
    return user


async def _inbound_state(db: AsyncSession, user: User, wanted: str) -> AttendanceState:
    """By id, else by label: the workspace's states first, then the person's own."""
    cleaned = " ".join(wanted.split())
    try:
        state_id: uuid.UUID | None = uuid.UUID(cleaned)
    except ValueError:
        state_id = None
    if state_id is not None:
        state = await _state(db, state_id)
        if _usable_by(state, user.id):
            assert state is not None
            return state
    for scope in (await workspace_states(db), await _personal_states(db, user.id)):
        for state in scope:
            if _same_label(state.label, cleaned):
                return state
    raise AppError(
        422,
        "attendance_state_unknown",
        "No state with this id or name",
        details={"state": cleaned},
    )


async def inbound(
    db: AsyncSession, integration: AttendanceIntegration, data: AttendanceInbound
) -> AttendanceInboundOut:
    await _require_enabled(db)
    user = await _inbound_person(db, data)
    state = await _inbound_state(db, user, data.state)
    at = data.at
    if at is not None and at < utcnow() - INBOUND_MAX_AGE:
        raise AppError(422, "attendance_change_too_old", "The change is older than 24 hours")
    result = await _apply(
        db,
        user=user,
        state=state,
        note=data.note,
        source="integration",
        actor_id=None,
        integration_id=integration.id,
        at=at,
    )
    locked = await db.get(AttendanceIntegration, integration.id)
    if locked is not None:
        locked.last_inbound_at = utcnow()
    await db.commit()
    return AttendanceInboundOut(
        applied=result.applied,
        reason=result.reason,  # type: ignore[arg-type]
        user_id=result.entry.user_id,
        state_id=result.entry.state_id,
        since=result.entry.since,
    )
