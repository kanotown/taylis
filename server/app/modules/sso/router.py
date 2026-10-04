"""Google sign-in endpoints (M48, docs/SSO.md §3). None needs a login: the state cookie, the
ticket and the app's verifier stand in for it."""

import html
import json
from typing import Annotated

from fastapi import APIRouter, Query, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse

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
    responses={
        302: {"description": "Back to the app with a ticket or sso_error"},
        200: {
            "description": "Desktop: a page that opens the app (chikuwachat://sso?…) and says the "
            "tab may be closed",
            "content": {"text/html": {}},
        },
    },
)
async def sso_google_callback(
    request: Request,
    db: Db,
    code: Annotated[str | None, Query(max_length=4096)] = None,
    state: Annotated[str | None, Query(max_length=256)] = None,
    error: Annotated[str | None, Query(max_length=256)] = None,
) -> Response:
    """Google's redirect. Web: `<PUBLIC_BASE_URL>/#sso_ticket=…` (or `#sso_error=`); the apps:
    `chikuwachat://sso?ticket=…` (or `?sso_error=`)."""
    provider = _google(request)
    _throttle(request)
    done = await service.complete(
        db,
        provider,
        request.app.state.settings,
        state=state,
        code=code,
        error=error,
        cookie=request.cookies.get(service.COOKIE),
        ip=_client_ip(request),
    )
    # The desktop app is opened from the user's own browser: after a bare 302 to the custom scheme
    # the tab is left blank and looks like it is still loading. Answer with a short page that opens
    # the app and says the tab can be closed (iOS / Android close their browser view themselves).
    response: Response = (
        _desktop_return_page(done.location)
        if done.platform == "desktop" and done.location.startswith(service.NATIVE_RETURN)
        else RedirectResponse(done.location, status_code=302)
    )
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


def _desktop_return_page(location: str) -> HTMLResponse:
    """The page a desktop sign-in ends on: opens Taylis through the custom scheme (meta refresh and
    script, a button if both are blocked) and says the tab may be closed. The ticket is in the page
    only as the app link; the response is no-store with no referrer, like the redirect."""
    href = html.escape(location, quote=True)
    body = f"""<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0;url={href}">
<title>Taylis に戻ります</title>
<style>
body{{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",
sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;
justify-content:center;background:#f6f6f8;color:#1f1f24}}
margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;
background:#f6f6f8;color:#1f1f24}}
main{{text-align:center;padding:32px;max-width:420px}}
h1{{font-size:20px;margin:0 0 12px}}p{{color:#5c5c66;line-height:1.6;margin:0 0 20px}}
a{{display:inline-block;background:#5b5bd6;color:#fff;text-decoration:none;
padding:10px 18px;border-radius:10px}}
padding:10px 18px;border-radius:10px}}
@media (prefers-color-scheme:dark){{body{{background:#17171c;color:#ececf1}}p{{color:#a4a4b0}}}}
</style></head>
<body><main>
<h1>ログインしました</h1>
<p>Taylis に戻ります。このタブは閉じてかまいません。<br>
アプリが開かないときは、下のボタンを押してください。</p>
<a href="{href}">Taylis を開く</a>
</main>
<script>location.replace({json.dumps(location)});</script>
</body></html>"""
    return HTMLResponse(body, status_code=200)
