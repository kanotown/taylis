"""Two-factor authentication with an authenticator app (M12i)."""

import base64
from datetime import timedelta
from typing import Any

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.modules.totp import otp
from tests.helpers import make_user

PASSWORD = "correct-horse-battery"
DEVICE = {"platform": "desktop", "device_name": "test box"}


def test_rfc6238_test_vectors() -> None:
    secret = b"12345678901234567890"
    assert otp.hotp(secret, 59 // 30) == "287082"
    assert otp.hotp(secret, 1111111109 // 30) == "081804"
    assert otp.hotp(secret, 1234567890 // 30) == "005924"
    assert otp.matching_step(secret, "287082", otp.datetime.fromtimestamp(59, otp.UTC)) == 1


def test_provisioning_uri_and_recovery_codes() -> None:
    uri = otp.provisioning_uri(b"12345678901234567890", "alice", "Chikuwa Chat")
    assert uri.startswith(
        "otpauth://totp/Chikuwa%20Chat:alice?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
    )
    assert "issuer=Chikuwa%20Chat" in uri and "digits=6" in uri and "period=30" in uri
    assert otp.qr_png(uri)[:8] == b"\x89PNG\r\n\x1a\n"
    codes = otp.recovery_codes()
    assert len(codes) == 8 and all(len(c) == 11 and c[5] == "-" for c in codes)
    assert otp.normalize_recovery(" AbCde-FGH2k ") == "abcdefgh2k"


def _code(secret_b32: str, *, offset_steps: int = 0) -> str:
    secret = base64.b32decode(secret_b32 + "=" * (-len(secret_b32) % 8))
    return otp.hotp(secret, otp.step_at(utcnow() + timedelta(seconds=30 * offset_steps)))


async def _login(client: AsyncClient, username: str, **extra: Any) -> Any:
    return await client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": PASSWORD, "device": DEVICE, **extra},
    )


async def test_totp_setup_login_recovery_and_reset(client: AsyncClient, db: AsyncSession) -> None:
    alice = await make_user(db, "alice", password=PASSWORD)
    await make_user(db, "root", role="admin", password=PASSWORD)
    tokens = (await _login(client, "alice")).json()
    headers = {"Authorization": f"Bearer {tokens['access_token']}"}

    status = await client.get("/api/v1/auth/totp", headers=headers)
    assert status.status_code == 200 and status.json() == {
        "enabled": False,
        "enabled_at": None,
        "recovery_codes_left": 0,
    }

    wrong = await client.post("/api/v1/auth/totp/setup", json={"password": "nope"}, headers=headers)
    assert wrong.status_code == 422 and wrong.json()["error"]["code"] == "invalid_password"
    setup = await client.post(
        "/api/v1/auth/totp/setup", json={"password": PASSWORD}, headers=headers
    )
    assert setup.status_code == 200, setup.text
    assert setup.headers["cache-control"] == "no-store"
    secret = setup.json()["secret"]
    assert setup.json()["otpauth_uri"].startswith("otpauth://totp/Taylis:alice?secret=")
    assert base64.b64decode(setup.json()["qr_png_base64"])[:4] == b"\x89PNG"

    # Not enabled until a code proves the app has the secret.
    assert (await _login(client, "alice")).status_code == 200
    right = _code(secret)
    bad = await client.post(
        "/api/v1/auth/totp/enable",
        json={"code": str((int(right) + 1) % 1_000_000).zfill(6)},
        headers=headers,
    )
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "invalid_totp"
    enabled = await client.post("/api/v1/auth/totp/enable", json={"code": right}, headers=headers)
    assert enabled.status_code == 200, enabled.text
    recovery = enabled.json()["recovery_codes"]
    assert len(recovery) == 8
    again = await client.post("/api/v1/auth/totp/enable", json={"code": right}, headers=headers)
    assert again.status_code == 409 and again.json()["error"]["code"] == "totp_already_enabled"
    status = await client.get("/api/v1/auth/totp", headers=headers)
    assert status.json()["enabled"] is True and status.json()["recovery_codes_left"] == 8

    # Login now needs the second factor; a code is accepted once.
    missing = await _login(client, "alice")
    assert missing.status_code == 401 and missing.json()["error"]["code"] == "totp_required"
    replay = await _login(client, "alice", totp_code=right)
    assert replay.status_code == 401 and replay.json()["error"]["code"] == "invalid_totp"
    fresh = _code(secret, offset_steps=1)  # within the skew window, newer than the enable step
    ok = await _login(client, "alice", totp_code=fresh)
    assert ok.status_code == 200, ok.text
    assert (await _login(client, "alice", totp_code=fresh)).status_code == 401
    wrong_password = await client.post(
        "/api/v1/auth/login",
        json={"username": "alice", "password": "nope", "device": DEVICE, "totp_code": fresh},
    )
    assert wrong_password.json()["error"]["code"] == "invalid_credentials"

    # A recovery code works once.
    recovered = await _login(client, "alice", totp_code=recovery[0].upper())
    assert recovered.status_code == 200, recovered.text
    assert (await _login(client, "alice", totp_code=recovery[0])).status_code == 401
    status = await client.get("/api/v1/auth/totp", headers=headers)
    assert status.json()["recovery_codes_left"] == 7

    # Administrators see who has it on and can reset it.
    root = (await _login(client, "root")).json()
    admin_headers = {"Authorization": f"Bearer {root['access_token']}"}
    listed = await client.get("/api/v1/admin/users", headers=admin_headers)
    assert {u["username"]: u["totp_enabled"] for u in listed.json()} == {
        "alice": True,
        "root": False,
    }
    reset = await client.delete(f"/api/v1/admin/users/{alice.id}/totp", headers=admin_headers)
    assert reset.status_code == 204
    assert (await _login(client, "alice")).status_code == 200

    # The member can turn it off with the password.
    setup = await client.post(
        "/api/v1/auth/totp/setup", json={"password": PASSWORD}, headers=headers
    )
    enabled = await client.post(
        "/api/v1/auth/totp/enable", json={"code": _code(setup.json()["secret"])}, headers=headers
    )
    assert enabled.status_code == 200
    assert (await _login(client, "alice")).status_code == 401
    denied = await client.post(
        "/api/v1/auth/totp/disable", json={"password": "nope"}, headers=headers
    )
    assert denied.status_code == 422
    off = await client.post(
        "/api/v1/auth/totp/disable", json={"password": PASSWORD}, headers=headers
    )
    assert off.status_code == 204
    assert (await _login(client, "alice")).status_code == 200
    assert (await client.get("/api/v1/auth/totp", headers=headers)).json()["enabled"] is False


async def test_wrong_current_password_does_not_end_the_session(
    client: AsyncClient, db: AsyncSession
) -> None:
    await make_user(db, "bob", password=PASSWORD)
    tokens = (await _login(client, "bob")).json()
    headers = {"Authorization": f"Bearer {tokens['access_token']}"}
    wrong = await client.put(
        "/api/v1/users/me/password",
        json={"current_password": "nope", "new_password": "another-long-one"},
        headers=headers,
    )
    assert wrong.status_code == 422 and wrong.json()["error"]["code"] == "invalid_password"
    assert (await client.get("/api/v1/users/me", headers=headers)).status_code == 200
