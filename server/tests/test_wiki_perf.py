"""M120 (docs/WIKI.md §4.6, §12): the access checks at 10,000 pages.

Targets: one page's level ≤ 1 ms, the set of pages someone can read ≤ 10 ms, moving a subtree of
1,000 pages (computing and writing its effective access again) ≤ 300 ms. The test builds the tree
with bulk inserts, measures, prints the numbers (`pytest -s`) and checks them with a margin of
two (the suite runs on several workers at once; docs/WIKI.md §4.6 has the numbers of a quiet run).
"""

import random
import statistics
import time
import uuid

from fastapi import FastAPI
from sqlalchemy import func, insert, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User
from app.modules.wiki import access
from app.modules.wiki import service as wiki
from app.modules.wiki.models import WikiEffectiveGrant, WikiGrant, WikiPage
from app.modules.wiki.schemas import PageMove
from tests.helpers import make_user

PAGES = 10_000
TOP = 40
MARGIN = 2.0


def _tree(rng: random.Random, owner: uuid.UUID) -> tuple[list[dict[str, object]], uuid.UUID]:
    """40 top-level spaces; the first holds a subtree of exactly 1,000 pages (the one moved);
    the rest are spread under the others up to six deep."""
    rows: list[dict[str, object]] = []
    paths: dict[uuid.UUID, list[uuid.UUID]] = {}

    def add(parent: uuid.UUID | None, n: int) -> uuid.UUID:
        page_id = uuid.uuid4()
        path = [*paths[parent], parent] if parent is not None else []
        paths[page_id] = path
        rows.append(
            {
                "id": page_id,
                "parent_id": parent,
                "path": path,
                "position": f"V{n:05d}",
                "kind": "page",
                "title": f"page {len(rows)}",
                "body": "",
                "head_rev_id": uuid.uuid4(),
                "meta_seq": 1,
                "vis_seq": 1,
                "created_seq": 1,
                "inherit_access": True,
                "created_by": owner,
                "updated_by": owner,
            }
        )
        return page_id

    def grow(roots: list[uuid.UUID], until: int, count: list[int]) -> None:
        open_parents = list(roots)  # pages that may still have children (depth < 6)
        while count[0] < until:
            parent = rng.choice(open_parents[-300:])
            child = add(parent, count[0])
            count[0] += 1
            if len(paths[child]) < 6:
                open_parents.append(child)

    tops = [add(None, n) for n in range(TOP)]
    big = add(tops[0], 0)
    grow([big], 999, [0])
    grow(tops[1:], PAGES - len(rows), [0])
    return rows, big


async def _build(db: AsyncSession, owner: User, people: list[User]) -> tuple[uuid.UUID, uuid.UUID]:
    rng = random.Random(120)
    rows, big = _tree(rng, owner.id)
    for start in range(0, len(rows), 2000):
        await db.execute(insert(WikiPage), rows[start : start + 2000])
    grants: list[dict[str, object]] = []
    for row in rows:
        if row["parent_id"] is None:
            grants.append(_grant(row["id"], "workspace", None, "edit", owner.id))
            grants.append(_grant(row["id"], "user", owner.id, "full", owner.id))
        elif rng.random() < 0.1:
            # A tenth of the pages narrowed to a few people (their own entries, not inherited).
            row["inherit_access"] = False
            await db.execute(
                text("UPDATE wiki_pages SET inherit_access = false WHERE id = :id"),
                {"id": row["id"]},
            )
            grants.append(_grant(row["id"], "user", owner.id, "full", owner.id))
            for person in rng.sample(people, 2):
                grants.append(_grant(row["id"], "user", person.id, "view", owner.id))
        elif rng.random() < 0.2:
            grants.append(_grant(row["id"], "user", rng.choice(people).id, "edit", owner.id))
    for start in range(0, len(grants), 2000):
        await db.execute(insert(WikiGrant), grants[start : start + 2000])
    await access.rebuild(db)
    await db.commit()
    await db.execute(text("ANALYZE wiki_pages"))
    await db.execute(text("ANALYZE wiki_effective_grants"))
    await db.commit()
    target = next(r["id"] for r in rows if r["parent_id"] is None and r["id"] != rows[0]["id"])
    return big, target  # type: ignore[return-value]


def _grant(
    page_id: object, ptype: str, pid: uuid.UUID | None, level: str, by: uuid.UUID
) -> dict[str, object]:
    return {
        "id": uuid.uuid4(),
        "page_id": page_id,
        "principal_type": ptype,
        "principal_id": pid,
        "level": level,
        "created_by": by,
    }


async def test_access_at_ten_thousand_pages(app: FastAPI, db: AsyncSession) -> None:
    owner = await make_user(db, "owner", role="admin")
    people = [await make_user(db, f"member{n}") for n in range(8)]
    big, target = await _build(db, owner, people)
    effective_rows = await db.scalar(select(func.count()).select_from(WikiEffectiveGrant))
    assert await db.scalar(select(func.count()).select_from(WikiPage)) == PAGES

    reader = people[0]
    ids = list((await db.execute(select(WikiPage.id).limit(400))).scalars())
    await access.level_of(db, reader, ids[0])  # warm up
    checks = []
    for page_id in ids[:300]:
        start = time.perf_counter()
        await access.level_of(db, reader, page_id)
        checks.append((time.perf_counter() - start) * 1000)
    check_ms = statistics.median(checks)

    sets = []
    for _ in range(15):
        start = time.perf_counter()
        readable = list((await db.execute(access.readable_ids(reader))).scalars())
        sets.append((time.perf_counter() - start) * 1000)
    set_ms = statistics.median(sets)
    assert len(readable) > 5000

    # Not a target: GET /wiki/tree's work for this reader (every page's metadata), for the docs.
    start = time.perf_counter()
    tree = await wiki.tree(db, reader)
    tree_ms = (time.perf_counter() - start) * 1000
    tree_kb = len(tree.model_dump_json()) / 1024

    await db.commit()
    async with app.state.db.session_factory() as session:
        moved_owner = await session.get(User, owner.id)
        assert moved_owner is not None
        start = time.perf_counter()
        out = await wiki.move(session, moved_owner, big, PageMove(parent_id=target))
        move_ms = (time.perf_counter() - start) * 1000
    assert out.page is not None and out.page.parent_id == target
    async with app.state.db.session_factory() as session:
        assert await access.verify(session) == []

    print(
        f"\nwiki at {PAGES} pages ({effective_rows} effective rows): level {check_ms:.2f} ms, "
        f"readable set ({len(readable)} ids) {set_ms:.2f} ms, "
        f"move of 1,000 pages {move_ms:.0f} ms, tree {tree_ms:.0f} ms ({tree_kb:.0f} KB)"
    )
    assert check_ms <= 1.0 * MARGIN
    assert set_ms <= 10.0 * MARGIN
    assert move_ms <= 300.0 * MARGIN
