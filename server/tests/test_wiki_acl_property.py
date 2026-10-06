"""M120 (docs/WIKI.md §4.6): wiki_effective_grants always equals a full recomputation from the
roots, whatever sequence of creates, moves (with and without keep_access), access changes,
trash, restore and purge led there, and also when several changes run at once (one advisory
lock serialises them)."""

import asyncio
import random
import uuid
from datetime import timedelta

import pytest
from fastapi import FastAPI
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.time import utcnow
from app.modules.groups.models import UserGroup, UserGroupMember
from app.modules.users.models import User
from app.modules.wiki import access
from app.modules.wiki import service as wiki
from app.modules.wiki.models import WikiPage
from app.modules.wiki.schemas import AccessUpdate, GrantIn, Level, PageCreate, PageMove
from tests.helpers import make_user

LEVELS: list[Level] = ["view", "edit", "full"]


async def _live(db: AsyncSession) -> tuple[list[uuid.UUID], list[uuid.UUID]]:
    rows = (
        await db.execute(select(WikiPage.id, WikiPage.deleted_at, WikiPage.trash_root_id))
    ).all()
    live = [r[0] for r in rows if r[1] is None]
    roots = [r[0] for r in rows if r[1] is not None and r[2] == r[0]]
    return live, roots


async def _step(
    app: FastAPI,
    rng: random.Random,
    actor: User,
    people: list[User],
    group_id: uuid.UUID,
) -> str:
    async with app.state.db.session_factory() as db:
        live, trashed = await _live(db)
        await db.rollback()
        op = rng.choice(
            ["create", "create", "move", "move", "access", "access", "trash", "restore", "purge"]
        )
        try:
            if op == "create" or not live:
                parent = rng.choice([None, *live]) if live else None
                await wiki.create(
                    db,
                    actor,
                    PageCreate(
                        parent_id=parent,
                        title=f"p{rng.randint(0, 999)}",
                        access=rng.choice(["workspace", "private"]),
                        client_save_id=uuid.uuid4(),
                    ),
                )
                return "create"
            if op == "move":
                page = rng.choice(live)
                target = rng.choice([None, *live])
                await wiki.move(
                    db,
                    actor,
                    page,
                    PageMove(parent_id=target, keep_access=rng.random() < 0.4),
                )
            elif op == "access":
                page = rng.choice(live)
                grants = [GrantIn(principal_type="user", principal_id=actor.id, level="full")]
                if rng.random() < 0.5:
                    grants.append(GrantIn(principal_type="workspace", level=rng.choice(LEVELS)))
                if rng.random() < 0.5:
                    grants.append(
                        GrantIn(
                            principal_type="group", principal_id=group_id, level=rng.choice(LEVELS)
                        )
                    )
                for person in rng.sample(people, rng.randint(0, len(people))):
                    grants.append(
                        GrantIn(
                            principal_type="user", principal_id=person.id, level=rng.choice(LEVELS)
                        )
                    )
                await wiki.set_access(
                    db,
                    actor,
                    page,
                    AccessUpdate(inherit_access=rng.random() < 0.6, grants=grants),
                )
            elif op == "trash":
                await wiki.trash(db, actor, rng.choice(live))
            elif op == "restore" and trashed:
                await wiki.restore(db, actor, rng.choice(trashed))
            elif op == "purge" and trashed:
                root = rng.choice(trashed)
                await db.execute(
                    update(WikiPage)
                    .where(WikiPage.trash_root_id == root)
                    .values(deleted_at=utcnow() - timedelta(days=40))
                )
                await db.commit()
                await wiki.purge_trash(db, now=utcnow(), trash_days=30)
            return op
        except AppError as exc:
            await db.rollback()
            return f"{op}:{exc.code}"


@pytest.mark.parametrize("seed", [1, 2, 3])
async def test_effective_access_equals_a_full_rebuild(
    app: FastAPI, db: AsyncSession, seed: int
) -> None:
    rng = random.Random(seed)
    actor = await make_user(db, f"admin{seed}", role="admin")
    people = [await make_user(db, f"user{seed}{n}") for n in range(3)]
    group = UserGroup(name=f"g{seed}", created_by=actor.id)
    db.add(group)
    await db.flush()
    db.add(UserGroupMember(group_id=group.id, user_id=people[0].id))
    await db.commit()
    done: list[str] = []
    for _ in range(70):
        done.append(await _step(app, rng, actor, people, group.id))
        async with app.state.db.session_factory() as check:
            problems = await access.verify(check)
        assert problems == [], (done[-5:], problems[:3])
    assert sum(1 for d in done if ":" not in d) > 40, done


async def test_concurrent_changes_stay_consistent(app: FastAPI, db: AsyncSession) -> None:
    actor = await make_user(db, "boss", role="admin")
    other = await make_user(db, "other")
    async with app.state.db.session_factory() as s:
        roots = [
            (await wiki.create(s, actor, PageCreate(title=f"r{n}", client_save_id=uuid.uuid4())))[
                0
            ].id
            for n in range(4)
        ]
    async with app.state.db.session_factory() as s:
        children = [
            (
                await wiki.create(
                    s, actor, PageCreate(parent_id=r, title="c", client_save_id=uuid.uuid4())
                )
            )[0].id
            for r in roots
        ]

    async def move(page: uuid.UUID, target: uuid.UUID) -> None:
        async with app.state.db.session_factory() as s:
            try:
                await wiki.move(s, actor, page, PageMove(parent_id=target))
            except AppError:
                await s.rollback()

    async def share(page: uuid.UUID) -> None:
        async with app.state.db.session_factory() as s:
            await wiki.set_access(
                s,
                actor,
                page,
                AccessUpdate(
                    inherit_access=False,
                    grants=[
                        GrantIn(principal_type="user", principal_id=actor.id, level="full"),
                        GrantIn(principal_type="user", principal_id=other.id, level="view"),
                    ],
                ),
            )

    await asyncio.gather(
        move(children[0], roots[1]),
        move(roots[1], roots[2]),
        move(roots[2], roots[3]),
        share(roots[3]),
        move(children[3], roots[0]),
        share(roots[0]),
    )
    async with app.state.db.session_factory() as check:
        assert await access.verify(check) == []
