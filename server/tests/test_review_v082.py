"""REVIEW-v0.1.82: what a posted file tells someone who cannot read its message (#5, #6), album
creation sent again (#3, #7) and the GIFs of a share link that hands out no originals (#4). The
downgrades of 0126 and 0127 (#1, #2) are in test_review_v082_migrations.py."""

import asyncio
import io
import uuid
import zipfile
from collections.abc import AsyncIterator, Callable
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from PIL import Image, ImageSequence
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.attachments import gifclean
from app.modules.drive import albums
from app.modules.drive.models import DriveAlbum, DriveItem
from app.modules.users.models import User
from tests.drive_helpers import act_as, drive_settings, folder, location, upload, workspace_root
from tests.helpers import make_user
from tests.test_albums import make_album, run_media, upload_photo, visitor
from tests.test_channel_files import make_channel, post

API = "/api/v1"


@pytest.fixture
def as_user(app: FastAPI) -> Callable[[User], None]:
    return act_as(app)


async def _ok(response: Any, status: int = 200) -> Any:
    assert response.status_code == status, response.text
    return response.json()


# --- #5, #6: a posted file moved out of a private channel ----------------------------------------


async def test_unreadable_posts_are_neither_named_nor_counted(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice", role="admin")  # manages 研究室ドライブ too
    carol = await make_user(db, "carol")
    boss = await make_user(db, "boss", role="admin")
    dave = await make_user(db, "dave")
    as_user(alice)
    secret = await make_channel(client, "secret", [carol], kind="private")
    lab = await make_channel(client, "lab", [])
    hidden = await post(client, secret["id"], [("plan.txt", b"version one")])
    shown = await post(client, lab["id"], [("open.txt", b"open")])
    hidden_id = hidden["attachments"][0]["drive"]["item_id"]
    hidden_version = hidden["attachments"][0]["drive"]["version_id"]
    open_id = shown["attachments"][0]["drive"]["item_id"]
    root = await workspace_root(client)
    moved = await _ok(
        await client.post(
            f"{API}/drive/items/move",
            json={"item_ids": [hidden_id, open_id], "target_folder_id": root},
        )
    )
    assert all(r["ok"] for r in moved["results"]), moved
    await upload(client, root, "plan.txt", b"version two", on_conflict="version")
    # carol was a member and left: she reads 研究室ドライブ but not the conversation any more.
    as_user(carol)
    assert (await client.post(f"{API}/channels/{secret['id']}/leave")).status_code == 204

    async def seen(user: User) -> dict[str, Any]:
        as_user(user)
        detail = await _ok(await client.get(f"{API}/drive/items/{hidden_id}"))
        listed = await _ok(await client.get(f"{API}/drive/folders/{root}/children"))
        marks = {i["id"]: i["posted"] for i in listed["items"]}
        trash = await _ok(
            await client.post(f"{API}/drive/items/impact", json={"item_ids": [hidden_id]})
        )
        both = await _ok(
            await client.post(f"{API}/drive/items/impact", json={"item_ids": [hidden_id, open_id]})
        )
        return {
            "posted": detail["item"]["posted"],
            "posts": len(detail["item"]["posts"] or []),
            "listed": marks[hidden_id],
            "open_listed": marks[open_id],
            "trash": trash,
            "both": both["posted_messages"],
        }

    nothing = {"posted_messages": 0, "channels": []}
    for outsider in (boss, carol):
        assert await seen(outsider) == {
            "posted": False,
            "posts": 0,
            "listed": False,
            "open_listed": True,  # a public channel's message: anyone but a guest reads it
            "trash": nothing,
            "both": 1,
        }, outsider.username
    reader = await seen(alice)
    assert (reader["posted"], reader["posts"], reader["listed"], reader["both"]) == (
        True,
        1,
        True,
        2,
    )
    assert reader["trash"]["posted_messages"] == 1
    assert [c["channel_id"] for c in reader["trash"]["channels"]] == [secret["id"]]
    assert (await seen(dave))["listed"] is False

    # #5: the posted version cannot be deleted, and the refusal names nothing to the manager
    # outside the conversation; its reader gets the message and the channel.
    as_user(boss)
    refused = await client.delete(f"{API}/drive/items/{hidden_id}/versions/{hidden_version}")
    assert refused.status_code == 409
    error = refused.json()["error"]
    assert error["code"] == "drive_version_posted"
    assert not error.get("details")
    assert hidden["id"] not in refused.text and secret["id"] not in refused.text
    as_user(alice)
    named = await client.delete(f"{API}/drive/items/{hidden_id}/versions/{hidden_version}")
    assert named.status_code == 409
    assert named.json()["error"]["details"] == {
        "message_id": hidden["id"],
        "channel_id": secret["id"],
    }


# --- #3: an album creation sent again ------------------------------------------------------------


async def test_album_create_again_checks_whoever_reads_it_now(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    aiko = await make_user(db, "aiko")
    bob = await make_user(db, "bob")
    as_user(aiko)
    workspace = next(
        loc
        for loc in (await client.get(f"{API}/drive/locations")).json()["locations"]
        if loc["kind"] == "workspace"
    )

    async def again(body: dict[str, Any]) -> Any:
        as_user(aiko)
        return await make_album(client, **body)

    # Moved to bob's My Drive, renamed, described: 404 and nothing of it.
    meeting = {"location_id": workspace["id"], "name": "meeting", "client_op_id": _uuid()}
    made = await _ok(await make_album(client, **meeting), 201)
    folder_id = made["folder"]["id"]
    as_user(bob)
    mine = await location(client, "me")
    moved = await _ok(
        await client.post(
            f"{API}/drive/items/move",
            json={"item_ids": [folder_id], "target_folder_id": mine["root_id"]},
        )
    )
    assert moved["results"][0]["ok"], moved
    await _ok(await client.patch(f"{API}/drive/items/{folder_id}", json={"name": "SECRET ALBUM"}))
    await _ok(
        await client.put(
            f"{API}/drive/folders/{folder_id}/album",
            json={"description": "SECRET MEETING DETAILS"},
        )
    )
    as_user(aiko)
    assert (await client.get(f"{API}/drive/items/{folder_id}")).status_code == 404
    hidden = await again(meeting)
    assert hidden.status_code == 404, hidden.text
    assert hidden.json()["error"]["code"] == "drive_item_not_found"
    assert "SECRET" not in hidden.text and folder_id not in hidden.text

    # Still readable (renamed by someone else in 研究室ドライブ): the same album, as it is now.
    kept = {"location_id": workspace["id"], "name": "合宿", "client_op_id": _uuid()}
    first = await _ok(await make_album(client, **kept), 201)
    as_user(bob)
    await _ok(
        await client.patch(f"{API}/drive/items/{first['folder']['id']}", json={"name": "夏合宿"})
    )
    replay = await again(kept)
    assert replay.status_code == 200, replay.text
    assert replay.json()["folder"]["id"] == first["folder"]["id"]
    assert replay.json()["folder"]["name"] == "夏合宿"
    # The same key with another name answers the album it made (the same request, §17).
    other = await again({**kept, "name": "別の名前"})
    assert other.status_code == 200 and other.json()["folder"]["id"] == first["folder"]["id"]

    # In the trash: 404.
    trashed = {"location_id": workspace["id"], "name": "ゴミ箱行き", "client_op_id": _uuid()}
    gone = await _ok(await make_album(client, **trashed), 201)
    await _ok(
        await client.post(f"{API}/drive/items/trash", json={"item_ids": [gone["folder"]["id"]]})
    )
    assert (await again(trashed)).status_code == 404

    # A channel's drive the creator has left: 404.
    lab = await make_channel(client, "lab", [bob])
    drive = await location(client, "channel", channel_id=lab["id"])
    in_channel = {"location_id": drive["id"], "name": "研究会", "client_op_id": _uuid()}
    await _ok(await make_album(client, **in_channel), 201)
    assert (await client.post(f"{API}/channels/{lab['id']}/leave")).status_code == 204
    assert (await again(in_channel)).status_code == 404

    # A plain folder sent again (POST /drive/folders): the same rule.
    as_user(aiko)
    op = _uuid()
    plain = await _ok(
        await client.post(
            f"{API}/drive/folders",
            json={"parent_id": workspace["root_id"], "name": "資料", "client_op_id": op},
        ),
        201,
    )
    as_user(bob)
    await client.post(
        f"{API}/drive/items/move",
        json={"item_ids": [plain["id"]], "target_folder_id": mine["root_id"]},
    )
    as_user(aiko)
    replayed = await client.post(
        f"{API}/drive/folders",
        json={"parent_id": workspace["root_id"], "name": "資料", "client_op_id": op},
    )
    assert replayed.status_code == 404, replayed.text


# --- #7: the same album creation twice at once ----------------------------------------------------


@pytest.mark.parametrize("same_parent", [True, False])
async def test_album_create_twice_at_once_makes_one(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
    same_parent: bool,
) -> None:
    drive_settings(app)
    aiko = await make_user(db, "aiko")
    as_user(aiko)
    root = await workspace_root(client)
    first_parent = await folder(client, root, "一")
    second_parent = first_parent if same_parent else await folder(client, root, "二")
    op = _uuid()
    # Both requests look for the key before either makes the album (REVIEW-v0.1.82 #7).
    barrier = asyncio.Barrier(2)
    calls = 0
    original = albums._replay

    async def slow_replay(*args: Any) -> Any:
        nonlocal calls
        calls += 1
        found = await original(*args)
        if calls <= 2:
            assert found is None
            await barrier.wait()
        return found

    monkeypatch.setattr(albums, "_replay", slow_replay)
    answers = await asyncio.gather(
        make_album(client, parent_id=first_parent, name="展示会", client_op_id=op),
        make_album(client, parent_id=second_parent, name="展示会", client_op_id=op),
    )
    assert sorted(a.status_code for a in answers) == [200, 201], [a.text for a in answers]
    ids = {a.json()["folder"]["id"] for a in answers}
    assert len(ids) == 1
    made = await db.scalar(
        select(func.count()).select_from(DriveItem).where(DriveItem.client_op_id == uuid.UUID(op))
    )
    assert made == 1
    assert await db.get(DriveAlbum, uuid.UUID(ids.pop()))


# --- #4: GIFs on a link without originals ---------------------------------------------------------

SECRET = b"GPSLatitude=35.123;GPSLongitude=139.123;PRIVATE_NOTE"
XMP = b'<x:xmpmeta xmlns:x="adobe:ns:meta/">GPS 35.6,139.7 where-we-were</x:xmpmeta>'


def _sub_blocks(data: bytes) -> bytes:
    out = b""
    for start in range(0, len(data), 255):
        part = data[start : start + 255]
        out += bytes([len(part)]) + part
    return out + b"\x00"


def gif(frames: int = 3, *, extras: bool = True, trailing: bytes = b"") -> bytes:
    """A GIF with a comment holding SECRET; with `extras`, an XMP packet (Adobe's raw form with
    its magic trailer), a plain-text extension and an unknown application extension too."""
    images = [Image.new("RGB", (12, 10), (i * 70, 20, 200 - i * 50)) for i in range(frames)]
    out = io.BytesIO()
    if frames > 1:
        images[0].save(
            out,
            format="GIF",
            save_all=True,
            append_images=images[1:],
            duration=[40, 80, 120][:frames],
            loop=0,
            comment=SECRET,
        )
    else:
        images[0].save(out, format="GIF", comment=SECRET)
    data = out.getvalue()
    if not extras:
        return data + trailing
    xmp = b"!\xff\x0bXMP DataXMP" + XMP + b"\x01" + bytes(range(255, -1, -1)) + b"\x00"
    text = b"!\x01\x0c" + bytes(12) + _sub_blocks(b"PRIVATE plain text")
    other = b"!\xff\x0bACME0000001" + _sub_blocks(SECRET)
    flags = data[10]
    head = 13 + (3 << ((flags & 7) + 1) if flags & 0x80 else 0)
    return data[:head] + xmp + text + other + data[head:] + trailing


async def _scrubbed(data: bytes, step: int | None = None) -> bytes:
    async def chunks() -> AsyncIterator[bytes]:
        size = step or len(data) or 1
        for start in range(0, len(data), size):
            yield data[start : start + size]

    return b"".join([c async for c in gifclean.scrub(chunks())])


def _frames(data: bytes) -> list[tuple[bytes, int | None]]:
    with Image.open(io.BytesIO(data)) as image:
        return [
            (frame.convert("RGB").tobytes(), frame.info.get("duration"))
            for frame in ImageSequence.Iterator(image)
        ]


def _clean(data: bytes) -> None:
    for secret in (SECRET, b"PRIVATE", b"where-we-were", b"35.6", b"XMP DataXMP", b"ACME"):
        assert secret not in data, secret
    with Image.open(io.BytesIO(data)) as image:
        assert "xmp" not in image.info
        # What is left of a comment (the same length, so a ZIP planned from the size holds) is
        # zero bytes (Pillow joins several comments with a newline).
        assert set(image.info.get("comment", b"")) <= {0, 10}


@pytest.mark.parametrize("step", [None, 1, 7, 300])
async def test_gif_scrub_keeps_the_frames_and_drops_the_metadata(step: int | None) -> None:
    for original in (gif(), gif(1), gif(extras=False), gif(trailing=b"AFTER-" + SECRET)):
        cleaned = await _scrubbed(original, step)
        assert len(cleaned) == len(original)
        _clean(cleaned)
        assert _frames(cleaned) == _frames(original)
        with Image.open(io.BytesIO(cleaned)) as image:
            if getattr(image, "n_frames", 1) > 1:
                assert image.info.get("loop") == 0  # NETSCAPE2.0 kept


async def test_gif_scrub_zeroes_what_it_cannot_read() -> None:
    original = gif()
    # Not a GIF: nothing of it.
    assert await _scrubbed(b"PNG!" + SECRET) == bytes(4 + len(SECRET))
    # Cut in the middle of the XMP packet: the header, then zeros.
    cut = original[: original.index(b"where-we-were") + 3]
    cleaned = await _scrubbed(cut, 5)
    assert len(cleaned) == len(cut) and cleaned.startswith(b"GIF89a")
    assert b"where" not in cleaned and b"XMP" not in cleaned
    # An unknown block: zeros from there on.
    head = original.index(b"!\xff\x0bXMP")
    broken = original[:head] + b"\x99" + SECRET + original[head:]
    cleaned = await _scrubbed(broken)
    assert len(cleaned) == len(broken) and cleaned[head:] == bytes(len(broken) - head)


async def test_link_without_originals_hands_out_gifs_without_metadata(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    as_user(await make_user(db, "aiko"))
    root = await workspace_root(client)
    album = await _ok(await make_album(client, parent_id=root, name="合宿"), 201)
    folder_id = album["folder"]["id"]
    animated, still = gif(), gif(1)
    moving = await upload_photo(client, folder_id, "anim.gif", animated)
    plain = await upload_photo(client, folder_id, "still.gif", still)
    await run_media(app)
    link = await _ok(await client.post(f"{API}/drive/items/{folder_id}/links", json={}), 201)
    assert link["link"]["originals"] is False
    token = link["path"].removeprefix("/s/")
    async with visitor(app) as v:
        shown = await v.get(f"{API}/shares/{token}/items/{moving['id']}/display")
        assert shown.status_code == 200 and shown.headers["content-type"] == "image/gif"
        assert len(shown.content) == len(animated)
        _clean(shown.content)
        assert _frames(shown.content) == _frames(animated)
        # A still GIF has a display-size WebP (made by the media loop): no metadata either.
        still_shown = await v.get(f"{API}/shares/{token}/items/{plain['id']}/display")
        assert still_shown.headers["content-type"] == "image/webp"
        assert SECRET not in still_shown.content
        light = await v.get(f"{API}/shares/{token}/zip", params={"size": "display"})
        assert light.status_code == 200, light.text
        assert int(light.headers["content-length"]) == len(light.content)
        with zipfile.ZipFile(io.BytesIO(light.content)) as archive:
            entries = {n: archive.read(n) for n in archive.namelist()}
        assert set(entries) == {"合宿/", "合宿/anim.gif", "合宿/still.webp"}
        _clean(entries["合宿/anim.gif"])
        assert _frames(entries["合宿/anim.gif"]) == _frames(animated)
        assert SECRET not in light.content
    # A link that hands out originals shows the GIF as it is (the person allowed it).
    opened = await _ok(
        await client.patch(f"{API}/drive/links/{link['link']['id']}", json={"originals": True})
    )
    assert opened["originals"] is True
    async with visitor(app) as v:
        whole = await v.get(f"{API}/shares/{token}/items/{moving['id']}/display")
        assert whole.content == animated


def _uuid() -> str:
    return str(uuid.uuid4())
