import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User


async def get_user(
    db: AsyncSession, user_id: uuid.UUID, *, for_update: bool = False
) -> User | None:
    stmt = select(User).where(User.id == user_id)
    if for_update:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    return (await db.execute(stmt)).scalar_one_or_none()


async def get_by_username(
    db: AsyncSession, username: str, *, for_update: bool = False
) -> User | None:
    stmt = select(User).where(User.username == username)
    if for_update:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    return (await db.execute(stmt)).scalar_one_or_none()


async def list_users(db: AsyncSession) -> list[User]:
    return list((await db.scalars(select(User).order_by(User.username))).all())


async def email_taken(db: AsyncSession, email: str, user_id: uuid.UUID) -> bool:
    stmt = select(User.id).where(User.email == email, User.id != user_id)
    return (await db.scalar(stmt)) is not None
