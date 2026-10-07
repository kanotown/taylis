"""Moderation (M104, docs/MODERATION.md): blocking people, reporting messages, deleting one's own
account.

- A block is private: only the blocker's devices learn of it (block.updated, audience the
  blocker). The blocked person is never told; what they can notice is that a new 1:1 DM to the
  blocker, or a post into an existing one, is refused with the neutral `403 dm_unavailable`.
- A report stores a copy of the body and tells every active administrator in a DM from the
  moderation bot (「モデレーション」), after the commit (opening a DM commits by itself). A notice
  that cannot be sent is logged: the report is in the admin screen either way.
- Deleting one's own account is the administrator's anonymization (admin.anonymize_in_tx) done
  by the person: immediate, no grace period. The last active administrator cannot.
"""

import logging
import uuid

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, bad_request, conflict, not_found
from app.core.roles import has_capability
from app.core.security import verify_password
from app.core.time import utcnow
from app.events.outbox import write_outbox
from app.modules.admin import service as admin
from app.modules.attachments.blobstore import BlobStore
from app.modules.audit import service as audit
from app.modules.channels import service as channels
from app.modules.messages import service as messages
from app.modules.messages.schemas import MessageCreate
from app.modules.moderation import blocks
from app.modules.moderation.events import BLOCK_UPDATED
from app.modules.moderation.models import MessageReport, UserBlock
from app.modules.moderation.schemas import (
    SNAPSHOT_MAX,
    AccountDeletion,
    AdminReportOut,
    BlockOut,
    BlockStateOut,
    BlockUpdatedData,
    GeneralReportAck,
    GeneralReportCreate,
    ReportAck,
    ReportCreate,
    ReportStatus,
)
from app.modules.tasks.deadlines import plain_name
from app.modules.tasks.models import SystemBot
from app.modules.users import service as users
from app.modules.users.models import User

log = logging.getLogger("app.moderation")

BOT_KEY = "moderation"
BOT_NAME = "モデレーション"
REASON_LABELS = {
    "spam": "迷惑・スパム",
    "harassment": "嫌がらせ",
    "inappropriate": "不適切な内容",
    "child_safety": "子どもの安全",
    "feedback": "ご意見",
    "other": "その他",
}
# Put first in the admins' notice of a child-safety report, so it stands out (M119).
CHILD_SAFETY_BANNER = "⚠️ 子どもの安全"
# How much of a POST /reports note the notice DM carries (the whole note is in the admin screen).
NOTICE_NOTE_MAX = 1000
# A notice's client_msg_id: uuid5(this, "<kind>/<id>/<admin>"), so a retry never posts twice.
_NOTICE_NAMESPACE = uuid.UUID("6f1d0c3e-2b7a-4c55-9e10-8a3f5d2c1b03")


# --- blocks ----------------------------------------------------------------------------------


async def _require_visible_user(db: AsyncSession, actor: User, user_id: uuid.UUID) -> User:
    target = await users.get_user(db, user_id)
    visible = await channels.visible_user_ids(db, actor)  # M13e: a guest sees fewer people
    if target is None or (visible is not None and user_id not in visible):
        raise not_found("user_not_found", "User not found")
    return target


async def list_blocks(db: AsyncSession, actor: User) -> list[BlockOut]:
    stmt = (
        select(UserBlock)
        .where(UserBlock.blocker_id == actor.id)
        .order_by(UserBlock.created_at, UserBlock.blocked_id)
    )
    rows = (await db.execute(stmt)).scalars().all()
    return [BlockOut(user_id=row.blocked_id, created_at=row.created_at) for row in rows]


async def set_block(
    db: AsyncSession, actor: User, user_id: uuid.UUID, *, blocked: bool
) -> tuple[BlockStateOut, bool]:
    """Block or unblock; (state, changed). Idempotent; my other devices get block.updated."""
    if user_id == actor.id:
        raise bad_request("cannot_block_self", "You cannot block yourself")
    if blocked:
        await _require_visible_user(db, actor, user_id)
        result = await db.execute(
            pg_insert(UserBlock)
            .values(blocker_id=actor.id, blocked_id=user_id, created_at=utcnow())
            .on_conflict_do_nothing(index_elements=["blocker_id", "blocked_id"])
        )
    else:
        result = await db.execute(
            delete(UserBlock).where(
                UserBlock.blocker_id == actor.id, UserBlock.blocked_id == user_id
            )
        )
    changed = bool(getattr(result, "rowcount", 0))
    if changed:
        await write_outbox(
            db,
            event_type=BLOCK_UPDATED,
            audience_type="user",
            audience_id=actor.id,
            payload=BlockUpdatedData(user_id=user_id, blocked=blocked).model_dump(mode="json"),
        )
    await db.commit()
    return BlockStateOut(user_id=user_id, blocked=blocked), changed


async def blocked_ids(db: AsyncSession, actor: User) -> list[uuid.UUID]:
    """For the bootstrap."""
    return await blocks.blocked_ids_of(db, actor.id)


# --- the moderation bot ------------------------------------------------------------------------


async def moderation_bot(db: AsyncSession, actor_id: uuid.UUID) -> User | None:
    """The moderation bot, made the first time (`actor_id` is in its audit row). None when an
    administrator deactivated it: the notices stop, the admin screen still lists the reports."""
    row = await db.get(SystemBot, BOT_KEY)
    if row is None:
        bot = await admin.create_bot_in_tx(
            db,
            actor_id=actor_id,
            username=f"moderation-bot-{uuid.uuid4().hex[:8]}",
            display_name=BOT_NAME,
        )
        await db.execute(
            pg_insert(SystemBot)
            .values(key=BOT_KEY, user_id=bot.id, created_at=utcnow())
            .on_conflict_do_nothing()
        )
        await db.commit()
        row = await db.get(SystemBot, BOT_KEY, populate_existing=True)
        if row is None:  # pragma: no cover - the insert above or a concurrent one wrote it
            return None
    user = await users.get_user(db, row.user_id)
    if user is None or not user.is_active:
        return None
    return user


async def bot_user_id(db: AsyncSession) -> uuid.UUID | None:
    stmt = select(SystemBot.user_id).where(SystemBot.key == BOT_KEY)
    return (await db.execute(stmt)).scalar_one_or_none()


async def _active_admin_ids(db: AsyncSession, *, excluding: uuid.UUID | None) -> list[uuid.UUID]:
    stmt = (
        select(User.id)
        .where(User.role == "admin", User.deactivated_at.is_(None))
        .order_by(User.username)
    )
    return [uid for uid in (await db.execute(stmt)).scalars().all() if uid != excluding]


async def notify_admins(
    db: AsyncSession, *, actor_id: uuid.UUID, key: str, text: str, excluding: uuid.UUID | None
) -> int:
    """A DM from the moderation bot to every active administrator but `excluding`; after the
    caller's commit. Returns how many were sent; a failure is logged, never raised."""
    sent = 0
    try:
        admin_ids = await _active_admin_ids(db, excluding=excluding)
        if not admin_ids:
            return 0
        bot = await moderation_bot(db, actor_id)
        if bot is None:
            return 0
    except Exception:
        await db.rollback()
        log.exception("moderation notice %s: no bot", key)
        return 0
    for admin_id in admin_ids:
        try:
            person = await users.get_user(db, admin_id)
            if person is None or not person.is_active:
                continue
            dm, _ = await channels.get_or_create_dm(db, bot, [person])
            await messages.create_message(
                db,
                bot,
                dm.id,
                MessageCreate(
                    client_msg_id=uuid.uuid5(_NOTICE_NAMESPACE, f"{key}/{admin_id}"), body=text
                ),
                advance_read=False,
                mentions=False,
            )
            sent += 1
        except Exception:
            await db.rollback()
            log.exception("moderation notice %s to %s failed", key, admin_id)
    return sent


# --- reports ---------------------------------------------------------------------------------


def report_notice(
    *,
    reason: str,
    author: User | None,
    channel_label: str,
    note: str | None,
    link: str,
) -> str:
    lines = [CHILD_SAFETY_BANNER] if reason == "child_safety" else []
    lines += ["🚩 メッセージが報告されました", f"理由: {REASON_LABELS.get(reason, reason)}"]
    if author is not None:
        lines.append(f"投稿者: {plain_name(author.display_name)} (@{author.username})")
    lines.append(f"場所: {plain_name(channel_label)}")
    if note:
        lines.append(f"メモ: {plain_name(note)}")
    if link:
        lines.append(link)
    lines.append("「管理」→「報告」で内容を確認して対応してください。")
    return "\n".join(lines)


async def report_message(
    db: AsyncSession, actor: User, message_id: uuid.UUID, data: ReportCreate, *, base_url: str
) -> tuple[ReportAck, bool]:
    """(ack, created). Anyone who can read the message may report it, once (a second report of
    the same message returns the first). Not one's own message."""
    message = await messages.get_readable_message(db, actor, message_id)
    if message.sender_id == actor.id:
        raise bad_request("cannot_report_own", "You cannot report your own message")
    existing = await db.scalar(
        select(MessageReport).where(
            MessageReport.message_id == message.id, MessageReport.reporter_id == actor.id
        )
    )
    if existing is not None:
        return _ack(existing), False
    note = (data.note or "").strip() or None
    report = MessageReport(
        message_id=message.id,
        channel_id=message.channel_id,
        reporter_id=actor.id,
        reported_user_id=message.sender_id,
        reason=data.reason,
        note=note,
        body_snapshot=message.body[:SNAPSHOT_MAX],
        created_at=utcnow(),
    )
    refused = await _insert_report(db, report, "message_reports_once")
    if refused is not None:
        # The same report sent twice at once: the other request's row (committed: the insert
        # waited for it) is the answer, without a second audit entry or notice.
        again = await db.scalar(
            select(MessageReport).where(
                MessageReport.message_id == message_id, MessageReport.reporter_id == actor.id
            )
        )
        if again is None:
            raise refused
        return _ack(again), False
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="moderation.message_reported",
        target_type="message",
        target_id=message.id,
        details={"report_id": str(report.id), "reason": data.reason},
    )
    await db.commit()
    ack = _ack(report)
    channel = await channels.require_channel(db, message.channel_id)
    author = await users.get_user(db, message.sender_id)
    label = f"#{channel.name}" if channel.name else "ダイレクトメッセージ"
    link = f"{base_url.rstrip('/')}/m/{message.id}" if base_url else ""
    await notify_admins(
        db,
        actor_id=actor.id,
        key=f"report/{ack.id}",
        text=report_notice(
            reason=ack.reason, author=author, channel_label=label, note=note, link=link
        ),
        excluding=actor.id,
    )
    return ack, True


def _ack(report: MessageReport) -> ReportAck:
    assert report.message_id is not None  # a message report
    return ReportAck(
        id=report.id,
        message_id=report.message_id,
        reason=report.reason,  # type: ignore[arg-type]
        created_at=report.created_at,
    )


def _person(user: User) -> str:
    return f"{plain_name(user.display_name)} (@{user.username})"


def general_report_notice(*, category: str, reporter: User, target: User | None, note: str) -> str:
    """The moderation bot's DM about a POST /reports report (M119). Names and the note are plain
    text (no mention, no emphasis); a long note is cut (the admin screen has all of it)."""
    lines = [CHILD_SAFETY_BANNER] if category == "child_safety" else []
    lines.append("💬 ご意見が届きました" if category == "feedback" else "🚩 報告が届きました")
    lines.append(f"種類: {REASON_LABELS.get(category, category)}")
    lines.append(f"報告者: {_person(reporter)}")
    if target is not None:
        lines.append(f"対象のユーザー: {_person(target)}")
    shown = note if len(note) <= NOTICE_NOTE_MAX else note[:NOTICE_NOTE_MAX] + "…"
    lines.append(f"内容: {plain_name(shown)}")
    lines.append("「管理」→「報告」で内容を確認して対応してください。")
    return "\n".join(lines)


def _general_ack(report: MessageReport) -> GeneralReportAck:
    return GeneralReportAck(
        id=report.id,
        category=report.reason,  # type: ignore[arg-type]
        user_id=report.reported_user_id,
        created_at=report.created_at,
    )


async def _insert_report(
    db: AsyncSession, report: MessageReport, once: str
) -> IntegrityError | None:
    """Inserts the report in a savepoint. Returns the error when the unique constraint `once`
    refused it (the same report, committed by a concurrent request: the insert waited for it);
    any other error propagates. The savepoint keeps the request's transaction, and the objects
    loaded in it, usable afterwards."""
    try:
        async with db.begin_nested():
            db.add(report)
            await db.flush()
    except IntegrityError as exc:
        if once not in str(exc.orig):
            raise
        return exc
    return None


async def find_general_report(
    db: AsyncSession, actor: User, client_report_id: uuid.UUID | None
) -> GeneralReportAck | None:
    """The report this person already sent with this client id (a retried request)."""
    if client_report_id is None:
        return None
    row = await db.scalar(
        select(MessageReport).where(
            MessageReport.reporter_id == actor.id,
            MessageReport.client_report_id == client_report_id,
        )
    )
    return _general_ack(row) if row is not None else None


async def submit_report(
    db: AsyncSession, actor: User, data: GeneralReportCreate
) -> tuple[GeneralReportAck, bool]:
    """POST /reports (M119, docs/MODERATION.md §3.1): a report about a person or about anything
    else, or feedback, from anyone signed in (guests too: a safety report must always be
    possible). (ack, created): a retry with the same client_report_id returns the first."""
    existing = await find_general_report(db, actor, data.client_report_id)
    if existing is not None:
        return existing, False
    target: User | None = None
    if data.user_id is not None:
        if data.user_id == actor.id:
            raise bad_request("cannot_report_self", "You cannot report yourself")
        target = await _require_visible_user(db, actor, data.user_id)
    report = MessageReport(
        kind="user" if target is not None else "general",
        reporter_id=actor.id,
        reported_user_id=target.id if target is not None else None,
        reason=data.category,
        note=data.note,
        client_report_id=data.client_report_id,
        created_at=utcnow(),
    )
    refused = await _insert_report(db, report, "message_reports_client_id")
    if refused is not None:
        # The same client_report_id sent twice at once (REVIEW-v0.1.43 #9): the unique index
        # made this insert wait for the other request and fail at the flush; its report is the
        # answer (200), without a second audit entry or notice.
        again = await find_general_report(db, actor, data.client_report_id)
        if again is None:
            raise refused
        return again, False
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="moderation.report_submitted",
        target_type="user" if target is not None else "message_report",
        target_id=target.id if target is not None else report.id,
        details={"report_id": str(report.id), "kind": report.kind, "category": data.category},
    )
    await db.commit()
    ack = _general_ack(report)
    await notify_admins(
        db,
        actor_id=actor.id,
        key=f"report/{ack.id}",
        text=general_report_notice(
            category=data.category, reporter=actor, target=target, note=data.note
        ),
        excluding=actor.id,
    )
    return ack, True


async def _readable_by(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> bool:
    try:
        await channels.require_readable(db, actor, channel_id)
    except AppError:
        return False
    return True


async def _admin_out(
    db: AsyncSession, actor: User, rows: list[MessageReport]
) -> list[AdminReportOut]:
    """M142 (docs/ROLES.md §4.3): without reports.read_private (a manager), a message report
    from a conversation the actor cannot read now has no snapshot and no channel name."""
    read_all = has_capability(actor, "reports.read_private")
    out: list[AdminReportOut] = []
    for row in rows:
        channel = (
            await channels.find_channel(db, row.channel_id) if row.channel_id is not None else None
        )
        hidden = (
            not read_all
            and row.channel_id is not None
            and (channel is None or not await _readable_by(db, actor, row.channel_id))
        )
        deleted = (
            row.message_id is not None and await messages.find_message(db, row.message_id) is None
        )
        if row.channel_id is None:
            channel_type = "none"  # M119: a report without a message
        else:
            channel_type = channel.type if channel else "public"
        out.append(
            AdminReportOut(
                id=row.id,
                kind=row.kind,  # type: ignore[arg-type]
                message_id=row.message_id,
                channel_id=row.channel_id,
                channel_type=channel_type,
                channel_name=channel.name if channel and not hidden else None,
                reporter_id=row.reporter_id,
                reported_user_id=row.reported_user_id,
                reason=row.reason,  # type: ignore[arg-type]
                note=row.note,
                body_snapshot="" if hidden else row.body_snapshot,
                snapshot_hidden=hidden,
                message_deleted=deleted,
                status=row.status,  # type: ignore[arg-type]
                created_at=row.created_at,
                resolved_at=row.resolved_at,
                resolved_by=row.resolved_by,
            )
        )
    return out


async def list_reports(
    db: AsyncSession, actor: User, status: ReportStatus | None, limit: int = 200
) -> list[AdminReportOut]:
    """For administrators and managers (reports.manage): newest first (open ones by default)."""
    stmt = select(MessageReport).order_by(MessageReport.created_at.desc()).limit(limit)
    if status is not None:
        stmt = stmt.where(MessageReport.status == status)
    return await _admin_out(db, actor, list((await db.execute(stmt)).scalars().all()))


async def open_report_count(db: AsyncSession) -> int:
    stmt = select(func.count()).select_from(MessageReport).where(MessageReport.status == "open")
    return int(await db.scalar(stmt) or 0)


async def set_report_status(
    db: AsyncSession, actor: User, report_id: uuid.UUID, status: ReportStatus
) -> AdminReportOut:
    report = await db.get(MessageReport, report_id, with_for_update=True)
    if report is None:
        raise not_found("report_not_found", "Report not found")
    if report.status != status:
        report.status = status
        report.resolved_at = utcnow() if status == "resolved" else None
        report.resolved_by = actor.id if status == "resolved" else None
        await audit.record_in_tx(
            db,
            actor_id=actor.id,
            action=f"moderation.report_{'resolved' if status == 'resolved' else 'reopened'}",
            target_type="message_report",
            target_id=report.id,
        )
        await db.commit()
    return (await _admin_out(db, actor, [report]))[0]


# --- deleting one's own account ------------------------------------------------------------------


async def _check_confirmation(user: User, data: AccountDeletion) -> None:
    if user.password_hash is None:  # M48: made by Google sign-in, no password to type
        typed = (data.confirm_username or "").strip().lower()
        if not typed or typed != user.username.lower():
            raise AppError(422, "invalid_confirmation", "Type your username to confirm")
        return
    if not data.password or not await verify_password(user.password_hash, data.password):
        # 422, not 401: a 401 makes the clients drop the session (SECURITY.md §2.7).
        raise AppError(422, "invalid_password", "Invalid password")


async def delete_own_account(
    db: AsyncSession, actor: User, data: AccountDeletion, blobs: BlobStore | None
) -> None:
    """The person's 「アカウントを削除」: confirmed by the password (or the username), then the
    account is anonymized at once (signed out everywhere, devices and push tokens gone, profile
    erased, the username a `deleted-…` tombstone). Messages stay under 「退会したユーザー」."""
    # Review v0.1.37 #1: the admin-set lock first (then the row), so two last administrators
    # deleting their accounts at once, or a deletion racing a demotion, leave one standing.
    await users.lock_admin_set(db)
    user = await users.get_user(db, actor.id, for_update=True)
    if user is None or not user.is_active:
        raise not_found("user_not_found", "User not found")
    if user.role == "bot":
        raise conflict("cannot_modify_self", "A bot account cannot be deleted this way")
    await _check_confirmation(user, data)
    if user.is_admin:
        await users.ensure_admin_remains(db, losing=user.id)
    tombstone_id = user.id
    avatar_key = await admin.anonymize_in_tx(
        db, user, admin=None, actor_id=user.id, action="user.account_deleted"
    )
    username = user.username
    await db.commit()
    await admin.delete_avatar_after_commit(blobs, avatar_key)
    await notify_admins(
        db,
        actor_id=tombstone_id,
        key=f"account_deleted/{tombstone_id}",
        text=(
            "🗑 メンバーが自分でアカウントを削除しました"
            f" (現在の表示: {admin.ANONYMIZED_DISPLAY_NAME} / @{username})。\n"
            "プロフィールとログイン情報は消去され、メッセージは「退会したユーザー」として残ります。"
        ),
        excluding=tombstone_id,
    )
