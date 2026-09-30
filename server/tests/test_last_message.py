"""M49: ChannelOut.last_message, the DM list's preview (MOBILE_UI.md §7.1, SYNC_PROTOCOL §7.8)."""

import io
import json
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.messages.mentions import attachment_text, notification_text
from app.modules.messages.service import PREVIEW_LENGTH
from app.modules.users.models import User
from tests.helpers import make_user

VECTORS = Path(__file__).resolve().parents[2] / "apps" / "shared" / "dm-preview.json"


def _png() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (8, 8), (200, 100, 50)).save(out, format="PNG")
    return out.getvalue()


async def _post(client: AsyncClient, channel_id: str, body: str, **extra: Any) -> dict[str, Any]:
    response = await client.post(
        f"/api/v1/channels/{channel_id}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": body, **extra},
    )
    assert response.status_code == 201, response.text
    data: dict[str, Any] = response.json()
    return data


async def _dm(client: AsyncClient, *others: User) -> dict[str, Any]:
    response = await client.post("/api/v1/dms", json={"user_ids": [str(u.id) for u in others]})
    assert response.status_code in (200, 201), response.text
    data: dict[str, Any] = response.json()
    return data


async def _last(client: AsyncClient, channel_id: str) -> dict[str, Any] | None:
    response = await client.get(f"/api/v1/channels/{channel_id}")
    assert response.status_code == 200, response.text
    last: dict[str, Any] | None = response.json()["last_message"]
    return last


def test_excerpt_rule_matches_the_shared_vectors() -> None:
    """The cases every client tests against (apps/shared/dm-preview.json)."""
    vectors = json.loads(VECTORS.read_text(encoding="utf-8"))
    names = {uuid.UUID(k): v for k, v in {**vectors["users"], **vectors["groups"]}.items()}
    assert PREVIEW_LENGTH == 140
    for case in vectors["excerpt"]:
        files = [{"content_type": t} for t in case["attachments"]]
        got = notification_text(case["body"], names, PREVIEW_LENGTH) or attachment_text(files)
        assert got == case["excerpt"], case["name"]


async def test_members_get_the_last_message_in_bootstrap_list_and_get(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    dm = await _dm(client, bob)
    assert dm["last_message"] is None  # nothing said yet
    await _post(client, dm["id"], "first")
    second = await _post(client, dm["id"], f"**明日**の件 <@{bob.id}>\nよろしく")

    expected = {
        "id": second["id"],
        "sender_id": str(alice.id),
        "type": "user",
        "seq": second["seq"],
        "excerpt": "明日の件 @Bob よろしく",  # mention names resolved, one line
        "has_attachments": False,
        "created_at": second["created_at"],
    }
    assert await _last(client, dm["id"]) == expected
    listed = (await client.get("/api/v1/channels")).json()
    assert [c["last_message"] for c in listed if c["id"] == dm["id"]] == [expected]
    boot = (await client.get("/api/v1/sync/bootstrap")).json()
    assert [c["last_message"] for c in boot["channels"] if c["id"] == dm["id"]] == [expected]
    as_user(bob)  # the same for the other member; POST /dms of an existing DM carries it too
    assert (await _dm(client, alice))["last_message"] == expected


async def test_non_members_never_see_it(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    await _post(client, general["id"], "public words")
    assert (await _last(client, general["id"]))["excerpt"] == "public words"  # type: ignore[index]

    as_user(bob)  # can read a public channel before joining (M27), but gets no preview
    assert await _last(client, general["id"]) is None
    browse = (await client.get("/api/v1/channels", params={"include": "public"})).json()
    row = next(c for c in browse if c["id"] == general["id"])
    assert row["membership"] is None and row["last_message"] is None
    joined = await client.post(f"/api/v1/channels/{general['id']}/join")
    assert joined.json()["last_message"] is None  # other responses leave it to the client
    assert (await _last(client, general["id"]))["excerpt"] == "public words"  # type: ignore[index]


async def test_thread_only_replies_do_not_count_also_in_channel_ones_do(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    group = await _dm(client, bob, carol)
    parent = await _post(client, group["id"], "parent")
    await _post(client, group["id"], "thread only", parent_id=parent["id"])
    assert (await _last(client, group["id"]))["id"] == parent["id"]  # type: ignore[index]
    shared = await _post(
        client, group["id"], "also here", parent_id=parent["id"], also_in_channel=True
    )
    last = await _last(client, group["id"])
    assert last is not None and last["id"] == shared["id"] and last["excerpt"] == "also here"


async def test_deleted_last_falls_back_and_edits_show(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    dm = await _dm(client, bob)
    first = await _post(client, dm["id"], "first")
    second = await _post(client, dm["id"], "second")
    edited = await client.patch(f"/api/v1/messages/{second['id']}", json={"body": "second!"})
    assert edited.status_code == 200, edited.text
    last = await _last(client, dm["id"])
    assert last is not None and (last["id"], last["excerpt"]) == (second["id"], "second!")
    assert last["seq"] == second["seq"]  # an edit does not move it

    assert (await client.delete(f"/api/v1/messages/{second['id']}")).status_code == 200
    last = await _last(client, dm["id"])
    assert last is not None and (last["id"], last["excerpt"]) == (first["id"], "first")
    assert (await client.delete(f"/api/v1/messages/{first['id']}")).status_code == 200
    assert await _last(client, dm["id"]) is None


async def test_attachment_only_and_mentions_for_guests(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    stranger = await make_user(db, "stranger")
    guest = await make_user(db, "guest", role="guest")
    as_user(alice)
    dm = await _dm(client, bob)
    ids = []
    for name in ("a.png", "b.png"):
        uploaded = await client.post(
            "/api/v1/attachments", files={"file": (name, _png(), "image/png")}
        )
        assert uploaded.status_code == 201, uploaded.text
        ids.append(uploaded.json()["id"])
    await _post(client, dm["id"], "", attachment_ids=ids)
    last = await _last(client, dm["id"])
    assert last is not None
    assert (last["excerpt"], last["has_attachments"]) == ("画像を 2 枚送信しました", True)

    # A guest sees only the people it shares a channel with (M13e): others read 「@メンバー」.
    with_guest = await _dm(client, guest)
    await _post(client, with_guest["id"], f"<@{stranger.id}> と <@{alice.id}> へ")
    assert (await _last(client, with_guest["id"]))["excerpt"] == "@Stranger と @Alice へ"  # type: ignore[index]
    as_user(guest)
    assert (await _last(client, with_guest["id"]))["excerpt"] == "@メンバー と @Alice へ"  # type: ignore[index]


async def test_group_mentions_read_as_the_group_name(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    admin = await make_user(db, "admin", role="admin")
    bob = await make_user(db, "bob")
    as_user(admin)
    group = await client.post("/api/v1/admin/groups", json={"name": "design"})
    assert group.status_code == 201, group.text
    dm = await _dm(client, bob)
    await _post(client, dm["id"], f"<@group:{group.json()['id']}> 集合")
    assert (await _last(client, dm["id"]))["excerpt"] == "@design 集合"  # type: ignore[index]


@contextmanager
def _counting(app: FastAPI) -> Iterator[list[str]]:
    statements: list[str] = []
    engine = app.state.db.engine.sync_engine

    def before(_conn: Any, _cursor: Any, statement: str, *_args: Any) -> None:
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", before)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", before)


async def test_bootstrap_query_count_does_not_grow_with_conversations(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    me = await make_user(db, "me")
    others = [await make_user(db, f"user{i}") for i in range(8)]
    as_user(me)

    async def add_dms(people: list[User]) -> None:
        for other in people:
            dm = await _dm(client, other)
            await _post(client, dm["id"], f"hi <@{other.id}>")

    async def bootstrap_queries() -> int:
        with _counting(app) as statements:
            response = await client.get("/api/v1/sync/bootstrap")
        assert response.status_code == 200
        assert all(c["last_message"] for c in response.json()["channels"])
        return len(statements)

    await add_dms(others[:2])
    few = await bootstrap_queries()
    assert few > 0
    await add_dms(others[2:])
    assert await bootstrap_queries() == few
