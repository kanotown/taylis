"""Wiki pages, the server (M120, docs/WIKI.md): the tree, the body and its versions, moving, the
trash, access with inheritance, guests, administrators, the change feed and the events."""

import uuid
from datetime import timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app import cli
from app.cli import build_parser
from app.core import settings as settings_module
from app.core.settings import Settings
from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.audit.models import AuditLog
from app.modules.canvases import service as canvases
from app.modules.wiki import access, events, ordering
from app.modules.wiki import service as wiki
from app.modules.wiki.models import WikiEffectiveGrant, WikiPage, WikiPageRevision
from tests.helpers import make_user
from tests.wiki_helpers import (
    API,
    Actor,
    assert_acl_consistent,
    create_page,
    key,
    save,
    set_access,
)


async def _get(client: AsyncClient, page_id: str) -> Any:
    return await client.get(f"{API}/wiki/pages/{page_id}")


# --- creating, reading ---------------------------------------------------------------------------


async def test_create_top_level_and_children(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    root = await create_page(client, title="研究室マニュアル", body="# はじめに")
    assert root["my_level"] == "full"
    assert root["parent_id"] is None
    assert root["breadcrumbs"] == []
    access_out = (await client.get(f"{API}/wiki/pages/{root['id']}/access")).json()
    assert {(e["principal_type"], e["level"]) for e in access_out["effective"]} == {
        ("workspace", "edit"),
        ("user", "full"),
    }
    a = await create_page(client, parent_id=root["id"], title="A")
    b = await create_page(client, parent_id=root["id"], title="B")
    first = await create_page(client, parent_id=root["id"], title="First", before_id=a["id"])
    middle = await create_page(client, parent_id=root["id"], title="Mid", after_id=a["id"])
    page = (await _get(client, root["id"])).json()
    assert [c["title"] for c in page["children"]] == ["First", "A", "Mid", "B"]
    assert first["position"] < a["position"] < middle["position"] < b["position"]
    child = (await _get(client, middle["id"])).json()
    assert child["breadcrumbs"] == [
        {"id": root["id"], "title": "研究室マニュアル", "icon": None, "readable": True}
    ]

    # Bob (a member) edits through the workspace entry but does not manage.
    as_user(bob)
    seen = (await _get(client, middle["id"])).json()
    assert seen["my_level"] == "edit"
    assert (await client.delete(f"{API}/wiki/pages/{middle['id']}")).status_code == 403
    tree = (await client.get(f"{API}/wiki/tree")).json()
    assert len(tree["pages"]) == 5
    assert tree["cursor"] >= max(p["meta_seq"] for p in tree["pages"])
    await assert_acl_consistent(db)


async def test_private_top_level_and_idempotent_create(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    save_id = key()
    body = {"client_save_id": save_id, "title": "メモ", "access": "private"}
    first = await client.post(f"{API}/wiki/pages", json=body)
    again = await client.post(f"{API}/wiki/pages", json=body)
    assert first.status_code == 201 and again.status_code == 200
    assert first.json()["id"] == again.json()["id"]
    assert first.json()["private"] is True
    as_user(bob)
    assert (await _get(client, first.json()["id"])).status_code == 404
    assert (await client.get(f"{API}/wiki/tree")).json()["pages"] == []


async def test_template_and_icon(client: AsyncClient, db: AsyncSession, as_user: Actor) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    await canvases.ensure_builtin_templates(db)
    made = await client.post(
        f"{API}/wiki/pages",
        json={"client_save_id": key(), "template_key": "minutes", "icon": "📘"},
    )
    assert made.status_code == 201, made.text
    page = made.json()
    assert page["body"].startswith("# 議事録")
    assert page["icon"] == "📘"
    changed = await client.patch(f"{API}/wiki/pages/{page['id']}", json={"icon": ":tada:"})
    assert changed.json()["icon"] == ":tada:"
    bad = await client.patch(f"{API}/wiki/pages/{page['id']}", json={"icon": ":Bad Icon:"})
    assert bad.status_code == 400
    cleared = await client.patch(f"{API}/wiki/pages/{page['id']}", json={"icon": ""})
    assert cleared.json()["icon"] is None


# --- saving --------------------------------------------------------------------------------------


async def test_save_merge_conflict_and_history(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    page = await create_page(client, title="Doc", body="one\ntwo\nthree")
    base = page["head_rev_id"]
    first = await save(client, page, "1\ntwo\nthree")
    assert first.status_code == 200 and first.json()["merged"] is False
    merged = await save(client, page, "one\ntwo\n3", base=base)
    assert merged.status_code == 200, merged.text
    assert merged.json()["merged"] is True
    assert merged.json()["page"]["body"] == "1\ntwo\n3"
    clash = await save(client, page, "uno\ntwo\nthree", base=base)
    assert clash.status_code == 409
    assert clash.json()["error"]["code"] == "page_conflict"
    expired = await save(client, page, "x", base=str(uuid.uuid4()))
    assert expired.json()["error"]["code"] == "page_base_expired"
    too_big = await save(client, page, "x" * 100_001)
    assert too_big.status_code == 422
    assert too_big.json()["error"]["code"] == "page_too_large"

    history = (await client.get(f"{API}/wiki/pages/{page['id']}/revisions")).json()
    kinds = [r["kind"] for r in history["items"]]
    assert kinds == ["merge", "save", "create"]
    create_rev = history["items"][-1]["id"]
    restored = await client.post(
        f"{API}/wiki/pages/{page['id']}/revisions/{create_rev}/restore",
        json={"client_save_id": key()},
    )
    assert restored.json()["body"] == "one\ntwo\nthree"
    labelled = await client.patch(
        f"{API}/wiki/pages/{page['id']}/revisions/{create_rev}", json={"label": " 提出版 "}
    )
    assert labelled.json()["label"] == "提出版"
    head = (await _get(client, page["id"])).json()["head_rev_id"]
    refused = await client.delete(f"{API}/wiki/pages/{page['id']}/revisions/{head}")
    assert refused.json()["error"]["code"] == "page_revision_is_head"
    erased = await client.delete(f"{API}/wiki/pages/{page['id']}/revisions/{create_rev}")
    assert erased.json()["kind"] == "erased"
    gone = await client.get(f"{API}/wiki/pages/{page['id']}/revisions/{create_rev}")
    assert gone.json()["body"] == ""


async def test_view_level_changes_nothing(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    page = await create_page(client, title="Rules", body="- [ ] read")
    await set_access(
        client,
        page["id"],
        [("workspace", None, "view"), ("user", str(alice.id), "full")],
        inherit=False,
    )
    as_user(bob)
    tick = await save(client, page, "- [x] read")
    assert tick.status_code == 403
    assert tick.json()["error"]["code"] == "page_edit_restricted"
    rename = await client.patch(f"{API}/wiki/pages/{page['id']}", json={"title": "x"})
    assert rename.status_code == 403
    child = await client.post(
        f"{API}/wiki/pages",
        json={"client_save_id": key(), "parent_id": page["id"], "title": "c"},
    )
    assert child.status_code == 403
    share = await client.get(f"{API}/wiki/pages/{page['id']}/access")
    assert share.status_code == 200 and share.json()["my_level"] == "view"
    refused = await client.put(
        f"{API}/wiki/pages/{page['id']}/access", json={"inherit_access": True, "grants": []}
    )
    assert refused.json()["error"]["code"] == "page_manage_restricted"


async def test_links_and_backlinks(client: AsyncClient, db: AsyncSession, as_user: Actor) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    target = await create_page(client, title="Target")
    public = await create_page(client, title="Public", body=f"see [T](page:{target['id']})")
    secret = await create_page(
        client,
        title="Secret source",
        body=f"see https://chat.example.org/p/{target['id']}",
        access_="private",
    )
    back = (await client.get(f"{API}/wiki/pages/{target['id']}/backlinks")).json()
    assert {p["id"] for p in back} == {public["id"], secret["id"]}
    as_user(bob)
    back = (await client.get(f"{API}/wiki/pages/{target['id']}/backlinks")).json()
    assert [p["id"] for p in back] == [public["id"]]
    resolved = await client.post(
        f"{API}/wiki/pages/resolve", json={"ids": [target["id"], secret["id"], key()]}
    )
    assert [r["id"] for r in resolved.json()] == [target["id"]]
    found = (await client.get(f"{API}/wiki/pages/lookup", params={"q": "sour"})).json()
    assert found == []
    found = (await client.get(f"{API}/wiki/pages/lookup", params={"q": "pub"})).json()
    assert [p["title"] for p in found] == ["Public"]


# --- moving, inheritance, keep_access ------------------------------------------------------------


async def test_move_inherits_and_dry_run(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    shared = await create_page(client, title="Shared")
    private = await create_page(client, title="Private", access_="private")
    note = await create_page(client, parent_id=shared["id"], title="Note")
    deep = await create_page(client, parent_id=note["id"], title="Deep")

    dry = await client.post(
        f"{API}/wiki/pages/{note['id']}/move",
        json={"parent_id": private["id"], "dry_run": True},
    )
    assert dry.status_code == 200
    assert dry.json()["changes"] == [
        {"principal_type": "workspace", "principal_id": None, "before": "edit", "after": None}
    ]
    assert dry.json()["manager_lost"] is False
    as_user(bob)
    assert (await _get(client, deep["id"])).status_code == 200

    as_user(alice)
    moved = await client.post(
        f"{API}/wiki/pages/{note['id']}/move", json={"parent_id": private["id"]}
    )
    assert moved.status_code == 200, moved.text
    as_user(bob)
    assert (await _get(client, note["id"])).status_code == 404
    assert (await _get(client, deep["id"])).status_code == 404

    as_user(alice)
    cycle = await client.post(
        f"{API}/wiki/pages/{private['id']}/move", json={"parent_id": deep["id"]}
    )
    assert cycle.json()["error"]["code"] == "wiki_move_cycle"
    page = (await _get(client, deep["id"])).json()
    assert [c["id"] for c in page["breadcrumbs"]] == [private["id"], note["id"]]

    # keep_access: back under Shared but still private.
    kept = await client.post(
        f"{API}/wiki/pages/{note['id']}/move",
        json={"parent_id": shared["id"], "keep_access": True},
    )
    assert kept.status_code == 200
    assert kept.json()["page"]["inherit_access"] is False
    as_user(bob)
    assert (await _get(client, deep["id"])).status_code == 404
    await assert_acl_consistent(db)


async def test_narrow_and_add_on_a_child(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    root = await create_page(client, title="Lab")
    child = await create_page(client, parent_id=root["id"], title="Faculty only")
    grandchild = await create_page(client, parent_id=child["id"], title="Budget")
    # Narrowing: stop inheriting, keep alice (full) and carol (view).
    await set_access(
        client,
        child["id"],
        [("user", str(alice.id), "full"), ("user", str(carol.id), "view")],
        inherit=False,
    )
    as_user(bob)
    for pid in (child["id"], grandchild["id"]):
        assert (await _get(client, pid)).status_code == 404
    as_user(carol)
    assert (await _get(client, grandchild["id"])).json()["my_level"] == "view"
    crumbs = (await _get(client, grandchild["id"])).json()["breadcrumbs"]
    assert [c["title"] for c in crumbs] == ["Lab", "Faculty only"]
    # Adding on the grandchild: bob reads it, sees no title of the parent he cannot read.
    as_user(alice)
    await set_access(client, grandchild["id"], [("user", str(bob.id), "edit")])
    as_user(bob)
    page = (await _get(client, grandchild["id"])).json()
    assert page["my_level"] == "edit"
    assert page["breadcrumbs"][1] == {"id": None, "title": None, "icon": None, "readable": False}
    tree = (await client.get(f"{API}/wiki/tree")).json()["pages"]
    assert {p["title"] for p in tree} == {"Lab", "Budget"}
    effective = (await client.get(f"{API}/wiki/pages/{grandchild['id']}/access")).json()
    inherited = [e for e in effective["effective"] if e["inherited"]]
    assert inherited and all(e["source_title"] is None for e in inherited)
    await assert_acl_consistent(db)


async def test_last_manager_and_shared_notice(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    guest = await make_user(db, "gina", role="guest")
    as_user(alice)
    page = await create_page(client, title="Mine", access_="private")
    refused = await client.put(
        f"{API}/wiki/pages/{page['id']}/access",
        json={
            "inherit_access": True,
            "grants": [{"principal_type": "user", "principal_id": str(guest.id), "level": "full"}],
        },
    )
    assert refused.json()["error"]["code"] == "page_last_manager"
    await set_access(
        client,
        page["id"],
        [("user", str(alice.id), "full"), ("user", str(bob.id), "view")],
    )
    notices = (
        (await db.execute(select(OutboxEvent).where(OutboxEvent.event_type == events.WIKI_SHARED)))
        .scalars()
        .all()
    )
    assert [n.audience_id for n in notices] == [bob.id]
    audit = (
        (await db.execute(select(AuditLog).where(AuditLog.action == "wiki.access_changed")))
        .scalars()
        .all()
    )
    assert len(audit) == 1
    as_user(bob)
    activity = (await client.get(f"{API}/activity", params={"include": ["page_shared"]})).json()
    assert [i["kind"] for i in activity["items"]] == ["page_shared"]
    assert activity["items"][0]["page"]["title"] == "Mine"


# --- guests and administrators -------------------------------------------------------------------


async def test_guests_read_only_what_is_named(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice", role="admin")
    guest = await make_user(db, "gina", role="guest")
    as_user(alice)
    group = await client.post(
        f"{API}/admin/groups", json={"name": "alumni", "member_ids": [str(guest.id)]}
    )
    assert group.status_code == 201, group.text
    everyone = await create_page(client, title="Everyone")
    by_group = await create_page(client, title="Alumni", access_="private")
    await set_access(
        client,
        by_group["id"],
        [("user", str(alice.id), "full"), ("group", group.json()["id"], "view")],
    )
    named = await create_page(client, title="Named", access_="private")
    await set_access(
        client, named["id"], [("user", str(alice.id), "full"), ("user", str(guest.id), "edit")]
    )
    as_user(guest)
    assert (await _get(client, everyone["id"])).status_code == 404
    assert (await _get(client, by_group["id"])).status_code == 404
    assert (await _get(client, named["id"])).json()["my_level"] == "edit"
    top = await client.post(f"{API}/wiki/pages", json={"client_save_id": key(), "title": "x"})
    assert top.json()["error"]["code"] == "guest_restricted"
    child = await create_page(client, parent_id=named["id"], title="Guest child")
    assert child["my_level"] == "edit"
    share = await client.put(
        f"{API}/wiki/pages/{named['id']}/access", json={"inherit_access": True, "grants": []}
    )
    assert share.status_code == 403


async def test_admin_cannot_read_but_can_take_over(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    admin = await make_user(db, "boss", role="admin")
    alice = await make_user(db, "alice")
    as_user(alice)
    page = await create_page(client, title="Diary", body="secret", access_="private")
    as_user(admin)
    assert (await _get(client, page["id"])).status_code == 404
    listed = (await client.get(f"{API}/admin/wiki/pages")).json()
    assert [(p["title"], p["has_manager"]) for p in listed] == [("Diary", True)]
    assert "body" not in listed[0]
    taken = await client.post(f"{API}/admin/wiki/pages/{page['id']}/takeover")
    assert taken.status_code == 200
    assert taken.json()["body"] == "secret"
    logged = (
        (await db.execute(select(AuditLog).where(AuditLog.action == "wiki.access_takeover")))
        .scalars()
        .all()
    )
    assert len(logged) == 1 and logged[0].actor_id == admin.id
    as_user(alice)
    assert (await client.get(f"{API}/admin/wiki/pages")).status_code == 403
    assert (await client.post(f"{API}/admin/wiki/pages/{page['id']}/takeover")).status_code == 403


# --- the trash -----------------------------------------------------------------------------------


async def test_trash_restore_and_purge(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    root = await create_page(client, title="Root")
    child = await create_page(client, parent_id=root["id"], title="Child")
    grandchild = await create_page(client, parent_id=child["id"], title="Grandchild")
    assert (await client.delete(f"{API}/wiki/pages/{child['id']}")).status_code == 204
    assert (await _get(client, grandchild["id"])).status_code == 404
    trash = (await client.get(f"{API}/wiki/trash")).json()
    assert [t["id"] for t in trash] == [child["id"]]
    not_root = await client.post(f"{API}/wiki/pages/{grandchild['id']}/restore")
    assert not_root.json()["error"]["code"] == "page_trashed_with_parent"
    back = await client.post(f"{API}/wiki/pages/{child['id']}/restore")
    assert back.status_code == 200
    assert (await _get(client, grandchild["id"])).status_code == 200

    # The parent trashed and purged first: the child (trashed on its own before) survives at the
    # top level with the access it had.
    assert (await client.delete(f"{API}/wiki/pages/{grandchild['id']}")).status_code == 204
    assert (await client.delete(f"{API}/wiki/pages/{root['id']}")).status_code == 204
    await db.execute(
        update(WikiPage)
        .where(WikiPage.trash_root_id == root["id"])
        .values(deleted_at=utcnow() - timedelta(days=31))
    )
    await db.commit()
    purged = await wiki.purge_trash(db, now=utcnow(), trash_days=30)
    assert purged == 2
    restored = await client.post(f"{API}/wiki/pages/{grandchild['id']}/restore")
    assert restored.status_code == 200, restored.text
    assert restored.json()["parent_id"] is None
    assert restored.json()["inherit_access"] is False
    changes = (await client.get(f"{API}/wiki/changes", params={"since": 0})).json()
    assert {root["id"], child["id"]} <= set(changes["removed"])
    await assert_acl_consistent(db)


# --- the change feed and events ------------------------------------------------------------------


async def test_change_feed(client: AsyncClient, db: AsyncSession, as_user: Actor) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(bob)
    start = (await client.get(f"{API}/wiki/tree")).json()["cursor"]
    boot = (await client.get(f"{API}/sync/bootstrap")).json()
    assert boot["wiki"]["change_seq"] == start
    as_user(alice)
    open_page = await create_page(client, title="Open")
    hidden = await create_page(client, title="Hidden", access_="private")
    as_user(bob)
    feed = (await client.get(f"{API}/wiki/changes", params={"since": start})).json()
    assert [p["id"] for p in feed["pages"]] == [open_page["id"]]
    assert feed["removed"] == []  # a private page never seen is not even an id
    cursor = feed["cursor"]

    # A body save does not move the feed.
    as_user(alice)
    assert (await save(client, open_page, "new body")).status_code == 200
    as_user(bob)
    same = (await client.get(f"{API}/wiki/changes", params={"since": cursor})).json()
    assert same["pages"] == [] and same["cursor"] == cursor

    # Taken away: an id in removed. Renamed while unreadable: nothing.
    as_user(alice)
    await set_access(client, open_page["id"], [("user", str(alice.id), "full")], inherit=False)
    await client.patch(f"{API}/wiki/pages/{hidden['id']}", json={"title": "Renamed"})
    as_user(bob)
    lost = (await client.get(f"{API}/wiki/changes", params={"since": cursor})).json()
    assert lost["pages"] == [] and lost["removed"] == [open_page["id"]]
    assert "Renamed" not in str(lost)

    too_new = (await client.get(f"{API}/wiki/changes", params={"since": 10**12})).json()
    assert too_new["reset"] is True


async def test_events_audience_is_resolved_when_sent(
    client: AsyncClient, db: AsyncSession, as_user: Actor, app: FastAPI
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    page = await create_page(client, title="P")
    await save(client, page, "edited")
    row = (
        (
            await db.execute(
                select(OutboxEvent)
                .where(OutboxEvent.event_type == events.WIKI_PAGE_UPDATED)
                .order_by(OutboxEvent.id.desc())
            )
        )
        .scalars()
        .first()
    )
    assert row is not None and row.audience_type == "page"
    resolve = events.audience_resolver(app.state.relay.resolve_audience)
    audience = await resolve(db, row)
    assert set(audience.ids) == {alice.id, bob.id}
    # Access narrowed after the event was written: bob no longer gets it.
    await set_access(client, page["id"], [("user", str(alice.id), "full")], inherit=False)
    row_id, alice_id = row.id, alice.id
    db.expire_all()
    again = await db.get(OutboxEvent, row_id)
    assert again is not None
    audience = await resolve(db, again)
    assert audience.ids == (alice_id,)
    changed = (
        (await db.execute(select(OutboxEvent).where(OutboxEvent.event_type == events.WIKI_CHANGED)))
        .scalars()
        .all()
    )
    assert changed and all(set(e.payload) == {"seq"} for e in changed)


async def test_mentions_reach_readers_only(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    page = await create_page(client, title="Plan", access_="private")
    await set_access(
        client, page["id"], [("user", str(alice.id), "full"), ("user", str(bob.id), "view")]
    )
    await db.execute(delete(OutboxEvent).where(OutboxEvent.event_type == events.WIKI_SHARED))
    await db.commit()
    page = (await _get(client, page["id"])).json()
    saved = await save(client, page, f"ask <@{bob.id}> and <@{carol.id}>")
    assert saved.status_code == 200
    mentioned = (
        (
            await db.execute(
                select(OutboxEvent).where(OutboxEvent.event_type == events.WIKI_MENTIONED)
            )
        )
        .scalars()
        .all()
    )
    assert [m.audience_id for m in mentioned] == [bob.id]
    as_user(bob)
    items = (await client.get(f"{API}/activity", params={"include": ["page_mention"]})).json()
    assert [i["kind"] for i in items["items"]] == ["page_mention"]
    assert "Bob" in items["items"][0]["page"]["excerpt"]
    summary = (
        await client.get(f"{API}/activity/summary", params={"include": ["page_mention"]})
    ).json()
    assert summary["unread_count"] == 1 and summary["mention_unread"] is True
    # Without include the item is not there (older clients).
    plain = (await client.get(f"{API}/activity")).json()
    assert plain["items"] == []


# --- small parts ---------------------------------------------------------------------------------


def test_fractional_keys() -> None:
    import random

    rng = random.Random(7)
    keys: list[str] = []
    for _ in range(600):
        index = rng.randint(0, len(keys))
        low = keys[index - 1] if index > 0 else None
        high = keys[index] if index < len(keys) else None
        made = ordering.key_between(low, high)
        assert ordering.valid(made)
        assert (low is None or low < made) and (high is None or made < high)
        keys.insert(index, made)
    appended: list[str] = []
    for _ in range(1000):
        appended.append(ordering.key_between(appended[-1] if appended else None, None))
    assert appended == sorted(appended)
    assert max(len(k) for k in appended) <= 40
    with pytest.raises(ValueError):
        ordering.key_between("b", "a")


async def test_depth_limit(client: AsyncClient, db: AsyncSession, as_user: Actor) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    parent: dict[str, Any] | None = None
    for depth in range(20):
        parent = await create_page(
            client, parent_id=parent["id"] if parent else None, title=f"d{depth}"
        )
    assert parent is not None
    deep = await client.post(
        f"{API}/wiki/pages",
        json={"client_save_id": key(), "parent_id": parent["id"], "title": "too deep"},
    )
    assert deep.json()["error"]["code"] == "wiki_too_deep"


async def test_permalink_landing(client: AsyncClient) -> None:
    page = await client.get(f"/p/{uuid.uuid4()}")
    assert page.status_code == 200
    assert "ドキュメント" in page.text
    assert (await client.get("/p/not-an-id")).status_code == 404


async def test_housekeeping_runs(db: AsyncSession, client: AsyncClient, as_user: Actor) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    page = await create_page(client, title="H", body="a")
    for n in range(3):
        current = (await _get(client, page["id"])).json()
        await save(client, current, f"a{n}")
    await db.execute(
        update(WikiPageRevision)
        .where(WikiPageRevision.page_id == page["id"])
        .values(created_at=utcnow() - timedelta(days=2))
    )
    await db.commit()
    pruned, purged, released = await wiki.housekeeping(db, now=utcnow(), trash_days=30)
    assert pruned >= 1 and purged == 0 and released == 0
    count = await db.scalar(
        select(func.count())
        .select_from(WikiPageRevision)
        .where(WikiPageRevision.page_id == page["id"])
    )
    assert count is not None and count < 4
    assert await access.verify(db) == []


async def test_wiki_acl_cli(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Actor,
    test_settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    page = await create_page(client, title="Checked")
    monkeypatch.setattr(settings_module, "get_settings", lambda: test_settings)
    assert build_parser().parse_args(["wiki-acl", "--verify"]).func is cli.cmd_wiki_acl
    assert await cli._wiki_acl(rebuild=False) == 0
    await db.execute(delete(WikiEffectiveGrant).where(WikiEffectiveGrant.page_id == page["id"]))
    await db.commit()
    assert await cli._wiki_acl(rebuild=False) == 1
    assert "1 difference(s)" in capsys.readouterr().out
    assert await cli._wiki_acl(rebuild=True) == 0
    assert (await _get(client, page["id"])).status_code == 200
