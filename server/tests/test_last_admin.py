"""Review v0.1.37 #1: operations that lower the number of active administrators are serialized
by one admin-set lock, so two of them racing never leave zero administrators."""

import asyncio
import uuid
from collections.abc import Awaitable, Callable

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.modules.admin import service as admin_service
from app.modules.admin.schemas import AdminUserUpdate
from app.modules.moderation import service as moderation
from app.modules.moderation.schemas import AccountDeletion
from app.modules.users import service as users
from app.modules.users.models import User
from tests.helpers import make_user

PASSWORD = "pw-12345678"
Op = Callable[[AsyncSession, User, User], Awaitable[object]]


async def _delete_self(session: AsyncSession, me: User, _other: User) -> object:
    await moderation.delete_own_account(session, me, AccountDeletion(password=PASSWORD), None)
    return None


async def _deactivate(session: AsyncSession, actor: User, target: User) -> object:
    return await admin_service.update_user(
        session, actor, target.id, AdminUserUpdate(deactivated=True)
    )


async def _demote(session: AsyncSession, actor: User, target: User) -> object:
    return await admin_service.update_user(session, actor, target.id, AdminUserUpdate(role="guest"))


async def _anonymize(session: AsyncSession, actor: User, target: User) -> object:
    return await admin_service.anonymize_user(session, actor, target.id)


async def _active_admins(db: AsyncSession) -> list[uuid.UUID]:
    db.expire_all()
    stmt = select(User.id).where(User.role == "admin", User.deactivated_at.is_(None))
    return list((await db.scalars(stmt)).all())


# (first, second): each lowers the admins by one; alone each is allowed, together they would
# leave none. The first takes a away, the second b: a "self" op is run by the one it removes,
# the others by the other admin (still an admin when the request was authorized).
CASES: dict[str, tuple[Op, Op]] = {
    "delete+delete": (_delete_self, _delete_self),
    "delete+deactivate": (_delete_self, _deactivate),
    "delete+demote": (_delete_self, _demote),
    "delete+anonymize": (_delete_self, _anonymize),
    "demote+demote": (_demote, _demote),
    "deactivate+deactivate": (_deactivate, _deactivate),
}


@pytest.mark.parametrize("case", list(CASES))
async def test_two_racing_operations_leave_one_admin(
    app: FastAPI, db: AsyncSession, monkeypatch: pytest.MonkeyPatch, case: str
) -> None:
    """The first operation is held right after its last-admin check passed (where the reviewer
    paused both). The second starts meanwhile: it must wait on the admin-set lock (seen in
    pg_locks), then re-read the admins and answer 409 last_admin."""
    first_op, second_op = CASES[case]
    a = await make_user(db, "a", role="admin", password=PASSWORD)
    b = await make_user(db, "b", role="admin", password=PASSWORD)
    await db.commit()
    a_id, b_id = a.id, b.id

    checked, release = asyncio.Event(), asyncio.Event()
    original = users.ensure_admin_remains
    calls = 0

    async def held(session: AsyncSession, *, losing: uuid.UUID) -> None:
        nonlocal calls
        calls += 1
        first = calls == 1
        await original(session, losing=losing)
        if first:
            checked.set()
            await asyncio.wait_for(release.wait(), timeout=10)

    monkeypatch.setattr(users, "ensure_admin_remains", held)
    factory = app.state.db.session_factory

    async def run(op: Op, actor_id: uuid.UUID, other_id: uuid.UUID) -> object:
        async with factory() as session:
            actor = await session.get(User, actor_id)
            other = await session.get(User, other_id)
            assert actor is not None and other is not None
            return await op(session, actor, other)

    def roles(op: Op, losing: uuid.UUID, keeping: uuid.UUID) -> tuple[uuid.UUID, uuid.UUID]:
        return (losing, keeping) if op is _delete_self else (keeping, losing)

    one = asyncio.create_task(run(first_op, *roles(first_op, a_id, b_id)))
    await asyncio.wait_for(checked.wait(), timeout=10)
    two = asyncio.create_task(run(second_op, *roles(second_op, b_id, a_id)))
    waited = False
    for _ in range(200):
        stmt = text("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted")
        if await db.scalar(stmt):
            waited = True
            break
        if two.done():
            break
        await asyncio.sleep(0.02)
    await db.rollback()
    release.set()
    await one
    outcome = (await asyncio.gather(two, return_exceptions=True))[0]

    assert waited, "the second operation did not wait for the admin-set lock"
    assert isinstance(outcome, AppError), outcome
    assert (outcome.status, outcome.code) == (409, "last_admin")
    assert await _active_admins(db) == [b_id]


async def test_demoting_or_deactivating_the_last_other_admin_is_refused(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """Without a race: an admin whose actor lost the role meanwhile cannot take the last one."""
    a = await make_user(db, "a", role="admin")
    b = await make_user(db, "b", role="admin")
    a_id, b_id = a.id, b.id
    as_user(a)
    assert (
        await client.patch(f"/api/v1/admin/users/{b.id}", json={"role": "member"})
    ).status_code == 200
    as_user(b)  # b's request was authorized as an admin before the demotion committed
    denied = await client.patch(f"/api/v1/admin/users/{a.id}", json={"deactivated": True})
    assert denied.status_code == 409 and denied.json()["error"]["code"] == "last_admin"
    # Promoting never needs the check.
    as_user(a)
    assert (
        await client.patch(f"/api/v1/admin/users/{b_id}", json={"role": "admin"})
    ).status_code == 200
    assert sorted(await _active_admins(db)) == sorted([a_id, b_id])
