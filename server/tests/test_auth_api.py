"""Acceptance tests for the auth / users modules (app/modules/auth/README.md)."""

import asyncio
import uuid
from collections.abc import AsyncIterator
from datetime import timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import create_access_token, hash_token, verify_password
from app.core.settings import build_settings
from app.core.time import utcnow
from app.main import create_app
from app.modules.auth import service as auth
from app.modules.auth.models import Device, UserSession
from tests.conftest import TEST_DATABASE_URL
from tests.helpers import make_user

PASSWORD = "correct-horse-battery"
DEVICE = {"platform": "desktop", "device_name": "test box", "app_version": "0.0.1"}


async def login(client: AsyncClient, username: str, password: str = PASSWORD) -> dict[str, Any]:
    response = await client.post(
        "/api/v1/auth/login", json={"username": username, "password": password, "device": DEVICE}
    )
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def bearer(tokens: dict[str, Any]) -> dict[str, str]:
    return {"Authorization": f"Bearer {tokens['access_token']}"}


async def attempt(client: AsyncClient, username: str, password: str) -> Any:
    return await client.post(
        "/api/v1/auth/login", json={"username": username, "password": password, "device": DEVICE}
    )


async def refresh(client: AsyncClient, tokens: dict[str, Any]) -> Any:
    payload = {"refresh_token": tokens["refresh_token"]}
    return await client.post("/api/v1/auth/refresh", json=payload)


async def _client_with(**overrides: Any) -> AsyncIterator[AsyncClient]:
    app: FastAPI = create_app(
        build_settings(
            **{
                "environment": "test",
                "debug": False,
                "database_url": TEST_DATABASE_URL,
                "secret_key": "test-secret-key-" + "0" * 40,
                "log_json": False,
                "login_rate_limit_per_ip": 100_000,
                "login_rate_limit_per_account": 100_000,
                **overrides,
            }
        )
    )
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            yield c
    finally:
        await app.state.db.dispose()


async def test_login_then_me(client: AsyncClient, db: AsyncSession) -> None:
    await make_user(db, "alice", password=PASSWORD)
    tokens = await login(client, "alice")
    assert tokens["token_type"] == "bearer"
    assert tokens["expires_in"] > 0
    assert tokens["user"]["username"] == "alice"
    assert tokens["device"]["platform"] == "desktop"

    me = await client.get("/api/v1/users/me", headers=bearer(tokens))
    assert me.status_code == 200 and me.json()["username"] == "alice"

    no_token = await client.get("/api/v1/users/me")
    assert no_token.status_code == 401 and no_token.json()["error"]["code"] == "missing_token"


async def test_invalid_credentials_share_one_code(client: AsyncClient, db: AsyncSession) -> None:
    await make_user(db, "alice", password=PASSWORD)
    wrong = await attempt(client, "alice", "nope-nope-nope")
    unknown = await attempt(client, "ghost", PASSWORD)
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json()["error"]["code"] == unknown.json()["error"]["code"] == "invalid_credentials"


async def test_login_rate_limit(db: AsyncSession) -> None:
    await make_user(db, "alice", password=PASSWORD)
    async for limited in _client_with(login_rate_limit_per_account=2):
        for _ in range(2):
            await attempt(limited, "alice", "bad")
        blocked = await attempt(limited, "alice", PASSWORD)
        assert blocked.status_code == 429
        assert blocked.json()["error"]["code"] == "rate_limited"
        assert int(blocked.headers["Retry-After"]) >= 1


async def test_refresh_rotation_grace_and_reuse_detection(db: AsyncSession) -> None:
    await make_user(db, "alice", password=PASSWORD)

    async for c in _client_with():  # default grace (30 s)
        first = await login(c, "alice")
        second = await refresh(c, first)
        assert second.status_code == 200
        assert second.json()["refresh_token"] != first["refresh_token"]
        # The lost-response retry: the previous token is still accepted inside the grace window.
        retry = await refresh(c, first)
        assert retry.status_code == 200
        latest = retry.json()
        # Two rotations later the very first token is unknown.
        stale = await refresh(c, first)
        assert stale.status_code == 401 and stale.json()["error"]["code"] == "invalid_token"
        assert (await c.get("/api/v1/users/me", headers=bearer(latest))).status_code == 200

    async for c in _client_with(refresh_grace_seconds=0):
        first = await login(c, "alice")
        second = (await refresh(c, first)).json()
        reuse = await refresh(c, first)
        assert reuse.status_code == 401 and reuse.json()["error"]["code"] == "session_revoked"
        # The whole session is gone: neither the newest refresh token nor the access token work.
        after = await refresh(c, second)
        assert after.status_code == 401
        me = await c.get("/api/v1/users/me", headers=bearer(second))
        assert me.status_code == 401 and me.json()["error"]["code"] == "session_revoked"


async def test_logout_invalidates_tokens(client: AsyncClient, db: AsyncSession) -> None:
    await make_user(db, "alice", password=PASSWORD)
    tokens = await login(client, "alice")
    assert (await client.post("/api/v1/auth/logout", headers=bearer(tokens))).status_code == 204
    me = await client.get("/api/v1/users/me", headers=bearer(tokens))
    assert me.status_code == 401 and me.json()["error"]["code"] == "session_revoked"
    assert (await refresh(client, tokens)).status_code == 401


async def test_sessions_list_and_revoke(client: AsyncClient, db: AsyncSession) -> None:
    await make_user(db, "alice", password=PASSWORD)
    desktop = await login(client, "alice")
    phone = await login(client, "alice")

    listed = await client.get("/api/v1/auth/sessions", headers=bearer(desktop))
    assert listed.status_code == 200
    sessions = listed.json()
    assert len(sessions) == 2
    assert [s["current"] for s in sessions].count(True) == 1

    other = next(s for s in sessions if not s["current"])
    revoked = await client.delete(f"/api/v1/auth/sessions/{other['id']}", headers=bearer(desktop))
    assert revoked.status_code == 204
    assert (await client.get("/api/v1/users/me", headers=bearer(phone))).status_code == 401
    assert (await client.get("/api/v1/users/me", headers=bearer(desktop))).status_code == 200


async def test_must_change_password_is_enforced(client: AsyncClient, db: AsyncSession) -> None:
    await make_user(db, "newbie", password=PASSWORD, must_change_password=True)
    tokens = await login(client, "newbie")
    assert tokens["user"]["must_change_password"] is True

    blocked = await client.get("/api/v1/channels", headers=bearer(tokens))
    assert blocked.status_code == 403
    assert blocked.json()["error"]["code"] == "password_change_required"
    assert (await client.get("/api/v1/users/me", headers=bearer(tokens))).status_code == 200

    changed = await client.put(
        "/api/v1/users/me/password",
        headers=bearer(tokens),
        json={"current_password": PASSWORD, "new_password": "a-brand-new-password"},
    )
    assert changed.status_code == 204
    assert (await client.get("/api/v1/channels", headers=bearer(tokens))).status_code == 200
    relogin = await login(client, "newbie", "a-brand-new-password")
    assert relogin["user"]["must_change_password"] is False


async def test_deactivated_user_is_locked_out(client: AsyncClient, db: AsyncSession) -> None:
    alice = await make_user(db, "alice", password=PASSWORD)
    tokens = await login(client, "alice")

    alice.deactivated_at = utcnow()
    await db.commit()

    me = await client.get("/api/v1/users/me", headers=bearer(tokens))
    assert me.status_code == 401
    again = await attempt(client, "alice", PASSWORD)
    assert again.status_code == 401 and again.json()["error"]["code"] == "invalid_credentials"


async def test_password_change_revokes_only_other_sessions(
    client: AsyncClient, db: AsyncSession
) -> None:
    alice = await make_user(db, "alice", password=PASSWORD)
    current = await login(client, "alice")
    other = await login(client, "alice")
    payload = {"current_password": "wrong", "new_password": "a-brand-new-password"}
    wrong = await client.put("/api/v1/users/me/password", headers=bearer(current), json=payload)
    # 422 (not 401): a wrong current password must not end the session (M12i).
    assert wrong.status_code == 422 and wrong.json()["error"]["code"] == "invalid_password"
    assert (await refresh(client, other)).status_code == 200
    payload["current_password"] = PASSWORD
    changed = await client.put("/api/v1/users/me/password", headers=bearer(current), json=payload)
    assert changed.status_code == 204
    assert (await client.get("/api/v1/users/me", headers=bearer(other))).status_code == 401
    assert (await refresh(client, other)).status_code == 401
    assert (await refresh(client, current)).status_code == 200
    assert (await attempt(client, "alice", PASSWORD)).status_code == 401
    await db.refresh(alice)
    assert await verify_password(alice.password_hash, payload["new_password"])
    session = await db.get(UserSession, uuid.UUID(other["session_id"]))
    device = await db.get(Device, uuid.UUID(other["device"]["id"]))
    assert session is not None and session.revoke_reason == "password_changed"
    assert device is not None and not device.enabled
    assert device.disabled_reason == "password_changed"


async def test_session_ownership_and_device_updates(client: AsyncClient, db: AsyncSession) -> None:
    await make_user(db, "alice", password=PASSWORD)
    await make_user(db, "bob", password=PASSWORD)
    alice = await login(client, "alice")
    bob = await login(client, "bob")
    listed = await client.get("/api/v1/auth/sessions", headers=bearer(alice))
    assert [s["id"] for s in listed.json()] == [alice["session_id"]]
    assert listed.json()[0]["device"]["id"] == alice["device"]["id"]
    assert "refresh_token_hash" not in listed.text
    denied = await client.delete(
        f"/api/v1/auth/sessions/{bob['session_id']}", headers=bearer(alice)
    )
    assert denied.status_code == 404 and denied.json()["error"]["code"] == "session_not_found"
    updated = await client.put(
        "/api/v1/devices/current", headers=bearer(alice), json={"device_name": "My desktop"}
    )
    assert updated.status_code == 200
    assert updated.json()["device_name"] == "My desktop"
    assert updated.json()["app_version"] == DEVICE["app_version"]
    cleared = await client.put(
        "/api/v1/devices/current", headers=bearer(alice), json={"device_name": None}
    )
    assert cleared.json()["device_name"] is None
    untouched = await db.get(Device, uuid.UUID(bob["device"]["id"]))
    assert untouched is not None and untouched.device_name == DEVICE["device_name"]
    revoked = await client.delete(
        f"/api/v1/auth/sessions/{alice['session_id']}", headers=bearer(alice)
    )
    assert revoked.status_code == 204
    assert (await refresh(client, alice)).status_code == 401
    assert (await refresh(client, bob)).status_code == 200
    device = await db.get(Device, uuid.UUID(alice["device"]["id"]))
    assert device is not None and not device.enabled and device.disabled_reason == "logout"


async def test_forced_password_change_exceptions(client: AsyncClient, db: AsyncSession) -> None:
    user = await make_user(db, "alice", password=PASSWORD, must_change_password=True)
    first = await login(client, "alice")
    other = await login(client, "alice")
    for method, path, payload in (
        ("GET", "/users", None),
        ("GET", f"/users/{user.id}", None),
        ("PATCH", "/users/me", {"display_name": "Blocked"}),
        ("PUT", "/devices/current", {"device_name": "Blocked"}),
    ):
        blocked = await client.request(
            method, f"/api/v1{path}", headers=bearer(first), json=payload
        )
        assert blocked.status_code == 403
        assert blocked.json()["error"]["code"] == "password_change_required"
    assert (await refresh(client, first)).status_code == 200
    assert (await client.get("/api/v1/auth/sessions", headers=bearer(first))).status_code == 200
    revoked = await client.delete(
        f"/api/v1/auth/sessions/{other['session_id']}", headers=bearer(first)
    )
    assert revoked.status_code == 204
    assert (await client.post("/api/v1/auth/logout", headers=bearer(first))).status_code == 204


@pytest.mark.parametrize("mode", ["signature", "expired", "subject", "session", "malformed"])
async def test_access_token_validation(
    client: AsyncClient, db: AsyncSession, app: FastAPI, mode: str
) -> None:
    user = await make_user(db, "alice", password=PASSWORD)
    tokens = await login(client, "alice")
    token = create_access_token(
        user_id=uuid.uuid4() if mode == "subject" else user.id,
        session_id=uuid.uuid4() if mode == "session" else uuid.UUID(tokens["session_id"]),
        secret="a-different-key-" + "x" * 32
        if mode == "signature"
        else app.state.settings.secret_key,
        ttl_seconds=-1 if mode == "expired" else 900,
        now=utcnow(),
    )
    if mode == "malformed":
        token = "not.a.jwt"
    result = await client.get("/api/v1/users/me", headers={"Authorization": f"Bearer {token}"})
    assert result.status_code == 401
    assert result.json()["error"]["code"] == (
        "token_expired" if mode == "expired" else "invalid_token"
    )
    assert result.headers["WWW-Authenticate"] == "Bearer"


async def test_tokens_only_accepted_in_bearer_header(client: AsyncClient, db: AsyncSession) -> None:
    await make_user(db, "alice", password=PASSWORD)
    tokens = await login(client, "alice")
    query = await client.get("/api/v1/users/me", params={"access_token": tokens["access_token"]})
    assert query.status_code == 401 and query.json()["error"]["code"] == "missing_token"
    client.cookies.set("access_token", tokens["access_token"])
    cookie = await client.get("/api/v1/users/me")
    assert cookie.status_code == 401 and cookie.json()["error"]["code"] == "missing_token"
    for header in ("Basic abc", "Bearer", "Bearer invalid"):
        result = await client.get("/api/v1/users/me", headers={"Authorization": header})
        assert result.status_code == 401 and result.json()["error"]["code"] == "invalid_token"


async def test_refresh_hash_storage_and_lifetime(client: AsyncClient, db: AsyncSession) -> None:
    await make_user(db, "alice", password=PASSWORD)
    first = await login(client, "alice")
    session = await db.get(UserSession, uuid.UUID(first["session_id"]))
    assert session is not None
    assert session.refresh_token_hash == hash_token(first["refresh_token"])
    session.created_at = utcnow() - timedelta(days=179)
    session.expires_at = utcnow() + timedelta(hours=1)
    await db.commit()
    rotated = await refresh(client, first)
    assert rotated.status_code == 200 and rotated.headers["Cache-Control"] == "no-store"
    await db.refresh(session)
    assert session.prev_token_hash == hash_token(first["refresh_token"])
    assert session.refresh_token_hash == hash_token(rotated.json()["refresh_token"])
    assert session.expires_at == session.created_at + timedelta(days=180)
    session.expires_at = utcnow() - timedelta(seconds=1)
    await db.commit()
    for response in (
        await refresh(client, rotated.json()),
        await client.get("/api/v1/users/me", headers=bearer(rotated.json())),
    ):
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "session_expired"


async def test_concurrent_refresh_keeps_one_token_chain(
    client: AsyncClient, db: AsyncSession
) -> None:
    await make_user(db, "alice", password=PASSWORD)
    first = await login(client, "alice")
    results = await asyncio.gather(refresh(client, first), refresh(client, first))
    assert [r.status_code for r in results] == [200, 200]
    hashes = {hash_token(r.json()["refresh_token"]) for r in results}
    session = await db.get(UserSession, uuid.UUID(first["session_id"]))
    assert session is not None
    assert {session.refresh_token_hash, session.prev_token_hash} == hashes
    assert (await refresh(client, first)).json()["error"]["code"] == "invalid_token"


async def test_account_rate_limit_is_case_insensitive(db: AsyncSession) -> None:
    await make_user(db, "alice", password=PASSWORD)
    async for limited in _client_with(login_rate_limit_per_account=2):
        assert (await attempt(limited, "Alice", "bad")).status_code == 401
        assert (await attempt(limited, "ALICE", "bad")).status_code == 401
        assert (await attempt(limited, "alice", PASSWORD)).status_code == 429


async def test_ip_limit_covers_unknown_accounts_and_ignores_untrusted_headers(
    db: AsyncSession,
) -> None:
    await make_user(db, "alice", password=PASSWORD)
    async for limited in _client_with(login_rate_limit_per_ip=2):
        assert (await attempt(limited, "ghost1", "bad")).status_code == 401
        assert (await attempt(limited, "ghost2", "bad")).status_code == 401
        result = await limited.post(
            "/api/v1/auth/login",
            json={"username": "alice", "password": PASSWORD, "device": DEVICE},
            headers={"X-Forwarded-For": "192.0.2.1"},
        )
        assert result.status_code == 429 and int(result.headers["Retry-After"]) >= 1


@pytest.mark.parametrize("operation", ["deactivate", "reset", "revoke"])
async def test_admin_operations_revoke_real_sessions(
    client: AsyncClient, db: AsyncSession, operation: str
) -> None:
    await make_user(db, "root", password=PASSWORD, role="admin")
    member = await make_user(db, "alice", password=PASSWORD)
    root = await login(client, "root")
    first = await login(client, "alice")
    second = await login(client, "alice")
    if operation == "deactivate":
        result = await client.patch(
            f"/api/v1/admin/users/{member.id}", headers=bearer(root), json={"deactivated": True}
        )
    elif operation == "reset":
        result = await client.post(
            f"/api/v1/admin/users/{member.id}/reset-password", headers=bearer(root)
        )
    else:
        result = await client.delete(
            f"/api/v1/admin/users/{member.id}/sessions", headers=bearer(root)
        )
    assert result.status_code in (200, 204)
    for tokens in (first, second):
        assert (await refresh(client, tokens)).status_code == 401
        assert (await client.get("/api/v1/users/me", headers=bearer(tokens))).status_code == 401
        device = await db.get(Device, uuid.UUID(tokens["device"]["id"]))
        session = await db.get(UserSession, uuid.UUID(tokens["session_id"]))
        assert device is not None and not device.enabled and device.disabled_reason == "admin"
        assert session is not None and session.revoke_reason == "admin"
    if operation == "reset":
        assert (await attempt(client, "alice", PASSWORD)).status_code == 401
        new = await login(client, "alice", result.json()["temporary_password"])
        assert new["user"]["must_change_password"] is True


async def test_admin_permissions_are_read_from_database(
    client: AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, "alice", password=PASSWORD)
    tokens = await login(client, "alice")
    denied = await client.get("/api/v1/admin/users", headers=bearer(tokens))
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "manager_required"
    user.role = "admin"
    await db.commit()
    assert (await client.get("/api/v1/admin/users", headers=bearer(tokens))).status_code == 200
    user.role = "member"
    await db.commit()
    assert (await client.get("/api/v1/admin/users", headers=bearer(tokens))).status_code == 403


async def test_revoke_all_sessions_leaves_commit_to_caller(
    client: AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, "alice", password=PASSWORD)
    user_id = user.id
    tokens = await login(client, "alice")
    assert await auth.revoke_all_sessions(db, user_id, "admin", utcnow()) == 1
    await db.rollback()
    assert (await client.get("/api/v1/users/me", headers=bearer(tokens))).status_code == 200
    assert await auth.revoke_all_sessions(db, user_id, "admin", utcnow()) == 1
    await db.commit()
    assert (await client.get("/api/v1/users/me", headers=bearer(tokens))).status_code == 401
    assert await auth.revoke_all_sessions(db, user_id, "admin", utcnow()) == 0


async def test_password_minimum_length_is_a_setting(client: AsyncClient, db: AsyncSession) -> None:
    await make_user(db, "alice", password=PASSWORD)
    tokens = await login(client, "alice")
    short = await client.put(
        "/api/v1/users/me/password",
        headers=bearer(tokens),
        json={"current_password": PASSWORD, "new_password": "seven77"},
    )
    assert short.status_code == 422 and short.json()["error"]["code"] == "password_too_short"
    assert short.json()["error"]["details"]["min_length"] == 8
    ok = await client.put(
        "/api/v1/users/me/password",
        headers=bearer(tokens),
        json={"current_password": PASSWORD, "new_password": "eight888"},
    )
    assert ok.status_code == 204
