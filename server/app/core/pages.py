"""Pages outside the API: the permalink landing pages for messages (M12b) and canvases (M42), and
the invite page (M12h).

A permalink is `<server>/m/<message_id>` or `<server>/c/<canvas_id>`. The apps recognise it in
message bodies and open the message or canvas in place, reading it through the API, which checks
the membership (a canvas: GET /api/v1/canvases/{id}, 403 / 404 for others). A browser lands here
and learns nothing about the target (no auth, no lookup, not even whether it exists), so a link
that leaks tells nothing on its own. Behind Caddy these paths load the web client instead, which
does the same as the apps.

An invite link is `<server>/invite/<token>`. The apps take the link on their login screen; a
browser gets a small page that calls the public invite API (preview, accept) and then tells the
new member to log in from an app. The page itself is static: the token stays in the URL.
"""

import re
import uuid
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from app.core.errors import not_found

router = APIRouter(tags=["pages"])

_PAGE = """<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>taylis</title>
<style>
body {{ font-family: system-ui, sans-serif; margin: 0; display: grid; place-items: center;
       min-height: 100vh; background: #f6f7fb; color: #1f2333; }}
main {{ max-width: 28rem; padding: 2rem; text-align: center; }}
h1 {{ font-size: 1.25rem; margin: 0 0 .75rem; }}
p {{ margin: .25rem 0; color: #5b6172; }}
</style>
</head>
<body>
<main>
<h1>taylis の{kind}</h1>
<p>このリンクは taylis の{kind}を指しています。</p>
<p>デスクトップ / iPhone / Android のアプリでこのリンクを開くと、
該当の{kind}が表示されます (見られるのは、その会話のメンバーだけです)。</p>
</main>
</body>
</html>
"""


def _landing(raw_id: str, kind: str) -> HTMLResponse:
    """The id is only validated, never looked up."""
    try:
        uuid.UUID(raw_id)
    except ValueError as exc:
        raise not_found("not_found", "No such page") from exc
    return HTMLResponse(
        _PAGE.format(kind=kind),
        headers={"X-Robots-Tag": "noindex", "Cache-Control": "no-store"},
    )


@router.get("/m/{message_id}", response_class=HTMLResponse, include_in_schema=False)
async def message_permalink(message_id: str) -> HTMLResponse:
    """The landing page for a message permalink (M12b)."""
    return _landing(message_id, "メッセージ")


@router.get("/c/{canvas_id}", response_class=HTMLResponse, include_in_schema=False)
async def canvas_permalink(canvas_id: str) -> HTMLResponse:
    """The landing page for a canvas permalink (M42, CANVAS.md §4.13)."""
    return _landing(canvas_id, "キャンバス")


_INVITE_TOKEN = re.compile(r"^[A-Za-z0-9_-]{20,128}$")

_INVITE_PAGE = (Path(__file__).parent / "templates" / "invite.html").read_text(encoding="utf-8")


@router.get("/invite/{token}", response_class=HTMLResponse, include_in_schema=False)
async def invite_page(token: str) -> HTMLResponse:
    """The browser side of an invite link (M12h); the token is only checked for shape here."""
    if not _INVITE_TOKEN.match(token):
        raise not_found("not_found", "No such page")
    return HTMLResponse(
        _INVITE_PAGE, headers={"X-Robots-Tag": "noindex", "Cache-Control": "no-store"}
    )
