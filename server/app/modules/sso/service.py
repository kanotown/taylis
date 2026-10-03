"""Google sign-in (M48, docs/SSO.md): start → Google → callback → one-time ticket → tokens.

The browser is bound to the sign-in by the state cookie (login CSRF), Google's code by PKCE, the ID
token by the nonce, and the ticket to the app that started the sign-in by the app's own PKCE-like
verifier: a ticket read by another app (a custom URL scheme is not exclusive) cannot be exchanged.
States and tickets are single use: they are marked used and committed before any check can fail.
"""

import base64
import hashlib
import hmac
import logging
import re
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import NamedTuple

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, unauthorized
from app.core.security import hash_token
from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.admin import service as admin
from app.modules.admin.schemas import AdminUserCreate
from app.modules.audit import service as audit
from app.modules.auth import service as auth
from app.modules.auth.schemas import TokenResponse
from app.modules.groups import service as groups
from app.modules.groups.schemas import RESERVED_NAMES
from app.modules.sso import repository as repo
from app.modules.sso.models import SsoRequest, SsoTicket, UserIdentity
from app.modules.sso.oidc import OIDCClaims, OIDCError, OIDCProvider
from app.modules.sso.schemas import SsoErrorCode, SsoExchange, SsoPlatform
from app.modules.users import service as users
from app.modules.users.models import User

log = logging.getLogger("app.sso")

REQUEST_TTL = timedelta(minutes=10)
TICKET_TTL = timedelta(minutes=2)
COOKIE = "chikuwa_sso"
COOKIE_PATH = "/api/v1/auth/sso"
NATIVE_RETURN = "chikuwachat://sso"
TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{20,128}$")  # states and tickets (token_urlsafe)
_USERNAME_INVALID = re.compile(r"[^a-z0-9._-]+")


class SsoFailure(Exception):
    def __init__(self, code: SsoErrorCode) -> None:
        super().__init__(code)
        self.code: SsoErrorCode = code


def s256(value: str) -> str:
    """base64url(SHA-256(value)) without padding (RFC 7636 S256)."""
    digest = hashlib.sha256(value.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def callback_uri(settings: Settings) -> str:
    return f"{settings.public_base_url.rstrip('/')}/api/v1/auth/sso/google/callback"


def return_url(
    settings: Settings, platform: str, *, ticket: str | None = None, error: str | None = None
) -> str:
    """Where the browser goes back to (§3 step 6). The web page gets a fragment, which stays out of
    access logs and referrers; the apps get their custom scheme."""
    value = ticket if ticket is not None else error
    if platform == "web":
        key = "sso_ticket" if ticket is not None else "sso_error"
        return f"{settings.public_base_url.rstrip('/')}/#{key}={value}"
    key = "ticket" if ticket is not None else "sso_error"
    return f"{NATIVE_RETURN}?{key}={value}"


class Completion(NamedTuple):
    """Where the callback sends the browser, and for which client (the router answers a desktop
    sign-in with a page instead of a bare redirect to the custom scheme)."""

    location: str
    platform: str


def cookie_secure(settings: Settings) -> bool:
    return settings.public_base_url.startswith("https://")


# --- start ---------------------------------------------------------------------------------


async def start(
    db: AsyncSession,
    provider: OIDCProvider,
    settings: Settings,
    platform: SsoPlatform,
    challenge: str,
) -> tuple[str, str]:
    """A new sign-in; returns Google's authorization URL and the state for the cookie."""
    now = utcnow()
    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    code_verifier = secrets.token_urlsafe(64)  # 86 characters, within RFC 7636's 43-128
    db.add(
        SsoRequest(
            state=state,
            nonce=nonce,
            code_verifier=code_verifier,
            challenge=challenge,
            platform=platform,
            created_at=now,
            expires_at=now + REQUEST_TTL,
        )
    )
    await db.commit()
    domains = settings.sso_allowed_domains
    url = provider.authorize_url(
        state=state,
        nonce=nonce,
        code_challenge=s256(code_verifier),
        redirect_uri=callback_uri(settings),
        hd=domains[0] if len(domains) == 1 else None,
    )
    return url, state


# --- callback ------------------------------------------------------------------------------


@dataclass(frozen=True)
class _Pending:
    nonce: str
    code_verifier: str
    challenge: str
    platform: str
    expires_at: datetime


async def complete(
    db: AsyncSession,
    provider: OIDCProvider,
    settings: Settings,
    *,
    state: str | None,
    code: str | None,
    error: str | None,
    cookie: str | None,
    ip: str | None,
) -> Completion:
    """Google's return: the URL to send the browser to, with a ticket or an error code."""
    row = await repo.get_request(db, state) if state and TOKEN_PATTERN.match(state) else None
    if row is None:
        # Unknown state: nothing says which app started it, so the web page gets the error.
        log.info("sso sign-in refused", extra={"reason": "expired", "ip": ip})
        return Completion(return_url(settings, "web", error="expired"), "web")
    now = utcnow()
    pending = _Pending(row.nonce, row.code_verifier, row.challenge, row.platform, row.expires_at)
    first_use = row.used_at is None
    if first_use:
        row.used_at = now
    await db.commit()  # used, whatever happens next
    try:
        if error:
            raise SsoFailure("cancelled" if error == "access_denied" else "provider_error")
        if not first_use or pending.expires_at <= now:
            raise SsoFailure("expired")
        # Login CSRF: the callback must come back to the browser that started (§1).
        if not cookie or not hmac.compare_digest(cookie.encode(), (state or "").encode()):
            raise SsoFailure("expired")
        if not code:
            raise SsoFailure("provider_error")
        try:
            claims = await provider.authenticate(
                code=code,
                code_verifier=pending.code_verifier,
                redirect_uri=callback_uri(settings),
            )
        except OIDCError as exc:
            log.warning("sso provider error: %s", exc, extra={"ip": ip})
            raise SsoFailure("provider_error") from exc
        _check_claims(claims, pending, settings)
        ticket = await _issue_ticket(db, provider.name, claims, pending, settings, now)
    except SsoFailure as failure:
        await db.rollback()
        log.info("sso sign-in refused", extra={"reason": failure.code, "ip": ip})
        return Completion(
            return_url(settings, pending.platform, error=failure.code), pending.platform
        )
    return Completion(return_url(settings, pending.platform, ticket=ticket), pending.platform)


def _check_claims(claims: OIDCClaims, pending: _Pending, settings: Settings) -> None:
    if not claims.nonce or not hmac.compare_digest(claims.nonce.encode(), pending.nonce.encode()):
        raise SsoFailure("provider_error")  # a replayed or substituted ID token
    if not claims.email or not claims.email_verified:
        raise SsoFailure("email_not_verified")
    # `hd` is set only for Workspace accounts; a consumer account at a Workspace domain's address
    # (possible for addresses the Workspace does not manage) has none and is refused.
    hosted = (claims.hosted_domain or "").lower()
    email_domain = claims.email.rsplit("@", 1)[-1].lower()
    if hosted not in settings.sso_allowed_domains or email_domain != hosted:
        raise SsoFailure("domain_not_allowed")


async def _issue_ticket(
    db: AsyncSession,
    provider: str,
    claims: OIDCClaims,
    pending: _Pending,
    settings: Settings,
    now: datetime,
) -> str:
    """Find (or link, or make) the user and store a ticket for them, committed. A concurrent first
    sign-in of the same person (or of two people deriving one username) is retried once."""
    for attempt in range(2):
        try:
            user = await _resolve_user(db, provider, claims, settings, now)
            ticket = secrets.token_urlsafe(32)
            db.add(
                SsoTicket(
                    ticket_hash=hash_token(ticket),
                    user_id=user.id,
                    challenge=pending.challenge,
                    platform=pending.platform,
                    created_at=now,
                    expires_at=now + TICKET_TTL,
                )
            )
            await db.commit()
            return ticket
        except (IntegrityError, AppError) as exc:
            await db.rollback()
            if isinstance(exc, AppError) and exc.status != 409:
                raise
            if attempt == 1:
                log.warning("sso account could not be created: %s", type(exc).__name__)
                raise SsoFailure("provider_error") from exc
    raise AssertionError("unreachable")


async def _resolve_user(
    db: AsyncSession, provider: str, claims: OIDCClaims, settings: Settings, now: datetime
) -> User:
    """§4: the linked account, else the account with that address, else a new one (option B)."""
    assert claims.email is not None
    identity = await repo.get_identity(db, provider, claims.subject)
    if identity is not None:
        user = await users.get_user(db, identity.user_id, for_update=True)
        if user is None or not user.is_active or user.role == "bot":
            raise SsoFailure("account_disabled")
        identity.last_login_at = now
        return user
    user = await repo.get_user_by_email(db, claims.email)
    if user is not None:
        if not user.is_active or user.role == "bot":
            raise SsoFailure("account_disabled")
        await _link(db, user, provider, claims, now)
        if user.must_change_password:
            # The administrator's temporary password was never the person's own: Google replaces
            # it, rather than the app asking them to change a password they were never told.
            user.password_hash = None
            user.must_change_password = False
            user.updated_at = now
        await audit.record_in_tx(
            db,
            actor_id=user.id,
            action="auth.sso_linked",
            target_type="user",
            target_id=user.id,
            details={"provider": provider, "email": claims.email},
        )
        return user
    if not settings.sso_auto_provision:
        raise SsoFailure("not_registered")
    username = await _free_username(db, claims.email)
    user = await admin.create_user_in_tx(
        db,
        AdminUserCreate(
            username=username,
            display_name=(claims.name or "").strip()[:80] or username,
            email=claims.email.lower(),
            role="member",
        ),
        password_hash=None,
        must_change_password=False,
        actor_id=None,
        details={"via": "sso", "provider": provider},
        # M90: the administrator's default channels; SSO_DEFAULT_CHANNELS only while those were
        # never set (deprecated).
        legacy_default_channels=settings.sso_default_channel_names,
    )
    await _link(db, user, provider, claims, now)
    return user


async def _link(
    db: AsyncSession, user: User, provider: str, claims: OIDCClaims, now: datetime
) -> None:
    db.add(
        UserIdentity(
            user_id=user.id,
            provider=provider,
            subject=claims.subject,
            email=claims.email,
            created_at=now,
            last_login_at=now,
        )
    )
    await db.flush()


def username_base(email: str) -> str:
    """The part before @, in the characters a username allows (USERNAME_PATTERN), 3-32 long."""
    local = email.split("@", 1)[0].lower()
    base = _USERNAME_INVALID.sub("-", local).strip("-")
    if len(base) < 3:
        base = f"{base}-user" if base else "user"
    return base[:32]


async def _free_username(db: AsyncSession, email: str) -> str:
    base = username_base(email)
    for n in range(1, 1000):
        suffix = "" if n == 1 else f"-{n}"
        candidate = base[: 32 - len(suffix)] + suffix
        if candidate in RESERVED_NAMES:  # @here, @channel …
            continue
        if not await repo.username_taken(db, candidate) and not await groups.name_in_use(
            db, candidate
        ):
            return candidate
    raise SsoFailure("provider_error")


# --- exchange ------------------------------------------------------------------------------


def _invalid_ticket() -> AppError:
    return unauthorized("invalid_ticket", "Invalid or expired sign-in ticket")


async def exchange(
    db: AsyncSession, data: SsoExchange, settings: Settings, ip: str | None
) -> TokenResponse:
    """The ticket and the verifier of the app that started the sign-in → a session (§3)."""
    if not TOKEN_PATTERN.match(data.ticket):
        raise _invalid_ticket()
    row = await repo.get_ticket(db, hash_token(data.ticket))
    if row is None:
        raise _invalid_ticket()
    now = utcnow()
    first_use = row.used_at is None
    if first_use:
        row.used_at = now
    user_id: uuid.UUID = row.user_id
    challenge, platform, expires_at = row.challenge, row.platform, row.expires_at
    await db.commit()  # one attempt per ticket, successful or not
    if (
        not first_use
        or expires_at <= now
        or not hmac.compare_digest(challenge.encode(), s256(data.verifier).encode())
        or platform != data.device.platform
    ):
        log.info("sso ticket refused", extra={"ip": ip})
        raise _invalid_ticket()
    user = await users.get_user(db, user_id, for_update=True)
    if user is None or not user.is_active or user.role == "bot":
        raise unauthorized("account_disabled", "Account disabled")
    # No second factor here: Google's own 2-step verification covers SSO sign-ins (§4).
    await audit.record_in_tx(
        db,
        actor_id=user.id,
        action="auth.sso_login",
        target_type="user",
        target_id=user.id,
        details={"platform": platform},
    )
    return await auth.open_session(db, user, data.device, settings, ip, now)


async def purge_expired(db: AsyncSession, now: datetime) -> int:
    """The hourly sweep (app.main); the caller commits."""
    return await repo.purge_expired(db, now)
