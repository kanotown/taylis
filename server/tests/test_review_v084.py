"""REVIEW-v0.1.84: the GIF extensions kept on a link without originals (#1), what a posted file
tells someone who cannot read its message (#4), a copy sent again (#5) and 「ドライブに保存」 sent
twice at once (#6). #2 and #3 are client-side (docs/PUSH_NOTIFICATIONS.md, the iOS tests)."""

import asyncio
import io
import uuid
import zipfile
from collections.abc import Callable
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.drive import conversation, copying, names, versions
from app.modules.drive.models import DriveItem, DriveLocation
from app.modules.users.models import User
from tests.drive_helpers import act_as, drive_settings, folder, location, upload, workspace_root
from tests.helpers import make_user
from tests.test_albums import make_album, run_media, upload_photo, visitor
from tests.test_channel_files import make_channel, post
from tests.test_review_v082 import SECRET, _frames, _scrubbed, _sub_blocks, gif

API = "/api/v1"


@pytest.fixture
def as_user(app: FastAPI) -> Callable[[User], None]:
    return act_as(app)


async def _ok(response: Any, status: int = 200) -> Any:
    assert response.status_code == status, response.text
    return response.json()


def _uuid() -> str:
    return str(uuid.uuid4())


# --- #1: what is inside the kept GIF extensions ---------------------------------------------------

LOOP = b"!\xff\x0bNETSCAPE2.0\x03\x01\x00\x00\x00"


def _animated() -> bytes:
    original = gif(extras=False)
    assert LOOP in original
    return original


def _loop_with(extra: bytes, identifier: bytes = b"NETSCAPE2.0") -> bytes:
    """The GIF with its loop extension (renamed to `identifier`) followed by `extra` sub-blocks
    before the terminator."""
    original = _animated()
    loop = b"!\xff\x0b" + identifier + b"\x03\x01\x00\x00"
    return original.replace(LOOP, loop + extra + b"\x00", 1)


def _loop_count(data: bytes) -> int | None:
    with Image.open(io.BytesIO(data)) as image:
        loop: int | None = image.info.get("loop")
        return loop


@pytest.mark.parametrize("step", [None, 1, 7, 65536])
async def test_gif_loop_extension_keeps_the_loop_count_alone(step: int | None) -> None:
    # A plain loop extension is kept as it is (and plays forever).
    plain = _animated()
    cleaned = await _scrubbed(plain, step)
    assert len(cleaned) == len(plain) and LOOP in cleaned
    assert _loop_count(cleaned) == 0
    # The review's case: data after the loop count, in the same NETSCAPE2.0 / ANIMEXTS1.0
    # extension. The whole extension becomes a blank comment (no loop: it plays once).
    for identifier in (b"NETSCAPE2.0", b"ANIMEXTS1.0"):
        for extra in (_sub_blocks(SECRET)[:-1], _sub_blocks(SECRET * 9)[:-1], b"\x01Z"):
            original = _loop_with(extra, identifier)
            cleaned = await _scrubbed(original, step)
            assert len(cleaned) == len(original)
            assert SECRET not in cleaned and b"\x01Z" not in cleaned
            assert identifier not in cleaned
            assert _frames(cleaned) == _frames(original)


async def test_gif_odd_loop_and_graphic_control_extensions_are_blanked() -> None:
    original = _animated()
    secret = b"HIDDEN!!"
    cases = [
        # A loop extension whose one sub-block is not 3 bytes long, or not a loop count.
        original.replace(LOOP, b"!\xff\x0bNETSCAPE2.0" + _sub_blocks(secret), 1),
        original.replace(LOOP, b"!\xff\x0bNETSCAPE2.0\x03\x02HI\x00", 1),
        # No sub-block at all.
        original.replace(LOOP, b"!\xff\x0bNETSCAPE2.0\x00", 1),
    ]
    control = original.index(b"!\xf9\x04")
    block = original[control : control + 8]
    # A graphic control extension of the wrong length, and one with a sub-block after its own.
    cases.append(original.replace(block, b"!\xf9" + _sub_blocks(secret), 1))
    cases.append(original.replace(block, block[:-1] + _sub_blocks(secret), 1))
    for case in cases:
        for step in (None, 1, 5):
            cleaned = await _scrubbed(case, step)
            assert len(cleaned) == len(case)
            assert secret not in cleaned and b"\x02HI" not in cleaned
            with Image.open(io.BytesIO(cleaned)) as image:
                assert getattr(image, "n_frames", 1) == 3


async def test_gif_graphic_control_keeps_its_fields_without_spare_bits() -> None:
    original = _animated()
    control = original.index(b"!\xf9\x04")
    packed, delay, index = original[control + 3], original[control + 4 : control + 6], 0x5A
    # Reserved bits set and a transparent index while transparency is off: both can hold data.
    changed = (
        original[: control + 3]
        + bytes([packed | 0xE0])
        + delay
        + bytes([index])
        + original[control + 7 :]
    )
    cleaned = await _scrubbed(changed)
    assert len(cleaned) == len(changed)
    assert cleaned[control + 3] == packed & 0x1F
    assert cleaned[control + 4 : control + 6] == delay
    assert cleaned[control + 6] == (index if packed & 1 else 0)
    assert _frames(cleaned) == _frames(original)


async def test_gif_scrub_survives_every_cut_of_the_new_paths() -> None:
    for original in (_loop_with(_sub_blocks(SECRET)[:-1]), _loop_with(b"", b"ANIMEXTS1.0")):
        for end in range(0, len(original), 3):
            cut = original[:end]
            cleaned = await _scrubbed(cut, 4)
            assert len(cleaned) == len(cut)
            assert SECRET not in cleaned


async def test_link_without_originals_drops_data_inside_the_loop_extension(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    as_user(await make_user(db, "aiko"))
    root = await workspace_root(client)
    album = await _ok(await make_album(client, parent_id=root, name="album"), 201)
    folder_id = album["folder"]["id"]
    original = _loop_with(_sub_blocks(SECRET)[:-1])
    photo = await upload_photo(client, folder_id, "animated.gif", original)
    await run_media(app)
    link = await _ok(await client.post(f"{API}/drive/items/{folder_id}/links", json={}), 201)
    assert link["link"]["originals"] is False
    token = link["path"].removeprefix("/s/")
    async with visitor(app) as v:
        content = await v.get(f"{API}/shares/{token}/items/{photo['id']}/content")
        shown = await v.get(f"{API}/shares/{token}/items/{photo['id']}/display")
        zipped = await v.get(f"{API}/shares/{token}/zip", params={"size": "display"})
    assert content.status_code == 403
    assert shown.status_code == 200 and zipped.status_code == 200
    assert SECRET not in shown.content and len(shown.content) == len(original)
    assert _frames(shown.content) == _frames(original)
    assert int(zipped.headers["content-length"]) == len(zipped.content)
    with zipfile.ZipFile(io.BytesIO(zipped.content)) as archive:
        entry = archive.read("album/animated.gif")
    assert SECRET not in entry and SECRET not in zipped.content
    assert _frames(entry) == _frames(original) and len(entry) == len(original)


# --- #4: a posted file in a conversation the caller cannot read ----------------------------------


async def test_unreadable_posts_leave_no_trace_in_metadata_versions_errors_or_search(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice", role="admin")
    carol = await make_user(db, "carol")
    boss = await make_user(db, "boss", role="admin")
    as_user(alice)
    secret = await make_channel(client, "secret", [carol], kind="private")
    message = await post(client, secret["id"], [("plan-zebra.txt", b"version one")])
    attachment = message["attachments"][0]
    item_id = attachment["drive"]["item_id"]
    posted_version = attachment["drive"]["version_id"]
    root = await workspace_root(client)
    moved = await _ok(
        await client.post(
            f"{API}/drive/items/move", json={"item_ids": [item_id], "target_folder_id": root}
        )
    )
    assert moved["results"][0]["ok"], moved
    await upload(client, root, "plan-zebra.txt", b"version two", on_conflict="version")
    await upload(client, root, "other-zebra.txt", b"an upload")
    # carol was a member and left: she reads 研究室ドライブ but not the conversation any more.
    as_user(carol)
    assert (await client.post(f"{API}/channels/{secret['id']}/leave")).status_code == 204

    async def seen(user: User) -> dict[str, Any]:
        as_user(user)
        meta = await _ok(await client.get(f"{API}/attachments/{attachment['id']}"))
        versions = await _ok(await client.get(f"{API}/drive/items/{item_id}/versions"))
        found: dict[str, list[str]] = {}
        for origin in ("posts", "uploads"):
            hits = await _ok(
                await client.get(f"{API}/search/drive", params={"q": "zebra", "origin": origin})
            )
            found[origin] = sorted(h["item"]["name"] for h in hits["items"])
        return {
            "drive": meta["drive"],
            "sources": [v["source"] for v in versions["versions"]],
            "found": found,
        }

    hidden = {
        "drive": None,
        "sources": ["upload", "upload"],
        "found": {"posts": [], "uploads": ["other-zebra.txt", "plan-zebra.txt"]},
    }
    for outsider in (boss, carol):
        assert await seen(outsider) == hidden, outsider.username
    reader = await seen(alice)
    assert reader["drive"]["state"] == "moved" and reader["drive"]["item_id"] == item_id
    assert reader["sources"] == ["upload", "message"]
    assert reader["found"] == {"posts": ["plan-zebra.txt"], "uploads": ["other-zebra.txt"]}

    # The posted version cannot be deleted: a general refusal for whoever cannot read the post.
    for outsider in (boss,):
        as_user(outsider)
        refused = await client.delete(f"{API}/drive/items/{item_id}/versions/{posted_version}")
        assert refused.status_code == 409
        error = refused.json()["error"]
        assert error["code"] == "drive_version_protected"
        assert not error.get("details")
        assert "message" not in error["message"].lower()
        assert message["id"] not in refused.text and secret["id"] not in refused.text
    as_user(alice)
    named = await client.delete(f"{API}/drive/items/{item_id}/versions/{posted_version}")
    assert named.status_code == 409
    assert named.json()["error"]["code"] == "drive_version_posted"
    assert named.json()["error"]["details"] == {
        "message_id": message["id"],
        "channel_id": secret["id"],
    }


# --- #5: a copy sent again -----------------------------------------------------------------------


async def test_copy_again_checks_whoever_reads_the_copy_now(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    root = await workspace_root(client)
    source = await folder(client, root, "source")
    target = await folder(client, root, "target")

    async def copy(body: dict[str, Any]) -> dict[str, Any]:
        as_user(alice)
        answer = await _ok(await client.post(f"{API}/drive/items/copy", json=body))
        result: dict[str, Any] = answer["results"][0]
        return result

    # Moved to bob's My Drive and renamed there: not the same request's success any more.
    body = {"item_ids": [source], "target_folder_id": target, "client_op_id": _uuid()}
    first = await copy(body)
    copied = first["new_id"]
    as_user(bob)
    mine = await location(client, "me")
    moved = await _ok(
        await client.post(
            f"{API}/drive/items/move",
            json={"item_ids": [copied], "target_folder_id": mine["root_id"]},
        )
    )
    assert moved["results"][0]["ok"]
    await _ok(await client.patch(f"{API}/drive/items/{copied}", json={"name": "SECRET"}))
    as_user(alice)
    assert (await client.get(f"{API}/drive/items/{copied}")).status_code == 404
    again = await copy(body)
    assert again == {"id": source, "ok": False, "error": "drive_item_not_found", "new_id": None}

    # Still readable (renamed in place): the same copy.
    kept = {"item_ids": [source], "target_folder_id": target, "client_op_id": _uuid()}
    made = await copy(kept)
    as_user(bob)
    await _ok(await client.patch(f"{API}/drive/items/{made['new_id']}", json={"name": "改名"}))
    assert (await copy(kept))["new_id"] == made["new_id"]

    # In the trash: not found.
    trashed = {"item_ids": [source], "target_folder_id": target, "client_op_id": _uuid()}
    gone = await copy(trashed)
    await _ok(await client.post(f"{API}/drive/items/trash", json={"item_ids": [gone["new_id"]]}))
    assert (await copy(trashed))["error"] == "drive_item_not_found"

    # In a channel's drive the copier has left: not found.
    lab = await make_channel(client, "lab", [bob])
    drive = await location(client, "channel", channel_id=lab["id"])
    in_channel = {
        "item_ids": [source],
        "target_folder_id": drive["root_id"],
        "client_op_id": _uuid(),
    }
    assert (await copy(in_channel))["ok"]
    assert (await client.post(f"{API}/channels/{lab['id']}/leave")).status_code == 204
    left = await copy({**in_channel, "target_folder_id": target})
    assert left["error"] == "drive_item_not_found"


async def test_album_add_copy_again_checks_whoever_reads_the_copy_now(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    root = await workspace_root(client)
    album = await _ok(await make_album(client, parent_id=root, name="合宿"), 201)
    mine = await location(client, "me")
    photo = await upload(client, mine["root_id"], "photo.txt", b"photo")
    body = {"item_ids": [photo["id"]], "client_op_id": _uuid()}
    add = f"{API}/drive/albums/{album['folder']['id']}/add"
    first = (await _ok(await client.post(add, json=body)))["results"][0]
    assert first["ok"] and first["action"] == "copied"
    as_user(bob)
    bobs = await location(client, "me")
    await _ok(
        await client.post(
            f"{API}/drive/items/move",
            json={"item_ids": [first["item_id"]], "target_folder_id": bobs["root_id"]},
        )
    )
    as_user(alice)
    again = (await _ok(await client.post(add, json=body)))["results"][0]
    assert again["ok"] is False and again["error"] == "drive_item_not_found"
    assert again["item_id"] is None


async def test_copy_twice_at_once_is_one_success(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    drive_settings(app)
    as_user(await make_user(db, "aiko"))
    root = await workspace_root(client)
    source = await upload(client, root, "a.txt", b"abc")
    target = await folder(client, root, "target")
    body = {
        "item_ids": [source["id"]],
        "target_folder_id": target,
        "client_op_id": _uuid(),
        "on_conflict": "fail",
    }
    # Both requests have copied the bytes before either places its copy.
    barrier = asyncio.Barrier(2)
    original = versions.clone_object

    async def coordinated(*args: Any, **kwargs: Any) -> Any:
        result = await original(*args, **kwargs)
        await barrier.wait()
        return result

    monkeypatch.setattr(copying, "clone_object", coordinated)
    before = len(app.state.blobs.objects)
    answers = await asyncio.gather(
        *[client.post(f"{API}/drive/items/copy", json=body) for _ in range(2)]
    )
    results = [(await _ok(a))["results"][0] for a in answers]
    assert all(r["ok"] for r in results), results
    assert len({r["new_id"] for r in results}) == 1
    assert len(app.state.blobs.objects) == before + 1  # the second request's copy removed


# --- #6: 「ドライブに保存」 twice at once ---------------------------------------------------------


@pytest.mark.parametrize("case", ["fail", "rename", "quota", "folder_full"])
async def test_save_attachment_twice_at_once_is_one_success(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
    case: str,
) -> None:
    drive_settings(app)
    as_user(await make_user(db, "aiko"))
    channel = await make_channel(client, "lab", [])
    message = await post(client, channel["id"], [("a.txt", b"a")])
    root = await workspace_root(client)
    target = await folder(client, root, "保存先")
    if case == "quota":
        # Room for exactly one more byte.
        await db.execute(
            text("UPDATE drive_locations SET quota_bytes = used_bytes + 1 WHERE root_id = :id"),
            {"id": uuid.UUID(root)},
        )
        await db.commit()
    if case == "folder_full":
        monkeypatch.setattr(names, "MAX_CHILDREN", 1)
    body = {
        "attachment_id": message["attachments"][0]["id"],
        "folder_id": target,
        "client_op_id": _uuid(),
        "on_conflict": "fail" if case == "fail" else "rename",
    }
    barrier = asyncio.Barrier(2)
    original = versions.clone_object

    async def coordinated(*args: Any, **kwargs: Any) -> Any:
        result = await original(*args, **kwargs)
        await barrier.wait()
        return result

    monkeypatch.setattr(conversation, "clone_object", coordinated)
    location_row = await db.scalar(
        select(DriveLocation).where(DriveLocation.root_id == uuid.UUID(root))
    )
    assert location_row is not None
    used_before = location_row.used_bytes
    objects_before = len(app.state.blobs.objects)
    answers = await asyncio.gather(
        *[client.post(f"{API}/drive/save-attachment", json=body) for _ in range(2)]
    )
    assert sorted(a.status_code for a in answers) == [200, 201], [a.text for a in answers]
    assert len({a.json()["id"] for a in answers}) == 1
    made = await db.scalar(
        select(func.count()).select_from(DriveItem).where(DriveItem.parent_id == uuid.UUID(target))
    )
    assert made == 1
    await db.refresh(location_row)
    assert location_row.used_bytes == used_before + 1
    assert len(app.state.blobs.objects) == objects_before + 1  # one copy of the byte, no orphan

    # And sent once more, later: the same file (200).
    monkeypatch.setattr(conversation, "clone_object", original)
    again = await client.post(f"{API}/drive/save-attachment", json=body)
    assert again.status_code == 200 and again.json()["id"] == answers[0].json()["id"]
