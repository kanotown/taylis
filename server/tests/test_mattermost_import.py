"""Mattermost import (M18): the read-only extract and the idempotent import."""

import io
import json
from pathlib import Path
from typing import Any

import asyncpg
import pytest
from fastapi import FastAPI
from PIL import Image
from sqlalchemy import func, select
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.events.models import OutboxEvent
from app.modules.attachments.models import Attachment
from app.modules.channels.models import Channel, ChannelMember
from app.modules.emoji.models import CustomEmoji
from app.modules.importer.mattermost_extract import asyncpg_dsn, extract_team
from app.modules.importer.mattermost_import import (
    ImportFailed,
    Report,
    channel_name,
    import_mattermost,
)
from app.modules.importer.models import ImportRef
from app.modules.messages.models import Message, Reaction
from app.modules.reads.models import ReadState
from app.modules.threads.models import ThreadFollow
from app.modules.users.models import User
from tests.helpers import make_user

T0 = 1_727_000_000_000  # 2024-09-22, epoch ms like Mattermost


def _png(width: int = 40, height: int = 30) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (0, 128, 255)).save(buffer, "PNG")
    return buffer.getvalue()


def _user(uid: str, username: str, **extra: Any) -> dict[str, Any]:
    return {
        "type": "user",
        "id": uid,
        "username": username,
        "email": extra.get("email"),
        "first_name": extra.get("first_name", ""),
        "last_name": extra.get("last_name", ""),
        "nickname": extra.get("nickname", ""),
        "position": extra.get("position", ""),
        "is_bot": extra.get("is_bot", False),
        "deleted": False,
    }


def _post(pid: str, channel: str, user: str, message: str, at: int, **extra: Any) -> dict[str, Any]:
    return {
        "type": "post",
        "id": pid,
        "channel_id": channel,
        "user_id": user,
        "root_id": extra.get("root_id"),
        "message": message,
        "create_at": at,
        "edit_at": extra.get("edit_at", 0),
        "pinned": extra.get("pinned", False),
        "override_username": None,
        "files": extra.get("files", []),
        "reactions": extra.get("reactions", []),
    }


def _channel(
    cid: str, display: str, members: list[tuple[str, bool]], **extra: Any
) -> dict[str, Any]:
    return {
        "type": "channel",
        "id": cid,
        "name": extra.get("name", cid),
        "display_name": display,
        "private": extra.get("private", False),
        "header": extra.get("header", ""),
        "purpose": extra.get("purpose", ""),
        "creator_id": extra.get("creator_id"),
        "create_at": T0,
        "delete_at": extra.get("delete_at", 0),
        "members": [{"user_id": u, "admin": a} for u, a in members],
    }


def _write(path: Path, records: list[dict[str, Any]]) -> Path:
    meta = {
        "type": "meta",
        "version": 1,
        "source": "mattermost",
        "team": {"id": "t", "name": "ebi"},
    }
    lines = [json.dumps(r, ensure_ascii=False) for r in [meta, *records]]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def _records(extra_posts: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    users = [
        _user("u-kano", "alicemm"),
        _user("u-ebi", "bobmm"),
        _user("u-taro", "taro", first_name="太郎", last_name="山田", position="M1"),
        _user("u-sato", "sato-mm", email="sato@example.com"),
        _user("u-bot", "hanpeen", is_bot=True),
        _user("u-silent", "silent"),
        _user("u-only", "onlymentioned"),
    ]
    emoji = [{"type": "emoji", "id": "e-ok", "name": "hanpen_ok", "creator_id": "u-ebi"}]
    general = _channel(
        "c-gen",
        "general",
        [("u-kano", True), ("u-ebi", False), ("u-taro", False), ("u-silent", False)],
        header="全体連絡",
        creator_id="u-ebi",
    )
    private = _channel("c-lab", "研究 報告#1", [("u-ebi", False), ("u-sato", False)], private=True)
    old = _channel("c-old", "old stuff", [("u-kano", False)], delete_at=T0 + 50_000)
    posts = [
        _post(
            "p1",
            "c-gen",
            "u-kano",
            "hello @bobmm. and @channel :smile: :hanpen_ok: `@bobmm` @onlymentioned",
            T0 + 1000,
        ),
        _post(
            "p2",
            "c-gen",
            "u-ebi",
            "thanks @alicemm",
            T0 + 2000,
            root_id="p1",
            reactions=[
                {"user_id": "u-kano", "emoji_name": "+1", "create_at": T0 + 2100},
                {"user_id": "u-taro", "emoji_name": "hanpen_ok", "create_at": T0 + 2200},
                {"user_id": "u-ebi", "emoji_name": "not_an_emoji_zz", "create_at": T0 + 2300},
                {"user_id": "u-kano", "emoji_name": "thumbsup", "create_at": T0 + 2400},
                {"user_id": "u-ebi", "emoji_name": "x" * 31, "create_at": T0 + 2500},
            ],
        ),
        _post(
            "p3",
            "c-gen",
            "u-taro",
            "",
            T0 + 3000,
            pinned=True,
            edit_at=T0 + 3500,
            files=[
                {
                    "id": "f1",
                    "name": "graph.png",
                    "path": "20240922/f1/graph.png",
                    "mime_type": "image/png",
                    "size": 1,
                    "width": 40,
                    "height": 30,
                },
                {
                    "id": "f2",
                    "name": "gone.pdf",
                    "path": "20240922/f2/gone.pdf",
                    "mime_type": "application/pdf",
                    "size": 1,
                    "width": 0,
                    "height": 0,
                },
            ],
        ),
        _post("p4", "c-gen", "u-bot", "bot says hi", T0 + 4000),
        _post("p5", "c-gen", "u-ebi", "orphan reply", T0 + 5000, root_id="deleted-root"),
        _post("q1", "c-lab", "u-sato", "進捗です", T0 + 6000),
        _post("q2", "c-lab", "u-ebi", "了解", T0 + 7000, root_id="q1"),
        _post("o1", "c-old", "u-kano", "archived talk", T0 + 8000),
    ]
    return [*users, *emoji, general, private, old, *posts, *(extra_posts or [])]


@pytest.fixture
def mm_files(tmp_path: Path) -> Path:
    root = tmp_path / "data"
    (root / "20240922" / "f1").mkdir(parents=True)
    (root / "20240922" / "f1" / "graph.png").write_bytes(_png())
    (root / "emoji" / "e-ok").mkdir(parents=True)
    (root / "emoji" / "e-ok" / "image").write_bytes(_png(600, 600))  # shrunk on import
    return root


async def _run(
    app: FastAPI, db: AsyncSession, path: Path, files: Path | None, *, dry_run: bool = False
) -> Report:
    settings: Settings = app.state.settings
    return await import_mattermost(
        db,
        path,
        files_root=files,
        user_map={"alicemm": "kano", "bobmm": "ebi"},
        actor_username="admin",
        blobs=app.state.blobs,
        settings=settings,
        dry_run=dry_run,
    )


async def _people(db: AsyncSession) -> dict[str, User]:
    for name in ("kano", "ebi"):
        await make_user(db, name)
    await make_user(db, "admin", role="admin")
    sato = await make_user(db, "sato")
    sato.email = "sato@example.com"
    await db.commit()
    return {u.username: u for u in (await db.execute(select(User))).scalars().all()}


async def _messages(db: AsyncSession, channel_id: Any) -> list[Message]:
    rows = await db.execute(
        select(Message).where(Message.channel_id == channel_id).order_by(Message.seq)
    )
    return list(rows.scalars().all())


async def test_import_maps_people_threads_mentions_files_and_reads(
    app: FastAPI, db: AsyncSession, tmp_path: Path, mm_files: Path
) -> None:
    people = await _people(db)
    kano, ebi, sato = people["kano"].id, people["ebi"].id, people["sato"].id
    db.add(Channel(type="public", name="general"))  # taken: the import becomes general-mm
    await db.commit()
    path = _write(tmp_path / "ebi.jsonl", _records())

    report = await _run(app, db, path, mm_files)

    assert report.counts["posts"] == 8 and report.counts["replies"] == 2
    assert report.counts["users_created"] == 2 and report.counts["users_mapped"] == 3
    assert report.counts["files"] == 1 and report.counts["files_missing"] == 1
    assert any("@sato-mm → @sato (メールアドレス一致)" in p for p in report.people)
    users = {u.username: u for u in (await db.execute(select(User))).scalars().all()}
    assert "silent" not in users and "onlymentioned" not in users  # nothing of theirs to keep
    taro, bot = users["taro"], users["hanpeen"]
    assert taro.deactivated_at is not None and taro.display_name == "太郎 山田"
    assert taro.title == "M1" and taro.role == "member"
    assert bot.role == "bot"

    channels = {c.name: c for c in (await db.execute(select(Channel))).scalars().all()}
    general, lab, old = channels["general-mm"], channels["研究-報告1"], channels["old-stuff"]
    assert general.topic == "全体連絡" and general.created_by == ebi
    assert lab.type == "private" and old.archived_at is not None
    members = {
        (m.channel_id, m.user_id): m.role
        for m in (await db.execute(select(ChannelMember))).scalars().all()
    }
    # Active accounts only (taro is deactivated, the bot never joins); admins become owners.
    assert members == {
        (general.id, kano): "owner",
        (general.id, ebi): "owner",  # the creator
        (lab.id, ebi): "member",
        (lab.id, sato): "member",
        (old.id, kano): "member",
    }

    p1, p2, p3, p4, p5 = await _messages(db, general.id)
    assert [m.seq for m in (p1, p2, p3, p4, p5)] == [1, 2, 3, 4, 5]
    assert general.last_seq == 5 and general.last_message_at == p5.created_at
    assert p1.body == f"hello <@{ebi}>. and <!channel> 😄 :hanpen_ok: `@bobmm` @onlymentioned"
    assert p1.mentioned_user_ids == [ebi] and p1.mention_all
    assert p1.reply_count == 1 and p1.updated_seq == 2 and p1.last_reply_at == p2.created_at
    assert p1.reply_user_ids == [p2.sender_id]  # C3
    assert p2.parent_id == p1.id and p2.body == f"thanks <@{kano}>"
    assert p1.id < p2.id < p3.id  # ids carry the Mattermost post times
    assert p3.pinned_at == p3.created_at and p3.edited_at is not None and p3.body == ""
    assert p4.sender_id == bot.id and p5.parent_id is None  # its root is gone
    assert any("スレッドの親が無い" in w for w in report.warnings)

    reactions = {
        (r.user_id, r.emoji)
        for r in (await db.execute(select(Reaction).where(Reaction.message_id == p2.id))).scalars()
    }
    assert reactions == {(kano, "👍"), (taro.id, ":hanpen_ok:"), (ebi, ":not_an_emoji_zz:")}
    assert report.unmatched_emoji == {"not_an_emoji_zz": 1}
    assert report.dropped_emoji == {"x" * 31: 1}  # longer than a reaction name may be

    (attachment,) = (
        await db.execute(select(Attachment).where(Attachment.message_id == p3.id))
    ).scalars()
    assert attachment.status == "attached" and attachment.content_type == "image/png"
    assert (attachment.width, attachment.height) == (40, 30) and attachment.sha256 is not None
    assert await app.state.blobs.exists(attachment.storage_key)
    assert attachment.thumbnail_key and await app.state.blobs.exists(attachment.thumbnail_key)

    emoji = (await db.execute(select(CustomEmoji))).scalar_one()
    assert emoji.name == "hanpen_ok" and emoji.created_by == ebi
    assert max(emoji.width, emoji.height) <= 512 and await app.state.blobs.exists(emoji.storage_key)

    reads = {
        (r.user_id, r.channel_id): r.last_read_seq
        for r in (await db.execute(select(ReadState))).scalars()
    }
    assert reads[(kano, general.id)] == 5 and reads[(ebi, general.id)] == 5
    assert reads[(sato, lab.id)] == 2
    q1 = (await _messages(db, lab.id))[0]
    follows = {
        (f.user_id, f.parent_id): f.last_read_seq
        for f in (await db.execute(select(ThreadFollow))).scalars()
    }
    assert follows == {(kano, p1.id): 2, (ebi, p1.id): 2, (sato, q1.id): 2, (ebi, q1.id): 2}

    events = [e.event_type for e in (await db.execute(select(OutboxEvent))).scalars()]
    assert events.count("channel.created") == 3 and events.count("emoji.updated") == 1
    assert "message.created" not in events  # history, not news: no pushes


async def test_rerun_appends_only_new_posts(
    app: FastAPI, db: AsyncSession, tmp_path: Path, mm_files: Path
) -> None:
    people = await _people(db)
    path = _write(tmp_path / "ebi.jsonl", _records())
    await _run(app, db, path, mm_files)
    counts = {
        table: (await db.execute(select(func.count()).select_from(table))).scalar_one()
        for table in (User, Channel, Message, Attachment, Reaction, CustomEmoji)
    }

    later = [_post("p6", "c-gen", "u-kano", "new since the first run", T0 + 9000, root_id="p1")]
    report = await _run(app, db, _write(tmp_path / "ebi2.jsonl", _records(later)), mm_files)

    assert report.counts["posts"] == 1 and report.counts["posts_skipped_existing"] == 8
    assert report.counts["users_created"] == 0 and report.counts["channels_created"] == 0
    for table, before in counts.items():
        after = (await db.execute(select(func.count()).select_from(table))).scalar_one()
        assert after == before + (1 if table is Message else 0), table
    general = (await db.execute(select(Channel).where(Channel.name == "general"))).scalar_one()
    rows = await _messages(db, general.id)
    assert rows[-1].seq == 6 and rows[-1].parent_id == rows[0].id and general.last_seq == 6
    assert rows[0].reply_count == 2 and rows[0].updated_seq == 6
    assert rows[0].reply_user_ids == [people["kano"].id, rows[1].sender_id]  # C3: newest first
    read = await db.get(ReadState, (people["kano"].id, general.id))
    assert read is not None and read.last_read_seq == 6


async def test_dry_run_writes_nothing(
    app: FastAPI, db: AsyncSession, tmp_path: Path, mm_files: Path
) -> None:
    await _people(db)
    report = await _run(app, db, _write(tmp_path / "ebi.jsonl", _records()), mm_files, dry_run=True)

    assert report.dry_run and report.counts["posts"] == 8 and report.counts["files"] == 1
    assert (await db.execute(select(func.count()).select_from(Message))).scalar_one() == 0
    assert (await db.execute(select(func.count()).select_from(Channel))).scalar_one() == 0
    assert (await db.execute(select(func.count()).select_from(ImportRef))).scalar_one() == 0
    assert (await db.execute(select(func.count()).select_from(User))).scalar_one() == 4
    assert app.state.blobs.objects == {}  # MemoryBlobStore in tests


async def test_bad_options_fail_before_writing(
    app: FastAPI, db: AsyncSession, tmp_path: Path
) -> None:
    await _people(db)
    path = _write(tmp_path / "ebi.jsonl", _records())
    settings: Settings = app.state.settings
    common: dict[str, Any] = {
        "files_root": None,
        "blobs": app.state.blobs,
        "settings": settings,
        "dry_run": False,
    }
    with pytest.raises(ImportFailed, match="no Taylis user"):
        await import_mattermost(
            db, path, user_map={"alicemm": "nobody"}, actor_username="admin", **common
        )
    with pytest.raises(ImportFailed, match="no such Mattermost user"):
        await import_mattermost(
            db, path, user_map={"ghost": "kano"}, actor_username="admin", **common
        )
    with pytest.raises(ImportFailed, match="not an active administrator"):
        await import_mattermost(db, path, user_map={}, actor_username="kano", **common)
    (tmp_path / "junk.jsonl").write_text('{"type":"meta","source":"slack"}\n')
    with pytest.raises(ImportFailed, match="not a mattermost-extract file"):
        await import_mattermost(
            db, tmp_path / "junk.jsonl", user_map={}, actor_username="admin", **common
        )
    assert (await db.execute(select(func.count()).select_from(User))).scalar_one() == 4


def _gif(side: int, frames: int = 3) -> bytes:
    from PIL import Image

    images = [Image.new("RGB", (side, side), (40 * i, 120, 200 - 40 * i)) for i in range(frames)]
    out = io.BytesIO()
    images[0].save(out, format="GIF", save_all=True, append_images=images[1:], duration=80, loop=0)
    return out.getvalue()


def test_a_large_animated_emoji_stays_animated() -> None:
    """Testers, 2026-09-29: imported GIFs did not move (a large one was stored as one frame)."""
    from PIL import Image

    from app.modules.importer.mattermost_import import _shrink_emoji

    data, width, height, content_type = _shrink_emoji(_gif(600), 256 * 1024)
    assert content_type == "image/gif" and max(width, height) <= 128
    with Image.open(io.BytesIO(data)) as image:
        assert getattr(image, "n_frames", 1) == 3
    still = _shrink_emoji(_png(600, 600), 256 * 1024)
    assert still[3] == "image/png"


async def test_refresh_emoji_brings_back_the_animation(
    app: FastAPI, db: AsyncSession, tmp_path: Path, mm_files: Path
) -> None:
    await _people(db)
    path = _write(tmp_path / "ebi.jsonl", _records())
    await _run(app, db, path, mm_files)
    emoji = (await db.execute(select(CustomEmoji))).scalar_one()
    assert emoji.content_type == "image/png"

    (mm_files / "emoji" / "e-ok" / "image").write_bytes(_gif(600))  # the Mattermost file is a GIF
    settings: Settings = app.state.settings
    report = await import_mattermost(
        db,
        path,
        files_root=mm_files,
        user_map={"alicemm": "kano", "bobmm": "ebi"},
        actor_username="admin",
        blobs=app.state.blobs,
        settings=settings,
        dry_run=False,
        refresh_emoji=True,
    )
    assert report.counts["emoji_refreshed"] == 1 and report.counts["emoji_created"] == 0
    refreshed = (await db.execute(select(CustomEmoji))).scalar_one()
    assert refreshed.content_type == "image/gif" and max(refreshed.width, refreshed.height) <= 128


def test_mattermost_emoji_names_with_hyphens_find_their_glyph() -> None:
    """The 🍤 team's dry run left :woman-bowing: and :rainbow-flag: unmatched (2026-09-29)."""
    from app.modules.importer.mattermost_import import standard_glyph

    assert standard_glyph("rainbow-flag") == standard_glyph("rainbow_flag") is not None
    assert standard_glyph("woman-bowing") == standard_glyph("bowing_woman") is not None
    assert standard_glyph("man-bowing") == standard_glyph("man_bowing") is not None
    assert standard_glyph("thumbsup") is not None
    assert standard_glyph("no-such-emoji") is None


def test_channel_names() -> None:
    assert channel_name("研究 報告") == "研究-報告"
    assert channel_name(" #random / @misc ") == "random--misc"
    assert channel_name("🍤") == "🍤"
    assert channel_name("###") == "channel"
    assert len(channel_name("x" * 100)) == 80


# ---- extract: a Mattermost-shaped database ---------------------------------------------------

MM_SCHEMA = """
DROP TABLE IF EXISTS teams, channels, channelmembers, posts, users, bots, reactions, fileinfo,
  emoji;
CREATE TABLE teams (id varchar(26), name varchar(64), displayname varchar(64), deleteat bigint);
CREATE TABLE channels (id varchar(26), createat bigint, deleteat bigint, teamid varchar(26),
  type varchar(1), displayname varchar(64), name varchar(64), header text, purpose text,
  creatorid varchar(26));
CREATE TABLE channelmembers (channelid varchar(26), userid varchar(26), roles text,
  schemeadmin boolean);
CREATE TABLE posts (id varchar(26), createat bigint, updateat bigint, deleteat bigint,
  userid varchar(26), channelid varchar(26), rootid varchar(26), originalid varchar(26),
  message text, type varchar(26), props jsonb, fileids text, editat bigint, ispinned boolean);
CREATE TABLE users (id varchar(26), username varchar(64), email varchar(128), nickname varchar(64),
  firstname varchar(64), lastname varchar(64), position varchar(128), deleteat bigint);
CREATE TABLE bots (userid varchar(26));
CREATE TABLE reactions (userid varchar(26), postid varchar(26), emojiname varchar(64),
  createat bigint, deleteat bigint);
CREATE TABLE fileinfo (id varchar(26), postid varchar(26), path text, name text, mimetype text,
  size bigint, width int, height int, createat bigint, deleteat bigint);
CREATE TABLE emoji (id varchar(26), name varchar(64), creatorid varchar(26), deleteat bigint);

INSERT INTO teams VALUES ('t1', 'ebi', '🍤', 0), ('t2', 'other', 'Other', 0);
INSERT INTO users VALUES
  ('u1', 'alicemm', 'k@example.com', '', 'Alice', 'Example', 'PI', 0),
  ('u2', 'bobmm', 'e@example.com', 'えび', '', '', '', 0),
  ('u3', 'hanpeen', '', '', '', '', '', 0),
  ('u4', 'mentioned', 'm@example.com', '', '', '', '', 0),
  ('u5', 'stranger', 's@example.com', '', '', '', '', 0);
INSERT INTO bots VALUES ('u3');
INSERT INTO channels VALUES
  ('c1', 1000, 0, 't1', 'O', 'General', 'general', 'head', 'purp', 'u1'),
  ('c2', 1100, 0, 't1', 'P', 'Secret', 'secret', '', '', 'u2'),
  ('c3', 1200, 5000, 't1', 'O', 'Old', 'old', '', '', 'u1'),
  ('c4', 1300, 0, 't2', 'O', 'Elsewhere', 'elsewhere', '', '', 'u5'),
  ('c5', 1400, 0, '', 'D', '', 'u1__u2', '', '', '');
INSERT INTO channelmembers VALUES
  ('c1', 'u1', 'channel_user channel_admin', true), ('c1', 'u2', 'channel_user', false),
  ('c2', 'u2', 'channel_user', false), ('c4', 'u5', 'channel_user', false), ('c5', 'u1', '', false);
INSERT INTO posts VALUES
  ('p1', 2000, 2000, 0, 'u1', 'c1', '', '', 'hi @Mentioned :hanpen_ok:', '', '{}', '[]', 0, true),
  ('p2', 2100, 2100, 0, 'u2', 'c1', 'p1', '', 'reply', '', '{}', '[]', 2200, false),
  ('p3', 2200, 2200, 3000, 'u2', 'c1', '', '', 'deleted', '', '{}', '[]', 0, false),
  ('p4', 2300, 2300, 0, 'u2', 'c1', '', '', 'u2 joined', 'system_join_channel', '{}', '[]', 0,
   false),
  ('p5', 2400, 2400, 0, 'u3', 'c1', '', '', 'hook', '',
   '{"from_webhook": "true", "override_username": "CI"}', '[]', 0, false),
  ('p6', 2500, 2500, 0, 'u2', 'c2', '', '', 'secret talk', '', '{}', '[]', 0, false),
  ('p7', 2600, 2600, 0, 'u5', 'c4', '', '', 'other team', '', '{}', '[]', 0, false),
  ('p8', 2700, 2700, 0, 'u1', 'c5', '', '', 'a dm', '', '{}', '[]', 0, false);
INSERT INTO reactions VALUES ('u2', 'p1', 'hanpen_ok', 2050, 0), ('u1', 'p1', 'smile', 2060, 2070),
  ('u5', 'p7', 'smile', 2610, 0);
INSERT INTO fileinfo VALUES
  ('f1', 'p2', '20240101/x/a.png', 'a.png', 'image/png', 10, 4, 3, 2100, 0),
  ('f2', 'p2', '20240101/x/b.png', 'b.png', 'image/png', 10, 4, 3, 2100, 9);
INSERT INTO emoji VALUES ('e1', 'hanpen_ok', 'u2', 0), ('e2', 'unused', 'u2', 0);
"""


async def test_extract_reads_one_team_only(tmp_path: Path, migrated_database: str) -> None:
    url = make_url(migrated_database)
    mm_db = f"{url.database}_mm"
    admin = await asyncpg.connect(
        user=url.username,
        password=url.password,
        host=url.host,
        port=url.port or 5432,
        database="postgres",
    )
    try:
        if not await admin.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", mm_db):
            await admin.execute(f'CREATE DATABASE "{mm_db}"')
    finally:
        await admin.close()
    dsn = url.set(drivername="postgres", database=mm_db).render_as_string(hide_password=False)
    conn = await asyncpg.connect(asyncpg_dsn(dsn))
    try:
        await conn.execute(MM_SCHEMA)
    finally:
        await conn.close()

    out = tmp_path / "ebi.jsonl"
    counts = await extract_team(dsn + "?sslmode=disable&connect_timeout=10", "ebi", out)

    records = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines()]
    by_type: dict[str, list[dict[str, Any]]] = {}
    for record in records:
        by_type.setdefault(record["type"], []).append(record)
    assert counts == {"users": 4, "emoji": 1, "channels": 3, "posts": 4, "files": 1, "reactions": 1}
    assert by_type["meta"][0]["team"]["name"] == "ebi"
    assert [c["name"] for c in by_type["channel"]] == ["general", "secret", "old"]
    assert sorted(by_type["channel"][0]["members"], key=lambda m: m["user_id"]) == [
        {"user_id": "u1", "admin": True},
        {"user_id": "u2", "admin": False},
    ]
    assert by_type["channel"][2]["delete_at"] == 5000
    assert [p["id"] for p in by_type["post"]] == ["p1", "p2", "p5", "p6"]
    p1, p2, p5 = by_type["post"][0], by_type["post"][1], by_type["post"][2]
    assert p1["pinned"] and p1["reactions"] == [
        {"user_id": "u2", "emoji_name": "hanpen_ok", "create_at": 2050}
    ]
    assert p2["root_id"] == "p1" and p2["edit_at"] == 2200
    assert [f["id"] for f in p2["files"]] == ["f1"]
    assert p5["override_username"] == "CI"
    users = {u["username"]: u for u in by_type["user"]}
    assert set(users) == {"alicemm", "bobmm", "hanpeen", "mentioned"}  # not the other team's
    assert users["hanpeen"]["is_bot"] and not users["alicemm"]["is_bot"]
    assert users["hanpeen"]["email"] is None
    assert [e["name"] for e in by_type["emoji"]] == ["hanpen_ok"]


def test_dsn_normalization() -> None:
    assert (
        asyncpg_dsn("postgres://mm:pw@localhost:5432/mattermost?sslmode=disable&connect_timeout=10")
        == "postgresql://mm:pw@localhost:5432/mattermost?sslmode=disable"
    )


async def test_normal_posts_between_batches_keep_the_seq(
    app: FastAPI,
    db: AsyncSession,
    tmp_path: Path,
    mm_files: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Review v0.1.22 #2: a later batch for another channel left the seq of a channel that got
    a normal post in between alone (it used to write the older last_seq back)."""
    from tests.test_review_v022 import check_seqs_after_import, interleave_normal_posts

    await _people(db)
    posted = interleave_normal_posts(monkeypatch, app)
    await _run(app, db, _write(tmp_path / "ebi.jsonl", _records()), mm_files)
    await check_seqs_after_import(app, posted)
