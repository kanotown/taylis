"""Google sign-in endpoints (M48, docs/SSO.md §3). None needs a login: the state cookie, the
ticket and the app's verifier stand in for it."""

from typing import Annotated

from fastapi import APIRouter, Query, Request, Response
from fastapi.responses import RedirectResponse

from app.core.db import Db
from app.core.errors import not_found, rate_limited
from app.core.ratelimit import RateLimiter
from app.modules.auth import web_session
from app.modules.auth.schemas import TokenResponse
from app.modules.sso import service
from app.modules.sso.oidc import OIDCProvider
from app.modules.sso.schemas import (
    CHALLENGE_PATTERN,
    AuthMethodsOut,
    ProviderMethod,
    SsoExchange,
    SsoPlatform,
)

router = APIRouter(tags=["auth"])


def _client_ip(request: Request) -> str | None:
    return request.client.host[:45] if request.client else None


def _throttle(request: Request) -> None:
    limiter: RateLimiter = request.app.state.limiters["sso"]
    key = _client_ip(request) or "unknown"
    if not limiter.try_acquire(key):
        raise rate_limited(limiter.retry_after_seconds(key))


def _google(request: Request) -> OIDCProvider:
    provider: OIDCProvider | None = request.app.state.sso_google
    if provider is None:
        raise not_found("sso_disabled", "Google sign-in is not enabled on this server")
    return provider


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"


@router.get("/auth/methods", response_model=AuthMethodsOut)
async def auth_methods(request: Request) -> AuthMethodsOut:
    """Which sign-in buttons the login screen shows."""
    return AuthMethodsOut(google=ProviderMethod(enabled=request.app.state.sso_google is not None))


@router.get(
    "/auth/sso/google/start",
    status_code=302,
    response_class=RedirectResponse,
    responses={302: {"description": "To Google's sign-in page"}},
)
async def sso_google_start(
    request: Request,
    db: Db,
    platform: SsoPlatform,
    challenge: Annotated[str, Query(pattern=CHALLENGE_PATTERN)],
) -> RedirectResponse:
    """Opened in a browser by the app: `challenge` = base64url(SHA-256(verifier)) of a secret the
    app keeps until it exchanges the ticket. 404 sso_disabled when Google sign-in is off."""
    provider = _google(request)
    _throttle(request)
    settings = request.app.state.settings
    url, state = await service.start(db, provider, settings, platform, challenge)
    response = RedirectResponse(url, status_code=302)
    _no_store(response)
    response.set_cookie(
        service.COOKIE,
        state,
        max_age=int(service.REQUEST_TTL.total_seconds()),
        path=service.COOKIE_PATH,
        httponly=True,
        secure=service.cookie_secure(settings),
        samesite="lax",  # sent on Google's top-level redirect back to the callback
    )
    return response


@router.get(
    "/auth/sso/google/callback",
    status_code=302,
    response_class=RedirectResponse,
    responses={302: {"description": "Back to the app with a ticket or sso_error"}},
)
async def sso_google_callback(
    request: Request,
    db: Db,
    code: Annotated[str | None, Query(max_length=4096)] = None,
    state: Annotated[str | None, Query(max_length=256)] = None,
    error: Annotated[str | None, Query(max_length=256)] = None,
) -> RedirectResponse:
    """Google's redirect. Web: `<PUBLIC_BASE_URL>/#sso_ticket=…` (or `#sso_error=`); the apps:
    `chikuwachat://sso?ticket=…` (or `?sso_error=`)."""
    provider = _google(request)
    _throttle(request)
    location = await service.complete(
        db,
        provider,
        request.app.state.settings,
        state=state,
        code=code,
        error=error,
        cookie=request.cookies.get(service.COOKIE),
        ip=_client_ip(request),
    )
    response = RedirectResponse(location, status_code=302)
    _no_store(response)
    response.headers["Referrer-Policy"] = "no-referrer"
    response.delete_cookie(
        service.COOKIE,
        path=service.COOKIE_PATH,
        httponly=True,
        secure=service.cookie_secure(request.app.state.settings),
        samesite="lax",
    )
    return response


@router.post("/auth/sso/exchange", response_model=TokenResponse)
async def sso_exchange(
    body: SsoExchange, request: Request, response: Response, db: Db
) -> TokenResponse:
    """The ticket and the app's verifier → the same tokens as POST /auth/login (web: the refresh
    token moves into the cookie). 401 invalid_ticket; a ticket is spent by its first use."""
    _google(request)
    _throttle(request)
    _no_store(response)
    tokens = await service.exchange(db, body, request.app.state.settings, _client_ip(request))
    if web_session.is_web(body.device.platform):
        web_session.issue(response, request, tokens)
    return tokens
