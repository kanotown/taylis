"""Outgoing webhooks of the 在室状況 board (M140, docs/PRESENCE.md §5).

The change and its `attendance.updated` outbox row commit together; the relay's planner (an
OutboxHandler, like the push planner) writes one delivery per enabled integration with a URL,
except the integration the change came from (loop prevention), unique per (outbox row,
integration) so a replayed row sends nothing twice. The worker claims due deliveries (moving
next_attempt_at on and committing first), sends outside any transaction, and records the result:
2xx delivered, 408 / 429 / 5xx / network errors retried with backoff, other answers failed. A
delivery whose person already has a newer delivered change for the same integration is
superseded instead of sent. While the board is turned off nothing is sent: the switch cancels
the pending deliveries, and the worker checks it again right before each send (§5.1).

Signing: X-Taylis-Signature: sha256=hex(HMAC-SHA256(key, timestamp + "." + body)), the key read
from ATTENDANCE_WEBHOOK_SECRETS_DIR/<secret_name> at each send (never stored in the DB).
"""

import logging
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

import httpx
from sqlalchemy import exists, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.errors import conflict, not_found
from app.core.settings import Settings
from app.core.time import utcnow
from app.events.envelope import Audience
from app.events.models import OutboxEvent
from app.modules.attendance import service
from app.modules.attendance.events import ATTENDANCE_UPDATED
from app.modules.attendance.models import (
    AttendanceCurrent,
    AttendanceDelivery,
    AttendanceIntegration,
    AttendanceLog,
    AttendanceSettings,
    AttendanceState,
)
from app.modules.attendance.schemas import AttendanceDeliveryOut, to_delivery_out
from app.modules.outbound import signed
from app.modules.outbound.signed import SECRET_MIN_BYTES as SECRET_MIN_BYTES
from app.modules.outbound.signed import body_bytes as body_bytes
from app.modules.outbound.signed import signature as signature
from app.modules.users.models import User
from app.modules.workspace import service as workspace

log = logging.getLogger("app.attendance.webhooks")

EVENT_CHANGED = "attendance.changed"
EVENT_TEST = "attendance.test"
USER_AGENT = "Taylis-Webhook/1.0"
# Waits after the 1st, 2nd, ... failed attempt; after the last the delivery has failed.
BACKOFF = (
    timedelta(seconds=30),
    timedelta(minutes=1),
    timedelta(minutes=2),
    timedelta(minutes=5),
    timedelta(minutes=10),
    timedelta(minutes=30),
    timedelta(hours=1),
    timedelta(hours=2),
)
MAX_ATTEMPTS = len(BACKOFF)
# How long a claimed delivery stays out of the queue (a crash mid-send retries after it).
LEASE = timedelta(minutes=2)
RESPONSE_SNIPPET = 200
# The most of an error answer's body read (enough for RESPONSE_SNIPPET characters of UTF-8).
RESPONSE_PREFIX_BYTES = 4 * RESPONSE_SNIPPET
# What a delivery that was never sent because the board was turned off records.
DISABLED_ERROR = "attendance_disabled"


# --- signing (shared with the 操作ボタン, app/modules/outbound/signed.py) --------------------


def read_secret(settings: Settings, name: str | None) -> bytes | None:
    """The signing key of an integration, or None when the file is missing or too short."""
    return signed.read_secret(settings.attendance_webhook_secrets_dir, name)


# --- sending -------------------------------------------------------------------------------


@dataclass(frozen=True)
class SendResult:
    status_code: int | None
    error: str | None

    @property
    def ok(self) -> bool:
        return self.status_code is not None and 200 <= self.status_code < 300

    @property
    def retryable(self) -> bool:
        if self.ok:
            return False
        if self.status_code is None:
            return self.error not in (
                "url_not_allowed",
                "secret_missing",
                "integration_disabled",
                DISABLED_ERROR,
            )
        return self.status_code in (408, 429) or self.status_code >= 500


# url, headers, body -> result. Tests inject a fake; production posts with httpx.
Sender = Callable[[str, dict[str, str], bytes], Awaitable[SendResult]]


def build_sender(settings: Settings, transport: httpx.AsyncBaseTransport | None = None) -> Sender:
    """Posts with the shared signed sender: `attendance_webhook_timeout_seconds` bounds the whole
    send; a success's body is not read, an error's only up to a bounded prefix (its first
    RESPONSE_SNIPPET characters are recorded; docs/PRESENCE.md §5.1)."""
    post = signed.build_poster(
        timeout=settings.attendance_webhook_timeout_seconds,
        allow_private=service.private_targets_allowed(settings),
        success_body_bytes=0,
        error_body_bytes=RESPONSE_PREFIX_BYTES,
        transport=transport,
    )

    async def send(url: str, headers: dict[str, str], body: bytes) -> SendResult:
        answer = await post(url, headers, body)
        if answer.status_code is None or answer.ok:
            return SendResult(answer.status_code, answer.error)
        return SendResult(answer.status_code, answer.text(RESPONSE_SNIPPET) or None)

    return send


def _headers(event: str, delivery_id: uuid.UUID, secret: bytes, body: bytes) -> dict[str, str]:
    return signed.signed_headers(event, delivery_id, secret, body, user_agent=USER_AGENT)


# --- the payload ---------------------------------------------------------------------------


def _iso(moment: datetime) -> str:
    return moment.isoformat().replace("+00:00", "Z")


def _state_ref(state: AttendanceState | None) -> dict[str, Any] | None:
    if state is None:
        return None
    return {"id": str(state.id), "label": state.label, "kind": state.kind}


async def _workspace_ref(db: AsyncSession, name: str) -> dict[str, Any]:
    workspace_id = await workspace.workspace_id(db)
    return {"id": str(workspace_id) if workspace_id else None, "name": name}


def _user_ref(user: User) -> dict[str, Any]:
    """Only what a receiver needs to match the person (docs/PRESENCE.md §5.2)."""
    return {
        "id": str(user.id),
        "email": user.email,
        "username": user.username,
        "display_name": user.display_name,
    }


async def build_change_body(
    db: AsyncSession, delivery_id: uuid.UUID, change: AttendanceLog, workspace_name: str
) -> dict[str, Any] | None:
    user = await db.get(User, change.user_id)
    to_state = await db.get(AttendanceState, change.to_state_id)
    if user is None or to_state is None:
        return None
    from_state = (
        await db.get(AttendanceState, change.from_state_id) if change.from_state_id else None
    )
    return {
        "event": EVENT_CHANGED,
        "delivery_id": str(delivery_id),
        "workspace": await _workspace_ref(db, workspace_name),
        "user": _user_ref(user),
        "from": _state_ref(from_state),
        "to": _state_ref(to_state),
        "note": change.note or "",
        "at": _iso(change.at),
        "source": change.source,
        "integration_id": str(change.integration_id) if change.integration_id else None,
    }


class AttendanceWebhookPlanner:
    """OutboxHandler: an `attendance.updated` row becomes one delivery per integration."""

    def __init__(self, workspace_name: str, wake: Callable[[], None] | None = None) -> None:
        self.workspace_name = workspace_name
        self.wake = wake

    async def handle(self, db: AsyncSession, event: OutboxEvent, audience: Audience) -> None:
        if event.event_type != ATTENDANCE_UPDATED:
            return
        log_id = event.payload.get("log_id")
        if log_id is None:
            return
        settings_row = (await db.execute(select(AttendanceSettings))).scalar_one_or_none()
        if settings_row is None or not settings_row.enabled:
            return
        change = await db.get(AttendanceLog, int(log_id))
        if change is None:
            return
        targets = (
            (
                await db.execute(
                    select(AttendanceIntegration).where(
                        AttendanceIntegration.enabled.is_(True),
                        AttendanceIntegration.url.is_not(None),
                        AttendanceIntegration.secret_name.is_not(None),
                    )
                )
            )
            .scalars()
            .all()
        )
        planned = 0
        for integration in targets:
            if change.integration_id is not None and integration.id == change.integration_id:
                continue  # the change came from there: never echoed back
            delivery_id = uuid.uuid4()
            body = await build_change_body(db, delivery_id, change, self.workspace_name)
            if body is None:
                return
            result = await db.execute(
                insert(AttendanceDelivery)
                .values(
                    id=delivery_id,
                    integration_id=integration.id,
                    outbox_event_id=event.id,
                    log_id=change.id,
                    user_id=change.user_id,
                    event=EVENT_CHANGED,
                    body=body,
                    status="pending",
                    attempts=0,
                    next_attempt_at=utcnow(),
                    created_at=utcnow(),
                )
                .on_conflict_do_nothing(constraint="attendance_deliveries_event_uq")
                .returning(AttendanceDelivery.id)
            )
            planned += len(result.all())
        if planned and self.wake is not None:
            self.wake()


# --- the worker ----------------------------------------------------------------------------


@dataclass(frozen=True)
class _Claimed:
    id: uuid.UUID
    integration_id: uuid.UUID
    event: str
    body: dict[str, Any]
    attempts: int


async def _record(
    db: AsyncSession, delivery_id: uuid.UUID, attempts: int, result: SendResult
) -> None:
    now = utcnow()
    values: dict[str, Any] = {
        "last_status_code": result.status_code,
        "last_error": None if result.ok else (result.error or f"HTTP {result.status_code}"),
    }
    if result.ok:
        values.update(status="delivered", delivered_at=now)
    elif result.retryable and attempts < MAX_ATTEMPTS:
        values.update(status="pending", next_attempt_at=now + BACKOFF[attempts - 1])
    else:
        values.update(status="failed")
    stmt = update(AttendanceDelivery).where(AttendanceDelivery.id == delivery_id)
    if not result.ok:
        # Turned off while this was sending: it stays cancelled (not retried after re-enabling).
        stmt = stmt.where(AttendanceDelivery.status == "pending")
    await db.execute(stmt.values(**values))


async def _cancel(db: AsyncSession, delivery_ids: list[uuid.UUID]) -> None:
    """Never sent: the board is off (docs/PRESENCE.md §5.1)."""
    if not delivery_ids:
        return
    await db.execute(
        update(AttendanceDelivery)
        .where(AttendanceDelivery.id.in_(delivery_ids), AttendanceDelivery.status == "pending")
        .values(status="cancelled", last_error=DISABLED_ERROR)
    )


async def _send_one(
    factory: async_sessionmaker[AsyncSession],
    claimed: _Claimed,
    settings: Settings,
    send: Sender,
) -> SendResult:
    async with factory() as db:
        # Right before the send: the board may have been turned off since the batch was claimed.
        if not await service.is_enabled(db):
            await _cancel(db, [claimed.id])
            await db.commit()
            return SendResult(None, DISABLED_ERROR)
        integration = await db.get(AttendanceIntegration, claimed.integration_id)
        url = integration.url if integration is not None else None
        enabled = integration is not None and integration.enabled
        secret_name = integration.secret_name if integration is not None else None
    if not enabled or not url:
        result = SendResult(None, "integration_disabled")
    else:
        secret = read_secret(settings, secret_name)
        if secret is None:
            result = SendResult(None, "secret_missing")
        else:
            body = body_bytes(claimed.body)
            try:
                result = await send(url, _headers(claimed.event, claimed.id, secret, body), body)
            except Exception as exc:  # a bug in sending must not stop the worker
                log.exception("attendance webhook %s failed", claimed.id)
                result = SendResult(None, f"error: {type(exc).__name__}")
    async with factory() as db:
        await _record(db, claimed.id, claimed.attempts, result)
        await db.commit()
    return result


async def process_due(
    factory: async_sessionmaker[AsyncSession],
    settings: Settings,
    send: Sender,
    *,
    batch: int = 20,
) -> int:
    """Sends the deliveries whose time has come. Returns how many were attempted."""
    now = utcnow()
    claimed: list[_Claimed] = []
    async with factory() as db:
        rows = (
            (
                await db.execute(
                    select(AttendanceDelivery)
                    .where(
                        AttendanceDelivery.status == "pending",
                        AttendanceDelivery.next_attempt_at <= now,
                    )
                    .order_by(AttendanceDelivery.created_at)
                    .limit(batch)
                    .with_for_update(skip_locked=True)
                )
            )
            .scalars()
            .all()
        )
        if rows and not await service.is_enabled(db):
            await _cancel(db, [row.id for row in rows])
            await db.commit()
            return 0
        for row in rows:
            if row.log_id is not None and row.user_id is not None:
                newer = await db.scalar(
                    select(
                        exists().where(
                            AttendanceDelivery.integration_id == row.integration_id,
                            AttendanceDelivery.user_id == row.user_id,
                            AttendanceDelivery.status == "delivered",
                            AttendanceDelivery.log_id > row.log_id,
                        )
                    )
                )
                if newer:
                    row.status = "superseded"
                    continue
            row.attempts += 1
            row.next_attempt_at = now + LEASE
            claimed.append(
                _Claimed(row.id, row.integration_id, row.event, dict(row.body), row.attempts)
            )
        await db.commit()
    for item in claimed:
        await _send_one(factory, item, settings, send)
    return len(claimed)


# --- the test button -----------------------------------------------------------------------


async def send_test(
    factory: async_sessionmaker[AsyncSession],
    actor: User,
    integration_id: uuid.UUID,
    settings: Settings,
    send: Sender,
) -> AttendanceDeliveryOut:
    """「テスト送信」: one `attendance.test` delivery to this integration now (recorded like the
    others, not retried). The body is a change of the administrator's own row (§5.2)."""
    async with factory() as db:
        integration = await db.get(AttendanceIntegration, integration_id)
        if integration is None:
            raise not_found("attendance_integration_not_found", "Integration not found")
        if not integration.url:
            raise conflict("attendance_integration_no_url", "This integration sends nothing")
        current = await db.get(AttendanceCurrent, actor.id)
        state = await db.get(AttendanceState, current.state_id) if current is not None else None
        if state is None:
            states = await service.workspace_states(db)
            state = states[0] if states else None
        delivery_id = uuid.uuid4()
        now = utcnow()
        body = {
            "event": EVENT_TEST,
            "delivery_id": str(delivery_id),
            "workspace": await _workspace_ref(db, settings.workspace_display_name),
            "user": _user_ref(actor),
            "from": None,
            "to": _state_ref(state),
            "note": "",
            "at": _iso(now),
            "source": "admin",
            "integration_id": None,
        }
        row = AttendanceDelivery(
            id=delivery_id,
            integration_id=integration.id,
            outbox_event_id=None,
            log_id=None,
            user_id=actor.id,
            event=EVENT_TEST,
            body=body,
            status="pending",
            attempts=1,
            # Out of the worker's queue while this request sends it.
            next_attempt_at=now + LEASE,
            created_at=now,
        )
        db.add(row)
        await db.commit()
    claimed = _Claimed(delivery_id, integration_id, EVENT_TEST, body, MAX_ATTEMPTS)
    await _send_one(factory, claimed, settings, send)
    async with factory() as db:
        saved = await db.get(AttendanceDelivery, delivery_id)
        assert saved is not None
        return to_delivery_out(saved)


async def recent_deliveries(
    db: AsyncSession, integration_id: uuid.UUID, limit: int = 50
) -> list[AttendanceDeliveryOut]:
    rows = await db.execute(
        select(AttendanceDelivery)
        .where(AttendanceDelivery.integration_id == integration_id)
        .order_by(AttendanceDelivery.created_at.desc())
        .limit(limit)
    )
    return [to_delivery_out(r) for r in rows.scalars().all()]
