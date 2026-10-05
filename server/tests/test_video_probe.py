"""M79: a video's upright size, length and poster, read at upload and by the backfill."""

import asyncio
import io
import json
import os
import shutil
import subprocess
import sys
import time
import tracemalloc
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.attachments import videos
from app.modules.attachments.models import Attachment
from app.modules.attachments.video_backfill import probe_stored_videos
from app.modules.messages.models import Message
from app.modules.users.models import User
from tests.helpers import make_user

VIDEOS = Path(__file__).parent / "fixtures" / "video"
HAS_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None
needs_ffmpeg = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg / ffprobe not installed")


def jpeg(width: int, height: int) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (width, height), (10, 20, 30)).save(out, format="JPEG")
    return out.getvalue()


def fake_probe(
    monkeypatch: pytest.MonkeyPatch, info: videos.VideoInfo | Exception | None
) -> list[str]:
    """Probing as if ffmpeg were installed, answering `info` (or raising it)."""
    calls: list[str] = []

    async def probe(path: str, settings: Settings) -> videos.VideoInfo | None:
        with open(path, "rb") as file:  # noqa: ASYNC230 - a test's temp file
            calls.append(file.read(4).hex())
        if isinstance(info, Exception):
            raise info
        return info

    monkeypatch.setattr(videos, "tools", lambda settings: ("ffprobe", "ffmpeg"))
    monkeypatch.setattr(videos, "probe_video", probe)
    return calls


def no_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(videos, "tools", lambda settings: None)


async def fresh(app: FastAPI, model: Any, key: uuid.UUID) -> Any:
    """The row as committed, from a session of its own (the test's keeps its user attached)."""
    async with app.state.db.session_factory() as session:
        return await session.get(model, key)


async def backfill(app: FastAPI, settings: Settings, **kwargs: Any) -> Any:
    async with app.state.db.session_factory() as session:
        return await probe_stored_videos(session, app.state.blobs, settings, **kwargs)


async def upload_video(client: AsyncClient, data: bytes | None = None) -> dict[str, Any]:
    content = data if data is not None else (VIDEOS / "sample.mp4").read_bytes()
    response = await client.post(
        "/api/v1/attachments", files={"file": ("clip.mp4", content, "video/mp4")}
    )
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


# --- ffprobe's answer ---


def probe_json(stream: dict[str, Any], duration: str | None = "3.500000") -> bytes:
    data: dict[str, Any] = {"streams": [stream], "format": {}}
    if duration is not None:
        data["format"]["duration"] = duration
    return json.dumps(data).encode()


def test_parse_probe_applies_rotation_aspect_and_duration() -> None:
    plain = probe_json({"width": 1920, "height": 1080, "sample_aspect_ratio": "1:1"})
    assert videos.parse_probe(plain) == (1920, 1080, 3500)
    # A phone's portrait clip: landscape pixels and a display matrix of -90 (or 90, 270).
    for rotation in (90, -90, 270):
        rotated = probe_json(
            {"width": 1920, "height": 1080, "side_data_list": [{"rotation": rotation}]}
        )
        assert videos.parse_probe(rotated) == (1080, 1920, 3500)
    assert videos.parse_probe(
        probe_json({"width": 1920, "height": 1080, "side_data_list": [{"rotation": 180}]})
    ) == (1920, 1080, 3500)
    # Older muxers say it with a "rotate" tag.
    tagged = probe_json({"width": 640, "height": 480, "tags": {"rotate": "90"}})
    assert videos.parse_probe(tagged) == (480, 640, 3500)
    # Anamorphic DV: 720x480 stored, 4:3 shown.
    anamorphic = probe_json({"width": 720, "height": 480, "sample_aspect_ratio": "8:9"})
    assert videos.parse_probe(anamorphic) == (640, 480, 3500)
    # The stream's duration when the container has none; none at all is fine.
    stream_only = probe_json({"width": 10, "height": 20, "duration": "0.25"}, duration=None)
    assert videos.parse_probe(stream_only) == (10, 20, 250)
    assert videos.parse_probe(probe_json({"width": 10, "height": 20}, duration=None)) == (
        10,
        20,
        None,
    )


@pytest.mark.parametrize(
    "raw",
    [
        b"",
        b"not json",
        b"[]",
        b'{"streams": []}',
        b'{"streams": ["x"], "format": "y"}',
        probe_json({"width": 0, "height": 100}, duration="nan"),
        probe_json({"width": 100_000, "height": 100}, duration="-1"),
        probe_json({"width": "wide", "height": None}, duration="soon"),
    ],
)
def test_parse_probe_treats_nonsense_as_unknown(raw: bytes) -> None:
    assert videos.parse_probe(raw) == (None, None, None)


# --- at upload ---


async def test_upload_records_shape_length_and_poster(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    as_user(await make_user(db, "filmer"))
    calls = fake_probe(
        monkeypatch, videos.VideoInfo(width=1080, height=1920, duration_ms=4200, poster=jpeg(9, 16))
    )
    meta = await upload_video(client)
    assert len(calls) == 1  # the probe read the uploaded bytes from a named file
    assert calls[0] == (VIDEOS / "sample.mp4").read_bytes()[:4].hex()
    assert (meta["width"], meta["height"], meta["duration_ms"]) == (1080, 1920, 4200)
    # A video's poster is has_poster, never has_thumbnail (older Android shows those as photos).
    assert meta["has_poster"] is True and meta["has_thumbnail"] is False
    poster = await client.get(f"/api/v1/attachments/{meta['id']}/thumbnail")
    assert poster.status_code == 200 and poster.headers["content-type"] == "image/jpeg"
    assert Image.open(io.BytesIO(poster.content)).size == (9, 16)
    row = await fresh(app, Attachment, uuid.UUID(meta["id"]))
    assert row is not None and row.video_probed_at is not None
    # The bytes themselves are stored untouched.
    content = await client.get(f"/api/v1/attachments/{meta['id']}/content")
    assert content.content == (VIDEOS / "sample.mp4").read_bytes()


async def test_upload_without_ffmpeg_or_with_a_failing_probe_still_succeeds(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    as_user(await make_user(db, "filmer"))
    no_tools(monkeypatch)
    missing = await upload_video(client)
    assert missing["width"] is None and missing["duration_ms"] is None
    assert missing["has_poster"] is False
    row = await fresh(app, Attachment, uuid.UUID(missing["id"]))
    assert row is not None and row.video_probed_at is None  # left for the backfill

    fake_probe(monkeypatch, RuntimeError("ffmpeg crashed"))
    crashed = await upload_video(client)
    assert crashed["width"] is None and crashed["has_poster"] is False

    # Found nothing (an unreadable clip): looked at, so the backfill does not try again.
    fake_probe(monkeypatch, videos.VideoInfo(None, None, None, None))
    unreadable = await upload_video(client)
    assert unreadable["has_poster"] is False
    row = await fresh(app, Attachment, uuid.UUID(unreadable["id"]))
    assert row is not None and row.video_probed_at is not None
    assert (await client.get(f"/api/v1/attachments/{unreadable['id']}/thumbnail")).status_code == (
        404
    )

    # Images are not probed as videos.
    calls = fake_probe(monkeypatch, videos.VideoInfo(1, 1, 1, None))
    image = await client.post(
        "/api/v1/attachments", files={"file": ("p.jpg", jpeg(4, 3), "image/jpeg")}
    )
    assert image.json()["has_thumbnail"] is True and image.json()["has_poster"] is False
    assert image.json()["duration_ms"] is None and calls == []


# --- real ffmpeg ---


def make_clip(path: Path, *, size: str, seconds: float, rotation: int | None = None) -> bytes:
    base = path.with_suffix(".plain.mp4")
    subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"testsrc=size={size}:rate=10",
            "-t",
            str(seconds),
            "-pix_fmt",
            "yuv420p",
            str(base),
        ],
        check=True,
        timeout=60,
    )
    if rotation is None:
        return base.read_bytes()
    subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-display_rotation",
            str(rotation),
            "-i",
            str(base),
            "-c",
            "copy",
            str(path),
        ],
        check=True,
        timeout=60,
    )
    return path.read_bytes()


@needs_ffmpeg
async def test_real_ffmpeg_reads_a_portrait_phone_clip(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    tmp_path: Path,
) -> None:
    as_user(await make_user(db, "filmer"))
    clip = make_clip(tmp_path / "portrait.mp4", size="320x180", seconds=3, rotation=90)
    meta = await upload_video(client, clip)
    assert (meta["width"], meta["height"]) == (180, 320)
    assert meta["duration_ms"] == 3000
    assert meta["has_poster"] is True
    poster = await client.get(f"/api/v1/attachments/{meta['id']}/thumbnail")
    image = Image.open(io.BytesIO(poster.content))
    assert image.format == "JPEG" and image.size == (180, 320)  # upright, as the sender saw it

    # A clip shorter than 2 s takes its first frame; the committed fixtures are 1 s.
    short = await upload_video(client)
    assert (short["width"], short["height"], short["duration_ms"]) == (160, 120, 1000)
    assert short["has_poster"] is True


@needs_ffmpeg
async def test_real_ffmpeg_scales_the_poster_and_refuses_playlists(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    tmp_path: Path,
    test_settings: Settings,
) -> None:
    clip = make_clip(tmp_path / "wide.mp4", size="1280x720", seconds=2.5)
    path = tmp_path / "wide.plain.mp4"
    info = await videos.probe_video(str(path), test_settings)
    assert info is not None and (info.width, info.height) == (1280, 720)
    assert info.poster is not None
    assert Image.open(io.BytesIO(info.poster)).size == (512, 288)  # attachment_thumbnail_px
    assert len(clip) > 0

    # An HLS playlist that points at a local file: not a whitelisted format, nothing is read.
    playlist = tmp_path / "evil.mp4"
    playlist.write_text("#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n")
    refused = await videos.probe_video(str(playlist), test_settings)
    assert refused == videos.VideoInfo(None, None, None, None)

    # The upload of a file that only looks like a video still succeeds, without a shape.
    as_user(await make_user(db, "filmer"))
    broken = (VIDEOS / "sample.mp4").read_bytes()[:64]
    meta = await upload_video(client, broken)
    assert meta["content_type"] == "video/mp4" and meta["width"] is None
    assert meta["has_poster"] is False


@needs_ffmpeg
async def test_real_ffmpeg_timeout_kills_the_process(
    tmp_path: Path, test_settings: Settings
) -> None:
    path = tmp_path / "clip.mp4"
    path.write_bytes((VIDEOS / "sample.mp4").read_bytes())
    settings = test_settings.model_copy(update={"video_probe_timeout_seconds": 0.0001})
    info = await videos.probe_video(str(path), settings)
    assert info == videos.VideoInfo(None, None, None, None)


# --- backfill ---


async def post_with(client: AsyncClient, channel_id: str, attachment_id: str) -> dict[str, Any]:
    posted = await client.post(
        f"/api/v1/channels/{channel_id}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": "", "attachment_ids": [attachment_id]},
    )
    assert posted.status_code == 201, posted.text
    body: dict[str, Any] = posted.json()
    return body


async def test_backfill_fills_old_videos_and_moves_the_messages(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
    test_settings: Settings,
) -> None:
    as_user(await make_user(db, "filmer"))
    channel = (await client.post("/api/v1/channels", json={"name": "clips"})).json()
    no_tools(monkeypatch)  # uploaded "before M79"
    old = await upload_video(client)
    message = await post_with(client, channel["id"], old["id"])
    pending = await upload_video(client)
    gone = await upload_video(client)
    gone_message = await post_with(client, channel["id"], gone["id"])
    assert (await client.delete(f"/api/v1/messages/{gone_message['id']}")).status_code == 200

    # Without ffmpeg the command refuses instead of marking everything as looked at.
    with pytest.raises(RuntimeError):
        await backfill(app, test_settings)

    calls = fake_probe(
        monkeypatch, videos.VideoInfo(width=720, height=1280, duration_ms=9000, poster=jpeg(9, 16))
    )
    first = await backfill(app, test_settings, limit=1)
    assert (first.probed, first.found, first.announced, first.remaining) == (1, 1, 1, True)
    rest = await backfill(app, test_settings)
    assert (rest.probed, rest.found, rest.announced, rest.remaining) == (1, 1, 0, False)
    assert len(calls) == 2  # the deleted one is skipped
    again = await backfill(app, test_settings)
    assert again.probed == 0 and len(calls) == 2  # idempotent

    # The message took a new updated_seq and message.updated (change "attachments") ...
    row = await fresh(app, Message, uuid.UUID(message["id"]))
    assert row is not None and row.updated_seq > message["updated_seq"]
    async with app.state.db.session_factory() as session:
        query = select(OutboxEvent).where(
            OutboxEvent.event_type == "message.updated",
            OutboxEvent.channel_id == uuid.UUID(channel["id"]),
        )
        events = (await session.execute(query)).scalars().all()
    changes = [e.payload for e in events if e.payload.get("change") == "attachments"]
    assert len(changes) == 1
    shown = changes[0]["message"]["attachments"][0]
    assert (shown["width"], shown["height"], shown["duration_ms"]) == (720, 1280, 9000)
    assert shown["has_poster"] is True
    # ... so a device holding the message gets it through the delta.
    delta = await client.get(
        f"/api/v1/channels/{channel['id']}/sync", params={"since_seq": message["updated_seq"]}
    )
    assert delta.status_code == 200, delta.text
    held = [m for m in delta.json()["messages"] if m["id"] == message["id"]]
    assert held and held[0]["attachments"][0]["has_poster"] is True
    # The pending one is read fresh by its uploader.
    reread = (await client.get(f"/api/v1/attachments/{pending['id']}")).json()
    assert reread["has_poster"] is True and reread["width"] == 720


async def test_backfill_marks_missing_bytes_as_looked_at(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
    test_settings: Settings,
) -> None:
    as_user(await make_user(db, "filmer"))
    no_tools(monkeypatch)
    meta = await upload_video(client)
    await app.state.blobs.delete(f"attachments/{meta['id']}")
    calls = fake_probe(monkeypatch, videos.VideoInfo(1, 1, 1, None))
    result = await backfill(app, test_settings)
    assert (result.probed, result.found) == (1, 0)
    assert calls == []  # never got as far as ffmpeg
    row = await fresh(app, Attachment, uuid.UUID(meta["id"]))
    assert row is not None and row.video_probed_at is not None and row.width is None
    assert row.video_probed_at <= utcnow()


# --- Review v0.1.22 #5: what is read from the child stays bounded ---


def _child(tmp_path: Path, body: str) -> tuple[Path, Path]:
    """An executable Python script standing in for ffprobe / ffmpeg; it writes its pid first."""
    pid_file = tmp_path / "child.pid"
    script = tmp_path / "fake-tool"
    script.write_text(
        f"#!{sys.executable}\n"
        "import os, sys, time\n"
        f"open({str(pid_file)!r}, 'w').write(str(os.getpid()))\n"
        "chunk = b'x' * 65536\n" + body
    )
    script.chmod(0o755)
    return script, pid_file


def _gone(pid_file: Path) -> bool:
    try:
        pid = pid_file.read_text()
    except FileNotFoundError:
        # The child never got as far as writing its pid (a busy machine): nothing is left running.
        return True
    if not pid:
        return True
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return True
    return False


async def _measure(coro: Any) -> tuple[Any, int, float]:
    tracemalloc.start()
    started = time.monotonic()
    try:
        result = await coro
        return result, tracemalloc.get_traced_memory()[1], time.monotonic() - started
    finally:
        tracemalloc.stop()


async def test_a_flood_on_stderr_keeps_only_its_tail(tmp_path: Path) -> None:
    script, pid_file = _child(
        tmp_path,
        "for _ in range(256):\n    sys.stderr.buffer.write(chunk)\n"  # 16 MiB
        "sys.stderr.buffer.flush()\nsys.stdout.buffer.write(b'ok')\n",
    )
    out, peak, _ = await _measure(videos.run_bounded([str(script)], 60, 1024))
    assert out == b"ok"
    assert peak < 2 * 1024 * 1024, peak  # was ~32 MiB: communicate() held both streams
    assert _gone(pid_file)


async def test_a_flood_on_both_streams_is_stopped_at_the_stdout_cap(tmp_path: Path) -> None:
    script, pid_file = _child(
        tmp_path,
        "while True:\n    sys.stderr.buffer.write(chunk)\n    sys.stdout.buffer.write(chunk)\n",
    )
    out, peak, elapsed = await _measure(videos.run_bounded([str(script)], 60, 1024 * 1024))
    assert out is None
    assert elapsed < 20  # killed at the cap, long before the timeout
    assert peak < 4 * 1024 * 1024, peak
    assert _gone(pid_file)


async def test_timeout_and_cancel_kill_the_child_and_release_the_slot(
    tmp_path: Path, test_settings: Settings
) -> None:
    script, pid_file = _child(
        tmp_path, "while True:\n    sys.stderr.buffer.write(chunk[:1024])\n    time.sleep(0.01)\n"
    )
    settings = test_settings.model_copy(
        update={
            "ffprobe_path": str(script),
            "ffmpeg_path": str(script),
            "video_probe_timeout_seconds": 0.5,
            "video_probe_max_concurrent": 1,
        }
    )
    slot = videos._semaphore(1)
    info = await videos.probe_video(str(tmp_path / "clip.mp4"), settings)
    assert info == videos.VideoInfo(None, None, None, None)
    assert _gone(pid_file) and not slot.locked()

    # Under load the child may not even have started (and written its pid) within the 0.5 s timeout.
    pid_file.unlink(missing_ok=True)
    slow = settings.model_copy(update={"video_probe_timeout_seconds": 60})
    task = asyncio.create_task(videos.probe_video(str(tmp_path / "clip.mp4"), slow))
    for _ in range(3000):  # up to 30 s for a busy machine to start the child
        if pid_file.exists() and pid_file.read_text():
            break
        await asyncio.sleep(0.01)
    assert slot.locked()  # the probe holds the only slot
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert _gone(pid_file) and not slot.locked()
