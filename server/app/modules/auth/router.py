from uuid import UUID

from fastapi import APIRouter, Request, Response

from app import i18n
from app.core.db import Db
from app.core.errors import AppError, rate_limited, unauthorized
from app.core.ratelimit import RateLimiter
from app.modules.auth import service, web_session
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


def _locale(request: Request) -> str | None:
    """M115: the app's language (Accept-Language), remembered on its device for pushes."""
    return i18n.from_accept_language(request.headers.get("accept-language"))


def _base_url(request: Request) -> str | None:
    """The address this app reaches the server by (PUBLIC_BASE_URL when set, else the request's,
    made public by the proxy headers): the iOS push's avatar URL (PUSH_NOTIFICATIONS.md §16)."""
    configured: str = request.app.state.settings.public_base_url.strip()
    url = (configured or str(request.base_url)).rstrip("/")
    if not url.startswith(("https://", "http://")) or len(url) > 255:
        return None
    return url


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
    tokens = await service.login(
        db, body, request.app.state.settings, _client_ip(request), locale=_locale(request)
    )
    if web_session.is_web(body.device.platform):
        web_session.issue(response, request, tokens)
    return tokens


@router.post("/auth/refresh", response_model=TokenResponse)
async def refresh(
    body: RefreshRequest, request: Request, response: Response, db: Db
) -> TokenResponse:
    _no_store(response)
    from_cookie = not body.refresh_token
    token = body.refresh_token or web_session.cookie_token(request)
    if not token:
        raise unauthorized("invalid_token", "Invalid refresh token")
    try:
        tokens = await service.refresh(
            db, token, request.app.state.settings, _client_ip(request), locale=_locale(request)
        )
    except AppError as exc:
        if from_cookie and exc.status == 401:
            web_session.clear_on_error(exc)
        raise
    if from_cookie:
        web_session.issue(response, request, tokens)
    return tokens


@router.post("/auth/logout", status_code=204, name="auth:logout")
async def logout(_: CurrentUser, context: CurrentSession, response: Response, db: Db) -> None:
    await service.logout(db, context)
    web_session.clear(response)  # a no-op for native clients


@router.get("/auth/sessions", response_model=list[SessionOut], name="auth:sessions")
async def list_sessions(_: CurrentUser, context: CurrentSession, db: Db) -> list[SessionOut]:
    return await service.list_sessions(db, context)


@router.delete("/auth/sessions/{session_id}", status_code=204, name="auth:revoke_session")
async def revoke_session(session_id: UUID, _: CurrentUser, context: CurrentSession, db: Db) -> None:
    await service.revoke_session(db, context, session_id)


@router.put("/devices/current", response_model=DeviceOut)
async def update_device(
    _: CurrentUser, context: CurrentSession, body: DeviceUpdate, request: Request, db: Db
) -> DeviceOut:
    return await service.update_device(
        db, context, body, locale=_locale(request), base_url=_base_url(request)
    )


@router.put("/users/me/password", status_code=204, name="auth:password")
async def change_password(
    _: CurrentUser, context: CurrentSession, body: PasswordChange, request: Request, db: Db
) -> None:
    await service.change_password(db, context, body, request.app.state.settings)
