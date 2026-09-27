"""The browser client's session (M12j): refresh token in an HttpOnly cookie, WS Origin check."""

import json
from collections.abc import Callable
from typing import Any

import pytest
import websockets
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User
from tests.conftest import LiveServer
from tests.helpers import http_login, make_user

PASSWORD = "correct-horse-battery"
CSRF = {"X-Requested-With": "ChikuwaChat"}


async def _web_login(client: AsyncClient, username: str, **headers: str) -> Any:
    return await client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": PASSWORD, "device": {"platform": "web"}},
        headers=headers,
    )


async def test_browser_login_keeps_the_refresh_token_in_a_cookie(
    client: AsyncClient, db: AsyncSession
) -> None:
    await make_user(db, "alice", password=PASSWORD)
    logged = await _web_login(client, "alice")
    assert logged.status_code == 200, logged.text
    body = logged.json()
    assert body["refresh_token"] == "" and body["access_token"]
    assert body["device"]["platform"] == "web"
    cookie = logged.headers["set-cookie"]
    assert cookie.startswith("chikuwa_refresh=")
    assert "httponly" in cookie.lower() and "samesite=strict" in cookie.lower()
    assert "path=/api/v1/auth" in cookie.lower() and "secure" not in cookie.lower()

    # The cookie alone is not enough: a cross-site form cannot add the header.
    denied = await client.post("/api/v1/auth/refresh", json={})
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "csrf_required"
    rotated = await client.post("/api/v1/auth/refresh", json={}, headers=CSRF)
    assert rotated.status_code == 200, rotated.text
    assert rotated.json()["refresh_token"] == ""
    assert rotated.headers["set-cookie"].startswith("chikuwa_refresh=")

    headers = {"Authorization": f"Bearer {rotated.json()['access_token']}"}
    assert (await client.get("/api/v1/users/me", headers=headers)).status_code == 200
    out = await client.post("/api/v1/auth/logout", headers=headers)
    assert out.status_code == 204
    assert "max-age=0" in out.headers["set-cookie"].lower()
    gone = await client.post("/api/v1/auth/refresh", json={}, headers=CSRF)
    assert gone.status_code == 401 and gone.json()["error"]["code"] == "invalid_token"

    # A stale cookie is dropped together with the 401.
    stale = {"Cookie": "chikuwa_refresh=" + "x" * 43, **CSRF}
    dead = await client.post("/api/v1/auth/refresh", json={}, headers=stale)
    assert dead.status_code == 401
    assert "max-age=0" in dead.headers["set-cookie"].lower()


async def test_cookie_is_secure_behind_tls_and_invites_use_it_too(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    await make_user(db, "alice", password=PASSWORD)
    logged = await _web_login(client, "alice", **{"X-Forwarded-Proto": "https"})
    assert logged.status_code == 200
    assert "secure" in logged.headers["set-cookie"].lower()

    root = await make_user(db, "root", role="admin")
    as_user(root)
    issued = (await client.post("/api/v1/admin/invites", json={})).json()
    accepted = await client.post(
        f"/api/v1/invites/{issued['token']}/accept",
        json={
            "username": "browserperson",
            "display_name": "Browser",
            "password": PASSWORD,
            "device": {"platform": "web"},
        },
    )
    assert accepted.status_code == 201, accepted.text
    assert accepted.json()["refresh_token"] == ""
    assert accepted.headers["set-cookie"].startswith("chikuwa_refresh=")


async def test_native_clients_still_send_the_token_in_the_body(
    client: AsyncClient, db: AsyncSession
) -> None:
    await make_user(db, "bob", password=PASSWORD)
    logged = await client.post(
        "/api/v1/auth/login",
        json={"username": "bob", "password": PASSWORD, "device": {"platform": "desktop"}},
    )
    assert logged.status_code == 200 and logged.json()["refresh_token"]
    assert "set-cookie" not in logged.headers
    rotated = await client.post(
        "/api/v1/auth/refresh", json={"refresh_token": logged.json()["refresh_token"]}
    )
    assert rotated.status_code == 200 and rotated.json()["refresh_token"]
    assert "set-cookie" not in rotated.headers
    empty = await client.post("/api/v1/auth/refresh", json={})
    assert empty.status_code == 401 and empty.json()["error"]["code"] == "invalid_token"


async def test_websocket_checks_the_origin(live: LiveServer) -> None:
    async with live.app.state.db.session_factory() as db:
        await make_user(db, "alice", password=PASSWORD)
    tokens = await http_login(live.base_url, "alice", PASSWORD)
    port = live.base_url.rsplit(":", 1)[1]
    for origin in (None, "http://localhost:1420", f"http://127.0.0.1:{port}"):
        headers = {"Origin": origin} if origin else {}
        async with websockets.connect(live.ws_url, additional_headers=headers) as ws:
            await ws.send(json.dumps({"type": "auth", "token": tokens["access_token"]}))
            assert '"hello"' in await ws.recv()
    with pytest.raises(websockets.InvalidStatus) as refused:
        await websockets.connect(live.ws_url, additional_headers={"Origin": "https://evil.example"})
    assert refused.value.response.status_code == 403
