"""OpenID Connect providers (M48, docs/SSO.md §1). Only the server talks to the identity provider.

`OIDCProvider` is the boundary: `GoogleOIDC` in production, a fake in the tests. A provider builds
the authorization URL and turns an authorization code into verified ID-token claims (signature,
issuer, audience, expiry); the policy checks (nonce, verified e-mail, allowed domain) belong to the
service, so they are the same for every provider.
"""

import asyncio
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlencode

import httpx
import jwt

from app.core.settings import Settings

log = logging.getLogger("app.sso")


class OIDCError(Exception):
    """The provider could not be reached, refused the code, or sent a token that fails checks."""


@dataclass(frozen=True)
class OIDCClaims:
    subject: str
    email: str | None
    email_verified: bool
    hosted_domain: str | None  # Google's `hd`: the Workspace domain; None for consumer accounts
    name: str | None
    nonce: str | None


class OIDCProvider(Protocol):
    name: str

    def authorize_url(
        self, *, state: str, nonce: str, code_challenge: str, redirect_uri: str, hd: str | None
    ) -> str: ...

    async def authenticate(self, *, code: str, code_verifier: str, redirect_uri: str) -> OIDCClaims:
        """Exchange the code (with the PKCE verifier) and verify the ID token."""
        ...


class SigningKeySource(Protocol):
    """What GoogleOIDC needs from PyJWKClient (a fake JWKS in the tests)."""

    def get_signing_key_from_jwt(self, token: str) -> jwt.PyJWK: ...


class GoogleOIDC:
    name = "google"
    AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
    TOKEN_URL = "https://oauth2.googleapis.com/token"
    JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
    ISSUERS = ("https://accounts.google.com", "accounts.google.com")

    def __init__(
        self,
        client_id: str,
        client_secret: str,
        *,
        keys: SigningKeySource | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout_seconds: float = 10.0,
    ) -> None:
        self.client_id = client_id
        self._client_secret = client_secret
        # Google rotates its keys every few weeks; PyJWKClient refetches the set on an unknown kid.
        self._keys: SigningKeySource = keys or jwt.PyJWKClient(
            self.JWKS_URL, cache_keys=True, lifespan=3600, timeout=int(timeout_seconds)
        )
        self._transport = transport
        self._timeout = timeout_seconds

    def authorize_url(
        self, *, state: str, nonce: str, code_challenge: str, redirect_uri: str, hd: str | None
    ) -> str:
        params = {
            "client_id": self.client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": "openid email profile",
            "state": state,
            "nonce": nonce,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
            "prompt": "select_account",
        }
        if hd:
            params["hd"] = hd  # only narrows Google's account chooser; the ID token is checked
        return f"{self.AUTHORIZE_URL}?{urlencode(params)}"

    async def authenticate(self, *, code: str, code_verifier: str, redirect_uri: str) -> OIDCClaims:
        id_token = await self._exchange(code, code_verifier, redirect_uri)
        return await self.verify_id_token(id_token)

    async def _exchange(self, code: str, code_verifier: str, redirect_uri: str) -> str:
        data = {
            "code": code,
            "client_id": self.client_id,
            "client_secret": self._client_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
            "code_verifier": code_verifier,
        }
        try:
            async with httpx.AsyncClient(timeout=self._timeout, transport=self._transport) as http:
                response = await http.post(
                    self.TOKEN_URL, data=data, headers={"Accept": "application/json"}
                )
        except httpx.HTTPError as exc:
            raise OIDCError(f"token endpoint unreachable: {type(exc).__name__}") from exc
        if response.status_code != 200:
            # The body names the OAuth error (invalid_grant, …); it carries no secret of ours.
            status, body = response.status_code, response.text[:200]
            raise OIDCError(f"token endpoint answered {status}: {body}")
        try:
            token = response.json().get("id_token")
        except ValueError as exc:
            raise OIDCError("token endpoint sent no JSON") from exc
        if not isinstance(token, str) or not token:
            raise OIDCError("token endpoint sent no id_token")
        return token

    async def verify_id_token(self, id_token: str) -> OIDCClaims:
        try:
            key = await asyncio.to_thread(self._keys.get_signing_key_from_jwt, id_token)
            claims: dict[str, Any] = jwt.decode(
                id_token,
                key.key,
                algorithms=["RS256"],
                audience=self.client_id,
                leeway=60,
                options={"require": ["iss", "aud", "exp", "iat", "sub"]},
            )
        except (jwt.PyJWTError, jwt.PyJWKClientError) as exc:
            raise OIDCError(f"invalid id token: {type(exc).__name__}") from exc
        if claims.get("iss") not in self.ISSUERS:
            raise OIDCError("invalid id token: issuer")
        subject = claims.get("sub")
        if not isinstance(subject, str) or not subject:
            raise OIDCError("invalid id token: subject")
        email = claims.get("email")
        hd = claims.get("hd")
        name = claims.get("name")
        nonce = claims.get("nonce")
        return OIDCClaims(
            subject=subject,
            email=email if isinstance(email, str) else None,
            # Google sends a boolean; very old tokens sent the string "true".
            email_verified=claims.get("email_verified") in (True, "true"),
            hosted_domain=hd if isinstance(hd, str) else None,
            name=name if isinstance(name, str) else None,
            nonce=nonce if isinstance(nonce, str) else None,
        )


def _client_secret(settings: Settings) -> tuple[str, str | None]:
    """The secret and, when it cannot be read, why."""
    if settings.sso_google_client_secret_file:
        try:
            secret = Path(settings.sso_google_client_secret_file).read_text().strip()
        except OSError as exc:
            return "", f"SSO_GOOGLE_CLIENT_SECRET_FILE is not readable ({type(exc).__name__})"
        return secret, None if secret else "SSO_GOOGLE_CLIENT_SECRET_FILE is empty"
    secret = settings.sso_google_client_secret.strip()
    return secret, None if secret else "SSO_GOOGLE_CLIENT_SECRET(_FILE) is not set"


def build_google(settings: Settings) -> GoogleOIDC | None:
    """The Google provider when every setting is present (§2); otherwise None, and the log says
    why (only when something was configured, so a server without SSO stays quiet)."""
    configured = any(
        (
            settings.sso_google_client_id,
            settings.sso_google_client_secret,
            settings.sso_google_client_secret_file,
            settings.sso_google_allowed_domains,
        )
    )
    if not configured:
        return None
    problems: list[str] = []
    if not settings.sso_google_client_id.strip():
        problems.append("SSO_GOOGLE_CLIENT_ID is not set")
    secret, problem = _client_secret(settings)
    if problem:
        problems.append(problem)
    if not settings.sso_allowed_domains:
        problems.append("SSO_GOOGLE_ALLOWED_DOMAINS is empty")
    if not settings.public_base_url.strip().startswith(("https://", "http://")):
        problems.append("PUBLIC_BASE_URL is not set")
    if problems:
        log.warning("Google sign-in stays disabled: %s", "; ".join(problems))
        return None
    log.info(
        "Google sign-in enabled for %s (auto-provision %s)",
        ", ".join(settings.sso_allowed_domains),
        "on" if settings.sso_auto_provision else "off",
    )
    return GoogleOIDC(settings.sso_google_client_id.strip(), secret)
