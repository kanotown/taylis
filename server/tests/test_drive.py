"""The drive (M160, docs/DRIVE.md phase D1): locations and permissions (§3), folders and names
(§4.3), moves, the trash (§10.1), the takeover and anonymisation (§3.3), events (§14)."""

import unicodedata
import uuid
from collections.abc import Callable
from datetime import timedelta

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.collation import name_key
from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.attachments.models import Attachment
from app.modules.audit.models import AuditLog
from app.modules.drive import events as drive_events
from app.modules.drive import housekeeping, names
from app.modules.drive import service as drive
from app.modules.drive.models import DriveItem, DriveLocation
from app.modules.users.models import User
from tests.drive_helpers import (
    act_as,
    children,
    drive_settings,
    folder,
    location,
    names_in,
    upload,
    workspace_root,
)
from tests.helpers import make_user

API = "/api/v1"


@pytest.fixture
def as_user(app: FastAPI) -> Callable[[User], None]:
    """The drive tests act with the user loaded in each request's session (drive_helpers)."""
    return act_as(app)


# --- names (§4.3) ------------------------------------------------------------------------------


def test_names_are_normalised_checked_and_sorted() -> None:
    nfd = unicodedata.normalize("NFD", "がくせい.pdf")
    assert names.normalize(f"  {nfd} ") == "がくせい.pdf"
    assert names.key("Report.PDF") == names.key("report.pdf")
    for bad in ("", "   ", "a/b", "x\x00y", "tab\there", ".", "..", "a" * 256):
        with pytest.raises(Exception) as caught:
            names.normalize(bad)
        assert getattr(caught.value, "code", None) == "drive_name_invalid", bad
    # Windows' forbidden characters are kept in the name (replaced in downloads only).
    assert names.normalize('a<b>:"c|?*.txt') == 'a<b>:"c|?*.txt'
    assert names.download_name('a<b>:"c|?*.txt') == "a_b___c___.txt"
    assert names.download_name("CON.txt") == "_CON.txt"
    assert names.download_name(".hidden ") == "hidden"
    sample = [
        "b",
        "B",
        "a10",
        "a2",
        "a1",
        "あ",
        "ア",
        "ぁ",
        "か",
        "が",
        "漢字",
        "亜",
        "Ω",
        "_x",
        "1",
        "01",
        "Zeta",
        "zeta",
        "",
        "a\x00b",
        "ab",
    ]
    by_bytes = sorted(sample, key=names.sort_key)
    by_tuple = sorted(sample, key=name_key)
    assert by_bytes == by_tuple
    assert names.numbered("報告.pdf", 2, is_file=True) == "報告 (2).pdf"
    assert names.numbered("資料.v2", 1, is_file=False) == "資料.v2 (1)"
    assert len(names.numbered("x" * 255, 3, is_file=False)) == 255


# --- the permission matrix (§3.2) ----------------------------------------------------------------


async def test_permission_matrix(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """3 locations x admin / manager / member / guest / channel owner / former member, and an
    archived channel and an owners-only channel: list (read), create a folder (write), delete
    from the trash (manage)."""
    drive_settings(app)
    admin = await make_user(db, "ada", role="admin")
    manager = await make_user(db, "max", role="manager")
    member = await make_user(db, "mia")
    guest = await make_user(db, "gus", role="guest")
    owner = await make_user(db, "olivia")
    former = await make_user(db, "fred")
    actors = {
        "admin": admin,
        "manager": manager,
        "member": member,
        "guest": guest,
        "owner": owner,
        "former": former,
    }

    as_user(owner)
    lab = (await client.post(f"{API}/channels", json={"name": "lab", "type": "private"})).json()
    for person in (member, guest, former):
        added = await client.post(
            f"{API}/channels/{lab['id']}/members", json={"user_id": str(person.id)}
        )
        assert added.status_code == 200, added.text
    channel_drive = await location(client, "channel", channel_id=lab["id"])
    as_user(former)
    assert (await client.post(f"{API}/channels/{lab['id']}/leave")).status_code == 204
    as_user(member)
    mine = await location(client, "me")
    workspace = await workspace_root(client)

    roots = {
        "workspace": workspace,
        "channel": channel_drive["root_id"],
        "user": mine["root_id"],
    }
    can_read = {
        "workspace": {"admin", "manager", "member", "owner", "former"},
        "channel": {"member", "guest", "owner"},
        "user": {"member"},
    }
    can_manage = {"workspace": {"admin"}, "channel": {"owner"}, "user": {"member"}}

    for place, root in roots.items():
        for role, actor in actors.items():
            as_user(actor)
            listed = await children(client, root)
            readable = role in can_read[place]
            assert listed.status_code == (200 if readable else 404), (place, role, listed.text)
            if not readable:
                assert listed.json()["error"]["code"] == "drive_item_not_found"
            made = await client.post(
                f"{API}/drive/folders", json={"parent_id": root, "name": f"{role}-folder"}
            )
            assert made.status_code == (201 if readable else 404), (place, role, made.text)
            if not readable:
                continue
            folder_id = made.json()["id"]
            trashed = await client.post(f"{API}/drive/items/trash", json={"item_ids": [folder_id]})
            assert trashed.json()["results"][0]["ok"], (place, role)
            deleted = await client.delete(f"{API}/drive/items/{folder_id}")
            if role in can_manage[place]:
                assert deleted.status_code == 204, (place, role, deleted.text)
            else:
                assert deleted.status_code == 403, (place, role, deleted.text)
                assert deleted.json()["error"]["code"] == "drive_manage_restricted"

    # The locations each sees.
    as_user(guest)
    kinds = [
        loc["kind"] for loc in (await client.get(f"{API}/drive/locations")).json()["locations"]
    ]
    assert kinds == ["channel"]
    me = await client.post(f"{API}/drive/locations/resolve", json={"kind": "me"})
    assert me.status_code == 403 and me.json()["error"]["code"] == "guest_restricted"
    as_user(admin)
    listed = (await client.get(f"{API}/drive/locations")).json()["locations"]
    assert [loc["kind"] for loc in listed] == ["workspace"]  # not the channel, not mia's
    assert listed[0]["can_manage"] is True and listed[0]["name"] == "研究室ドライブ"
    not_member = await client.post(
        f"{API}/drive/locations/resolve", json={"kind": "channel", "channel_id": lab["id"]}
    )
    assert not_member.status_code == 404

    # An owners-only channel: members read, owners (and admins among the members) write.
    as_user(owner)
    await client.patch(f"{API}/channels/{lab['id']}", json={"posting_policy": "owners"})
    as_user(member)
    refused = await client.post(
        f"{API}/drive/folders", json={"parent_id": roots["channel"], "name": "x"}
    )
    assert refused.status_code == 403 and refused.json()["error"]["code"] == "drive_read_only"
    assert (await children(client, roots["channel"])).status_code == 200
    as_user(owner)
    assert (
        await client.post(f"{API}/drive/folders", json={"parent_id": roots["channel"], "name": "y"})
    ).status_code == 201
    await client.patch(f"{API}/channels/{lab['id']}", json={"posting_policy": "everyone"})

    # An archived channel: everyone reads, nobody writes or deletes for good.
    as_user(guest)
    kept = await client.post(
        f"{API}/drive/folders", json={"parent_id": roots["channel"], "name": "kept"}
    )
    kept_id = kept.json()["id"]
    await client.post(f"{API}/drive/items/trash", json={"item_ids": [kept_id]})
    as_user(owner)
    assert (await client.post(f"{API}/channels/{lab['id']}/archive")).status_code == 200
    for role in ("member", "guest", "owner"):
        as_user(actors[role])
        assert (await children(client, roots["channel"])).status_code == 200, role
        made = await client.post(
            f"{API}/drive/folders", json={"parent_id": roots["channel"], "name": f"late-{role}"}
        )
        assert made.status_code == 403 and made.json()["error"]["code"] == "drive_read_only"
        gone = await client.delete(f"{API}/drive/items/{kept_id}")
        assert gone.status_code == 403 and gone.json()["error"]["code"] == "drive_read_only"
        restored = await client.post(f"{API}/drive/items/{kept_id}/restore", json={})
        assert restored.status_code == 403
    channel_out = next(
        loc
        for loc in (await client.get(f"{API}/drive/locations")).json()["locations"]
        if loc["kind"] == "channel"
    )
    assert channel_out["can_write"] is False and channel_out["can_manage"] is False

    # A DM has no drive.
    as_user(member)
    dm = (await client.post(f"{API}/dms", json={"user_ids": [str(owner.id)]})).json()
    refused = await client.post(
        f"{API}/drive/locations/resolve", json={"kind": "channel", "channel_id": dm["id"]}
    )
    assert refused.status_code == 422 and refused.json()["error"]["code"] == "drive_not_available"


async def test_a_former_member_and_a_new_guest_lose_access_at_once(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    owner = await make_user(db, "olivia")
    member = await make_user(db, "mia")
    admin = await make_user(db, "ada", role="admin")
    as_user(owner)
    lab = (await client.post(f"{API}/channels", json={"name": "lab", "type": "private"})).json()
    await client.post(f"{API}/channels/{lab['id']}/members", json={"user_id": str(member.id)})
    root = (await location(client, "channel", channel_id=lab["id"]))["root_id"]
    shared = await upload(client, root, "notes.txt", b"hello drive")
    as_user(member)
    assert (await client.get(f"{API}/drive/items/{shared['id']}")).status_code == 200
    as_user(owner)
    await client.delete(f"{API}/channels/{lab['id']}/members/{member.id}")
    as_user(member)
    for path in (
        f"/drive/items/{shared['id']}",
        f"/drive/items/{shared['id']}/content",
        f"/attachments/{shared['file']['attachment_id']}",
        f"/attachments/{shared['file']['attachment_id']}/content",
    ):
        response = await client.get(f"{API}{path}")
        assert response.status_code == 404, (path, response.text)
    # A person made a guest no longer sees 研究室ドライブ (nor their My Drive).
    as_user(member)
    workspace = await workspace_root(client)
    mine = (await location(client, "me"))["root_id"]
    as_user(admin)
    changed = await client.patch(f"{API}/admin/users/{member.id}", json={"role": "guest"})
    assert changed.status_code == 200, changed.text
    await db.refresh(member)
    as_user(member)
    assert (await children(client, workspace)).status_code == 404
    assert (await children(client, mine)).status_code == 404


# --- folders and names ---------------------------------------------------------------------------


async def test_folders_names_and_listing(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice")
    as_user(alice)
    root = await workspace_root(client)

    op = str(uuid.uuid4())
    first = await client.post(
        f"{API}/drive/folders", json={"parent_id": root, "name": "Papers", "client_op_id": op}
    )
    assert first.status_code == 201
    again = await client.post(
        f"{API}/drive/folders", json={"parent_id": root, "name": "Papers", "client_op_id": op}
    )
    assert again.status_code == 200 and again.json()["id"] == first.json()["id"]
    clash = await client.post(f"{API}/drive/folders", json={"parent_id": root, "name": "papers"})
    assert clash.status_code == 409
    error = clash.json()["error"]
    assert error["code"] == "drive_name_taken"
    assert error["details"] == {"existing_id": first.json()["id"], "existing_kind": "folder"}
    # NFD from a Mac is the same name.
    nfd = await client.post(
        f"{API}/drive/folders",
        json={"parent_id": root, "name": unicodedata.normalize("NFD", "ゼミ")},
    )
    assert nfd.status_code == 201 and nfd.json()["name"] == "ゼミ"
    assert (
        await client.post(f"{API}/drive/folders", json={"parent_id": root, "name": "ゼミ"})
    ).status_code == 409

    # mkdir -p: made once, then found.
    made = await client.post(f"{API}/drive/folders", json={"parent_id": root, "path": "a/b/c"})
    assert made.status_code == 201
    found = await client.post(f"{API}/drive/folders", json={"parent_id": root, "path": "/a/b/c/"})
    assert found.status_code == 200 and found.json()["id"] == made.json()["id"]
    detail = (await client.get(f"{API}/drive/items/{made.json()['id']}")).json()
    assert [c["name"] for c in detail["path"]] == ["研究室ドライブ", "a", "b"]
    deep = "/".join(f"d{i}" for i in range(33))
    too_deep = await client.post(f"{API}/drive/folders", json={"parent_id": root, "path": deep})
    assert (
        too_deep.status_code == 422 and too_deep.json()["error"]["code"] == "drive_depth_exceeded"
    )
    ok_deep = "/".join(f"d{i}" for i in range(32))
    assert (
        await client.post(f"{API}/drive/folders", json={"parent_id": root, "path": ok_deep})
    ).status_code == 201
    bad = await client.post(f"{API}/drive/folders", json={"parent_id": root, "name": "x/y"})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "drive_name_invalid"

    # A file in the way of a path.
    await upload(client, root, "file", b"x")
    blocked = await client.post(f"{API}/drive/folders", json={"parent_id": root, "path": "file/z"})
    assert blocked.status_code == 409

    # Listing: folders first, the Japanese name order, pages by cursor.
    box = await folder(client, root, "box")
    for name, size in (("b.txt", 30), ("A.txt", 10), ("c.txt", 20)):
        await upload(client, box, name, b"x" * size)
    for name in ("Zeta", "alpha"):
        await folder(client, box, name)
    assert await names_in(client, box) == ["alpha", "Zeta", "A.txt", "b.txt", "c.txt"]
    seen: list[str] = []
    cursor = None
    while True:
        params: dict[str, object] = {"limit": 2}
        if cursor:
            params["cursor"] = cursor
        page = (await children(client, box, **params)).json()
        seen += [item["name"] for item in page["items"]]
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert seen == ["alpha", "Zeta", "A.txt", "b.txt", "c.txt"]
    by_size = (await children(client, box, sort="size", order="desc", limit=3)).json()
    # Folders first (no size: by id, newest first when descending), then the files by size.
    assert [i["name"] for i in by_size["items"]] == ["alpha", "Zeta", "b.txt"]
    rest = (
        await children(client, box, sort="size", order="desc", cursor=by_size["next_cursor"])
    ).json()
    assert [i["name"] for i in rest["items"]] == ["c.txt", "A.txt"]
    assert (await children(client, box, cursor="garbage")).status_code == 400

    # Rename: case-insensitive clash, the preview's name follows.
    items = {i["name"]: i for i in (await children(client, box)).json()["items"]}
    taken = await client.patch(f"{API}/drive/items/{items['b.txt']['id']}", json={"name": "a.TXT"})
    assert taken.status_code == 409
    renamed = await client.patch(
        f"{API}/drive/items/{items['b.txt']['id']}", json={"name": "報告.txt"}
    )
    assert renamed.status_code == 200 and renamed.json()["name"] == "報告.txt"
    attachment = await db.get(Attachment, uuid.UUID(items["b.txt"]["file"]["attachment_id"]))
    assert attachment is not None
    await db.refresh(attachment)
    assert attachment.filename == "報告.txt"
    assert (await client.patch(f"{API}/drive/items/{root}", json={"name": "root"})).json()["error"][
        "code"
    ] == "drive_root_immutable"


async def test_moves_cycles_and_across_locations(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice")
    as_user(alice)
    root = await workspace_root(client)
    a = await folder(client, root, "a")
    b = await folder(client, a, "b")
    c = await folder(client, b, "c")
    into_child = await client.post(
        f"{API}/drive/items/move", json={"item_ids": [a], "target_folder_id": c}
    )
    assert into_child.json()["results"] == [{"id": a, "ok": False, "error": "drive_cycle"}]
    into_self = await client.post(
        f"{API}/drive/items/move", json={"item_ids": [b], "target_folder_id": b}
    )
    assert into_self.json()["results"][0]["error"] == "drive_cycle"

    # Several at once, each on its own; a clash fails alone, or is renamed.
    other = await folder(client, root, "other")
    await folder(client, other, "b")
    f1 = await upload(client, a, "f1.txt", b"one")
    moved = await client.post(
        f"{API}/drive/items/move",
        json={"item_ids": [b, f1["id"], str(uuid.uuid4())], "target_folder_id": other},
    )
    results = moved.json()["results"]
    assert [r["ok"] for r in results] == [False, True, False]
    assert results[0]["error"] == "drive_name_taken"
    assert results[2]["error"] == "drive_item_not_found"
    renamed = await client.post(
        f"{API}/drive/items/move",
        json={"item_ids": [b], "target_folder_id": other, "on_conflict": "rename"},
    )
    assert renamed.json()["results"][0]["ok"]
    assert sorted(await names_in(client, other)) == ["b", "b (1)", "f1.txt"]

    # To My Drive: the subtree's rows and bytes go with it.
    payload = b"x" * 3000
    big = await upload(client, c, "big.bin", payload)
    mine = await location(client, "me")
    before = {
        loc["kind"]: loc for loc in (await client.get(f"{API}/drive/locations")).json()["locations"]
    }
    across = await client.post(
        f"{API}/drive/items/move", json={"item_ids": [b], "target_folder_id": mine["root_id"]}
    )
    assert across.json()["results"][0]["ok"], across.text
    after = {
        loc["kind"]: loc for loc in (await client.get(f"{API}/drive/locations")).json()["locations"]
    }
    assert after["user"]["used_bytes"] == len(payload)
    assert after["workspace"]["used_bytes"] == before["workspace"]["used_bytes"] - len(payload)
    assert after["user"]["item_count"] == 3  # b, c, big.bin
    moved_file = await db.get(DriveItem, uuid.UUID(big["id"]))
    assert moved_file is not None
    await db.refresh(moved_file)
    assert str(moved_file.location_id) == mine["id"]
    # The target's quota is checked.
    await db.execute(text("UPDATE drive_locations SET quota_bytes = 10 WHERE kind = 'workspace'"))
    await db.commit()
    back = await client.post(
        f"{API}/drive/items/move", json={"item_ids": [b], "target_folder_id": root}
    )
    assert back.json()["results"][0]["error"] == "drive_quota_exceeded"


async def test_restoring_an_item_inside_a_group_restores_the_whole_group(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """§10.1: a group is never split; restoring a member brings its group back (the answer is
    the member), with the root's on_conflict; a purge still wants the root."""
    drive_settings(app)
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    root = await workspace_root(client)
    a = await folder(client, root, "A")
    b = await folder(client, a, "B")
    f = await upload(client, b, "f.txt", b"f" * 10)
    g = await upload(client, a, "g.txt", b"g" * 20)
    await client.post(f"{API}/drive/items/trash", json={"item_ids": [g["id"]]})  # its own group
    await client.post(f"{API}/drive/items/trash", json={"item_ids": [a]})
    await folder(client, root, "A")  # a clash for the root

    # The root's name is taken: on_conflict = fail refuses, nothing moves.
    refused = await client.post(
        f"{API}/drive/items/{f['id']}/restore", json={"on_conflict": "fail"}
    )
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "drive_name_taken"
    # Bob (another member of 研究室ドライブ) restores the file: A comes back renamed, f in B.
    as_user(bob)
    restored = await client.post(f"{API}/drive/items/{f['id']}/restore", json={})
    assert restored.status_code == 200, restored.text
    body = restored.json()
    assert body["id"] == f["id"] and body["trashed_at"] is None and body["parent_id"] == b
    assert await names_in(client, root) == ["A", "A (1)"]
    assert await names_in(client, a) == ["B"]  # g stays in the trash (its own group)
    assert await names_in(client, b) == ["f.txt"]
    trash = (await client.get(f"{API}/drive/locations/{f['location_id']}/trash")).json()
    assert [e["item"]["name"] for e in trash["entries"]] == ["g.txt"]
    log = (
        await db.execute(select(AuditLog).where(AuditLog.action == "drive.restore"))
    ).scalar_one()
    assert log.actor_id == bob.id and str(log.target_id) == a
    assert log.details["asked_item_id"] == f["id"] and log.details["items"] == 3
    # Not in the trash any more: 409 as before.
    again = await client.post(f"{API}/drive/items/{f['id']}/restore", json={})
    assert again.status_code == 409 and again.json()["error"]["code"] == "drive_not_in_trash"

    # A purge of a member is still refused (only a group's root goes for good).
    admin = await make_user(db, "ada", role="admin")
    as_user(admin)
    await client.post(f"{API}/drive/items/trash", json={"item_ids": [a]})
    part = await client.delete(f"{API}/drive/items/{f['id']}")
    assert part.status_code == 409 and part.json()["error"]["code"] == "drive_not_in_trash"


async def test_trash_groups_restore_and_purge(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice")
    admin = await make_user(db, "ada", role="admin")
    as_user(alice)
    root = await workspace_root(client)
    a = await folder(client, root, "A")
    f = await upload(client, a, "f.txt", b"f" * 10)
    b = await folder(client, a, "B")
    g = await upload(client, b, "g.txt", b"g" * 20)

    # g first (its own group), then A (A, f, B; not g).
    await client.post(f"{API}/drive/items/trash", json={"item_ids": [g["id"]]})
    await client.post(f"{API}/drive/items/trash", json={"item_ids": [a]})
    assert await names_in(client, root) == []
    location_id = f["location_id"]
    trash = (await client.get(f"{API}/drive/locations/{location_id}/trash")).json()["entries"]
    assert [(e["item"]["name"], e["item_count"], e["size_bytes"]) for e in trash] == [
        ("A", 3, 10),
        ("g.txt", 1, 20),
    ]
    assert (await children(client, b)).status_code == 404
    assert (await client.get(f"{API}/drive/items/{f['id']}/content")).status_code == 404
    # g's folder is in the trash: g goes to the root.
    await client.post(f"{API}/drive/items/{g['id']}/restore", json={})
    assert await names_in(client, root) == ["g.txt"]
    # A comes back where it was, without g; a clash is renamed.
    await folder(client, root, "A")
    restored = await client.post(f"{API}/drive/items/{a}/restore", json={})
    assert restored.status_code == 200 and restored.json()["name"] == "A (1)"
    assert await names_in(client, b) == []
    assert await names_in(client, a) == ["B", "f.txt"]
    fail = await client.post(f"{API}/drive/items/trash", json={"item_ids": [a]})
    assert fail.json()["results"][0]["ok"]
    await folder(client, root, "A (1)")
    refused = await client.post(f"{API}/drive/items/{a}/restore", json={"on_conflict": "fail"})
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "drive_name_taken"

    # For good, by hand (an admin in 研究室ドライブ) and after 30 days.
    not_in_trash = await client.delete(f"{API}/drive/items/{g['id']}")
    assert not_in_trash.status_code == 403  # alice cannot manage 研究室ドライブ
    as_user(admin)
    assert (await client.delete(f"{API}/drive/items/{g['id']}")).json()["error"][
        "code"
    ] == "drive_not_in_trash"
    await client.post(f"{API}/drive/items/trash", json={"item_ids": [g["id"]]})
    assert (await client.delete(f"{API}/drive/items/{g['id']}")).status_code == 204
    g_attachment = await db.get(Attachment, uuid.UUID(g["file"]["attachment_id"]))
    assert g_attachment is not None
    await db.refresh(g_attachment)
    assert g_attachment.status == "deleted"

    used = (
        await db.execute(select(DriveLocation.used_bytes).where(DriveLocation.kind == "workspace"))
    ).scalar_one()
    assert used == 10
    await db.execute(
        text("UPDATE drive_items SET trashed_at = now() - interval '31 days' WHERE id = :id"),
        {"id": a},
    )
    await db.commit()
    done = await housekeeping.run(app.state.drive, app.state.settings, app.state.blobs)
    assert done.purged_trash == 1
    db.expire_all()
    assert await db.get(DriveItem, uuid.UUID(a)) is None
    assert await db.get(DriveItem, uuid.UUID(f["id"])) is None
    workspace = (
        await db.execute(select(DriveLocation).where(DriveLocation.kind == "workspace"))
    ).scalar_one()
    assert workspace.used_bytes == 0
    assert workspace.item_count == 2  # the two folders 「A」 and 「A (1)」 made above
    audits: list[str] = list(
        (
            await db.execute(
                text("SELECT action FROM audit_logs WHERE action LIKE 'drive.%' ORDER BY id")
            )
        )
        .scalars()
        .all()
    )
    assert list(audits) == ["drive.delete", "drive.purge"]


async def test_drive_events_and_their_audience(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    guest = await make_user(db, "gus", role="guest")
    as_user(alice)
    root = await workspace_root(client)
    made = await folder(client, root, "docs")
    rows = (
        (
            await db.execute(
                select(OutboxEvent).where(OutboxEvent.event_type == drive_events.DRIVE_CHANGED)
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1
    event = rows[0]
    assert event.audience_type == "drive" and event.payload["folder_ids"] == [root]
    assert "name" not in str(event.payload) and "docs" not in str(event.payload)
    audience = await drive_events.resolve_drive_audience(db, event)
    assert audience is not None
    assert set(audience.ids) == {alice.id, bob.id}  # not the guest
    assert guest.id not in audience.ids
    mine = await location(client, "me")
    await folder(client, mine["root_id"], "private")
    last = (
        await db.execute(
            select(OutboxEvent)
            .where(OutboxEvent.event_type == drive_events.DRIVE_CHANGED)
            .order_by(OutboxEvent.id.desc())
            .limit(1)
        )
    ).scalar_one()
    audience = await drive_events.resolve_drive_audience(db, last)
    assert audience is not None and audience.ids == (alice.id,)
    assert last.payload["seq"] > event.payload["seq"]
    assert made


async def test_takeover_and_anonymisation(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    admin = await make_user(db, "ada", role="admin")
    grad = await make_user(db, "grad")
    leaver = await make_user(db, "leaver")
    as_user(grad)
    mine = await location(client, "me")
    thesis = await folder(client, mine["root_id"], "thesis")
    await upload(client, thesis, "draft.pdf", b"%PDF-1.4 draft" * 10)
    await upload(client, mine["root_id"], "notes.txt", b"n" * 7)

    as_user(admin)
    early = await client.post(f"{API}/admin/drive/users/{grad.id}/takeover", json={})
    assert early.status_code == 409
    assert early.json()["error"]["code"] == "drive_takeover_active_user"
    grad.deactivated_at = utcnow()
    await db.commit()
    taken = await client.post(f"{API}/admin/drive/users/{grad.id}/takeover", json={})
    assert taken.status_code == 200, taken.text
    holder = taken.json()["folder"]
    assert holder["name"] == "Grad"
    detail = (await client.get(f"{API}/drive/items/{holder['id']}")).json()
    assert [c["name"] for c in detail["path"]] == ["研究室ドライブ", "引き取り"]
    assert sorted(await names_in(client, holder["id"])) == ["notes.txt", "thesis"]
    locations = {loc.kind: loc for loc in (await db.execute(select(DriveLocation))).scalars().all()}
    for row in locations.values():
        await db.refresh(row)
    assert locations["user"].used_bytes == 0 and locations["user"].item_count == 0
    assert locations["workspace"].used_bytes == 140 + 7
    assert (
        await db.execute(text("SELECT count(*) FROM audit_logs WHERE action = 'drive.takeover'"))
    ).scalar_one() == 1

    # Anonymisation: the My Drive goes for good (no trash), shared files stay.
    as_user(leaver)
    own = await location(client, "me")
    await upload(client, own["root_id"], "secret.txt", b"s" * 5)
    shared = await upload(client, await workspace_root(client), "shared.txt", b"k" * 3)
    as_user(admin)
    assert (await client.post(f"{API}/admin/users/{leaver.id}/anonymize")).status_code in (200, 204)
    done = await housekeeping.run(app.state.drive, app.state.settings, app.state.blobs)
    assert done.purged_locations == 1
    db.expire_all()
    assert await db.get(DriveLocation, uuid.UUID(own["id"])) is None
    assert await db.get(DriveItem, uuid.UUID(shared["id"])) is not None


async def test_workspace_location_is_made_again_when_missing(
    app: FastAPI, db: AsyncSession
) -> None:
    await db.execute(text("DELETE FROM drive_items"))
    await db.execute(text("DELETE FROM drive_locations"))
    await db.commit()
    first = await drive.workspace_location(db)
    second = await drive.workspace_location(db)
    assert first.id == second.id
    root = await db.get(DriveItem, first.root_id)
    assert root is not None and root.parent_id is None and root.kind == "folder"
    assert timedelta(0) <= utcnow() - first.created_at < timedelta(minutes=5)
