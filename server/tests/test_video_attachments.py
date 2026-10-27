"""Video uploads use the existing attachment API and its configured byte limit."""

import hashlib
import uuid
from collections.abc import Callable
from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.modules.auth.deps import get_current_user
from app.modules.users.models import User
from tests.conftest import LiveServer
from tests.helpers import make_user

VIDEOS = Path(__file__).parent / "fixtures" / "video"


@pytest.mark.parametrize(
    ("extension", "mime"),
    [("mp4", "video/mp4"), ("mov", "video/quicktime"), ("webm", "video/webm")],
)
async def test_video_upload_sniffs_real_container_and_roundtrips(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    extension: str,
    mime: str,
) -> None:
    as_user(await make_user(db, "video-uploader"))
    content = (VIDEOS / f"sample.{extension}").read_bytes()
    response = await client.post(
        "/api/v1/attachments", files={"file": (f"sample.{extension}", content, mime)}
    )
    assert response.status_code == 201, response.text
    meta = response.json()
    assert meta["content_type"] == mime
    assert meta["has_thumbnail"] is False
    downloaded = await client.get(f"/api/v1/attachments/{meta['id']}/content")
    assert downloaded.content == content
    assert downloaded.headers["content-type"] == mime
    assert downloaded.headers["content-disposition"].startswith("attachment;")


async def test_100_mib_video_over_real_http_and_one_byte_over_limit(
    live: LiveServer, tmp_path: Path
) -> None:
    """Actual multipart HTTP, PostgreSQL and MemoryBlobStore; no reverse proxy in this test."""
    limit = 100 * 1024 * 1024
    assert Settings.model_fields["attachment_max_bytes"].default == limit
    live.app.state.settings = live.app.state.settings.model_copy(
        update={"attachment_max_bytes": limit}
    )
    async with live.app.state.db.session_factory() as db:
        actor = await make_user(db, "large-video-uploader")
    live.app.dependency_overrides[get_current_user] = lambda: actor

    # A playable MP4 with an ISO BMFF free-space box, exactly the production default limit.
    clip = (VIDEOS / "sample.mp4").read_bytes()
    path = tmp_path / "100MiB.mp4"
    with path.open("wb") as file:
        file.write(clip)
        file.write((limit - len(clip)).to_bytes(4, "big") + b"free")
        file.truncate(limit)
    with path.open("rb") as file:
        expected_hash = hashlib.file_digest(file, "sha256").digest()

    async with AsyncClient(base_url=live.base_url, timeout=60) as client:
        with path.open("rb") as file:
            response = await client.post(
                "/api/v1/attachments", files={"file": (path.name, file, "video/mp4")}
            )
        assert response.status_code == 201, response.text
        meta = response.json()
        assert meta["size_bytes"] == limit
        assert meta["content_type"] == "video/mp4"
        channel = (await client.post("/api/v1/channels", json={"name": "video-check"})).json()
        posted = await client.post(
            f"/api/v1/channels/{channel['id']}/messages",
            json={"client_msg_id": str(uuid.uuid4()), "body": "", "attachment_ids": [meta["id"]]},
        )
        assert posted.status_code == 201, posted.text
        assert posted.json()["attachments"][0]["status"] == "attached"

        received = hashlib.sha256()
        size = 0
        async with client.stream("GET", f"/api/v1/attachments/{meta['id']}/content") as download:
            assert download.status_code == 200
            async for chunk in download.aiter_bytes():
                received.update(chunk)
                size += len(chunk)
        assert size == limit
        assert received.digest() == expected_hash

        with path.open("ab") as file:
            file.write(b"x")
        with path.open("rb") as file:
            refused = await client.post(
                "/api/v1/attachments", files={"file": (path.name, file, "video/mp4")}
            )
        assert refused.status_code == 413
        assert refused.json()["error"]["code"] == "attachment_too_large"


@pytest.mark.parametrize(("extension", "mime"), [("mp4", "video/mp4"), ("mov", "video/quicktime")])
async def test_video_content_answers_ranges_and_head_for_players(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    extension: str,
    mime: str,
) -> None:
    """2026-10-27 (docs/PREVIEWS.md §12): what a <video> (Safari / WKWebView above all) asks of
    a clip: a 2-byte probe, the end of a file whose moov is at the end, and HEAD."""
    as_user(await make_user(db, "range-viewer"))
    content = (VIDEOS / f"sample.{extension}").read_bytes()
    size = len(content)
    meta = (
        await client.post(
            "/api/v1/attachments", files={"file": (f"sample.{extension}", content, mime)}
        )
    ).json()
    url = f"/api/v1/attachments/{meta['id']}/content"

    probe = await client.get(url, headers={"Range": "bytes=0-1"})
    assert probe.status_code == 206 and probe.content == content[:2]
    assert probe.headers["content-range"] == f"bytes 0-1/{size}"
    assert probe.headers["content-length"] == "2"
    assert probe.headers["content-type"] == mime
    assert probe.headers["accept-ranges"] == "bytes"
    tail = await client.get(url, headers={"Range": "bytes=-100"})
    assert tail.status_code == 206 and tail.content == content[-100:]
    assert tail.headers["content-range"] == f"bytes {size - 100}-{size - 1}/{size}"
    rest = await client.get(url, headers={"Range": f"bytes={size - 10}-"})
    assert rest.status_code == 206 and rest.content == content[-10:]
    past = await client.get(url, headers={"Range": f"bytes={size}-"})
    assert past.status_code == 416 and past.headers["content-range"] == f"bytes */{size}"
    # If-Range on another ETag: the whole file.
    stale = await client.get(url, headers={"Range": "bytes=0-1", "If-Range": '"other"'})
    assert stale.status_code == 200 and stale.content == content

    head = await client.head(url)
    assert head.status_code == 200 and head.content == b""
    assert head.headers["content-length"] == str(size)
    assert head.headers["content-type"] == mime
    assert head.headers["accept-ranges"] == "bytes"
    assert head.headers["etag"] == f'"{meta["id"]}"'
    head_part = await client.head(url, headers={"Range": "bytes=10-19"})
    assert head_part.status_code == 206 and head_part.content == b""
    assert head_part.headers["content-length"] == "10"
    assert head_part.headers["content-range"] == f"bytes 10-19/{size}"
    # Someone who cannot read it: refused for HEAD as for GET.
    as_user(await make_user(db, "stranger"))
    refused = await client.get(url)
    assert refused.status_code in (403, 404)
    assert (await client.head(url)).status_code == refused.status_code
