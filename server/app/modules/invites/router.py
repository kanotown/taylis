from uuid import UUID

from fastapi import APIRouter, Request, Response

from app.core.db import Db
from app.core.errors import rate_limited
from app.core.ratelimit import RateLimiter
from app.modules.auth.deps import CurrentAdmin
from app.modules.auth.schemas import TokenResponse
from app.modules.invites import service
from app.modules.invites.schemas import (
    InviteAccept,
    InviteCreate,
    InviteCreated,
    InviteOut,
    InvitePreviewOut,
)

router = APIRouter(tags=["invites"])


def _client_ip(request: Request) -> str | None:
    return request.client.host[:45] if request.client else None


def _throttle(request: Request) -> None:
    limiter: RateLimiter = request.app.state.limiters["invite"]
    key = _client_ip(request) or "unknown"
    if not limiter.try_acquire(key):
        raise rate_limited(limiter.retry_after_seconds(key))


@router.post("/admin/invites", response_model=InviteCreated, status_code=201)
async def create_invite(actor: CurrentAdmin, body: InviteCreate, db: Db) -> InviteCreated:
    """Issue an invite link (M12h). The token appears only in this response."""
    invite, token = await service.create(db, actor, body)
    return InviteCreated(invite=invite, token=token)


@router.get("/admin/invites", response_model=list[InviteOut])
async def list_invites(_: CurrentAdmin, db: Db) -> list[InviteOut]:
    return await service.list_invites(db)


@router.delete("/admin/invites/{invite_id}", status_code=204)
async def revoke_invite(invite_id: UUID, actor: CurrentAdmin, db: Db) -> None:
    await service.revoke(db, actor, invite_id)


@router.get("/invites/{token}", response_model=InvitePreviewOut)
async def preview_invite(token: str, request: Request, db: Db) -> InvitePreviewOut:
    """No login: who invites, which channels, until when. 404 unknown, 410 no longer usable."""
    _throttle(request)
    return await service.preview(db, token, request.app.state.settings)


@router.post("/invites/{token}/accept", response_model=TokenResponse, status_code=201)
async def accept_invite(
    token: str, body: InviteAccept, request: Request, response: Response, db: Db
) -> TokenResponse:
    """Create the account and log it in; the response is the same as POST /auth/login."""
    _throttle(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    return await service.accept(db, token, body, request.app.state.settings, _client_ip(request))
