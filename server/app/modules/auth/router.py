from uuid import UUID

from fastapi import APIRouter, Request, Response

from app.core.db import Db
from app.core.errors import rate_limited
from app.core.ratelimit import RateLimiter
from app.modules.auth import service
from app.modules.auth.deps import CurrentSession, CurrentUser
from app.modules.auth.schemas import (
    DeviceOut,
    DeviceUpdate,
    LoginRequest,
    PasswordChange,
    RefreshRequest,
    SessionOut,
    TokenResponse,
)

router = APIRouter(tags=["auth"])


def _client_ip(request: Request) -> str | None:
    # Proxy headers are handled by uvicorn's trusted-proxy configuration, never parsed here.
    return request.client.host[:45] if request.client else None


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"


@router.post("/auth/login", response_model=TokenResponse)
async def login(body: LoginRequest, request: Request, response: Response, db: Db) -> TokenResponse:
    limiters: dict[str, RateLimiter] = request.app.state.limiters
    for name, key in (
        ("login_ip", _client_ip(request) or "unknown"),
        ("login_account", body.username.lower()),
    ):
        limiter = limiters[name]
        if not limiter.try_acquire(key):
            raise rate_limited(limiter.retry_after_seconds(key))
    _no_store(response)
    return await service.login(db, body, request.app.state.settings, _client_ip(request))


@router.post("/auth/refresh", response_model=TokenResponse)
async def refresh(
    body: RefreshRequest, request: Request, response: Response, db: Db
) -> TokenResponse:
    _no_store(response)
    return await service.refresh(
        db, body.refresh_token, request.app.state.settings, _client_ip(request)
    )


@router.post("/auth/logout", status_code=204, name="auth:logout")
async def logout(_: CurrentUser, context: CurrentSession, db: Db) -> None:
    await service.logout(db, context)


@router.get("/auth/sessions", response_model=list[SessionOut], name="auth:sessions")
async def list_sessions(_: CurrentUser, context: CurrentSession, db: Db) -> list[SessionOut]:
    return await service.list_sessions(db, context)


@router.delete("/auth/sessions/{session_id}", status_code=204, name="auth:revoke_session")
async def revoke_session(session_id: UUID, _: CurrentUser, context: CurrentSession, db: Db) -> None:
    await service.revoke_session(db, context, session_id)


@router.put("/devices/current", response_model=DeviceOut)
async def update_device(
    _: CurrentUser, context: CurrentSession, body: DeviceUpdate, db: Db
) -> DeviceOut:
    return await service.update_device(db, context, body)


@router.put("/users/me/password", status_code=204, name="auth:password")
async def change_password(
    _: CurrentUser, context: CurrentSession, body: PasswordChange, request: Request, db: Db
) -> None:
    await service.change_password(db, context, body, request.app.state.settings)
