"""Browser sessions (M12j, SECURITY.md §2.3): the refresh token travels in an HttpOnly cookie.

The page cannot read the cookie (no theft through a script injection), the browser sends it only
to the auth endpoints (Path) and only from our own pages (SameSite=Strict), and the refresh route
additionally demands a custom header, which a cross-site form cannot add. The access token stays
in the page's memory. Native clients keep receiving the refresh token in the response body.
"""

from fastapi import Request, Response

from app.core.errors import AppError, forbidden
from app.modules.auth.schemas import TokenResponse

COOKIE = "chikuwa_refresh"
PATH = "/api/v1/auth"
REQUESTED_WITH = "ChikuwaChat"


def is_web(platform: str) -> bool:
    return platform == "web"


def _secure(request: Request) -> bool:
    return (request.headers.get("x-forwarded-proto") or request.url.scheme) == "https"


def issue(response: Response, request: Request, tokens: TokenResponse) -> None:
    """Move the refresh token from the body into the cookie."""
    settings = request.app.state.settings
    response.set_cookie(
        COOKIE,
        tokens.refresh_token,
        max_age=settings.refresh_token_ttl_days * 86400,
        path=PATH,
        httponly=True,
        secure=_secure(request),
        samesite="strict",
    )
    tokens.refresh_token = ""


def cookie_token(request: Request) -> str | None:
    """The cookie's token, if any; using it requires the header a cross-site request cannot add."""
    token = request.cookies.get(COOKIE)
    if token and request.headers.get("x-requested-with") != REQUESTED_WITH:
        raise forbidden("csrf_required", "X-Requested-With header required")
    return token or None


def clear(response: Response) -> None:
    response.delete_cookie(COOKIE, path=PATH, httponly=True, samesite="strict")


def clear_on_error(exc: AppError) -> None:
    """A dead cookie is dropped together with the 401, so the browser stops sending it."""
    exc.headers = {
        **(exc.headers or {}),
        "Set-Cookie": f"{COOKIE}=; Max-Age=0; Path={PATH}; HttpOnly; SameSite=strict",
    }
