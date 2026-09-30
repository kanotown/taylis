import uuid
from datetime import datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.sso.models import SsoRequest, SsoTicket, UserIdentity
from app.modules.users.models import User


async def get_request(db: AsyncSession, state: str) -> SsoRequest | None:
    stmt = (
        select(SsoRequest)
        .where(SsoRequest.state == state)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def get_ticket(db: AsyncSession, ticket_hash: bytes) -> SsoTicket | None:
    stmt = (
        select(SsoTicket)
        .where(SsoTicket.ticket_hash == ticket_hash)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def get_identity(db: AsyncSession, provider: str, subject: str) -> UserIdentity | None:
    stmt = (
        select(UserIdentity)
        .where(UserIdentity.provider == provider, UserIdentity.subject == subject)
        .with_for_update()
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def get_user_by_email(db: AsyncSession, email: str) -> User | None:
    """`users.email` is CITEXT: the match ignores case."""
    stmt = select(User).where(User.email == email).with_for_update()
    return (await db.execute(stmt)).scalar_one_or_none()


async def username_taken(db: AsyncSession, username: str) -> bool:
    stmt = select(User.id).where(User.username == username)
    return (await db.execute(stmt)).scalar_one_or_none() is not None


async def purge_expired(db: AsyncSession, now: datetime) -> int:
    """Requests and tickets an hour past their expiry (the hourly sweep); the caller commits."""
    cutoff = now - timedelta(hours=1)
    requests = await db.execute(delete(SsoRequest).where(SsoRequest.expires_at < cutoff))
    tickets = await db.execute(delete(SsoTicket).where(SsoTicket.expires_at < cutoff))
    return int(getattr(requests, "rowcount", 0) or 0) + int(getattr(tickets, "rowcount", 0) or 0)


async def forget_user_in_tx(db: AsyncSession, user_id: uuid.UUID) -> None:
    """An anonymized account (admin): its external accounts and open tickets go too."""
    await db.execute(delete(UserIdentity).where(UserIdentity.user_id == user_id))
    await db.execute(delete(SsoTicket).where(SsoTicket.user_id == user_id))
