"""Pages outside the API: the message permalink landing page (M12b) and the invite page (M12h).

A permalink is `<server>/m/<message_id>`. The apps recognise it in message bodies and open the
message in place; a browser lands here and learns nothing about the message (no auth, no lookup),
so a link that leaks tells nothing on its own.

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
<title>ChikuwaChat</title>
<style>
body { font-family: system-ui, sans-serif; margin: 0; display: grid; place-items: center;
       min-height: 100vh; background: #f6f7fb; color: #1f2333; }
main { max-width: 28rem; padding: 2rem; text-align: center; }
h1 { font-size: 1.25rem; margin: 0 0 .75rem; }
p { margin: .25rem 0; color: #5b6172; }
</style>
</head>
<body>
<main>
<h1>ChikuwaChat のメッセージ</h1>
<p>このリンクは ChikuwaChat のメッセージを指しています。</p>
<p>デスクトップ / iPhone / Android のアプリでこのリンクを開くと、
該当のメッセージが表示されます。</p>
</main>
</body>
</html>
"""


@router.get("/m/{message_id}", response_class=HTMLResponse, include_in_schema=False)
async def message_permalink(message_id: str) -> HTMLResponse:
    """The landing page for a permalink; the id is only validated, never looked up."""
    try:
        uuid.UUID(message_id)
    except ValueError as exc:
        raise not_found("not_found", "No such page") from exc
    return HTMLResponse(_PAGE, headers={"X-Robots-Tag": "noindex", "Cache-Control": "no-store"})


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
