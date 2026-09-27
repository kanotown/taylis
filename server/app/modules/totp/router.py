from uuid import UUID

from fastapi import APIRouter, Request, Response

from app.core.db import Db
from app.modules.auth.deps import CurrentAdmin, CurrentUser
from app.modules.totp import service
from app.modules.totp.schemas import (
    TotpEnabledOut,
    TotpEnableRequest,
    TotpSetupOut,
    TotpSetupRequest,
    TotpStatusOut,
)

router = APIRouter(tags=["auth"])


@router.get("/auth/totp", response_model=TotpStatusOut)
async def totp_status(user: CurrentUser, db: Db) -> TotpStatusOut:
    """Whether my account asks for an authenticator code at login (M12i)."""
    return await service.status(db, user.id)


@router.post("/auth/totp/setup", response_model=TotpSetupOut)
async def totp_setup(
    user: CurrentUser, body: TotpSetupRequest, request: Request, response: Response, db: Db
) -> TotpSetupOut:
    """Start (or restart) the setup: needs my password; the secret is shown only here."""
    response.headers["Cache-Control"] = "no-store"
    issuer = request.app.state.settings.app_name
    return await service.begin_setup(db, user, body.password, issuer)


@router.post("/auth/totp/enable", response_model=TotpEnabledOut)
async def totp_enable(
    user: CurrentUser, body: TotpEnableRequest, response: Response, db: Db
) -> TotpEnabledOut:
    """Confirm the setup with a code from the app; returns the recovery codes once."""
    response.headers["Cache-Control"] = "no-store"
    return await service.enable(db, user, body.code)


@router.post("/auth/totp/disable", status_code=204)
async def totp_disable(user: CurrentUser, body: TotpSetupRequest, db: Db) -> None:
    await service.disable(db, user, body.password)


@router.delete("/admin/users/{user_id}/totp", status_code=204)
async def admin_reset_totp(user_id: UUID, actor: CurrentAdmin, db: Db) -> None:
    """Turn 2FA off for a member who lost the authenticator (audited)."""
    await service.admin_reset(db, actor, user_id)
