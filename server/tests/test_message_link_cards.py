"""M185 (docs/LINK_PREVIEWS.md): the cards of message links (POST /messages/previews) follow the
read rule of GET /messages/{id} and leak nothing else; the sender (or an administrator) removes a
link's card for everyone (PUT /messages/{id}/previews/hidden)."""

import io
import json
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.ratelimit import RateLimiter
from app.events.models import OutboxEvent
from app.modules.messages.link_cards import (
    EXCERPT_CHARS,
    EXCERPT_LINES,
    excerpt,
    link_keys,
    preview_key,
)
from app.modules.users.models import User
from tests.helpers import make_user

ROOT = Path(__file__).resolve().parents[2]
BASE = "https://chat.example.com"
EMPTY: dict[str, Any] = {
    "channel_id": None,
    "channel_type": None,
    "channel_name": None,
    "parent_id": None,
    "sender_id": None,
    "created_at": None,
    "edited_at": None,
    "excerpt": "",
    "excerpt_truncated": False,
    "attachment_count": 0,
    "attachment_types": [],
    "thumbnail_attachment_id": None,
}


async def _post(client: AsyncClient, channel_id: str, body: str, **extra: Any) -> dict[str, Any]:
    response = await client.post(
        f"/api/v1/channels/{channel_id}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": body, **extra},
    )
    assert response.status_code == 201, response.text
    result: dict[str, Any] = response.json()
    return result


async def _channel(client: AsyncClient, name: str, kind: str = "public") -> str:
    response = await client.post("/api/v1/channels", json={"name": name, "type": kind})
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


async def _previews(client: AsyncClient, *ids: str) -> dict[str, dict[str, Any]]:
    response = await client.post("/api/v1/messages/previews", json={"ids": list(ids)})
    assert response.status_code == 200, response.text
    return {item["id"]: item for item in response.json()["items"]}


def _states(items: dict[str, dict[str, Any]]) -> dict[str, str]:
    return {key: item["state"] for key, item in items.items()}


def _png() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (64, 48), (200, 100, 50)).save(out, format="PNG")
    return out.getvalue()


async def _events(db: AsyncSession, change: str) -> list[OutboxEvent]:
    rows = (await db.execute(select(OutboxEvent).order_by(OutboxEvent.id))).scalars()
    return [
        e for e in rows if e.event_type == "message.updated" and e.payload.get("change") == change
    ]


def test_keys_links_and_excerpts() -> None:
    # §4.1: scheme and host in lower case, no fragment, "/" for an empty path; the rest as written.
    # The same vectors as the clients (apps/shared/link-cards.json).
    vectors = json.loads((ROOT / "apps" / "shared" / "link-cards.json").read_text())["keys"]
    assert len(vectors) >= 8
    for vector in vectors:
        assert preview_key(vector["url"]) == vector["key"], vector
    # Every link of a body, with and without trailing punctuation, markdown labels too.
    keys = link_keys(f"see https://a.example/x。 and [doc]({BASE}/m/abc), (https://c.example)")
    assert {"https://a.example/x", f"{BASE}/m/abc", "https://c.example/"} <= keys
    # 2026-11-05: the keys the clients compute now (the links as their tokenizer reads them) are all
    # keys of the body, and so are those they computed before (a removed card stays removable).
    fixture = json.loads((ROOT / "apps" / "shared" / "link-cards.json").read_text())
    assert len(fixture["body_keys"]) >= 5
    for case in fixture["body_keys"]:
        assert set(case["keys"]) <= link_keys(case["body"]), case
    for case in fixture["legacy_keys"]:
        assert set(case["migrated"]) - {"https://unrelated.example/"} <= link_keys(case["body"]), (
            case
        )
    assert "https://example.com/a」を見て" in link_keys("「https://example.com/a」を見て")
    # The excerpt: the first lines, capped, never half a mention token.
    long_line = "x" * (EXCERPT_CHARS - 5) + f" <@{uuid.UUID(int=1)}> after"
    cut, truncated = excerpt(long_line)
    assert truncated and cut == "x" * (EXCERPT_CHARS - 5) and "<@" not in cut
    many = "\n".join(f"line {n}" for n in range(EXCERPT_LINES + 3))
    cut, truncated = excerpt(many)
    assert truncated and cut.split("\n") == [f"line {n}" for n in range(EXCERPT_LINES)]
    assert excerpt("  short\n") == ("short", False)


async def test_previews_follow_the_read_rule_and_leak_nothing(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")  # a member of the workspace in none of the channels
    gina = await make_user(db, "gina", role="guest")
    adam = await make_user(db, "adam", role="admin")  # an administrator outside them

    as_user(alice)
    general = await _channel(client, "general")
    secret = await _channel(client, "secret", "private")
    old = await _channel(client, "old")
    left = await _channel(client, "left-behind", "private")
    for channel in (general, secret, left):
        added = await client.post(
            f"/api/v1/channels/{channel}/members", json={"user_id": str(bob.id)}
        )
        assert added.status_code == 200, added.text
    dm = (await client.post("/api/v1/dms", json={"user_ids": [str(bob.id)]})).json()["id"]

    upload = await client.post(
        "/api/v1/attachments", files={"file": ("photo.png", _png(), "image/png")}
    )
    assert upload.status_code == 201, upload.text
    body = "\n".join([f"**計画** <@{bob.id}> を見て", *[f"行 {n}" for n in range(10)]])
    public = await _post(client, general, body, attachment_ids=[upload.json()["id"]])
    reply = await _post(client, general, "スレッドの返信", parent_id=public["id"])
    gone = await _post(client, general, "消すメッセージ")
    assert (await client.delete(f"/api/v1/messages/{gone['id']}")).status_code == 200
    private = await _post(client, secret, "非公開の話")
    direct = await _post(client, dm, "DM の話")
    archived = await _post(client, old, "アーカイブ前の話")
    assert (await client.post(f"/api/v1/channels/{old}/archive")).status_code == 200
    behind = await _post(client, left, "抜ける前の話")
    as_user(bob)
    assert (await client.post(f"/api/v1/channels/{left}/leave")).status_code == 204
    missing = str(uuid.uuid4())  # another server's message, or none at all

    ids = [
        public["id"],
        reply["id"],
        gone["id"],
        private["id"],
        direct["id"],
        archived["id"],
        behind["id"],
        missing,
        public["id"],  # asked twice: answered once
    ]

    # bob: a member everywhere but the channel he left.
    items = await _previews(client, *ids)
    assert list(items) == list(dict.fromkeys(ids))
    assert _states(items) == {
        public["id"]: "ok",
        reply["id"]: "ok",
        gone["id"]: "deleted",
        private["id"]: "ok",
        direct["id"]: "ok",
        archived["id"]: "ok",
        behind["id"]: "unavailable",
        missing: "unavailable",
    }
    first = items[public["id"]]
    assert first["channel_id"] == general and first["channel_name"] == "general"
    assert first["channel_type"] == "public" and first["parent_id"] is None
    assert first["sender_id"] == str(alice.id) and first["created_at"] == public["created_at"]
    # The body as written (mention tokens for the client to name), the first lines only.
    assert first["excerpt"].split("\n")[0] == f"**計画** <@{bob.id}> を見て"
    assert len(first["excerpt"].split("\n")) == EXCERPT_LINES and first["excerpt_truncated"]
    assert first["attachment_count"] == 1 and first["attachment_types"] == ["image/png"]
    assert first["thumbnail_attachment_id"] == upload.json()["id"]
    # The thumbnail loads for whoever gets the card.
    thumb = await client.get(f"/api/v1/attachments/{upload.json()['id']}/thumbnail")
    assert thumb.status_code == 200
    assert items[reply["id"]]["parent_id"] == public["id"]
    assert items[direct["id"]]["channel_type"] == "dm"
    assert items[direct["id"]]["channel_name"] is None  # clients name a DM from their own list
    assert items[private["id"]]["channel_name"] == "secret"
    for key in (gone["id"], behind["id"], missing):
        assert {k: v for k, v in items[key].items() if k not in ("id", "state")} == EMPTY

    # carol reads public channels before joining (M27), nothing else; a deleted public message
    # says so, a private one never.
    as_user(carol)
    assert _states(await _previews(client, *ids)) == {
        public["id"]: "ok",
        reply["id"]: "ok",
        gone["id"]: "deleted",
        private["id"]: "unavailable",
        direct["id"]: "unavailable",
        archived["id"]: "ok",
        behind["id"]: "unavailable",
        missing: "unavailable",
    }
    # With the preview before joining off (M88), not even the public ones.
    await db.execute(text("UPDATE workspace_settings SET preview_before_join = false"))
    await db.commit()
    states = _states(await _previews(client, public["id"], gone["id"]))
    assert states == {public["id"]: "unavailable", gone["id"]: "unavailable"}
    await db.execute(text("UPDATE workspace_settings SET preview_before_join = true"))
    await db.commit()

    # An administrator outside a private channel or a DM reads them no more than anyone.
    as_user(adam)
    states = _states(await _previews(client, private["id"], direct["id"], public["id"]))
    assert states == {private["id"]: "unavailable", direct["id"]: "unavailable", public["id"]: "ok"}

    # A guest reads only the channels they were added to (no public preview).
    as_user(gina)
    assert _states(await _previews(client, public["id"], gone["id"])) == {
        public["id"]: "unavailable",
        gone["id"]: "unavailable",
    }
    as_user(alice)
    added = await client.post(f"/api/v1/channels/{general}/members", json={"user_id": str(gina.id)})
    assert added.status_code == 200, added.text
    as_user(gina)
    states = _states(await _previews(client, public["id"], reply["id"], private["id"]))
    assert states == {public["id"]: "ok", reply["id"]: "ok", private["id"]: "unavailable"}


async def test_the_batch_is_bounded_and_rate_limited(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    as_user(await make_user(db, "alice"))
    too_many = [str(uuid.uuid4()) for _ in range(21)]
    for ids in ([], too_many, ["not-a-uuid"]):
        response = await client.post("/api/v1/messages/previews", json={"ids": ids})
        assert response.status_code == 422
    app.state.limiters["message_preview"] = RateLimiter(2)
    for _ in range(2):
        ok = await client.post("/api/v1/messages/previews", json={"ids": [str(uuid.uuid4())]})
        assert ok.status_code == 200
    limited = await client.post("/api/v1/messages/previews", json={"ids": [str(uuid.uuid4())]})
    assert limited.status_code == 429 and limited.json()["error"]["code"] == "rate_limited"


async def test_the_sender_removes_a_preview_for_everyone(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    adam = await make_user(db, "adam", role="admin")
    as_user(alice)
    general = await _channel(client, "general")
    for person in (bob, adam):
        added = await client.post(
            f"/api/v1/channels/{general}/members", json={"user_id": str(person.id)}
        )
        assert added.status_code == 200, added.text
    linked = await _post(client, general, "元のメッセージ")
    body = f"see https://Example.COM/Page#top and {BASE}/m/{linked['id']}."
    message = await _post(client, general, body)
    mid = message["id"]
    assert message["hidden_previews"] == []
    url = f"/api/v1/messages/{mid}/previews/hidden"

    # Only the sender (or an administrator in the conversation) may remove a card.
    as_user(bob)
    refused = await client.put(url, json={"url": "https://example.com/Page", "hidden": True})
    assert refused.status_code == 403 and refused.json()["error"]["code"] == "not_message_owner"
    as_user(carol)
    outsider = await client.put(url, json={"url": "https://example.com/Page", "hidden": True})
    assert outsider.status_code == 403 and outsider.json()["error"]["code"] == "not_a_member"

    as_user(alice)
    hidden = await client.put(url, json={"url": "https://Example.COM/Page#top", "hidden": True})
    assert hidden.status_code == 200, hidden.text
    assert hidden.json()["hidden_previews"] == ["https://example.com/Page"]
    seq = hidden.json()["updated_seq"]
    assert seq > message["updated_seq"]
    # The same again: nothing changes, nothing is announced.
    again = await client.put(url, json={"url": "https://example.com/Page", "hidden": True})
    assert again.status_code == 200 and again.json()["updated_seq"] == seq
    events = await _events(db, "previews")
    assert len(events) == 1 and events[0].seq == seq
    assert events[0].payload["message"]["hidden_previews"] == ["https://example.com/Page"]
    # Delta sync carries it to devices that missed the event.
    delta = (await client.get(f"/api/v1/channels/{general}/sync", params={"since_seq": 0})).json()
    row = next(m for m in delta["messages"] if m["id"] == mid)
    assert row["hidden_previews"] == ["https://example.com/Page"]

    # A link that is not in the body, or not a link at all.
    for wrong in ("https://other.example/", "mailto:alice@example.com"):
        bad = await client.put(url, json={"url": wrong, "hidden": True})
        assert bad.status_code in (400, 422)
        if bad.status_code == 400:
            assert bad.json()["error"]["code"] == "preview_not_in_message"

    # An administrator who is in the conversation removes the message link's card too (the link
    # as it is in the body, its trailing full stop or not).
    as_user(adam)
    by_admin = await client.put(url, json={"url": f"{BASE}/m/{linked['id']}", "hidden": True})
    assert by_admin.status_code == 200, by_admin.text
    assert by_admin.json()["hidden_previews"] == [
        "https://example.com/Page",
        f"{BASE}/m/{linked['id']}",
    ]

    # Brought back by the sender.
    as_user(alice)
    shown = await client.put(url, json={"url": "https://example.com/Page", "hidden": False})
    assert shown.status_code == 200
    assert shown.json()["hidden_previews"] == [f"{BASE}/m/{linked['id']}"]
    assert len(await _events(db, "previews")) == 3

    # An edit that takes a link out forgets its key; a deleted message keeps none.
    edited = await client.patch(f"/api/v1/messages/{mid}", json={"body": "no links any more"})
    assert edited.status_code == 200 and edited.json()["hidden_previews"] == []
    other = await _post(client, general, "https://example.org/")
    other_url = f"/api/v1/messages/{other['id']}/previews/hidden"
    hid = await client.put(other_url, json={"url": "https://example.org/", "hidden": True})
    assert hid.json()["hidden_previews"] == ["https://example.org/"]
    tombstone = (await client.delete(f"/api/v1/messages/{other['id']}")).json()
    assert tombstone["deleted"] and tombstone["hidden_previews"] == []
    gone = await client.put(other_url, json={"url": "https://example.org/", "hidden": False})
    assert gone.status_code == 404

    # An archived conversation is read-only.
    last = await _post(client, general, "https://example.net/")
    assert (await client.post(f"/api/v1/channels/{general}/archive")).status_code == 200
    archived = await client.put(
        f"/api/v1/messages/{last['id']}/previews/hidden",
        json={"url": "https://example.net/", "hidden": True},
    )
    assert archived.status_code == 409
    assert archived.json()["error"]["code"] == "channel_archived"
