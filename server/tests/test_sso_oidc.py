"""GoogleOIDC (M48) without the network: a locally generated RSA key behind a fake JWKS, and the
token endpoint behind httpx's MockTransport."""

import json
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm

from app.core.settings import build_settings
from app.modules.sso.oidc import GoogleOIDC, OIDCError, build_google

CLIENT_ID = "test-client.apps.googleusercontent.com"


def _key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


KEY = _key()
OTHER_KEY = _key()


class LocalJWKS(jwt.PyJWKClient):
    """PyJWKClient itself (kid lookup, caching), fed a JWKS from memory instead of Google."""

    def __init__(self, jwks: dict[str, Any]) -> None:
        super().__init__("https://jwks.invalid/certs")
        self._jwks = jwks
        self.fetches = 0

    def fetch_data(self) -> Any:
        self.fetches += 1
        return self._jwks


def jwks(*pairs: tuple[str, rsa.RSAPrivateKey]) -> dict[str, Any]:
    keys = []
    for kid, key in pairs:
        jwk = json.loads(RSAAlgorithm.to_jwk(key.public_key()))
        keys.append({**jwk, "kid": kid, "use": "sig", "alg": "RS256"})
    return {"keys": keys}


def id_token(key: rsa.RSAPrivateKey = KEY, kid: str = "k1", **changes: Any) -> str:
    now = int(time.time())
    payload = {
        "iss": "https://accounts.google.com",
        "aud": CLIENT_ID,
        "sub": "1234567890",
        "email": "taro@example.ac.jp",
        "email_verified": True,
        "hd": "example.ac.jp",
        "name": "山田 太郎",
        "nonce": "n-1",
        "iat": now,
        "exp": now + 3600,
        **changes,
    }
    payload = {k: v for k, v in payload.items() if v is not None}
    return jwt.encode(payload, key, algorithm="RS256", headers={"kid": kid})


def provider(transport: httpx.AsyncBaseTransport | None = None) -> GoogleOIDC:
    return GoogleOIDC(
        CLIENT_ID, "not-a-secret", keys=LocalJWKS(jwks(("k1", KEY))), transport=transport
    )


async def test_a_valid_id_token_gives_its_claims() -> None:
    claims = await provider().verify_id_token(id_token())
    assert claims.subject == "1234567890" and claims.email == "taro@example.ac.jp"
    assert claims.email_verified is True and claims.hosted_domain == "example.ac.jp"
    assert claims.name == "山田 太郎" and claims.nonce == "n-1"
    # The short issuer form Google also uses; a consumer account has no hd.
    short = await provider().verify_id_token(id_token(iss="accounts.google.com", hd=None))
    assert short.hosted_domain is None
    unverified = await provider().verify_id_token(id_token(email_verified=False))
    assert unverified.email_verified is False


@pytest.mark.parametrize(
    "token",
    [
        pytest.param(lambda: id_token(aud="someone-else"), id="audience"),
        pytest.param(lambda: id_token(iss="https://evil.example"), id="issuer"),
        pytest.param(lambda: id_token(exp=int(time.time()) - 600), id="expired"),
        pytest.param(lambda: id_token(key=OTHER_KEY), id="signature"),
        pytest.param(lambda: id_token(kid="unknown"), id="unknown-key"),
        pytest.param(lambda: id_token(sub=None), id="no-subject"),
        pytest.param(
            lambda: jwt.encode({"sub": "1", "aud": CLIENT_ID}, "h" * 32, algorithm="HS256"),
            id="hmac",
        ),
        pytest.param(lambda: "not.a.token", id="garbage"),
    ],
)
async def test_bad_id_tokens_are_refused(token: Any) -> None:
    with pytest.raises(OIDCError):
        await provider().verify_id_token(token())


async def test_code_exchange_sends_the_pkce_verifier_and_verifies_the_token() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"id_token": id_token(), "access_token": "ignored"})

    claims = await provider(httpx.MockTransport(handler)).authenticate(
        code="the-code", code_verifier="pkce-verifier", redirect_uri="https://chat/cb"
    )
    assert claims.subject == "1234567890"
    assert str(seen[0].url) == GoogleOIDC.TOKEN_URL
    form = parse_qs(seen[0].content.decode())
    assert form == {
        "code": ["the-code"],
        "client_id": [CLIENT_ID],
        "client_secret": ["not-a-secret"],
        "redirect_uri": ["https://chat/cb"],
        "grant_type": ["authorization_code"],
        "code_verifier": ["pkce-verifier"],
    }


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(400, json={"error": "invalid_grant"}),
        httpx.Response(200, json={"access_token": "no id token"}),
        httpx.Response(200, text="<html>"),
    ],
)
async def test_token_endpoint_failures_are_provider_errors(response: httpx.Response) -> None:
    transport = httpx.MockTransport(lambda _: response)
    with pytest.raises(OIDCError):
        await provider(transport).authenticate(code="c", code_verifier="v", redirect_uri="r")


async def test_unreachable_token_endpoint_is_a_provider_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down", request=request)

    with pytest.raises(OIDCError):
        await provider(httpx.MockTransport(handler)).authenticate(
            code="c", code_verifier="v", redirect_uri="r"
        )


def test_authorize_url() -> None:
    url = urlparse(
        provider().authorize_url(
            state="s", nonce="n", code_challenge="c", redirect_uri="https://chat/cb", hd="ex.jp"
        )
    )
    assert f"{url.scheme}://{url.netloc}{url.path}" == GoogleOIDC.AUTHORIZE_URL
    assert parse_qs(url.query) == {
        "client_id": [CLIENT_ID],
        "redirect_uri": ["https://chat/cb"],
        "response_type": ["code"],
        "scope": ["openid email profile"],
        "state": ["s"],
        "nonce": ["n"],
        "code_challenge": ["c"],
        "code_challenge_method": ["S256"],
        "prompt": ["select_account"],
        "hd": ["ex.jp"],
    }


def test_build_google_needs_every_setting(tmp_path: Path) -> None:
    assert build_google(build_settings()) is None  # not configured at all
    full = {
        "sso_google_client_id": CLIENT_ID,
        "sso_google_client_secret": "not-a-secret",
        "sso_google_allowed_domains": "example.ac.jp",
        "public_base_url": "https://chat.example.ac.jp",
    }
    assert isinstance(build_google(build_settings(**full)), GoogleOIDC)
    for missing in full:
        assert build_google(build_settings(**{**full, missing: ""})) is None, missing
    secret_file = tmp_path / "google_client_secret"
    secret_file.write_text("from-a-file\n")
    from_file = build_google(
        build_settings(
            **{
                **full,
                "sso_google_client_secret": "",
                "sso_google_client_secret_file": str(secret_file),
            }
        )
    )
    assert from_file is not None and from_file._client_secret == "from-a-file"
    missing_file = {**full, "sso_google_client_secret_file": str(tmp_path / "nope")}
    assert build_google(build_settings(**missing_file)) is None
