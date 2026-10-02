"""Slack import (M87): a synthetic export ZIP through the whole import."""

import io
import json
import zipfile
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from PIL import Image
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.events.models import OutboxEvent
from app.modules.attachments import videos
from app.modules.attachments.models import Attachment
from app.modules.channels.models import Channel, ChannelMember
from app.modules.emoji.models import CustomEmoji
from app.modules.importer.core import ImportFailed, Report
from app.modules.importer.models import ImportRef
from app.modules.importer.slack_import import FileSource, Options, import_slack
from app.modules.messages.models import Message, Reaction
from app.modules.reads.models import ReadState
from app.modules.threads.models import ThreadFollow
from app.modules.users.models import User
from tests.helpers import make_user

DAY1 = 1_714_521_600  # 2024-05-01 00:00 UTC
DAY2 = DAY1 + 86_400
TOKEN = "xoxp-test-token"
MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 64


def _png(width: int = 40, height: int = 30) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (0, 128, 255)).save(buffer, "PNG")
    return buffer.getvalue()


def ts(seconds: int, micro: int = 0) -> str:
    return f"{seconds}.{micro:06d}"


def _user(uid: str, name: str, **extra: Any) -> dict[str, Any]:
    return {
        "id": uid,
        "name": name,
        "deleted": extra.get("deleted", False),
        "is_bot": extra.get("is_bot", False),
        "real_name": extra.get("real_name", ""),
        "profile": {
            "email": extra.get("email"),
            "display_name": extra.get("display_name", ""),
            "real_name": extra.get("real_name", ""),
            "title": extra.get("title", ""),
            **({"bot_id": extra["bot_id"]} if "bot_id" in extra else {}),
        },
    }


def _file(fid: str, name: str, **extra: Any) -> dict[str, Any]:
    url = extra.get("url", f"https://files.slack.com/files-pri/T1-{fid}/download/{name}?t=xoxe-1")
    return {
        "id": fid,
        "name": name,
        "title": name,
        "mimetype": extra.get("mimetype", "application/octet-stream"),
        "size": extra.get("size", 10),
        "url_private": url,
        "url_private_download": url,
        **({"mode": extra["mode"]} if "mode" in extra else {}),
    }


def export_data(extra_general: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    users = [
        _user("U1", "taro", email="taro@example.com", real_name="山田 太郎", title="M1"),
        _user("U2", "hanako", display_name="Hanako S"),
        _user("U3", "jiro"),
        _user("U4", "ghost", deleted=True, real_name="Ghost Person", email="ghost@example.com"),
        _user("U5", "silent"),
        _user("UB", "deploybot", is_bot=True, bot_id="B1", real_name="Deploy"),
    ]
    channels = [
        {
            "id": "C1",
            "name": "general",
            "created": DAY1 - 1000,
            "creator": "U1",
            "is_archived": False,
            "members": ["U1", "U2", "U3", "U4", "U5"],
            "topic": {"value": "全体 &amp; <@U2> の連絡"},
            "purpose": {"value": "みんなの場所"},
            "pins": [{"id": ts(DAY1 + 900), "type": "C", "user": "U3", "created": DAY1 + 950}],
        },
        {
            "id": "C2",
            "name": "old",
            "created": DAY1 - 5000,
            "creator": "U1",
            "is_archived": True,
            "members": ["U1"],
        },
        {"id": "C3", "name": "random", "created": DAY1, "members": ["U1", "U2"]},
    ]
    groups = [{"id": "G1", "name": "secret", "created": DAY1, "creator": "U1", "members": ["U1"]}]
    dms = [{"id": "D1", "created": DAY1, "members": ["U1", "U2"]}]
    root = ts(DAY1 + 100)
    day1 = [
        # deliberately not in ts order: the import sorts by ts
        {
            "type": "message",
            "user": "U2",
            "text": "reply",
            "ts": ts(DAY1 + 200),
            "thread_ts": root,
            "edited": {"user": "U2", "ts": ts(DAY1 + 250)},
        },
        {
            "type": "message",
            "user": "U1",
            "text": "hello <@U2> and <!here> :smile: *bold* <https://example.com|site> "
            "&amp; <#C2|old> :partyparrot:",
            "ts": root,
            "thread_ts": root,
            "reply_count": 2,
            "reactions": [
                {"name": "+1::skin-tone-2", "users": ["U2", "U3"], "count": 2},
                {"name": "partyparrot", "users": ["U1"], "count": 1},
                {"name": "unknown_x", "users": ["U2"], "count": 1},
                {"name": "x" * 40, "users": ["U2"], "count": 1},
            ],
        },
        {
            "type": "message",
            "subtype": "thread_broadcast",
            "user": "U3",
            "text": "also to channel",
            "ts": ts(DAY1 + 300),
            "thread_ts": root,
        },
        {
            "type": "message",
            "subtype": "channel_join",
            "user": "U5",
            "text": "<@U5> joined",
            "ts": ts(DAY1 + 350),
        },
        {
            "type": "message",
            "subtype": "file_share",
            "user": "U4",
            "text": "",
            "ts": ts(DAY1 + 400),
            "files": [
                _file("F1", "graph.png", mimetype="image/png", size=len(_png())),
                _file("F2", "missing.pdf"),
                _file("F3", "old.zip", mode="hidden_by_limit"),
                _file("F4", "clip.mp4", mimetype="video/mp4", size=len(MP4)),
            ],
        },
        {
            "type": "message",
            "subtype": "bot_message",
            "bot_id": "B2",
            "username": "CI Bot",
            "text": "",
            "ts": ts(DAY1 + 500),
            "attachments": [{"fallback": "Build passed", "color": "good"}],
        },
        {
            "type": "message",
            "subtype": "bot_message",
            "bot_id": "B1",
            "text": "deployed",
            "ts": ts(DAY1 + 600),
        },
        {
            "type": "message",
            "subtype": "tombstone",
            "user": "USLACKBOT",
            "text": "This message was deleted.",
            "ts": ts(DAY1 + 700),
        },
        {
            "type": "message",
            "subtype": "me_message",
            "user": "U1",
            "text": "waves",
            "ts": ts(DAY1 + 800),
        },
        {
            "type": "message",
            "user": "U2",
            "text": "pin me",
            "ts": ts(DAY1 + 900),
            "pinned_to": ["C1"],
        },
    ]
    day2 = [
        {"type": "message", "user": "U1", "text": "code ```a *b*``` end", "ts": ts(DAY2 + 10)},
        *(extra_general or []),
    ]
    return {
        "users.json": users,
        "channels.json": channels,
        "groups.json": groups,
        "dms.json": dms,
        "general/2024-05-01.json": day1,
        "general/2024-05-02.json": day2,
        "old/2024-04-30.json": [
            {"type": "message", "user": "U1", "text": "archived talk", "ts": ts(DAY1 - 4000)}
        ],
        "secret/2024-05-01.json": [
            {"type": "message", "user": "U1", "text": "private talk", "ts": ts(DAY1 + 5)}
        ],
        "D1/2024-05-01.json": [
            {"type": "message", "user": "U2", "text": "dm hello", "ts": ts(DAY1 + 6)}
        ],
    }


def write_zip(path: Path, data: dict[str, Any]) -> Path:
    with zipfile.ZipFile(path, "w") as zf:
        for name, value in data.items():
            zf.writestr(name, json.dumps(value, ensure_ascii=False))
    return path


class FakeSlack:
    """A stand-in for files.slack.com (httpx's mock transport)."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.fail_first: set[str] = set()

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if "F1" in path:
            return httpx.Response(200, content=_png(), headers={"content-type": "image/png"})
        if "F4" in path:
            return httpx.Response(200, content=MP4, headers={"content-type": "video/mp4"})
        if "F5" in path:
            if "F5" not in self.fail_first:
                self.fail_first.add("F5")
                return httpx.Response(503)
            return httpx.Response(200, content=b"%PDF-1.4 retried")
        if "F6" in path:
            return httpx.Response(
                200,
                content=b"<html>login</html>",
                headers={"content-type": "text/html; charset=utf-8"},
            )
        if "F7" in path:
            return httpx.Response(200, content=b"%PDF-1.4 elsewhere")
        return httpx.Response(404)


def downloads(cache: Path, fake: FakeSlack) -> FileSource:
    return FileSource(
        cache_dir=cache,
        download=True,
        token=TOKEN,
        backoff_seconds=0,
        transport=httpx.MockTransport(fake.handler),
    )


@pytest.fixture(autouse=True)
def fake_video_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    async def probe(path: str, settings: Settings) -> videos.VideoInfo:
        return videos.VideoInfo(width=640, height=360, duration_ms=4200, poster=_png(64, 36))

    monkeypatch.setattr(videos, "probe_video", probe)


async def _people(db: AsyncSession) -> dict[str, User]:
    yamada = await make_user(db, "yamada")
    yamada.email = "taro@example.com"
    await make_user(db, "hana")
    await make_user(db, "jiro")
    await make_user(db, "admin", role="admin")
    await db.commit()
    return {u.username: u for u in (await db.execute(select(User))).scalars().all()}


async def _run(
    app: FastAPI,
    db: AsyncSession,
    path: Path,
    files: FileSource,
    *,
    dry_run: bool = False,
    options: Options | None = None,
    user_map: dict[str, str] | None = None,
) -> Report:
    return await import_slack(
        db,
        path,
        files=files,
        options=options or Options(channel_prefix="slack-"),
        user_map=user_map if user_map is not None else {"hanako s": "hana", "u3": "jiro"},
        actor_username="admin",
        blobs=app.state.blobs,
        settings=app.state.settings,
        dry_run=dry_run,
    )


async def _messages(db: AsyncSession, channel_id: Any) -> list[Message]:
    rows = await db.execute(
        select(Message).where(Message.channel_id == channel_id).order_by(Message.seq)
    )
    return list(rows.scalars().all())


async def _count(db: AsyncSession, table: Any) -> int:
    return (await db.execute(select(func.count()).select_from(table))).scalar_one()


async def test_import_people_channels_threads_files_and_reads(
    app: FastAPI, db: AsyncSession, tmp_path: Path
) -> None:
    people = await _people(db)
    yamada, hana, jiro = people["yamada"].id, people["hana"].id, people["jiro"].id
    emoji_dir = tmp_path / "emoji"
    emoji_dir.mkdir()
    (emoji_dir / "partyparrot.gif").write_bytes(_png(600, 600))  # shrunk like the Mattermost ones
    fake = FakeSlack()
    path = write_zip(tmp_path / "export.zip", export_data())

    report = await _run(
        app,
        db,
        path,
        downloads(tmp_path / "cache", fake),
        options=Options(channel_prefix="slack-", emoji_dir=emoji_dir),
    )

    # people: email, display name and id mappings; a deactivated account and two bots made
    assert any("@taro → @yamada (メールアドレス一致)" in p for p in report.people)
    assert any("@hanako → @hana (--user)" in p for p in report.people)
    assert any("@jiro → @jiro (--user)" in p for p in report.people)
    users = {u.username: u for u in (await db.execute(select(User))).scalars().all()}
    assert "silent" not in users  # a member who never posted
    ghost, ci, deploy = users["ghost"], users["ci-bot"], users["deploybot"]
    assert ghost.deactivated_at is not None and ghost.display_name == "Ghost Person"
    assert ghost.email == "ghost@example.com"
    assert ci.role == "bot" and ci.display_name == "CI Bot" and deploy.role == "bot"
    assert sorted(report.unmapped) == [
        "@ci-bot → @ci-bot (新規 bot)",
        "@deploybot → @deploybot (新規 bot)",
        "@ghost → @ghost (新規 (無効化済み))",
    ]

    channels = {c.name: c for c in (await db.execute(select(Channel))).scalars().all()}
    assert set(channels) == {"slack-general", "slack-old", "slack-random"}  # no private, no DM
    general, old = channels["slack-general"], channels["slack-old"]
    assert general.type == "public" and general.topic == "全体 & @Hanako S の連絡"
    assert general.purpose == "みんなの場所" and general.created_by == yamada
    assert old.archived_at is not None and old.archived_at.timestamp() == DAY1 - 4000
    members = {
        (m.channel_id, m.user_id): m.role
        for m in (await db.execute(select(ChannelMember))).scalars().all()
        if m.channel_id == general.id
    }
    assert members == {
        (general.id, yamada): "owner",
        (general.id, hana): "member",
        (general.id, jiro): "member",
    }

    msgs = await _messages(db, general.id)
    m1, m2, m3, m5, m6, m7, m9, m10, m11 = msgs
    assert [m.seq for m in msgs] == list(range(1, 10)) and general.last_seq == 9
    assert [m.created_at.timestamp() for m in msgs] == sorted(
        m.created_at.timestamp() for m in msgs
    )
    assert m1.body == (
        f"hello <@{hana}> and <!here> 😄 **bold** [site](https://example.com) & #slack-old "
        ":partyparrot:"
    )
    assert m1.mentioned_user_ids == [hana] and m1.mention_all and m1.sender_id == yamada
    assert m1.reply_count == 2 and m1.last_reply_at == m3.created_at
    assert m2.parent_id == m1.id and m2.edited_at is not None and m2.body == "reply"
    assert m2.created_at.timestamp() == DAY1 + 200
    assert m3.parent_id == m1.id and m3.also_in_channel and m3.sender_id == jiro
    assert not m2.also_in_channel
    assert m5.sender_id == ghost.id and m5.body == "📎 missing.pdf (Slack から取得できませんでした)"
    assert m6.sender_id == ci.id and m6.body == "Build passed"
    assert m7.sender_id == deploy.id and m7.body == "deployed"
    assert m9.body == "waves"
    assert m10.pinned_at == m10.created_at and m10.pinned_by == jiro  # channels.json pins
    assert m11.body == "code\n```\na *b*\n```\nend"

    reactions = {
        (r.user_id, r.emoji)
        for r in (await db.execute(select(Reaction).where(Reaction.message_id == m1.id))).scalars()
    }
    assert reactions == {
        (hana, "👍🏻"),
        (jiro, "👍🏻"),
        (yamada, ":partyparrot:"),
        (hana, ":unknown_x:"),
    }
    assert report.unmatched_emoji == {"unknown_x": 1}
    assert report.dropped_emoji == {"x" * 40: 1}
    emoji = (await db.execute(select(CustomEmoji))).scalar_one()
    assert emoji.name == "partyparrot" and max(emoji.width, emoji.height) <= 512

    files = {
        a.filename: a
        for a in (
            await db.execute(select(Attachment).where(Attachment.message_id == m5.id))
        ).scalars()
    }
    assert set(files) == {"graph.png", "clip.mp4"}
    graph, clip = files["graph.png"], files["clip.mp4"]
    assert graph.content_type == "image/png" and (graph.width, graph.height) == (40, 30)
    assert graph.thumbnail_key and await app.state.blobs.exists(graph.thumbnail_key)
    assert await app.state.blobs.exists(graph.storage_key) and graph.sha256 is not None
    assert clip.content_type == "video/mp4" and clip.duration_ms == 4200
    assert (clip.width, clip.height) == (640, 360) and clip.thumbnail_key is not None
    assert report.counts["files"] == 2 and report.counts["files_failed"] == 1
    assert report.counts["files_hidden"] == 1
    assert report.failed_files == ["#slack-general missing.pdf (F2): HTTP 404"]
    assert report.channels["#slack-general"]["posts"] == 9
    assert report.channels["#slack-general"]["replies"] == 2
    assert report.channels["#slack-general"]["files"] == 2

    # the token went to Slack's file host only, and each file was asked for once
    paths = sorted(r.url.path for r in fake.requests)
    assert len(paths) == 3 and all(
        r.headers["authorization"] == f"Bearer {TOKEN}" for r in fake.requests
    )
    assert (tmp_path / "cache" / "F1" / "graph.png").read_bytes() == _png()

    reads = {
        (r.user_id, r.channel_id): r.last_read_seq
        for r in (await db.execute(select(ReadState))).scalars()
    }
    assert reads[(yamada, general.id)] == 9 and reads[(hana, general.id)] == 9
    follows = {(f.user_id, f.parent_id) for f in (await db.execute(select(ThreadFollow))).scalars()}
    assert follows == {(yamada, m1.id), (hana, m1.id), (jiro, m1.id)}
    events = [e.event_type for e in (await db.execute(select(OutboxEvent))).scalars()]
    assert events.count("channel.created") == 3
    assert "message.created" not in events  # history, not news: no pushes


async def test_rerun_adds_only_new_messages_and_reuses_the_cache(
    app: FastAPI, db: AsyncSession, tmp_path: Path
) -> None:
    await _people(db)
    fake = FakeSlack()
    first = write_zip(tmp_path / "a.zip", export_data())
    await _run(app, db, first, downloads(tmp_path / "cache", fake))
    before = {t: await _count(db, t) for t in (User, Channel, Message, Attachment, Reaction)}
    asked = len(fake.requests)

    later = [
        {
            "type": "message",
            "user": "U2",
            "text": "new one",
            "ts": ts(DAY2 + 99),
            "thread_ts": ts(DAY1 + 100),
        }
    ]
    report = await _run(
        app,
        db,
        write_zip(tmp_path / "b.zip", export_data(later)),
        downloads(tmp_path / "cache", fake),
    )

    assert report.counts["posts"] == 1 and report.counts["posts_skipped_existing"] == 9 + 1
    assert report.counts["users_created"] == 0 and report.counts["channels_created"] == 0
    for table, count in before.items():
        assert await _count(db, table) == count + (1 if table is Message else 0), table
    # F2 failed the first time and its message exists: it is not asked for again
    assert len(fake.requests) == asked
    general = (
        await db.execute(select(Channel).where(Channel.name == "slack-general"))
    ).scalar_one()
    rows = await _messages(db, general.id)
    assert rows[-1].seq == 10 and rows[-1].parent_id == rows[0].id and rows[0].reply_count == 3


async def test_dry_run_writes_nothing(app: FastAPI, db: AsyncSession, tmp_path: Path) -> None:
    await _people(db)
    files_dir = tmp_path / "files"
    (files_dir / "F1").mkdir(parents=True)
    (files_dir / "F1" / "graph.png").write_bytes(_png())
    users_before = await _count(db, User)

    report = await _run(
        app,
        db,
        write_zip(tmp_path / "e.zip", export_data()),
        FileSource(files_dir=files_dir),
        dry_run=True,
    )

    assert report.dry_run and report.counts["posts"] == 10 and report.counts["files"] == 1
    assert report.counts["files_failed"] == 2  # F2 and F4 are not in the folder
    assert any("--files-dir に無い" in line for line in report.failed_files)
    for table in (Message, Channel, ImportRef, Attachment, Reaction):
        assert await _count(db, table) == 0, table
    assert await _count(db, User) == users_before
    assert app.state.blobs.objects == {}


async def test_files_dir_and_an_unpacked_export(
    app: FastAPI, db: AsyncSession, tmp_path: Path
) -> None:
    await _people(db)
    unpacked = tmp_path / "export"
    for name, value in export_data().items():
        (unpacked / name).parent.mkdir(parents=True, exist_ok=True)
        (unpacked / name).write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    files_dir = tmp_path / "files"
    files_dir.mkdir()
    (files_dir / "F1-graph.png").write_bytes(_png())  # <id>-<name>
    (files_dir / "F4.mp4").write_bytes(MP4)  # <id>.<ext>

    report = await _run(app, db, unpacked, FileSource(files_dir=files_dir))

    assert report.counts["files"] == 2 and report.counts["files_failed"] == 1
    assert report.counts["posts"] == 10


async def test_private_channels_and_dms_only_when_asked(
    app: FastAPI, db: AsyncSession, tmp_path: Path
) -> None:
    people = await _people(db)
    report = await _run(
        app,
        db,
        write_zip(tmp_path / "p.zip", export_data()),
        FileSource(),
        options=Options(channel_prefix="slack-", include_private=True, include_dms=True),
    )
    secret = (await db.execute(select(Channel).where(Channel.name == "slack-secret"))).scalar_one()
    assert secret.type == "private"
    dm = (await db.execute(select(Channel).where(Channel.type == "dm"))).scalar_one()
    members = set(
        (await db.execute(select(ChannelMember.user_id).where(ChannelMember.channel_id == dm.id)))
        .scalars()
        .all()
    )
    assert members == {people["yamada"].id, people["hana"].id}
    (hello,) = await _messages(db, dm.id)
    assert hello.body == "dm hello" and hello.sender_id == people["hana"].id
    assert report.counts["dms_created"] == 1
    # without a downloader the files leave their lines and are listed
    assert report.counts["files_failed"] == 3
    assert any("--download も --files-dir も指定していない" in f for f in report.failed_files)


async def test_a_name_clash_stops_before_writing(
    app: FastAPI, db: AsyncSession, tmp_path: Path
) -> None:
    await _people(db)
    db.add(Channel(type="public", name="general"))
    await db.commit()
    path = write_zip(tmp_path / "c.zip", export_data())
    users_before = await _count(db, User)

    with pytest.raises(ImportFailed, match=r"#general.*--channel-prefix"):
        await _run(app, db, path, FileSource(), options=Options())
    assert await _count(db, User) == users_before
    assert await _count(db, Channel) == 1 and await _count(db, ImportRef) == 0

    db.add(Channel(type="public", name="slack-old"))
    await db.commit()
    with pytest.raises(ImportFailed, match="#slack-old; choose another --channel-prefix"):
        await _run(app, db, path, FileSource())

    report = await _run(app, db, path, FileSource(), options=Options(channel_prefix="s-"))
    assert report.counts["channels_created"] == 3


async def test_bad_options_fail_before_writing(
    app: FastAPI, db: AsyncSession, tmp_path: Path
) -> None:
    await _people(db)
    path = write_zip(tmp_path / "b.zip", export_data())
    with pytest.raises(ImportFailed, match="no such Slack user"):
        await _run(app, db, path, FileSource(), user_map={"nobody": "hana"})
    with pytest.raises(ImportFailed, match="no ChikuwaChat user ghost2"):
        await _run(app, db, path, FileSource(), user_map={"ghost": "ghost2"})
    with pytest.raises(ImportFailed, match="not an active administrator"):
        await import_slack(
            db,
            path,
            files=FileSource(),
            options=Options(),
            user_map={},
            actor_username="hana",
            blobs=app.state.blobs,
            settings=app.state.settings,
            dry_run=False,
        )
    (tmp_path / "junk.zip").write_bytes(b"not a zip")
    with pytest.raises(ImportFailed, match="not a Slack export"):
        await _run(app, db, tmp_path / "junk.zip", FileSource())
    assert await _count(db, Channel) == 0


async def test_downloads_retry_refuse_login_pages_and_keep_the_token_home(
    tmp_path: Path,
) -> None:
    fake = FakeSlack()
    source = downloads(tmp_path / "cache", fake)
    source.max_bytes = 1000
    files = [
        _file("F5", "retry.pdf", size=0),
        _file("F6", "login.pdf"),
        _file("F7", "elsewhere.pdf", url="https://evil.example.com/F7.pdf", size=0),
        _file("F8", "huge.bin", size=5000),
        _file("../x", "bad.bin"),
    ]
    await source.fetch(files)

    assert source.locate(files[0]) is not None  # 503 then 200
    assert "ログイン画面" in source.failures["F6"]
    assert source.locate(files[2]) is not None
    assert "上限" in source.failures["F8"]
    assert source.failures["../x"] == "ファイル id が不正"
    by_host = {r.url.host: r for r in fake.requests}
    assert by_host["files.slack.com"].headers["authorization"] == f"Bearer {TOKEN}"
    assert "authorization" not in by_host["evil.example.com"].headers
    assert not any("F8" in r.url.path for r in fake.requests)  # too large: never asked for
    assert not list((tmp_path / "cache").rglob("*.part"))


def test_cli_checks_the_file_options_and_reads_the_token_from_a_file(tmp_path: Path) -> None:
    from app.cli import main, read_secret_file

    base = ["import-slack", str(tmp_path / "x.zip"), "--actor", "admin"]
    assert main([*base, "--download"]) == 2  # no --files-cache
    assert main([*base, "--download", "--files-cache", "c", "--files-dir", "d"]) == 2
    assert main([*base, "--slack-token-file", "t"]) == 2  # a token without --download
    token = tmp_path / "token"
    token.write_text(f"  {TOKEN}\n", encoding="utf-8")
    assert read_secret_file(str(token)) == TOKEN
    assert read_secret_file(None) is None
