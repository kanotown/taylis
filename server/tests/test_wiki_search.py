"""M120: searching wiki pages (docs/WIKI.md §8.1), their files (§4.7) and their pushes (§9.3)."""

import io
import uuid
from typing import Any

from fastapi import FastAPI
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import text
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.events.outbox import OutboxRelay
from app.modules.channels import service as channels
from app.modules.notifications.planner import PushPlanner
from app.modules.search import repository as search_repo
from app.modules.wiki import events as wiki_events
from tests.helpers import make_user
from tests.test_outbox import RecordingBus
from tests.test_push_planner import add_device, deliveries
from tests.wiki_helpers import API, Actor, create_page, save, set_access


async def _search(client: AsyncClient, **params: Any) -> dict[str, Any]:
    response = await client.get(f"{API}/search/pages", params=params)
    assert response.status_code == 200, response.text
    out: dict[str, Any] = response.json()
    return out


async def test_search_finds_readable_pages_only(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    manual = await create_page(client, title="研究室マニュアル", body="GPU サーバの予約方法")
    gpu = await create_page(
        client, parent_id=manual["id"], title="計算機", body="GPU server booking in English"
    )
    await create_page(client, title="個人メモ", body="GPU の私的なメモ", access_="private")
    found = await _search(client, q="GPU")
    assert {h["page"]["title"] for h in found["hits"]} == {"研究室マニュアル", "計算機", "個人メモ"}
    assert found["total"] == 3

    as_user(bob)
    found = await _search(client, q="GPU")
    assert {h["page"]["title"] for h in found["hits"]} == {"研究室マニュアル", "計算機"}
    assert found["total"] == 2
    assert "予約" in found["hits"][0]["snippet"] or "booking" in found["hits"][0]["snippet"]
    narrowed = await _search(client, q="GPU in:計算機")
    assert [h["page"]["id"] for h in narrowed["hits"]] == [gpu["id"]]
    assert narrowed["filters"]["in_page"] == "計算機"
    subtree = await _search(client, q="GPU", in_page=manual["id"])
    assert subtree["total"] == 2
    unknown = await _search(client, q="GPU in:個人メモ")
    assert unknown["hits"] == [] and unknown["filters"]["unresolved"] == ["in:個人メモ"]
    by_author = await _search(client, q="from:@alice")
    assert by_author["total"] == 2
    title_only = await _search(client, q="マニュアル")
    assert [h["page"]["title"] for h in title_only["hits"]] == ["研究室マニュアル"]


async def test_page_search_uses_the_index(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    for i in range(12):
        await create_page(client, title=f"ノート {i}", body=f"note {i} {'東京' if i % 3 else ''}")
    stmt = search_repo.page_search_statement(
        "東京",
        search_repo.PageScope(actor=alice),
        sort="relevance",
        limit=5,
        offset=0,
        escaped=False,
    )
    sql = str(
        stmt.compile(
            dialect=postgresql.dialect(),  # type: ignore[no-untyped-call]
            compile_kwargs={"literal_binds": True},
        )
    )
    async with db.begin():
        await db.execute(text("SET LOCAL enable_seqscan = off"))
        plan = "\n".join(row[0] for row in (await db.execute(text(f"EXPLAIN {sql}"))).all())
        assert "wiki_pages_search_idx" in plan, plan
        rows = (await db.execute(text(sql))).all()
    assert len(rows) == 5


def _png() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (20, 10), (9, 9, 9)).save(out, format="PNG")
    return out.getvalue()


async def test_page_files_follow_the_page(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    uploaded = (
        await client.post(f"{API}/attachments", files={"file": ("a.png", _png(), "image/png")})
    ).json()
    page = await create_page(
        client, title="With image", body=f"![a](attachment:{uploaded['id']})", access_="private"
    )
    await set_access(
        client, page["id"], [("user", str(alice.id), "full"), ("user", str(bob.id), "view")]
    )
    as_user(bob)
    content = await client.get(f"{API}/attachments/{uploaded['id']}/content")
    assert content.status_code == 200 and content.content == _png()
    as_user(carol)
    assert (await client.get(f"{API}/attachments/{uploaded['id']}/content")).status_code == 404
    as_user(alice)
    await client.delete(f"{API}/wiki/pages/{page['id']}")
    as_user(bob)
    assert (await client.get(f"{API}/attachments/{uploaded['id']}/thumbnail")).status_code == 404
    as_user(alice)
    await client.post(f"{API}/wiki/pages/{page['id']}/restore")
    as_user(bob)
    assert (await client.get(f"{API}/attachments/{uploaded['id']}")).status_code == 200


async def test_page_pushes(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Actor,
    test_settings: Settings,
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    await add_device(db, bob)
    await add_device(db, carol, token="carol-tok")
    planner = PushPlanner(test_settings, is_active=lambda _uid: False)
    relay = OutboxRelay(
        app.state.db,
        RecordingBus(),
        wiki_events.audience_resolver(channels.resolve_event_audience),
        handlers=[planner],
    )

    async def drain() -> list[dict[str, Any]]:
        while await relay.process_batch():
            pass
        return [d.payload for d in await deliveries(db) if d.payload.get("kind") == "page"]

    as_user(alice)
    page = await create_page(client, title="ゼミ資料", access_="private")
    await set_access(
        client, page["id"], [("user", str(alice.id), "full"), ("user", str(bob.id), "view")]
    )
    pushes = await drain()
    assert [p["body"] for p in pushes] == ["Alice が「ゼミ資料」を共有しました"]
    assert pushes[0]["page_id"] == page["id"] and pushes[0]["title"] == "ドキュメント"
    assert pushes[0]["collapse_key"] == f"page:{page['id']}"
    page = (await client.get(f"{API}/wiki/pages/{page['id']}")).json()
    await save(client, page, f"<@{bob.id}> と <@{carol.id}> へ")
    pushes = await drain()
    # carol cannot read the page: no event, no push.
    assert [p["body"] for p in pushes][-1] == "Alice が「ゼミ資料」であなたをメンションしました"
    assert len(pushes) == 2
    assert all(uuid.UUID(str(p["page_id"])) for p in pushes)
