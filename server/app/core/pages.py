"""Pages outside the API: the message permalink landing page (M12b).

A permalink is `<server>/m/<message_id>`. The apps recognise it in message bodies and open the
message in place; a browser lands here and learns nothing about the message (no auth, no lookup),
so a link that leaks tells nothing on its own.
"""

import uuid

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
