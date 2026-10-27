"""Sound files (docs/PREVIEWS.md §13): the clients play `audio/*` in place, from the type the
upload's bytes were sniffed as. A FLAC is served as audio/flac, the name the macOS WKWebView plays
(it refuses audio/x-flac, which `filetype` answers); the stored and listed type stays as sniffed."""

from collections.abc import Callable

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.attachments.service import served_type
from app.modules.users.models import User
from tests.drive_helpers import act_as, drive_settings, location, upload
from tests.helpers import make_user

API = "/api/v1"
PAD = bytes(4096)
# The first bytes of each kind of file, as a recorder or an encoder writes them.
SOUNDS = {
    "take.wav": (b"RIFF\x24\x00\x00\x00WAVEfmt " + PAD, "audio/x-wav"),
    "take.flac": (b"fLaC" + PAD, "audio/x-flac"),
    "memo.mp3": (b"ID3\x04\x00\x00\x00\x00\x00\x00" + PAD, "audio/mpeg"),
    "voice.ogg": (b"OggS\x00\x02" + PAD, "audio/ogg"),
    "memo.m4a": (b"\x00\x00\x00\x20ftypM4A \x00\x00\x02\x00" + PAD, "audio/mp4"),
    "raw.aac": (b"\xff\xf1\x50\x80" + PAD, "audio/aac"),
}


def test_served_type_renames_only_what_an_engine_refuses() -> None:
    assert served_type("audio/x-flac") == "audio/flac"
    assert served_type("AUDIO/X-FLAC") == "audio/flac"
    for kept in ("audio/x-wav", "audio/mpeg", "audio/ogg", "video/mp4", "application/pdf"):
        assert served_type(kept) == kept


@pytest.mark.parametrize("name", sorted(SOUNDS))
async def test_a_sound_upload_is_typed_from_its_bytes_and_served_for_a_player(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], name: str
) -> None:
    as_user(await make_user(db, "recorder"))
    data, sniffed = SOUNDS[name]
    # The browser's claim is not trusted: the bytes decide.
    response = await client.post(
        f"{API}/attachments", files={"file": (name, data, "application/octet-stream")}
    )
    assert response.status_code == 201, response.text
    meta = response.json()
    assert meta["content_type"] == sniffed
    assert meta["has_thumbnail"] is False and meta["has_poster"] is False
    assert meta["width"] is None and meta["preview"] is None
    content = await client.get(f"{API}/attachments/{meta['id']}/content")
    assert content.status_code == 200 and content.content == data
    assert content.headers["content-type"] == served_type(sniffed)
    assert content.headers["content-disposition"].startswith("attachment;")
    assert content.headers["x-content-type-options"] == "nosniff"
    part = await client.get(
        f"{API}/attachments/{meta['id']}/content", headers={"Range": "bytes=0-3"}
    )
    assert part.status_code == 206 and part.content == data[:4]


async def test_a_drive_flac_is_served_as_audio_flac_also_from_a_ticket(
    app: FastAPI, client: AsyncClient, db: AsyncSession
) -> None:
    drive_settings(app)
    act_as(app)(await make_user(db, "owner"))
    root = (await location(client, "me"))["root_id"]
    data = SOUNDS["take.flac"][0]
    item = await upload(client, root, "take.flac", data)
    assert item["content_type"] == "audio/x-flac"
    direct = await client.get(f"{API}/drive/items/{item['id']}/content")
    assert direct.status_code == 200 and direct.headers["content-type"] == "audio/flac"
    ticket = (await client.post(f"{API}/drive/items/{item['id']}/download-ticket")).json()
    app.dependency_overrides.clear()
    streamed = await client.get(ticket["url"], headers={"Range": "bytes=0-3"})
    assert streamed.status_code == 206 and streamed.content == b"fLaC"
    assert streamed.headers["content-type"] == "audio/flac"
