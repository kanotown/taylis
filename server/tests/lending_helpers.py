"""Shared by the 備品 loan tests (L2, M168): a lab of people, a frozen clock and a borrow helper."""

import uuid
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest
from httpx import AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.lending import loans, notices, service
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_lending_ledger import API, Lab, _code, _ok

__all__ = ["API", "TODAY", "Clock", "LoanLab", "_code", "_ok", "day", "freeze", "make_lab"]

# Noon in Tokyo on 2026-10-26 (03:00 UTC).
NOON_JST = datetime(2026, 10, 26, 3, 0, tzinfo=UTC)
TODAY = date(2026, 10, 26)


class Clock:
    """utcnow() for the lending service and loans while a test runs."""

    def __init__(self, now: datetime) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **delta: float) -> None:
        self.now += timedelta(**delta)


def freeze(monkeypatch: pytest.MonkeyPatch) -> Clock:
    frozen = Clock(NOON_JST)
    monkeypatch.setattr(service, "utcnow", frozen)
    monkeypatch.setattr(loans, "utcnow", frozen)
    monkeypatch.setattr(notices, "utcnow", frozen)
    return frozen


def day(offset: int) -> str:
    """TODAY + offset days as an ISO date."""
    return (TODAY + timedelta(days=offset)).isoformat()


class LoanLab(Lab):
    """The L1 lab and a second member (bob)."""

    async def setup(self, db: AsyncSession) -> None:
        await super().setup(db)
        self.bob = await make_user(db, "bob")

    async def borrow_response(
        self, user: User, item_id: str, *, due: int = 3, **body: Any
    ) -> Response:
        self.as_user(user)
        payload = {
            "client_request_id": str(uuid.uuid4()),
            "due_on": day(due),
            "purpose": "学会発表の撮影",
            **body,
        }
        return await self.client.post(f"{API}/lending/items/{item_id}/borrow", json=payload)

    async def borrow(self, user: User, item_id: str, **body: Any) -> dict[str, Any]:
        out: dict[str, Any] = await _ok(await self.borrow_response(user, item_id, **body), 201)
        return out

    async def give_back(
        self, user: User, loan_id: str, condition: str = "ok", note: str | None = None
    ) -> Response:
        self.as_user(user)
        return await self.client.post(
            f"{API}/lending/loans/{loan_id}/return", json={"condition": condition, "note": note}
        )

    async def extend(self, user: User, loan_id: str, due: int) -> Response:
        self.as_user(user)
        return await self.client.post(
            f"{API}/lending/loans/{loan_id}/extend", json={"due_on": day(due)}
        )


async def make_lab(
    db: AsyncSession, client: AsyncClient, as_user: Callable[[User], None]
) -> LoanLab:
    lab = LoanLab(client, as_user)
    await lab.setup(db)
    await lab.enable()
    return lab
