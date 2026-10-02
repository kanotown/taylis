from typing import Any

import httpx
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
    notification_default: str = "mentions",
) -> User:
    """Insert a user directly. Pass ``password`` when the test needs to log in."""
    user = User(
        username=username,
        display_name=username.title(),
        password_hash=await hash_password(password) if password else "not-a-real-hash",
        must_change_password=must_change_password,
        role=role,
        # Written when "mentions" was the default (before 0060); new accounts now get "all".
        notification_default=notification_default,
    )
    db.add(user)
    await db.commit()
    return user


async def http_login(base_url: str, username: str, password: str) -> dict[str, Any]:
    """Log in against a live server and return the token response."""
    async with httpx.AsyncClient(base_url=base_url) as client:
        response = await client.post(
            "/api/v1/auth/login",
            json={"username": username, "password": password, "device": {"platform": "desktop"}},
        )
        assert response.status_code == 200, response.text
        body: dict[str, Any] = response.json()
        return body
