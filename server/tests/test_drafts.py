"""Drafts shared by my devices (M15d)."""

import uuid
from collections.abc import Callable

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.drafts import service as drafts_service
from app.modules.users.models import User
from tests.helpers import make_user


async def test_drafts_are_saved_listed_and_deleted(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    cid = (await client.post("/api/v1/channels", json={"name": "general"})).json()["id"]
    parent = (
        await client.post(
            f"/api/v1/channels/{cid}/messages",
            json={"client_msg_id": str(uuid.uuid4()), "body": "topic"},
        )
    ).json()

    saved = await client.put("/api/v1/drafts", json={"channel_id": cid, "body": "書きかけ"})
    assert saved.status_code == 200 and saved.json()["body"] == "書きかけ"
    assert saved.json()["parent_id"] is None
    again = await client.put("/api/v1/drafts", json={"channel_id": cid, "body": "書きかけの続き"})
    assert again.status_code == 200
    reply = await client.put(
        "/api/v1/drafts",
        json={"channel_id": cid, "parent_id": parent["id"], "body": "返信の下書き"},
    )
    assert reply.status_code == 200

    listed = (await client.get("/api/v1/drafts")).json()
    assert {(d["parent_id"], d["body"]) for d in listed} == {
        (None, "書きかけの続き"),
        (parent["id"], "返信の下書き"),
    }
    boot = (await client.get("/api/v1/sync/bootstrap")).json()
    assert len(boot["drafts"]) == 2

    # Blank text is not a draft: DELETE removes it (idempotently).
    blank = await client.put("/api/v1/drafts", json={"channel_id": cid, "body": "  \n"})
    assert blank.status_code == 422
    assert (await client.delete("/api/v1/drafts", params={"channel_id": cid})).status_code == 204
    assert (await client.delete("/api/v1/drafts", params={"channel_id": cid})).status_code == 204
    listed = (await client.get("/api/v1/drafts")).json()
    assert [d["parent_id"] for d in listed] == [parent["id"]]

    # Every change reached my devices (and only mine); the repeated delete said nothing.
    rows = (
        (
            await db.execute(
                select(OutboxEvent)
                .where(OutboxEvent.event_type == "draft.updated")
                .order_by(OutboxEvent.id)
            )
        )
        .scalars()
        .all()
    )
    assert [(r.audience_type, r.audience_id) for r in rows] == [("user", alice.id)] * 4
    assert [r.payload["deleted"] for r in rows] == [False, False, False, True]
    assert rows[-1].payload["body"] == ""

    # Drafts are private and need membership; a thread draft needs a parent in that channel.
    as_user(bob)
    assert (await client.get("/api/v1/drafts")).json() == []
    denied = await client.put("/api/v1/drafts", json={"channel_id": cid, "body": "x"})
    assert denied.status_code == 403
    own = (await client.post("/api/v1/channels", json={"name": "random"})).json()["id"]
    wrong = await client.put(
        "/api/v1/drafts", json={"channel_id": own, "parent_id": parent["id"], "body": "x"}
    )
    assert wrong.status_code in (403, 404)

    # Leaving the conversation hides its drafts.
    as_user(alice)
    await client.post(f"/api/v1/channels/{cid}/members", json={"user_id": str(bob.id)})
    as_user(bob)
    assert (
        await client.put("/api/v1/drafts", json={"channel_id": cid, "body": "x"})
    ).status_code == 200
    await client.post(f"/api/v1/channels/{cid}/leave")
    assert (await client.get("/api/v1/drafts")).json() == []


async def test_draft_limit(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(drafts_service, "MAX_DRAFTS", 1)
    alice = await make_user(db, "alice")
    as_user(alice)
    first = (await client.post("/api/v1/channels", json={"name": "one"})).json()["id"]
    second = (await client.post("/api/v1/channels", json={"name": "two"})).json()["id"]
    assert (
        await client.put("/api/v1/drafts", json={"channel_id": first, "body": "a"})
    ).status_code == 200
    # Updating the existing one is fine; a new one is refused.
    assert (
        await client.put("/api/v1/drafts", json={"channel_id": first, "body": "b"})
    ).status_code == 200
    full = await client.put("/api/v1/drafts", json={"channel_id": second, "body": "c"})
    assert full.status_code == 409 and full.json()["error"]["code"] == "too_many_drafts"
