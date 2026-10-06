"""M120 (docs/WIKI.md §4.7, §12 M120 completion): a page someone cannot read does not exist for
them on any path. One world, one parametrised suite: every path by every kind of outsider (a
member it is not shared with, a guest in a group it is shared with, an administrator).

Each case answers 404 where it names the page, and no response ever holds the secret's title or
body (the marker SECRET).
"""

import io
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient, Response
from PIL import Image
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.users.models import User
from app.modules.wiki import events
from tests.helpers import make_user
from tests.wiki_helpers import API, Actor, create_page, key, set_access

MARK = "SECRET"


def _png() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (16, 12), (1, 2, 3)).save(out, format="PNG")
    return out.getvalue()


@dataclass
class World:
    alice: User
    outsiders: dict[str, User]
    secret: dict[str, Any]
    secret_rev: str
    inner: dict[str, Any]  # a narrowed child of an open page
    shared_child: dict[str, Any]  # under the secret, shared with bob by name
    open_page: dict[str, Any]
    theirs: dict[str, Any]  # a page every outsider has full access to
    image_id: str


async def _world(client: AsyncClient, db: AsyncSession, as_user: Actor) -> World:
    alice = await make_user(db, "alice", role="admin")
    bob = await make_user(db, "bob")
    gina = await make_user(db, "gina", role="guest")
    boss = await make_user(db, "boss", role="admin")
    as_user(alice)
    group = await client.post(
        f"{API}/admin/groups", json={"name": "alumni", "member_ids": [str(gina.id)]}
    )
    assert group.status_code == 201, group.text
    open_page = await create_page(client, title="Open handbook", body="welcome")
    uploaded = await client.post(
        f"{API}/attachments", files={"file": ("x.png", _png(), "image/png")}
    )
    image_id = uploaded.json()["id"]
    secret = await create_page(
        client,
        title=f"{MARK}-TITLE",
        body=(
            f"{MARK}-BODY for <@{bob.id}> <@{gina.id}> <@{boss.id}>\n"
            f"![x](attachment:{image_id})\n[open](page:{open_page['id']})"
        ),
        access_="private",
    )
    # A guest's group has view: guests ignore group entries (WIKI.md §4.4).
    await set_access(
        client,
        secret["id"],
        [("user", str(alice.id), "full"), ("group", group.json()["id"], "view")],
    )
    shared_child = await create_page(client, parent_id=secret["id"], title="Shared child")
    await set_access(client, shared_child["id"], [("user", str(bob.id), "view")])
    inner = await create_page(client, parent_id=open_page["id"], title=f"{MARK}-INNER")
    await set_access(client, inner["id"], [("user", str(alice.id), "full")], inherit=False)
    theirs = await create_page(client, title="Theirs", access_="private")
    await set_access(
        client,
        theirs["id"],
        [("user", str(u.id), "full") for u in (alice, bob, gina, boss)],
    )
    revisions = (await client.get(f"{API}/wiki/pages/{secret['id']}/revisions")).json()
    return World(
        alice=alice,
        outsiders={"member": bob, "guest": gina, "admin": boss},
        secret=secret,
        secret_rev=revisions["items"][0]["id"],
        inner=inner,
        shared_child=shared_child,
        open_page=open_page,
        theirs=theirs,
        image_id=image_id,
    )


Call = Callable[[AsyncClient, World], Awaitable[Response | list[Response]]]


def _sid(w: World) -> str:
    return str(w.secret["id"])


CASES: dict[str, tuple[Call, bool]] = {
    # name: (the request(s), whether it names the secret and must be 404)
    "page": (lambda c, w: c.get(f"{API}/wiki/pages/{_sid(w)}"), True),
    "inner page": (lambda c, w: c.get(f"{API}/wiki/pages/{w.inner['id']}"), True),
    "revisions": (lambda c, w: c.get(f"{API}/wiki/pages/{_sid(w)}/revisions"), True),
    "revision": (
        lambda c, w: c.get(f"{API}/wiki/pages/{_sid(w)}/revisions/{w.secret_rev}"),
        True,
    ),
    "restore revision": (
        lambda c, w: c.post(
            f"{API}/wiki/pages/{_sid(w)}/revisions/{w.secret_rev}/restore",
            json={"client_save_id": key()},
        ),
        True,
    ),
    "label revision": (
        lambda c, w: c.patch(
            f"{API}/wiki/pages/{_sid(w)}/revisions/{w.secret_rev}", json={"label": "x"}
        ),
        True,
    ),
    "erase revision": (
        lambda c, w: c.delete(f"{API}/wiki/pages/{_sid(w)}/revisions/{w.secret_rev}"),
        True,
    ),
    "save": (
        lambda c, w: c.put(
            f"{API}/wiki/pages/{_sid(w)}/content",
            json={"base_rev_id": w.secret_rev, "body": "x", "client_save_id": key()},
        ),
        True,
    ),
    "rename": (lambda c, w: c.patch(f"{API}/wiki/pages/{_sid(w)}", json={"title": "x"}), True),
    "move": (
        lambda c, w: c.post(f"{API}/wiki/pages/{_sid(w)}/move", json={"dry_run": True}),
        True,
    ),
    "move into": (
        lambda c, w: c.post(
            f"{API}/wiki/pages/{w.theirs['id']}/move",
            json={"parent_id": _sid(w), "dry_run": True},
        ),
        True,
    ),
    "create under": (
        lambda c, w: c.post(
            f"{API}/wiki/pages", json={"client_save_id": key(), "parent_id": _sid(w)}
        ),
        True,
    ),
    "trash": (lambda c, w: c.delete(f"{API}/wiki/pages/{_sid(w)}"), True),
    "restore": (lambda c, w: c.post(f"{API}/wiki/pages/{_sid(w)}/restore"), True),
    "access": (lambda c, w: c.get(f"{API}/wiki/pages/{_sid(w)}/access"), True),
    "set access": (
        lambda c, w: c.put(
            f"{API}/wiki/pages/{_sid(w)}/access", json={"inherit_access": True, "grants": []}
        ),
        True,
    ),
    "backlinks of": (lambda c, w: c.get(f"{API}/wiki/pages/{_sid(w)}/backlinks"), True),
    "export": (lambda c, w: c.get(f"{API}/wiki/pages/{_sid(w)}/export"), True),
    "image": (lambda c, w: c.get(f"{API}/attachments/{w.image_id}"), True),
    "image content": (lambda c, w: c.get(f"{API}/attachments/{w.image_id}/content"), True),
    "image thumbnail": (lambda c, w: c.get(f"{API}/attachments/{w.image_id}/thumbnail"), True),
    # Paths that list or look up: answer, but without the secret.
    "tree": (lambda c, w: c.get(f"{API}/wiki/tree"), False),
    "changes": (lambda c, w: c.get(f"{API}/wiki/changes", params={"since": 0}), False),
    "trash list": (lambda c, w: c.get(f"{API}/wiki/trash"), False),
    "search": (lambda c, w: c.get(f"{API}/search/pages", params={"q": "TITLE"}), False),
    "search body": (lambda c, w: c.get(f"{API}/search/pages", params={"q": "BODY"}), False),
    "search in page": (
        lambda c, w: c.get(f"{API}/search/pages", params={"q": "welcome", "in_page": _sid(w)}),
        False,
    ),
    "lookup": (lambda c, w: c.get(f"{API}/wiki/pages/lookup", params={"q": "TITLE"}), False),
    "resolve": (
        lambda c, w: c.post(
            f"{API}/wiki/pages/resolve", json={"ids": [_sid(w), str(w.inner["id"])]}
        ),
        False,
    ),
    "backlinks to a readable page": (
        lambda c, w: c.get(f"{API}/wiki/pages/{w.open_page['id']}/backlinks"),
        False,
    ),
    "readable parent's children": (
        lambda c, w: c.get(f"{API}/wiki/pages/{w.open_page['id']}"),
        False,
    ),
    "export subtree": (
        lambda c, w: c.get(
            f"{API}/wiki/pages/{w.open_page['id']}/export", params={"subtree": "true"}
        ),
        False,
    ),
    "activity": (
        lambda c, w: c.get(f"{API}/activity", params={"include": ["page_mention", "page_shared"]}),
        False,
    ),
    "bootstrap": (lambda c, w: c.get(f"{API}/sync/bootstrap"), False),
}


def _texts(result: Response | list[Response]) -> list[Response]:
    return result if isinstance(result, list) else [result]


@pytest.mark.parametrize("who", ["member", "guest", "admin"])
@pytest.mark.parametrize("case", sorted(CASES))
async def test_unreadable_page_does_not_exist(
    client: AsyncClient, db: AsyncSession, as_user: Actor, who: str, case: str
) -> None:
    world = await _world(client, db, as_user)
    as_user(world.outsiders[who])
    call, names_it = CASES[case]
    for response in _texts(await call(client, world)):
        if names_it:
            assert response.status_code == 404, (case, response.status_code, response.text)
            code = response.json()["error"]["code"]
            assert code in ("page_not_found", "attachment_not_found"), code
        elif response.status_code == 404:
            # The open page is not shared with guests: for them it does not exist either.
            assert who == "guest" and response.json()["error"]["code"] == "page_not_found"
        else:
            assert response.status_code == 200, (case, response.text)
        assert MARK not in response.text, (case, response.text[:300])
        # Not even the id, but in the change feed's `removed` (WIKI.md §10: ids only).
        if case != "changes":
            assert str(world.secret["id"]) not in response.text, (case, response.text[:300])


async def test_breadcrumbs_hide_an_unreadable_parent(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    world = await _world(client, db, as_user)
    as_user(world.outsiders["member"])
    page = await client.get(f"{API}/wiki/pages/{world.shared_child['id']}")
    assert page.status_code == 200
    assert page.json()["breadcrumbs"] == [
        {"id": None, "title": None, "icon": None, "readable": False}
    ]
    assert MARK not in page.text
    access_out = await client.get(f"{API}/wiki/pages/{world.shared_child['id']}/access")
    assert MARK not in access_out.text
    assert str(world.secret["id"]) not in access_out.text
    tree = (await client.get(f"{API}/wiki/tree")).json()
    assert {p["title"] for p in tree["pages"]} == {"Open handbook", "Shared child", "Theirs"}
    child = next(p for p in tree["pages"] if p["title"] == "Shared child")
    assert child["parent_id"] is None  # shown at the top level, its parent unnamed


async def test_events_and_notices_skip_outsiders(
    client: AsyncClient, db: AsyncSession, as_user: Actor, app: FastAPI
) -> None:
    world = await _world(client, db, as_user)
    outsiders = {u.id for u in world.outsiders.values()}
    mentioned = (
        (
            await db.execute(
                select(OutboxEvent).where(OutboxEvent.event_type == events.WIKI_MENTIONED)
            )
        )
        .scalars()
        .all()
    )
    assert not {m.audience_id for m in mentioned} & outsiders
    shared = (
        (await db.execute(select(OutboxEvent).where(OutboxEvent.event_type == events.WIKI_SHARED)))
        .scalars()
        .all()
    )
    # bob was named on the shared child (that one he can read); nobody about the secret.
    pairs = {(s.audience_id, s.payload["page_id"]) for s in shared}
    assert (world.outsiders["member"].id, str(world.shared_child["id"])) in pairs
    assert all(page_id != str(world.secret["id"]) for _, page_id in pairs)
    updated = (
        (
            await db.execute(
                select(OutboxEvent).where(
                    OutboxEvent.event_type == events.WIKI_PAGE_UPDATED,
                    OutboxEvent.audience_id == uuid.UUID(str(world.secret["id"])),
                )
            )
        )
        .scalars()
        .all()
    )
    resolve = events.audience_resolver(app.state.relay.resolve_audience)
    for row in updated:
        audience = await resolve(db, row)
        assert set(audience.ids) == {world.alice.id}
    changed = (
        (await db.execute(select(OutboxEvent).where(OutboxEvent.event_type == events.WIKI_CHANGED)))
        .scalars()
        .all()
    )
    assert all(MARK not in str(e.payload) for e in changed)


async def test_admin_lists_titles_only_for_admins(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    world = await _world(client, db, as_user)
    for who in ("member", "guest"):
        as_user(world.outsiders[who])
        listed = await client.get(f"{API}/admin/wiki/pages")
        assert listed.status_code == 403 and MARK not in listed.text
    as_user(world.outsiders["admin"])
    listed = await client.get(f"{API}/admin/wiki/pages")
    # WIKI.md §4.3: an administrator sees titles and who has access, never bodies.
    assert f"{MARK}-TITLE" in listed.text and f"{MARK}-BODY" not in listed.text
