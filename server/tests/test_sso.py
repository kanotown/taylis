"""Google sign-in (M48, docs/SSO.md) against a fake OpenID provider: the state cookie, PKCE, the
nonce, the domain checks, the user resolution and the one-time tickets bound to the app."""

import base64
import hashlib
import uuid
from collections.abc import Callable
from dataclasses import replace
from datetime import timedelta
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

import pytest
from fastapi import FastAPI
from httpx import AsyncClient, Response
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.modules.audit.models import AuditLog
from app.modules.auth.deps import get_current_user
from app.modules.channels.models import ChannelMember
from app.modules.sso import service as sso
from app.modules.sso.models import SsoRequest, SsoTicket, UserIdentity
from app.modules.sso.oidc import OIDCClaims, OIDCError
from app.modules.users.models import User
from tests.helpers import make_user

BASE = "https://chat.example.ac.jp"
START = "/api/v1/auth/sso/google/start"
CALLBACK = "/api/v1/auth/sso/google/callback"
EXCHANGE = "/api/v1/auth/sso/exchange"
VERIFIER = "v" * 20 + "-verifier_0123456789abcdefghij"  # 49 base64url characters
PASSWORD = "correct-horse-battery"


def s256(value: str) -> str:
    digest = hashlib.sha256(value.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


class FakeOIDC:
    """Stands in for Google: the authorization URL carries what the test needs to read back, and
    each code maps to the claims (or the failure) the test prepared."""

    name = "google"

    def __init__(self) -> None:
        self.results: dict[str, OIDCClaims | Exception] = {}
        self.calls: list[dict[str, str]] = []

    def authorize_url(
        self, *, state: str, nonce: str, code_challenge: str, redirect_uri: str, hd: str | None
    ) -> str:
        params = {
            "state": state,
            "nonce": nonce,
            "code_challenge": code_challenge,
            "redirect_uri": redirect_uri,
        }
        if hd:
            params["hd"] = hd
        return f"https://idp.test/auth?{urlencode(params)}"

    async def authenticate(self, *, code: str, code_verifier: str, redirect_uri: str) -> OIDCClaims:
        self.calls.append(
            {"code": code, "code_verifier": code_verifier, "redirect_uri": redirect_uri}
        )
        result = self.results[code]
        if isinstance(result, Exception):
            raise result
        return result


@pytest.fixture
def google(app: FastAPI) -> FakeOIDC:
    fake = FakeOIDC()
    configure(app)
    app.state.sso_google = fake
    return fake


def configure(app: FastAPI, **overrides: Any) -> None:
    app.state.settings = app.state.settings.model_copy(
        update={
            "sso_google_client_id": "test-client.apps.googleusercontent.com",
            "sso_google_client_secret": "not-a-secret",
            "sso_google_allowed_domains": "example.ac.jp",
            "public_base_url": BASE,
            **overrides,
        }
    )


def claims(nonce: str | None, **changes: Any) -> OIDCClaims:
    base = OIDCClaims(
        subject="google-sub-1",
        email="taro@example.ac.jp",
        email_verified=True,
        hosted_domain="example.ac.jp",
        name="山田 太郎",
        nonce=nonce,
    )
    return replace(base, **changes)


async def begin(client: AsyncClient, platform: str = "web", verifier: str = VERIFIER) -> Any:
    started = await client.get(START, params={"platform": platform, "challenge": s256(verifier)})
    assert started.status_code == 302, started.text
    query = parse_qs(urlparse(started.headers["location"]).query)
    return started, query["state"][0], query["nonce"][0]


async def callback(
    client: AsyncClient,
    state: str,
    *,
    code: str = "code-1",
    cookie: str | None = "same",
    **extra: str,
) -> Response:
    headers = {"Cookie": f"{sso.COOKIE}={state if cookie == 'same' else cookie}"} if cookie else {}
    return await client.get(
        CALLBACK, params={"state": state, "code": code, **extra}, headers=headers
    )


def returned(response: Response) -> dict[str, str]:
    """The ticket or error the browser is sent back with (web fragment or app URL)."""
    assert response.status_code == 302, response.text
    location = response.headers["location"]
    url = urlparse(location)
    if url.scheme == "chikuwachat":
        assert location.startswith("chikuwachat://sso?")
        return {k: v[0] for k, v in parse_qs(url.query).items()}
    assert location.startswith(f"{BASE}/#")
    return {k: v[0] for k, v in parse_qs(url.fragment).items()}


async def sign_in(
    client: AsyncClient,
    google: FakeOIDC,
    *,
    platform: str = "web",
    verifier: str = VERIFIER,
    **claim_changes: Any,
) -> dict[str, str]:
    _, state, nonce = await begin(client, platform, verifier)
    google.results["code-1"] = claims(**{"nonce": nonce, **claim_changes})
    return returned(await callback(client, state))


async def exchange(
    client: AsyncClient, ticket: str, *, verifier: str = VERIFIER, platform: str = "web"
) -> Response:
    return await client.post(
        EXCHANGE,
        json={"ticket": ticket, "verifier": verifier, "device": {"platform": platform}},
    )


async def set_email(db: AsyncSession, user: User, email: str) -> None:
    user.email = email
    await db.commit()


async def actions(db: AsyncSession) -> list[str]:
    rows = (await db.execute(select(AuditLog).order_by(AuditLog.id))).scalars().all()
    return [row.action for row in rows]


# --- configuration -------------------------------------------------------------------------


async def test_disabled_sso_is_404_and_methods_say_so(client: AsyncClient) -> None:
    methods = await client.get("/api/v1/auth/methods")
    assert methods.status_code == 200
    assert methods.json() == {"password": True, "google": {"enabled": False}}
    for response in (
        await client.get(START, params={"platform": "web", "challenge": s256(VERIFIER)}),
        await client.get(CALLBACK, params={"state": "x" * 43, "code": "c"}),
        await exchange(client, "t" * 43),
    ):
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "sso_disabled"


async def test_methods_report_google_when_enabled(client: AsyncClient, google: FakeOIDC) -> None:
    methods = await client.get("/api/v1/auth/methods")
    assert methods.json() == {"password": True, "google": {"enabled": True}}


async def test_start_validates_the_challenge_and_platform(
    client: AsyncClient, google: FakeOIDC
) -> None:
    bad = await client.get(START, params={"platform": "web", "challenge": "short"})
    assert bad.status_code == 422
    bad = await client.get(START, params={"platform": "tv", "challenge": s256(VERIFIER)})
    assert bad.status_code == 422


# --- the web and native flows --------------------------------------------------------------


async def test_web_sign_in_links_the_account_with_that_address(
    client: AsyncClient, db: AsyncSession, google: FakeOIDC
) -> None:
    taro = await make_user(db, "taro", password=PASSWORD)
    await set_email(db, taro, "Taro@Example.ac.jp")  # the match ignores case

    started, state, nonce = await begin(client)
    cookie = started.headers["set-cookie"].lower()
    assert cookie.startswith(f"{sso.COOKIE}={state}".lower())
    assert "httponly" in cookie and "secure" in cookie and "samesite=lax" in cookie
    assert "path=/api/v1/auth/sso" in cookie and "max-age=600" in cookie
    assert started.headers["cache-control"] == "no-store"
    authorize = parse_qs(urlparse(started.headers["location"]).query)
    assert authorize["hd"] == ["example.ac.jp"]
    assert authorize["redirect_uri"] == [f"{BASE}/api/v1/auth/sso/google/callback"]

    google.results["code-1"] = claims(nonce)
    back = await callback(client, state)
    assert "chikuwa_sso=" in back.headers["set-cookie"] and "max-age=0" in back.headers[
        "set-cookie"
    ].lower().replace('"', "")
    # PKCE with Google: the verifier sent with the code matches the challenge in the URL.
    assert s256(google.calls[0]["code_verifier"]) == authorize["code_challenge"][0]
    ticket = returned(back)["sso_ticket"]

    tokens = await exchange(client, ticket)
    assert tokens.status_code == 200, tokens.text
    body = tokens.json()
    assert body["user"]["id"] == str(taro.id) and body["user"]["has_password"] is True
    assert body["refresh_token"] == "" and body["device"]["platform"] == "web"
    assert tokens.headers["set-cookie"].startswith("chikuwa_refresh=")
    assert tokens.headers["cache-control"] == "no-store"
    me = await client.get(
        "/api/v1/users/me", headers={"Authorization": f"Bearer {body['access_token']}"}
    )
    assert me.status_code == 200 and me.json()["username"] == "taro"

    # A ticket is spent by its first use.
    again = await exchange(client, ticket)
    assert again.status_code == 401 and again.json()["error"]["code"] == "invalid_ticket"

    identity = (await db.execute(select(UserIdentity))).scalar_one()
    assert identity.user_id == taro.id and identity.subject == "google-sub-1"
    assert await actions(db) == ["auth.sso_linked", "auth.sso_login"]
    rows = (await db.execute(select(AuditLog))).scalars().all()
    assert all(ticket not in str(row.details) for row in rows)

    # Later sign-ins follow the link, even after the address changed at Google.
    again_ticket = (await sign_in(client, google, email="t.yamada@example.ac.jp"))["sso_ticket"]
    later = await exchange(client, again_ticket)
    assert later.status_code == 200 and later.json()["user"]["id"] == str(taro.id)


async def test_native_sign_in_returns_to_the_app_scheme(
    client: AsyncClient, db: AsyncSession, google: FakeOIDC
) -> None:
    taro = await make_user(db, "taro")
    await set_email(db, taro, "taro@example.ac.jp")
    back = await sign_in(client, google, platform="ios")
    assert set(back) == {"ticket"}
    tokens = await exchange(client, back["ticket"], platform="ios")
    assert tokens.status_code == 200, tokens.text
    assert tokens.json()["refresh_token"]  # native apps keep it themselves
    assert "set-cookie" not in tokens.headers
    assert tokens.json()["device"]["platform"] == "ios"


async def test_linking_replaces_an_unused_temporary_password(
    client: AsyncClient, db: AsyncSession, google: FakeOIDC
) -> None:
    new = await make_user(db, "hanako", password=PASSWORD, must_change_password=True)
    await set_email(db, new, "hanako@example.ac.jp")
    back = await sign_in(client, google, email="hanako@example.ac.jp", subject="sub-h")
    body = (await exchange(client, back["sso_ticket"])).json()
    assert body["user"]["must_change_password"] is False
    assert body["user"]["has_password"] is False
    login = await client.post(
        "/api/v1/auth/login",
        json={"username": "hanako", "password": PASSWORD, "device": {"platform": "desktop"}},
    )
    assert login.status_code == 401


# --- the state and the browser binding ------------------------------------------------------


async def test_callback_needs_the_cookie_of_the_browser_that_started(
    client: AsyncClient, db: AsyncSession, google: FakeOIDC
) -> None:
    _, state, nonce = await begin(client)
    google.results["code-1"] = claims(nonce)
    assert returned(await callback(client, state, cookie=None)) == {"sso_error": "expired"}
    # The state was spent by that attempt: the right cookie no longer helps.
    assert returned(await callback(client, state)) == {"sso_error": "expired"}

    _, state, nonce = await begin(client)
    google.results["code-1"] = claims(nonce)
    other = "o" * 43
    assert returned(await callback(client, state, cookie=other)) == {"sso_error": "expired"}
    assert google.calls == []  # Google was never asked


async def test_expired_replayed_and_unknown_states(
    client: AsyncClient, db: AsyncSession, google: FakeOIDC
) -> None:
    taro = await make_user(db, "taro")
    await set_email(db, taro, "taro@example.ac.jp")
    _, state, nonce = await begin(client, platform="android")
    await db.execute(
        update(SsoRequest)
        .where(SsoRequest.state == state)
        .values(expires_at=utcnow() - timedelta(seconds=1))
    )
    await db.commit()
    google.results["code-1"] = claims(nonce)
    assert returned(await callback(client, state)) == {"sso_error": "expired"}

    _, state, nonce = await begin(client)
    google.results["code-1"] = claims(nonce)
    assert "sso_ticket" in returned(await callback(client, state))
    assert returned(await callback(client, state)) == {"sso_error": "expired"}

    # Nothing says which app started an unknown state: the web page gets the error.
    unknown = await callback(client, "u" * 43)
    assert unknown.headers["location"] == f"{BASE}/#sso_error=expired"


async def test_nonce_provider_failures_and_cancel(
    client: AsyncClient, db: AsyncSession, google: FakeOIDC
) -> None:
    taro = await make_user(db, "taro")
    await set_email(db, taro, "taro@example.ac.jp")
    assert await sign_in(client, google, nonce="another-nonce") == {"sso_error": "provider_error"}
    assert await sign_in(client, google, nonce=None) == {"sso_error": "provider_error"}

    _, state, _ = await begin(client)
    google.results["code-1"] = OIDCError("invalid id token: InvalidSignatureError")
    assert returned(await callback(client, state)) == {"sso_error": "provider_error"}

    _, state, _ = await begin(client, platform="desktop")
    back = await client.get(
        CALLBACK,
        params={"state": state, "error": "access_denied"},
        headers={"Cookie": f"{sso.COOKIE}={state}"},
    )
    assert back.headers["location"] == "chikuwachat://sso?sso_error=cancelled"
    assert await db.scalar(select(SsoTicket.ticket_hash)) is None


# --- the ID token's claims -------------------------------------------------------------------


async def test_domain_and_verified_email_are_required(
    client: AsyncClient, db: AsyncSession, google: FakeOIDC
) -> None:
    taro = await make_user(db, "taro")
    await set_email(db, taro, "taro@example.ac.jp")
    refused = {"sso_error": "domain_not_allowed"}
    assert await sign_in(client, google, hosted_domain="other.ac.jp") == refused
    assert await sign_in(client, google, hosted_domain=None) == refused  # a consumer account
    assert await sign_in(client, google, email="taro@other.ac.jp") == refused
    assert await sign_in(client, google, email_verified=False) == {
        "sso_error": "email_not_verified"
    }
    assert await db.scalar(select(UserIdentity.id)) is None


async def test_several_domains_leave_the_chooser_open(app: FastAPI, client: AsyncClient) -> None:
    configure(app, sso_google_allowed_domains="example.ac.jp, Lab.Example.jp")
    app.state.sso_google = FakeOIDC()
    started, _, _ = await begin(client)
    assert "hd" not in parse_qs(urlparse(started.headers["location"]).query)
    assert app.state.settings.sso_allowed_domains == ["example.ac.jp", "lab.example.jp"]


# --- user resolution -------------------------------------------------------------------------


async def test_unknown_person_is_not_registered_without_auto_provision(
    client: AsyncClient, db: AsyncSession, google: FakeOIDC
) -> None:
    assert await sign_in(client, google) == {"sso_error": "not_registered"}
    assert (await db.execute(select(User))).first() is None


async def test_auto_provision_makes_a_member_in_the_default_channels(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    google: FakeOIDC,
    as_user: Callable[[User], None],
) -> None:
    configure(app, sso_auto_provision=True, sso_default_channels="general, secret, missing")
    root = await make_user(db, "root", role="admin")
    await make_user(db, "taro")  # the derived name is taken: the new account gets taro-2
    as_user(root)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    await client.post("/api/v1/channels", json={"name": "secret", "type": "private"})
    app.dependency_overrides.pop(get_current_user, None)

    back = await sign_in(client, google, platform="android")
    tokens = await exchange(client, back["ticket"], platform="android")
    assert tokens.status_code == 200, tokens.text
    me = tokens.json()["user"]
    assert me["username"] == "taro-2" and me["display_name"] == "山田 太郎"
    assert me["role"] == "member" and me["email"] == "taro@example.ac.jp"
    assert me["must_change_password"] is False and me["has_password"] is False
    joined = (
        (
            await db.execute(
                select(ChannelMember.channel_id).where(ChannelMember.user_id == uuid.UUID(me["id"]))
            )
        )
        .scalars()
        .all()
    )
    assert [str(c) for c in joined] == [general["id"]]  # private and unknown names are skipped
    created = (
        (await db.execute(select(AuditLog).where(AuditLog.action == "admin.user_created")))
        .scalars()
        .all()
    )
    assert [row.details.get("via") for row in created if row.target_id == me["id"]] == ["sso"]

    # No password: password login fails cleanly, changing it (or 2FA) is refused.
    login = await client.post(
        "/api/v1/auth/login",
        json={"username": "taro-2", "password": "", "device": {"platform": "desktop"}},
    )
    assert login.status_code == 401 and login.json()["error"]["code"] == "invalid_credentials"
    headers = {"Authorization": f"Bearer {tokens.json()['access_token']}"}
    change = await client.put(
        "/api/v1/users/me/password",
        json={"current_password": "", "new_password": "a-new-password"},
        headers=headers,
    )
    assert change.status_code == 409 and change.json()["error"]["code"] == "password_not_set"
    totp = await client.post("/api/v1/auth/totp/setup", json={"password": ""}, headers=headers)
    assert totp.status_code == 409 and totp.json()["error"]["code"] == "password_not_set"

    # The second sign-in finds the same account through the link.
    again = await sign_in(client, google, platform="android")
    second = await exchange(client, again["ticket"], platform="android")
    assert second.json()["user"]["id"] == me["id"]


@pytest.mark.parametrize("saved", ["lounge", "empty"])
async def test_the_admins_default_channels_win_over_the_env_once_set(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    google: FakeOIDC,
    as_user: Callable[[User], None],
    saved: str,
) -> None:
    """M90: SSO_DEFAULT_CHANNELS applies only while the administrator never saved the list; once
    saved (even empty) the list decides."""
    configure(app, sso_auto_provision=True, sso_default_channels="general")
    root = await make_user(db, "root", role="admin")
    as_user(root)
    await client.post("/api/v1/channels", json={"name": "general"})
    lounge = (await client.post("/api/v1/channels", json={"name": "lounge"})).json()
    shown = (await client.get("/api/v1/admin/workspace-settings")).json()
    assert shown["legacy_sso_default_channels"] == ["general"]
    ids = [lounge["id"]] if saved == "lounge" else []
    patched = await client.patch(
        "/api/v1/admin/workspace-settings", json={"default_channel_ids": ids}
    )
    assert patched.json()["legacy_sso_default_channels"] == []
    app.dependency_overrides.pop(get_current_user, None)

    back = await sign_in(client, google, platform="android")
    tokens = await exchange(client, back["ticket"], platform="android")
    assert tokens.status_code == 200, tokens.text
    joined = (
        (
            await db.execute(
                select(ChannelMember.channel_id).where(
                    ChannelMember.user_id == uuid.UUID(tokens.json()["user"]["id"])
                )
            )
        )
        .scalars()
        .all()
    )
    assert [str(c) for c in joined] == ids


async def test_deactivated_accounts_are_refused(
    client: AsyncClient, db: AsyncSession, google: FakeOIDC
) -> None:
    taro = await make_user(db, "taro")
    await set_email(db, taro, "taro@example.ac.jp")
    taro.deactivated_at = utcnow()
    await db.commit()
    assert await sign_in(client, google) == {"sso_error": "account_disabled"}
    assert await db.scalar(select(UserIdentity.id)) is None

    taro.deactivated_at = None
    await db.commit()
    assert "sso_ticket" in await sign_in(client, google)  # linked now
    taro.deactivated_at = utcnow()
    await db.commit()
    assert await sign_in(client, google) == {"sso_error": "account_disabled"}


def test_username_is_derived_from_the_local_part() -> None:
    assert sso.username_base("Taro.Yamada@example.ac.jp") == "taro.yamada"
    assert sso.username_base("t+chat@example.ac.jp") == "t-chat"
    assert sso.username_base("ab@example.ac.jp") == "ab-user"
    assert sso.username_base("+@example.ac.jp") == "user"
    assert sso.username_base(("x" * 40) + "@example.ac.jp") == "x" * 32


# --- tickets -------------------------------------------------------------------------------


async def test_ticket_needs_the_verifier_and_platform_of_the_app_that_started(
    client: AsyncClient, db: AsyncSession, google: FakeOIDC
) -> None:
    taro = await make_user(db, "taro")
    await set_email(db, taro, "taro@example.ac.jp")

    # Another app that read the redirect has the ticket but not the verifier; the attempt spends it.
    ticket = (await sign_in(client, google, platform="ios"))["ticket"]
    wrong = await exchange(client, ticket, verifier="w" * 43, platform="ios")
    assert wrong.status_code == 401 and wrong.json()["error"]["code"] == "invalid_ticket"
    assert (await exchange(client, ticket, platform="ios")).status_code == 401

    ticket = (await sign_in(client, google, platform="ios"))["ticket"]
    assert (await exchange(client, ticket, platform="android")).status_code == 401

    ticket = (await sign_in(client, google, platform="ios"))["ticket"]
    await db.execute(update(SsoTicket).values(expires_at=utcnow() - timedelta(seconds=1)))
    await db.commit()
    assert (await exchange(client, ticket, platform="ios")).status_code == 401

    assert (await exchange(client, "not a ticket", platform="ios")).status_code == 401
    short = await client.post(
        EXCHANGE, json={"ticket": ticket, "verifier": "short", "device": {"platform": "ios"}}
    )
    assert short.status_code == 422

    # The account was disabled between the callback and the exchange.
    ticket = (await sign_in(client, google, platform="ios"))["ticket"]
    taro.deactivated_at = utcnow()
    await db.commit()
    disabled = await exchange(client, ticket, platform="ios")
    assert disabled.status_code == 401 and disabled.json()["error"]["code"] == "account_disabled"


async def test_expired_requests_and_tickets_are_purged(
    client: AsyncClient, db: AsyncSession, google: FakeOIDC
) -> None:
    taro = await make_user(db, "taro")
    await set_email(db, taro, "taro@example.ac.jp")
    await sign_in(client, google)
    await begin(client)
    assert await sso.purge_expired(db, utcnow()) == 0
    assert await sso.purge_expired(db, utcnow() + timedelta(hours=2)) == 3
    await db.commit()
    assert await db.scalar(select(SsoRequest.state)) is None


# --- has_password and the reserved addresses -------------------------------------------------


async def test_password_accounts_report_has_password(client: AsyncClient, db: AsyncSession) -> None:
    await make_user(db, "alice", password=PASSWORD)
    login = await client.post(
        "/api/v1/auth/login",
        json={"username": "alice", "password": PASSWORD, "device": {"platform": "desktop"}},
    )
    assert login.json()["user"]["has_password"] is True


async def test_members_cannot_claim_an_address_of_a_sign_in_domain(
    client: AsyncClient, db: AsyncSession, google: FakeOIDC, as_user: Callable[[User], None]
) -> None:
    mallory = await make_user(db, "mallory")
    as_user(mallory)
    claim = await client.patch("/api/v1/users/me", json={"email": "victim@EXAMPLE.ac.jp"})
    assert claim.status_code == 403 and claim.json()["error"]["code"] == "email_domain_reserved"
    other = await client.patch("/api/v1/users/me", json={"email": "mallory@gmail.com"})
    assert other.status_code == 200


async def test_anonymizing_forgets_the_google_account(
    client: AsyncClient, db: AsyncSession, google: FakeOIDC, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    taro = await make_user(db, "taro")
    await set_email(db, taro, "taro@example.ac.jp")
    assert "sso_ticket" in await sign_in(client, google)
    as_user(root)
    erased = await client.post(f"/api/v1/admin/users/{taro.id}/anonymize")
    assert erased.status_code in (200, 204), erased.text
    assert await db.scalar(select(UserIdentity.id)) is None
    assert await db.scalar(select(SsoTicket.ticket_hash)) is None
