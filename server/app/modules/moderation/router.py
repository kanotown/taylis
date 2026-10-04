from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Query, Request, Response

from app.core.db import Db
from app.core.errors import rate_limited
from app.modules.auth.deps import CurrentAdmin, CurrentUser
from app.modules.messages.router import public_base_url
from app.modules.moderation import service
from app.modules.moderation.schemas import (
    AccountDeletion,
    AdminReportOut,
    BlockOut,
    BlockStateOut,
    ReportAck,
    ReportCreate,
)

router = APIRouter(tags=["moderation"])


def _limit(request: Request, name: str, key: str) -> None:
    limiter = request.app.state.limiters[name]
    if not limiter.try_acquire(key):
        raise rate_limited(limiter.retry_after_seconds(key))


@router.get("/users/me/blocks", response_model=list[BlockOut])
async def list_blocks(user: CurrentUser, db: Db) -> list[BlockOut]:
    """The people I blocked (M104, docs/MODERATION.md §4), oldest first. Only mine."""
    return await service.list_blocks(db, user)


@router.put("/users/{user_id}/block", response_model=BlockStateOut)
async def block_user(
    user_id: UUID, user: CurrentUser, db: Db, request: Request, response: Response
) -> BlockStateOut:
    """Block someone (201 when new): their messages fold away on my devices, no push from them,
    no 1:1 DM from them. They are not told."""
    _limit(request, "moderation", f"block:{user.id}")
    state, changed = await service.set_block(db, user, user_id, blocked=True)
    response.status_code = 201 if changed else 200
    return state


@router.delete("/users/{user_id}/block", response_model=BlockStateOut)
async def unblock_user(user_id: UUID, user: CurrentUser, db: Db, request: Request) -> BlockStateOut:
    _limit(request, "moderation", f"block:{user.id}")
    state, _ = await service.set_block(db, user, user_id, blocked=False)
    return state


@router.post("/messages/{message_id}/report", response_model=ReportAck)
async def report_message(
    message_id: UUID,
    body: ReportCreate,
    user: CurrentUser,
    db: Db,
    request: Request,
    response: Response,
) -> ReportAck:
    """Report a message to the administrators (201 when new; a repeat returns the first, 200).
    The reporter learns nothing about other reports."""
    _limit(request, "report", str(user.id))
    ack, created = await service.report_message(
        db, user, message_id, body, base_url=public_base_url(request)
    )
    response.status_code = 201 if created else 200
    return ack


@router.post("/users/me/delete-account", status_code=204, name="users:delete_account")
async def delete_account(
    body: AccountDeletion, user: CurrentUser, db: Db, request: Request
) -> None:
    """Delete my account (docs/MODERATION.md §2): confirmed by my password, or my username for an
    account without one. Immediate: every session ends, my profile is erased and my username
    becomes `deleted-…`; my messages stay under 「退会したユーザー」. 409 last_admin."""
    _limit(request, "login_account", f"delete:{user.id}")  # password guesses, like a login
    await service.delete_own_account(db, user, body, request.app.state.blobs)


@router.get("/admin/reports", response_model=list[AdminReportOut])
async def list_reports(
    _: CurrentAdmin,
    db: Db,
    status: Literal["open", "resolved", "all"] = Query(default="open"),
) -> list[AdminReportOut]:
    """Reported messages, newest first (administrators)."""
    return await service.list_reports(db, None if status == "all" else status)


@router.post("/admin/reports/{report_id}/resolve", response_model=AdminReportOut)
async def resolve_report(report_id: UUID, actor: CurrentAdmin, db: Db) -> AdminReportOut:
    return await service.set_report_status(db, actor, report_id, "resolved")


@router.post("/admin/reports/{report_id}/reopen", response_model=AdminReportOut)
async def reopen_report(report_id: UUID, actor: CurrentAdmin, db: Db) -> AdminReportOut:
    return await service.set_report_status(db, actor, report_id, "open")
