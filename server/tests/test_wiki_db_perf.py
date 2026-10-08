"""M123 (docs/WIKI.md §5.4, §12 M123): a database of 5,000 rows (the limit) is sorted and
filtered by the server in plain Python under 50 ms. Measured as the query of the API (load the
rows, filter, sort, page of 100, relation cells), median of several runs; the test allows twice
the target so a busy parallel run does not fail it (as test_wiki_perf.py)."""

import statistics
import time
import uuid
from typing import Any

from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.wiki import databases
from app.modules.wiki.db_schemas import RowQuery
from tests.helpers import make_user
from tests.wiki_helpers import Actor, create_database, option_id, prop_id, schema

ROWS = 5000
TARGET_MS = 50.0
WORDS = [
    "院ゼミ",
    "修論",
    "卒論",
    "Transformer",
    "BERT",
    "実験",
    "論文",
    "合宿",
    "Attention",
    "輪講",
]


async def _fill(db: AsyncSession, database: dict[str, Any], user_id: uuid.UUID) -> None:
    year, stage, notes, due = (prop_id(database, n) for n in ("Year", "Stage", "Notes", "Due"))
    options = [option_id(database, "Stage", n) for n in ("A", "B", "C")]
    await db.execute(
        text(
            """
            INSERT INTO wiki_pages (id, parent_id, path, position, kind, title, body, version,
              head_rev_id, meta_seq, vis_seq, created_seq, props, props_text, created_by,
              updated_by)
            SELECT gen_random_uuid(), CAST(:db AS uuid), ARRAY[CAST(:db AS uuid)],
              lpad(n::text, 6, '0'), 'row',
              (CAST(:words AS text[]))[1 + n % 10] || ' ' || n, '', 1, gen_random_uuid(), 1, 1,
              1,
              jsonb_build_object(
                CAST(:year AS text), 1990 + n % 37,
                CAST(:stage AS text), (CAST(:options AS text[]))[1 + n % 3],
                CAST(:notes AS text), 'note ' || (n * 7919 % 5000),
                CAST(:due AS text), jsonb_build_object(
                  'start', to_char(DATE '2026-01-01' + (n % 365), 'YYYY-MM-DD'),
                  'end', NULL, 'time', false)),
              '', CAST(:user AS uuid), CAST(:user AS uuid)
            FROM generate_series(1, :rows) AS n
            """
        ),
        {
            "db": database["page_id"],
            "words": WORDS,
            "year": year,
            "stage": stage,
            "notes": notes,
            "due": due,
            "options": options,
            "user": user_id,
            "rows": ROWS,
        },
    )
    await db.commit()


async def _median_ms(run: Any, times: int = 7) -> float:
    await run()  # warm (the name keys are cached per process, as on the server)
    samples = []
    for _ in range(times):
        start = time.perf_counter()
        await run()
        samples.append((time.perf_counter() - start) * 1000)
    return statistics.median(samples)


async def test_query_of_5000_rows(client: AsyncClient, db: AsyncSession, as_user: Actor) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    database = await create_database(client)
    await schema(
        client,
        database,
        {"op": "add", "name": "Year", "type": "number"},
        {"op": "add", "name": "Stage", "type": "select", "options": [{"name": n} for n in "ABC"]},
        {"op": "add", "name": "Notes", "type": "text"},
        {"op": "add", "name": "Due", "type": "date"},
    )
    await _fill(db, database, alice.id)
    await db.refresh(alice)
    db_id = uuid.UUID(database["page_id"])
    year, stage = prop_id(database, "Year"), prop_id(database, "Stage")
    cases = {
        "title sort + text filter": RowQuery(
            sort=[{"prop_id": "title"}],  # type: ignore[list-item]
            filter={"conditions": [{"prop_id": "title", "op": "contains", "value": "論"}]},  # type: ignore[arg-type]
        ),
        "number sort desc + select filter": RowQuery(
            sort=[{"prop_id": year, "direction": "desc"}, {"prop_id": "title"}],  # type: ignore[list-item]
            filter={
                "conditions": [
                    {
                        "prop_id": stage,
                        "op": "not_equals",
                        "value": option_id(database, "Stage", "B"),
                    }
                ]
            },  # type: ignore[arg-type]
        ),
        "everything by date": RowQuery(sort=[{"prop_id": prop_id(database, "Due")}]),  # type: ignore[list-item]
        "calendar month": RowQuery(
            range={"prop_id": prop_id(database, "Due"), "start": "2026-10-01", "end": "2026-10-31"},  # type: ignore[arg-type]
            limit=1000,
        ),
        # M147 (WIKI.md §22.4): a board's first 1,000 cards in groups, a table by week.
        "board by select (1,000 cards)": RowQuery(
            grouped=True,
            group_by={"prop_id": stage},  # type: ignore[arg-type]
            limit=1000,
        ),
        "groups by week + covers": RowQuery(
            grouped=True,
            group_by={"prop_id": prop_id(database, "Due"), "date_unit": "week"},  # type: ignore[arg-type]
            covers=True,
        ),
    }
    results: dict[str, float] = {}
    for name, q in cases.items():

        async def run(q: RowQuery = q) -> None:
            out = await databases.query(db, alice, db_id, q)
            assert out.total > 0

        results[name] = await _median_ms(run)
    print({k: round(v, 1) for k, v in results.items()})
    for name, ms in results.items():
        assert ms < TARGET_MS * 2, (name, ms)
