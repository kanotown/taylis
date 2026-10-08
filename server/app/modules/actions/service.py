"""操作ボタン (actions, M143, docs/ACTIONS.md).

A press is synchronous (§4): the server checks the right, writes a `pending` row and commits,
calls the relay once outside any transaction (one bound on the whole send), then records the
result, the audit row and, on success, the optional notice in one transaction. There is no outbox
and no retry: a late or repeated "unlock" is dangerous (D3, D4). A repeat of the same person's
`client_invoke_id` returns the earlier result without calling the relay again (D5).

What is sent is what was authorized (§4.1): the press carries the button's configuration it was
allowed under, and just before sending the button, the switch and the person's right are checked
again. If any of it changed, nothing is sent and the press ends as `failed` (`action_changed`).
"""

import asyncio
import json
import logging
import time
import unicodedata
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.errors import bad_request, conflict, forbidden, not_found
from app.core.roles import PERSON_ROLES
from app.core.settings import Settings
from app.core.time import utcnow
from app.events.outbox import write_outbox
from app.modules.actions.events import ACTIONS_UPDATED
from app.modules.actions.models import Action, ActionInvocation, ActionSettings
from app.modules.actions.schemas import (
    ActionAdminOut,
    ActionCreate,
    ActionInvocationOut,
    ActionInvokeOut,
    ActionListOut,
    ActionOrder,
    ActionSettingsOut,
    ActionSettingsUpdate,
    ActionsUpdatedData,
    ActionUpdate,
    to_action_out,
    to_invocation_out,
    to_invoke_out,
)
from app.modules.audit import service as audit
from app.modules.channels.models import Channel
from app.modules.groups.models import UserGroup, UserGroupMember
from app.modules.link_previews.fetcher import UrlNotAllowed, check_url_shape
from app.modules.outbound import signed
from app.modules.users.models import User
from app.modules.workspace import service as workspace

log = logging.getLogger("app.actions")

MAX_ACTIONS = 50
EVENT_INVOKED = "action.invoked"
EVENT_TEST = "action.test"
USER_AGENT = "Taylis-Actions/1.0"
MESSAGE_MAX = 200
# How much of the relay's answer is read (for its JSON `message`).
ANSWER_MAX_BYTES = 4096
# A pending press older than the timeout plus this was cut off (a crash mid-send).
STALE_AFTER = timedelta(seconds=30)
WAIT_STEP_SECONDS = 0.2
BOT_KEY = "actions"
BOT_NAME = "操作ボタン"
NOTICE_EMOJI = "🔘"

_NOTICE_NAMESPACE = uuid.UUID("5d0c6f0e-7a51-4f43-9d1c-2a6b8e3c4f10")


# --- settings ------------------------------------------------------------------------------


async def _settings_row(db: AsyncSession, *, for_update: bool = False) -> ActionSettings | None:
    stmt = select(ActionSettings)
    if for_update:
        stmt = stmt.with_for_update()
    return (await db.execute(stmt)).scalar_one_or_none()


async def is_enabled(db: AsyncSession) -> bool:
    row = await _settings_row(db)
    return row is not None and row.enabled


def _settings_out(row: ActionSettings | None) -> ActionSettingsOut:
    return ActionSettingsOut(
        enabled=row is not None and row.enabled,
        show_on_attendance=row is not None and row.show_on_attendance,
        log_retention_days=row.log_retention_days if row is not None else 365,
    )


async def _changed(db: AsyncSession) -> None:
    await write_outbox(
        db,
        event_type=ACTIONS_UPDATED,
        audience_type="all",
        payload=ActionsUpdatedData().model_dump(mode="json"),
    )


async def admin_settings(db: AsyncSession) -> ActionSettingsOut:
    return _settings_out(await _settings_row(db))


async def update_settings(
    db: AsyncSession, actor: User, data: ActionSettingsUpdate
) -> ActionSettingsOut:
    row = await _settings_row(db, for_update=True)
    if row is None:
        row = ActionSettings(
            singleton=True, enabled=False, show_on_attendance=False, log_retention_days=365
        )
        db.add(row)
        await db.flush()
    changes: dict[str, object] = {}
    for field in ("enabled", "show_on_attendance", "log_retention_days"):
        value = getattr(data, field)
        if value is not None and value != getattr(row, field):
            changes[field] = value
            setattr(row, field, value)
    if changes:
        row.updated_at = utcnow()
        row.updated_by = actor.id
        await audit.record_in_tx(
            db,
            actor_id=actor.id,
            action="action.settings_updated",
            target_type="actions",
            target_id=None,
            details=changes,
        )
        await _changed(db)
    await db.commit()
    return _settings_out(row)


# --- who may press -------------------------------------------------------------------------


def _is_person(user: User) -> bool:
    """Guests and bots never press (docs/ACTIONS.md D7)."""
    return user.is_active and user.role in PERSON_ROLES


async def _group_ids_of(db: AsyncSession, user_id: uuid.UUID) -> set[uuid.UUID]:
    rows = await db.execute(
        select(UserGroupMember.group_id).where(UserGroupMember.user_id == user_id)
    )
    return set(rows.scalars().all())


def may_press(user: User, action: Action, group_ids: set[uuid.UUID]) -> bool:
    """Any of the roles, groups and people the button names; never a guest or a bot."""
    if not _is_person(user):
        return False
    return (
        user.role in action.allowed_roles
        or user.id in action.allowed_user_ids
        or bool(group_ids & set(action.allowed_group_ids))
    )


async def _ordered(db: AsyncSession) -> list[Action]:
    rows = await db.execute(select(Action).order_by(Action.position, Action.created_at))
    return list(rows.scalars().all())


async def list_for(db: AsyncSession, user: User) -> ActionListOut:
    """GET /actions: the enabled buttons I may press (none for guests, bots and while off)."""
    row = await _settings_row(db)
    if row is None or not row.enabled:
        return ActionListOut(enabled=False)
    shown: list[Action] = []
    if _is_person(user):
        groups = await _group_ids_of(db, user.id)
        shown = [a for a in await _ordered(db) if a.enabled and may_press(user, a, groups)]
    return ActionListOut(
        enabled=True,
        show_on_attendance=row.show_on_attendance,
        actions=[to_action_out(a) for a in shown],
    )


async def bootstrap(db: AsyncSession, user: User) -> ActionListOut | None:
    """The bootstrap's `actions`: null for guests and bots and while off."""
    if not _is_person(user) or not await is_enabled(db):
        return None
    return await list_for(db, user)


# --- administration ------------------------------------------------------------------------


def private_targets_allowed(settings: Settings) -> bool:
    """The dev flag (ACTION_ALLOW_PRIVATE), never in production (docs/ACTIONS.md D10)."""
    return settings.action_allow_private and settings.environment != "production"


def check_target(url: str, settings: Settings) -> None:
    """The shape of a relay URL (DNS is checked at each send)."""
    if private_targets_allowed(settings):
        if not url.startswith(("https://", "http://")):
            raise bad_request("action_url_not_allowed", "Only http(s) URLs can be used")
        return
    if not url.startswith("https://"):
        raise bad_request("action_url_not_allowed", "Only https URLs can be used")
    try:
        check_url_shape(url)
    except UrlNotAllowed as exc:
        raise bad_request("action_url_not_allowed", str(exc)) from exc


async def _existing_group_ids(db: AsyncSession, ids: list[uuid.UUID]) -> set[uuid.UUID]:
    if not ids:
        return set()
    rows = await db.execute(select(UserGroup.id).where(UserGroup.id.in_(ids)))
    return set(rows.scalars().all())


async def _check_refs(
    db: AsyncSession,
    *,
    group_ids: list[uuid.UUID] | None,
    user_ids: list[uuid.UUID] | None,
    channel_id: uuid.UUID | None,
) -> None:
    if group_ids:
        known = await _existing_group_ids(db, group_ids)
        unknown = [str(g) for g in group_ids if g not in known]
        if unknown:
            raise bad_request("validation_error", "Unknown groups", {"group_ids": unknown})
    if user_ids:
        rows = await db.execute(select(User.id).where(User.id.in_(user_ids)))
        known_users = set(rows.scalars().all())
        missing = [str(u) for u in user_ids if u not in known_users]
        if missing:
            raise bad_request("validation_error", "Unknown users", {"user_ids": missing})
    if channel_id is not None:
        channel = await db.get(Channel, channel_id)
        if channel is None or channel.type in ("dm", "group_dm"):
            raise bad_request(
                "validation_error", "Unknown channel", {"notice_channel_id": str(channel_id)}
            )


async def _last_invoked(db: AsyncSession) -> dict[uuid.UUID, datetime]:
    rows = await db.execute(
        select(ActionInvocation.action_id, func.max(ActionInvocation.created_at))
        .where(ActionInvocation.kind == "invoke")
        .group_by(ActionInvocation.action_id)
    )
    return {action_id: at for action_id, at in rows.all()}


def _admin_out(
    row: Action,
    settings: Settings,
    groups: set[uuid.UUID],
    last: dict[uuid.UUID, datetime],
) -> ActionAdminOut:
    return ActionAdminOut(
        **to_action_out(row).model_dump(),
        action_key=row.action_key,
        url=row.url,
        secret_name=row.secret_name,
        secret_present=signed.read_secret(settings.action_secrets_dir, row.secret_name) is not None,
        allowed_roles=list(row.allowed_roles),  # type: ignore[arg-type]
        # A group deleted since is left out (it names nobody).
        allowed_group_ids=[g for g in row.allowed_group_ids if g in groups],
        allowed_user_ids=list(row.allowed_user_ids),
        notice_channel_id=row.notice_channel_id,
        enabled=row.enabled,
        created_at=row.created_at,
        updated_at=row.updated_at,
        last_invoked_at=last.get(row.id),
    )


async def _one_admin_out(db: AsyncSession, row: Action, settings: Settings) -> ActionAdminOut:
    groups = await _existing_group_ids(db, list(row.allowed_group_ids))
    return _admin_out(row, settings, groups, await _last_invoked(db))


async def admin_list(db: AsyncSession, settings: Settings) -> list[ActionAdminOut]:
    rows = await _ordered(db)
    groups = await _existing_group_ids(db, [g for r in rows for g in r.allowed_group_ids])
    last = await _last_invoked(db)
    return [_admin_out(r, settings, groups, last) for r in rows]


def _audit_details(row: Action) -> dict[str, Any]:
    """What the audit keeps of a button (the key's file name, never a key)."""
    return {
        "name": row.name,
        "group_label": row.group_label,
        "action_key": row.action_key,
        "url": row.url,
        "secret_name": row.secret_name,
        "allowed_roles": list(row.allowed_roles),
        "allowed_group_ids": [str(g) for g in row.allowed_group_ids],
        "allowed_user_ids": [str(u) for u in row.allowed_user_ids],
        "notice_channel_id": str(row.notice_channel_id) if row.notice_channel_id else None,
        "enabled": row.enabled,
        "provides_status": row.provides_status,
    }


def group_key(action: Action) -> str:
    """The group a button belongs to: its label, or the button itself when it has none."""
    return f"g:{action.group_label}" if action.group_label else f"a:{action.id}"


async def _check_status_source(db: AsyncSession, row: Action) -> None:
    """At most one button per group provides the group's state (docs/ACTIONS.md §12). Call under
    the advisory lock."""
    if not row.provides_status or not row.group_label:
        return
    taken = await db.execute(
        select(Action.id).where(
            Action.id != row.id,
            Action.provides_status.is_(True),
            Action.group_label == row.group_label,
        )
    )
    if taken.first() is not None:
        raise conflict(
            "action_status_source_taken",
            "Another button of this group already provides its state",
        )


async def create_action(
    db: AsyncSession, actor: User, data: ActionCreate, settings: Settings
) -> ActionAdminOut:
    check_target(data.url, settings)
    await _check_refs(
        db,
        group_ids=data.allowed_group_ids,
        user_ids=data.allowed_user_ids,
        channel_id=data.notice_channel_id,
    )
    await db.execute(text("SELECT pg_advisory_xact_lock(hashtext('actions'))"))
    rows = await _ordered(db)
    if len(rows) >= MAX_ACTIONS:
        raise conflict("action_limit", "Too many buttons")
    now = utcnow()
    row = Action(
        name=data.name,
        group_label=data.group_label,
        icon=data.icon,
        emoji=data.emoji,
        action_key=data.action_key,
        url=data.url,
        secret_name=data.secret_name,
        confirm=data.confirm,
        confirm_text=data.confirm_text,
        allowed_roles=list(data.allowed_roles),
        allowed_group_ids=list(data.allowed_group_ids),
        allowed_user_ids=list(data.allowed_user_ids),
        notice_channel_id=data.notice_channel_id,
        enabled=data.enabled,
        provides_status=data.provides_status,
        position=max((r.position for r in rows), default=-1) + 1,
        created_by=actor.id,
        created_at=now,
        updated_at=now,
    )
    await _check_status_source(db, row)
    db.add(row)
    await db.flush()
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="action.created",
        target_type="action",
        target_id=row.id,
        details=_audit_details(row),
    )
    await _changed(db)
    await db.commit()
    return await _one_admin_out(db, row, settings)


async def _action(db: AsyncSession, action_id: uuid.UUID, *, lock: bool = False) -> Action:
    row = await db.get(Action, action_id, with_for_update=lock)
    if row is None:
        raise not_found("action_not_found", "No such button")
    return row


async def update_action(
    db: AsyncSession,
    actor: User,
    action_id: uuid.UUID,
    data: ActionUpdate,
    settings: Settings,
) -> ActionAdminOut:
    row = await _action(db, action_id, lock=True)
    sent = data.model_fields_set
    if data.url is not None:
        check_target(data.url, settings)
    await _check_refs(
        db,
        group_ids=data.allowed_group_ids,
        user_ids=data.allowed_user_ids,
        channel_id=data.notice_channel_id if "notice_channel_id" in sent else None,
    )
    # Fields that cannot be cleared: null leaves them as they are.
    for field in (
        "name",
        "action_key",
        "url",
        "secret_name",
        "confirm",
        "allowed_roles",
        "allowed_group_ids",
        "allowed_user_ids",
        "enabled",
        "provides_status",
    ):
        value = getattr(data, field)
        if value is not None:
            setattr(row, field, list(value) if isinstance(value, list) else value)
    # Fields that null clears.
    for field in ("group_label", "icon", "emoji", "confirm_text", "notice_channel_id"):
        if field in sent:
            setattr(row, field, getattr(data, field))
    if row.provides_status and ("provides_status" in sent or "group_label" in sent):
        await db.execute(text("SELECT pg_advisory_xact_lock(hashtext('actions'))"))
        await _check_status_source(db, row)
    row.updated_at = utcnow()
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="action.updated",
        target_type="action",
        target_id=row.id,
        details=data.model_dump(exclude_unset=True, mode="json"),
    )
    await _changed(db)
    await db.commit()
    return await _one_admin_out(db, row, settings)


async def delete_action(db: AsyncSession, actor: User, action_id: uuid.UUID) -> None:
    """Its presses go with it (the audit log keeps each one)."""
    row = await _action(db, action_id, lock=True)
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="action.deleted",
        target_type="action",
        target_id=row.id,
        details={"name": row.name, "group_label": row.group_label},
    )
    await db.delete(row)
    await _changed(db)
    await db.commit()


async def reorder(
    db: AsyncSession, actor: User, data: ActionOrder, settings: Settings
) -> list[ActionAdminOut]:
    rows = await _ordered(db)
    if len(data.ids) != len(set(data.ids)) or set(data.ids) != {r.id for r in rows}:
        raise bad_request("validation_error", "Send every button once, in the new order")
    by_id = {r.id: r for r in rows}
    for position, action_id in enumerate(data.ids):
        by_id[action_id].position = position
    await _changed(db)
    await db.commit()
    return await admin_list(db, settings)


async def invocations(
    db: AsyncSession, action_id: uuid.UUID, limit: int = 50
) -> list[ActionInvocationOut]:
    await _action(db, action_id)
    rows = await db.execute(
        select(ActionInvocation)
        .where(ActionInvocation.action_id == action_id)
        .order_by(ActionInvocation.created_at.desc(), ActionInvocation.id.desc())
        .limit(limit)
    )
    return [to_invocation_out(r) for r in rows.scalars().all()]


async def forget_in_tx(db: AsyncSession, user_id: uuid.UUID) -> None:
    """For the admin module: an anonymized person is taken off every button's list (their
    presses stay, under the anonymized name)."""
    result = await db.execute(
        update(Action)
        .where(Action.allowed_user_ids.contains([user_id]))
        .values(allowed_user_ids=func.array_remove(Action.allowed_user_ids, user_id))
        .returning(Action.id)
    )
    if result.all():
        await _changed(db)


async def purge(db: AsyncSession, *, now: datetime) -> int:
    """Presses older than the retention (0 = kept). Returns how many were removed."""
    row = await _settings_row(db)
    removed = 0
    if row is not None and row.log_retention_days > 0:
        result = await db.execute(
            delete(ActionInvocation)
            .where(ActionInvocation.created_at < now - timedelta(days=row.log_retention_days))
            .returning(ActionInvocation.id)
        )
        removed = len(result.all())
    await db.commit()
    return removed


# --- pressing ------------------------------------------------------------------------------


def clean_message(raw: Any) -> str | None:
    """The relay's `message` as plain text: a string only, control characters removed, spaces
    collapsed, at most MESSAGE_MAX characters (docs/ACTIONS.md §5)."""
    if not isinstance(raw, str):
        return None
    kept = "".join(
        " " if unicodedata.category(ch) in ("Cc", "Cf", "Zl", "Zp") else ch for ch in raw
    )
    cleaned = " ".join(kept.split())
    return cleaned[:MESSAGE_MAX] or None


def _answer_message(answer: signed.Answer) -> str | None:
    if not answer.body:
        return None
    try:
        data = json.loads(answer.text(ANSWER_MAX_BYTES))
    except ValueError:
        return None
    return clean_message(data.get("message")) if isinstance(data, dict) else None


# A press not sent because the button, the switch or the person's right changed after it was
# authorized (§4.1).
ACTION_CHANGED = "action_changed"


def _error_of(answer: signed.Answer) -> str | None:
    if answer.ok:
        return None
    if answer.status_code is not None:
        return "relay_error"
    code = answer.error or "network"
    if code == "timeout":
        return "timeout"
    if code in ("url_not_allowed", "secret_missing", ACTION_CHANGED):
        return code
    return "network"  # DNS, connection refused, TLS…


def build_poster(settings: Settings) -> signed.Poster:
    """The relay sender (SSRF-checked, one bound on the whole send, a bounded answer)."""
    return signed.build_poster(
        timeout=settings.action_timeout_seconds,
        allow_private=private_targets_allowed(settings),
        success_body_bytes=ANSWER_MAX_BYTES,
        error_body_bytes=ANSWER_MAX_BYTES,
    )


def _iso(moment: datetime) -> str:
    return moment.isoformat().replace("+00:00", "Z")


@dataclass(frozen=True)
class Authorized:
    """What a press was allowed under (§4.1): where it goes, what it asks for and who may press.
    The press is sent only while the button still reads the same."""

    action_key: str
    url: str
    secret_name: str
    allowed_roles: tuple[str, ...]
    allowed_group_ids: tuple[uuid.UUID, ...]
    allowed_user_ids: tuple[uuid.UUID, ...]

    @classmethod
    def of(cls, row: Action) -> "Authorized":
        return cls(
            row.action_key,
            row.url,
            row.secret_name,
            tuple(row.allowed_roles),
            tuple(row.allowed_group_ids),
            tuple(row.allowed_user_ids),
        )


async def _still_allowed(
    db: AsyncSession, action: Action | None, person: User | None, authorized: Authorized
) -> bool:
    """The switch on, the button there, on and unchanged, and the person still allowed."""
    return (
        action is not None
        and person is not None
        and action.enabled
        and Authorized.of(action) == authorized
        and await is_enabled(db)
        and may_press(person, action, await _group_ids_of(db, person.id))
    )


async def _body(
    db: AsyncSession,
    event: str,
    invocation: ActionInvocation,
    action: Action,
    user: User,
    workspace_name: str,
) -> dict[str, Any]:
    workspace_id = await workspace.workspace_id(db)
    return {
        "type": event,
        "invoke_id": str(invocation.id),
        "action_id": str(action.id),
        "action_key": action.action_key,
        "user": {
            "id": str(user.id),
            "username": user.username,
            "email": user.email,
            "display_name": user.display_name,
            "role": user.role,
        },
        "workspace": {"id": str(workspace_id) if workspace_id else None, "name": workspace_name},
        "at": _iso(invocation.created_at),
    }


async def _bot(db: AsyncSession, actor_id: uuid.UUID) -> User | None:
    """The 「操作ボタン」 system bot, made the first time a notice is posted. None when an
    administrator deactivated it."""
    from app.modules.admin import service as admin
    from app.modules.tasks.models import SystemBot
    from app.modules.users import service as users

    row = await db.get(SystemBot, BOT_KEY)
    if row is None:
        bot = await admin.create_bot_in_tx(
            db,
            actor_id=actor_id,
            username=f"actions-bot-{uuid.uuid4().hex[:8]}",
            display_name=BOT_NAME,
        )
        await db.execute(
            pg_insert(SystemBot)
            .values(key=BOT_KEY, user_id=bot.id, created_at=utcnow())
            .on_conflict_do_nothing()
        )
        row = await db.get(SystemBot, BOT_KEY, populate_existing=True)
        if row is None:  # pragma: no cover - the insert above or a concurrent one wrote it
            return None
    user = await users.get_user(db, row.user_id)
    if user is None or not user.is_active:
        return None
    return user


def notice_text(action: Action, user: User) -> str:
    """「🔓 山田 太郎 が 研究室の鍵：開ける を実行」 (the workspace's language, docs/ACTIONS.md
    §6)."""
    label = f"{action.group_label}：{action.name}" if action.group_label else action.name
    return f"{action.emoji or NOTICE_EMOJI} {user.display_name} が {label} を実行"


async def _post_notice(
    db: AsyncSession, action: Action, user: User, invocation_id: uuid.UUID
) -> None:
    """The success notice in the chosen conversation (in a savepoint: a failure only logs)."""
    from app.modules.channels import service as channels
    from app.modules.messages import service as messages
    from app.modules.messages.schemas import MessageCreate

    if action.notice_channel_id is None:
        return
    try:
        async with db.begin_nested():
            channel = await channels.find_channel(db, action.notice_channel_id)
            if channel is None or channel.is_archived:
                return
            bot = await _bot(db, user.id)
            if bot is None:
                return
            if await channels.membership_of(db, bot.id, channel.id) is None:
                await channels.add_member_in_tx(db, channel, bot.id)
            await messages.create_message(
                db,
                bot,
                channel.id,
                MessageCreate(
                    client_msg_id=uuid.uuid5(_NOTICE_NAMESPACE, str(invocation_id)),
                    body=notice_text(action, user),
                ),
                advance_read=False,
                commit=False,
                mentions=False,
            )
    except Exception:
        log.exception("action %s: the notice failed", action.id)


async def _finish(
    db: AsyncSession,
    invocation_id: uuid.UUID,
    answer: signed.Answer,
    latency_ms: int,
) -> ActionInvocation:
    row = await db.get(ActionInvocation, invocation_id, populate_existing=True)
    if row is None:  # the button was deleted meanwhile (its presses go with it)
        raise not_found("action_not_found", "No such button")
    row.status = "succeeded" if answer.ok else "failed"
    row.status_code = answer.status_code
    row.error = _error_of(answer)
    row.message = _answer_message(answer)
    row.latency_ms = latency_ms
    row.finished_at = utcnow()
    return row


async def _send(
    factory: async_sessionmaker[AsyncSession],
    *,
    event: str,
    invocation_id: uuid.UUID,
    action_id: uuid.UUID,
    user: User,
    settings: Settings,
    post: signed.Poster,
    authorized: Authorized | None = None,
) -> tuple[signed.Answer, int]:
    """One call to the relay, outside any transaction. Never retried. With `authorized` (a press),
    nothing is sent unless the button, the switch and the person's right are as they were when
    the press was allowed (§4.1); otherwise the answer is `action_changed`."""
    async with factory() as db:
        action = await db.get(Action, action_id)
        invocation = await db.get(ActionInvocation, invocation_id)
        person = await db.get(User, user.id)
        if authorized is not None and not await _still_allowed(db, action, person, authorized):
            log.warning("action %s: changed after the press was allowed; not sent", action_id)
            return signed.Answer(None, ACTION_CHANGED), 0
        if action is None or invocation is None or person is None:
            raise not_found("action_not_found", "No such button")
        body = await _body(db, event, invocation, action, person, settings.workspace_display_name)
        url, secret_name = action.url, action.secret_name
    secret = signed.read_secret(settings.action_secrets_dir, secret_name)
    if secret is None:
        return signed.Answer(None, "secret_missing"), 0
    payload = signed.body_bytes(body)
    headers = signed.signed_headers(event, invocation_id, secret, payload, user_agent=USER_AGENT)
    started = time.monotonic()
    try:
        answer = await post(url, headers, payload)
    except Exception as exc:  # a bug in sending must not leave the press pending
        log.exception("action %s: sending failed", action_id)
        answer = signed.Answer(None, f"network: {type(exc).__name__}")
    return answer, int((time.monotonic() - started) * 1000)


async def _settle_repeat(
    factory: async_sessionmaker[AsyncSession],
    user_id: uuid.UUID,
    client_invoke_id: uuid.UUID,
    action_id: uuid.UUID,
    settings: Settings,
) -> ActionInvokeOut | None:
    """The earlier press with this client_invoke_id, once it is done (waiting for one still being
    sent; one left pending by a crash is reported as interrupted). None when there is none."""
    deadline = time.monotonic() + settings.action_timeout_seconds + 2
    while True:
        async with factory() as db:
            row = (
                await db.execute(
                    select(ActionInvocation).where(
                        ActionInvocation.user_id == user_id,
                        ActionInvocation.client_invoke_id == client_invoke_id,
                    )
                )
            ).scalar_one_or_none()
            if row is None:
                return None
            if row.action_id != action_id:
                raise conflict(
                    "action_invoke_id_reused", "This client_invoke_id was used for another button"
                )
            if row.status != "pending":
                return to_invoke_out(row, repeated=True)
            stale = row.created_at < utcnow() - (
                timedelta(seconds=settings.action_timeout_seconds) + STALE_AFTER
            )
            if stale:
                row.status = "failed"
                row.error = "interrupted"
                row.finished_at = utcnow()
                await db.commit()
                return to_invoke_out(row, repeated=True)
            if time.monotonic() >= deadline:
                return to_invoke_out(row, repeated=True)
        await asyncio.sleep(WAIT_STEP_SECONDS)


async def _pressable(db: AsyncSession, user: User, action_id: uuid.UUID) -> Action:
    if not await is_enabled(db):
        raise conflict("actions_disabled", "The buttons are turned off")
    action = await db.get(Action, action_id)
    if action is None:
        raise not_found("action_not_found", "No such button")
    if not action.enabled:
        raise conflict("action_disabled", "This button is turned off")
    if not may_press(user, action, await _group_ids_of(db, user.id)):
        raise forbidden("action_not_allowed", "You cannot press this button")
    return action


async def invoke(
    factory: async_sessionmaker[AsyncSession],
    user: User,
    action_id: uuid.UUID,
    client_invoke_id: uuid.UUID,
    settings: Settings,
    post: signed.Poster,
    acquire: Callable[[], None],
) -> ActionInvokeOut:
    """POST /actions/{id}/invoke (docs/ACTIONS.md §4). `acquire` is the per-person, per-button
    rate limit (raises 429); a repeat of a client_invoke_id does not count against it."""
    async with factory() as db:
        # Pinned here: what is sent must be what this check allowed (§4.1).
        authorized = Authorized.of(await _pressable(db, user, action_id))
    earlier = await _settle_repeat(factory, user.id, client_invoke_id, action_id, settings)
    if earlier is not None:
        return earlier
    acquire()
    invocation_id = uuid.uuid4()
    async with factory() as db:
        inserted = await db.execute(
            pg_insert(ActionInvocation)
            .values(
                id=invocation_id,
                action_id=action_id,
                user_id=user.id,
                client_invoke_id=client_invoke_id,
                kind="invoke",
                status="pending",
                created_at=utcnow(),
            )
            .on_conflict_do_nothing(constraint="action_invocations_client_uq")
            .returning(ActionInvocation.id)
        )
        won = bool(inserted.all())
        await db.commit()
    if not won:  # the same id at the same moment: the other request sends it
        earlier = await _settle_repeat(factory, user.id, client_invoke_id, action_id, settings)
        assert earlier is not None
        return earlier
    answer, latency = await _send(
        factory,
        event=EVENT_INVOKED,
        invocation_id=invocation_id,
        action_id=action_id,
        user=user,
        settings=settings,
        post=post,
        authorized=authorized,
    )
    async with factory() as db:
        row = await _finish(db, invocation_id, answer, latency)
        action = await db.get(Action, action_id)
        await audit.record_in_tx(
            db,
            actor_id=user.id,
            action="action.invoked",
            target_type="action",
            target_id=action_id,
            details={
                "invoke_id": str(invocation_id),
                "name": action.name if action is not None else None,
                "ok": answer.ok,
                "status_code": answer.status_code,
                "error": row.error,
            },
        )
        if answer.ok and action is not None:
            author = await db.get(User, user.id)
            if author is not None:
                await _post_notice(db, action, author, invocation_id)
        await db.commit()
        return to_invoke_out(row)


async def send_test(
    factory: async_sessionmaker[AsyncSession],
    actor: User,
    action_id: uuid.UUID,
    settings: Settings,
    post: signed.Poster,
) -> ActionInvokeOut:
    """「テスト送信」: one `action.test` now (recorded as kind test, never retried). Sent while the
    feature or the button is off too (docs/ACTIONS.md §7.2)."""
    invocation_id = uuid.uuid4()
    async with factory() as db:
        await _action(db, action_id)
        db.add(
            ActionInvocation(
                id=invocation_id,
                action_id=action_id,
                user_id=actor.id,
                client_invoke_id=None,
                kind="test",
                status="pending",
                created_at=utcnow(),
            )
        )
        await db.commit()
    answer, latency = await _send(
        factory,
        event=EVENT_TEST,
        invocation_id=invocation_id,
        action_id=action_id,
        user=actor,
        settings=settings,
        post=post,
    )
    async with factory() as db:
        row = await _finish(db, invocation_id, answer, latency)
        await db.commit()
        return to_invoke_out(row)
