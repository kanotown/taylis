"""Two-factor authentication with an authenticator app (M12i, SECURITY.md §2.7).

A leaf module: `auth.login` asks `check_login` for the second factor, `admin` lists who has it
on. Wrong codes or passwords inside a session answer 422 (a 401 would sign the client out).
"""

import base64
import hmac
import logging
import uuid
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, conflict, unauthorized
from app.core.security import hash_token, verify_password
from app.core.time import utcnow
from app.modules.audit import service as audit
from app.modules.totp import otp
from app.modules.totp import repository as repo
from app.modules.totp.models import UserTotp
from app.modules.totp.schemas import TotpEnabledOut, TotpSetupOut, TotpStatusOut
from app.modules.users.models import User

log = logging.getLogger("app.totp")


def _invalid_password() -> AppError:
    return AppError(422, "invalid_password", "Invalid password")


def _invalid_code() -> AppError:
    return AppError(422, "invalid_totp", "Invalid two-factor code")


async def status(db: AsyncSession, user_id: uuid.UUID) -> TotpStatusOut:
    row = await repo.get(db, user_id)
    enabled = row is not None and row.enabled_at is not None
    return TotpStatusOut(
        enabled=enabled,
        enabled_at=row.enabled_at if row is not None and enabled else None,
        recovery_codes_left=len(row.recovery_hashes) if row is not None and enabled else 0,
    )


async def begin_setup(db: AsyncSession, user: User, password: str, issuer: str) -> TotpSetupOut:
    """A fresh secret in the pending state; the user confirms it with `enable`."""
    if user.password_hash is None:
        # M48: Google sign-in never asks for the code, and there is no password to protect.
        raise conflict("password_not_set", "This account signs in with Google and has no password")
    if not await verify_password(user.password_hash, password):
        raise _invalid_password()
    now = utcnow()
    row = await repo.get(db, user.id, for_update=True)
    if row is not None and row.enabled_at is not None:
        raise conflict("totp_already_enabled", "Two-factor authentication is already enabled")
    secret = otp.generate_secret()
    if row is None:
        row = UserTotp(user_id=user.id, secret=secret, recovery_hashes=[], created_at=now)
        db.add(row)
    else:
        row.secret = secret
    row.updated_at = now
    await db.commit()
    uri = otp.provisioning_uri(secret, user.username, issuer)
    return TotpSetupOut(
        secret=otp.base32(secret),
        otpauth_uri=uri,
        qr_png_base64=base64.b64encode(otp.qr_png(uri)).decode("ascii"),
    )


async def enable(db: AsyncSession, user: User, code: str) -> TotpEnabledOut:
    row = await repo.get(db, user.id, for_update=True)
    if row is None:
        raise conflict("totp_setup_required", "Start the setup first")
    if row.enabled_at is not None:
        raise conflict("totp_already_enabled", "Two-factor authentication is already enabled")
    now = utcnow()
    normalized = otp.normalize_code(code)
    step = otp.matching_step(row.secret, normalized, now) if otp.is_totp_shape(normalized) else None
    if step is None:
        raise _invalid_code()
    codes = otp.recovery_codes()
    row.enabled_at = now
    row.last_used_step = step
    row.recovery_hashes = [hash_token(otp.normalize_recovery(c)) for c in codes]
    row.updated_at = now
    await audit.record_in_tx(
        db, actor_id=user.id, action="auth.totp_enabled", target_type="user", target_id=user.id
    )
    await db.commit()
    return TotpEnabledOut(recovery_codes=codes)


async def disable(db: AsyncSession, user: User, password: str) -> None:
    if not await verify_password(user.password_hash, password):
        raise _invalid_password()
    if await repo.remove(db, user.id):
        await audit.record_in_tx(
            db, actor_id=user.id, action="auth.totp_disabled", target_type="user", target_id=user.id
        )
    await db.commit()


async def remove_in_tx(db: AsyncSession, user_id: uuid.UUID) -> None:
    """The caller's transaction drops the second factor (an anonymized account)."""
    await repo.remove(db, user_id)


async def admin_reset(db: AsyncSession, actor: User, user_id: uuid.UUID) -> None:
    """For a member who lost the authenticator: 2FA off, they log in with the password alone."""
    if await repo.remove(db, user_id):
        await audit.record_in_tx(
            db, actor_id=actor.id, action="admin.totp_reset", target_type="user", target_id=user_id
        )
    await db.commit()


async def enabled_user_ids(db: AsyncSession, ids: list[uuid.UUID]) -> set[uuid.UUID]:
    return await repo.enabled_ids(db, ids)


async def check_login(
    db: AsyncSession, user_id: uuid.UUID, code: str | None, now: datetime
) -> None:
    """The second factor of a login whose password was right; the caller commits.

    Raises 401 totp_required when the user has 2FA and sent no code, 401 invalid_totp when the
    code is wrong, already used, or not one of the remaining recovery codes.
    """
    row = await repo.get(db, user_id, for_update=True)
    if row is None or row.enabled_at is None:
        return
    if not code:
        raise unauthorized("totp_required", "Two-factor code required")
    normalized = otp.normalize_code(code)
    if otp.is_totp_shape(normalized):
        step = otp.matching_step(row.secret, normalized, now)
        if step is not None and (row.last_used_step is None or step > row.last_used_step):
            row.last_used_step = step
            row.updated_at = now
            return
    else:
        digest = hash_token(otp.normalize_recovery(normalized))
        remaining = [h for h in row.recovery_hashes if not hmac.compare_digest(h, digest)]
        if len(remaining) < len(row.recovery_hashes):
            row.recovery_hashes = remaining
            row.updated_at = now
            log.info("recovery code used", extra={"user_id": str(user_id)})
            return
    log.warning("two-factor code rejected", extra={"user_id": str(user_id)})
    raise unauthorized("invalid_totp", "Invalid two-factor code")
