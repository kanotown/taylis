"""Async database engine and the request-scoped session dependency.

Transaction policy: services call ``await session.commit()`` explicitly at the end of a unit of
work. The session dependency never commits; anything left uncommitted is rolled back when the
request-scoped session closes. Savepoints (``session.begin_nested()``) are used where a
constraint violation must be handled without aborting the whole transaction.
"""

from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)


class Database:
    def __init__(
        self, url: str, *, echo: bool = False, pool_size: int = 5, max_overflow: int = 10
    ) -> None:
        self.engine: AsyncEngine = create_async_engine(
            url, echo=echo, pool_pre_ping=True, pool_size=pool_size, max_overflow=max_overflow
        )
        self.session_factory = async_sessionmaker(self.engine, expire_on_commit=False)

    async def dispose(self) -> None:
        await self.engine.dispose()


async def get_db(request: Request) -> AsyncIterator[AsyncSession]:
    db: Database = request.app.state.db
    async with db.session_factory() as session:
        yield session


Db = Annotated[AsyncSession, Depends(get_db)]
