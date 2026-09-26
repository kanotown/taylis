from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import hash_password
from app.modules.users.models import User


async def make_user(
    db: AsyncSession,
    username: str,
    *,
    role: str = "member",
    password: str | None = None,
    must_change_password: bool = False,
) -> User:
    """Insert a user directly. Pass ``password`` when the test needs to log in."""
    user = User(
        username=username,
        display_name=username.title(),
        password_hash=await hash_password(password) if password else "not-a-real-hash",
        must_change_password=must_change_password,
        role=role,
    )
    db.add(user)
    await db.commit()
    return user
