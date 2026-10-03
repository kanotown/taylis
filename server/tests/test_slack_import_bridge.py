"""Slack import, the lab's export (M92): a Mattermost → Slack bridge's bot posts as people
(--bot-as), its relayed join lines left out, Japanese custom emoji renamed (--emoji-rename) from
an emoji ZIP, and keycap reactions."""

import unicodedata
import zipfile
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.cli import main, parse_bot_as, parse_emoji_renames, print_import_report
from app.core.ids import uuid7
from app.modules.emoji.models import CustomEmoji
from app.modules.importer.core import ImportFailed, Report
from app.modules.importer.slack_import import (
    BRIDGE_JOIN,
    EmojiImages,
    FileSource,
    Options,
    import_slack,
)
from app.modules.messages.models import Message, Reaction
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_slack_import import DAY1, _NoUtf8FlagInfo, _png, _user, ts, write_zip

REPO = Path(__file__).resolve().parents[2]


def _bot(
    n: int, text: str, *, username: str | None = None, profile: str | None = None
) -> dict[str, Any]:
    message: dict[str, Any] = {
        "type": "message",
        "subtype": "bot_message",
        "bot_id": "BBRIDGE",
        "text": text,
        "ts": ts(DAY1 + n),
    }
    if username is not None:
        message["username"] = username
    if profile is not None:
        message["bot_profile"] = {"id": "BBRIDGE", "name": profile}
    return message


def bridge_export() -> dict[str, Any]:
    users = [
        _user("U1", "taro", real_name="Taro"),
        _user("U2", "suzu", display_name="Suzuki S"),  # never posts: the bridge posts for them
    ]
    general = {
        "id": "C1",
        "name": "general",
        "created": DAY1 - 1000,
        "creator": "U1",
        "members": ["U1", "U2"],
    }
    reactions = [
        {"name": name, "users": ["U1"], "count": 1}
        for name in ("完了", "確認しました", "one", "two", "keycap_ten", "hash", "未登録の絵文字")
    ]
    day = [
        {
            "type": "message",
            "user": "U1",
            "text": "hello :完了: and `:完了:` in code :確認しました:",
            "ts": ts(DAY1 + 1),
            "reactions": reactions,
        },
        _bot(2, "suzuki says hi", username="suzuki"),
        _bot(3, "tana post", username="Tanaka"),
        _bot(4, "sato post", profile="sato"),
        _bot(5, "suzuki がチャンネルに参加しました。", username="suzuki"),
        _bot(6, "@99x9999zさんがチャンネルに参加しました", username="bridge"),
        _bot(7, "  <@U1> がチャンネルに参加しました\n", username="bridge"),
        # a person writing the same words is a post
        {
            "type": "message",
            "user": "U1",
            "text": "taro がチャンネルに参加しました。",
            "ts": ts(DAY1 + 8),
        },
        _bot(9, "build ok", username="CI Bot"),
    ]
    return {"users.json": users, "channels.json": [general], "general/2024-05-01.json": day}


def emoji_zip(path: Path) -> Path:
    """The images as the user downloaded them: UTF-8 names without the ZIP's UTF-8 flag."""
    with zipfile.ZipFile(path, "w") as zf:
        for name in ("完了.png", "確認しました.png", "未登録の絵文字.png", "emoji/partyparrot.gif"):
            zf.writestr(_NoUtf8FlagInfo(name), _png(64, 64))
    with zipfile.ZipFile(path) as zf:
        assert all(not info.flag_bits & 0x800 for info in zf.infolist())
    return path


async def _setup(db: AsyncSession) -> dict[str, User]:
    admin = await make_user(db, "admin", role="admin")
    await make_user(db, "tana")
    db.add(
        CustomEmoji(
            id=uuid7(),
            name="kakunin",
            created_by=admin.id,
            content_type="image/png",
            size_bytes=10,
            width=16,
            height=16,
            storage_key="emoji/existing",
        )
    )
    await db.commit()
    return {u.username: u for u in (await db.execute(select(User))).scalars().all()}


BOT_AS = {"suzuki": "suzu", "tanaka": "@tana", "sato": "new:佐藤 さん:guest"}
RENAMES = {"完了": "kanryo", "確認しました": "kakunin"}


async def _run(
    app: FastAPI,
    db: AsyncSession,
    path: Path,
    emoji: Path | None,
    *,
    bot_as: dict[str, str] | None = None,
    people_only: bool = False,
) -> Report:
    return await import_slack(
        db,
        path,
        files=FileSource(),
        options=Options(
            emoji_dir=emoji,
            bot_as=bot_as if bot_as is not None else BOT_AS,
            emoji_renames=RENAMES,
        ),
        user_map={},
        actor_username="admin",
        blobs=app.state.blobs,
        settings=app.state.settings,
        dry_run=False,
        people_only=people_only,
    )


async def _users(db: AsyncSession) -> dict[str, User]:
    db.expire_all()
    return {u.username: u for u in (await db.execute(select(User))).scalars().all()}


async def _messages(db: AsyncSession) -> list[Message]:
    return list((await db.execute(select(Message).order_by(Message.seq))).scalars().all())


async def test_bridge_bots_become_people_and_join_lines_are_left_out(
    app: FastAPI, db: AsyncSession, tmp_path: Path
) -> None:
    await _setup(db)
    path = write_zip(tmp_path / "lab.zip", bridge_export())

    report = await _run(app, db, path, emoji_zip(tmp_path / "emoji.zip"))

    users = await _users(db)
    suzu, tana, sato = users["suzu"], users["tana"], users["sato"]
    # suzu (a Slack person with no posts of their own) is made for the bridge's posts
    assert suzu.display_name == "Suzuki S" and not suzu.is_active and suzu.role == "member"
    assert sato.display_name == "佐藤 さん" and sato.role == "guest"
    assert not sato.is_active
    assert users["ci-bot"].role == "bot"
    assert not {"suzuki", "tanaka", "bridge"} & set(users)  # no bot accounts for them

    msgs = await _messages(db)
    assert [(m.sender_id, m.body) for m in msgs[1:]] == [
        (suzu.id, "suzuki says hi"),
        (tana.id, "tana post"),
        (sato.id, "sato post"),
        (users["taro"].id, "taro がチャンネルに参加しました。"),
        (users["ci-bot"].id, "build ok"),
    ]
    assert report.counts["bridge_join_skipped"] == 3

    rows = {r.source_id: r for r in report.people_rows if r.action == "bot → person"}
    assert {k: (r.username, r.name) for k, r in rows.items()} == {
        "bot:suzuki": ("suzu", "suzuki (1 posts)"),
        "bot:Tanaka": ("tana", "Tanaka (1 posts)"),
        "bot:sato": ("sato", "sato (1 posts)"),
    }
    assert report.counts["people: bot → person"] == 3


async def test_renamed_emoji_keycaps_and_a_rerun(
    app: FastAPI, db: AsyncSession, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    await _setup(db)
    path = write_zip(tmp_path / "lab.zip", bridge_export())
    emoji = emoji_zip(tmp_path / "emoji.zip")

    report = await _run(app, db, path, emoji)

    first = (await _messages(db))[0]
    # the rename holds in the text too (not in code, which Slack shows as it is)
    assert first.body == "hello :kanryo: and `:完了:` in code :kakunin:"
    reactions = {
        r.emoji
        for r in (
            await db.execute(select(Reaction).where(Reaction.message_id == first.id))
        ).scalars()
    }
    # 1️⃣ #️⃣ start with an ASCII character, which a reaction cannot: kept by name
    assert reactions == {":kanryo:", ":kakunin:", ":one:", ":two:", "🔟", ":hash:"}
    assert report.dropped_emoji == {"未登録の絵文字": 1}  # not renamed: reported, as before
    assert report.unmatched_emoji == {"one": 1, "two": 1, "hash": 1}
    assert report.counts["reactions_keycap_as_name"] == 3
    emoji_rows = {e.name: e for e in (await db.execute(select(CustomEmoji))).scalars()}
    assert set(emoji_rows) == {"kakunin", "kanryo"}  # the existing one reused, not replaced
    assert emoji_rows["kakunin"].storage_key == "emoji/existing"
    assert await app.state.blobs.exists(emoji_rows["kanryo"].storage_key)
    assert report.emoji_lines == [
        ":確認しました: → :kakunin: already a custom emoji here: reused",
        ":完了: → :kanryo: created",
    ]
    assert report.counts["emoji_renamed"] == 1 and report.counts["emoji_reused"] == 1

    print_import_report(report)
    out = capsys.readouterr().out
    assert "bridge_join_skipped: 3" in out
    assert ":完了: → :kanryo: created" in out
    assert "未登録の絵文字 1 times  (give it a name with --emoji-rename FROM=TO)" in out
    assert ":one: 1 times  (a reaction cannot be 1️⃣" in out
    assert "bot → person" in out

    # a rerun adds nothing: no second account, emoji or post
    counts = (
        await db.scalar(select(func.count()).select_from(User)),
        await db.scalar(select(func.count()).select_from(CustomEmoji)),
        await db.scalar(select(func.count()).select_from(Message)),
        await db.scalar(select(func.count()).select_from(Reaction)),
    )
    again = await _run(app, db, path, emoji)
    assert (
        await db.scalar(select(func.count()).select_from(User)),
        await db.scalar(select(func.count()).select_from(CustomEmoji)),
        await db.scalar(select(func.count()).select_from(Message)),
        await db.scalar(select(func.count()).select_from(Reaction)),
    ) == counts
    assert again.counts["posts"] == 0 and again.counts["posts_skipped_existing"] == 6
    assert again.counts["users_created"] == 0
    assert ":完了: → :kanryo: imported before" in again.emoji_lines
    assert any("bot sato → @sato (--bot-as, previous run)" in p for p in again.people)


async def test_people_only_shows_the_bots_and_bad_targets_stop(
    app: FastAPI, db: AsyncSession, tmp_path: Path
) -> None:
    await _setup(db)
    path = write_zip(tmp_path / "lab.zip", bridge_export())

    report = await _run(app, db, path, None, people_only=True)
    assert {r.username for r in report.people_rows if r.action == "bot → person"} == {
        "suzu",
        "tana",
        "sato",
    }
    assert "sato" not in await _users(db)  # nothing written

    for bot_as, message in (
        ({"nobody": "suzu"}, "no bot post with that name"),
        ({"suzuki": "someone"}, "no such Slack user"),
        ({"suzuki": "@ghost"}, "no such Taylis user"),
        ({"suzuki": "new::guest"}, "needs a display name"),
    ):
        with pytest.raises(ImportFailed, match=message):
            await _run(app, db, path, None, bot_as=bot_as)
    assert await db.scalar(select(func.count()).select_from(Message)) == 0


def test_bridge_join_lines() -> None:
    for text in (
        "suzuki がチャンネルに参加しました。",
        "suzukiがチャンネルに参加しました",
        "@99x9999zさんがチャンネルに参加しました",
        "@99x9999z さんがチャンネルに参加しました。",
        "<@U0123ABC> がチャンネルに参加しました",
        "<@U0123ABC|suzu>さんがチャンネルに参加しました。\n",
    ):
        assert BRIDGE_JOIN.match(text), text
    for text in (
        "suzuki がチャンネルに参加しました。よろしく",
        "がチャンネルに参加しました",
        "a\nb がチャンネルに参加しました",
    ):
        assert not BRIDGE_JOIN.match(text), text


def test_emoji_images_from_a_folder_with_decomposed_names(tmp_path: Path) -> None:
    folder = tmp_path / "emoji"
    folder.mkdir()
    nfd = unicodedata.normalize("NFD", "ごめんなさい")  # as macOS writes it
    (folder / f"{nfd}.png").write_bytes(b"png")
    (folder / "parrot.gif").write_bytes(b"gif")
    (folder / "parrot.png").write_bytes(b"png-first")
    (folder / "notes.txt").write_text("x")
    images = EmojiImages(folder)
    assert len(images) == 2
    assert images.get("ごめんなさい") == b"png"
    assert images.get("parrot") == b"png-first"
    assert images.get("notes") is None


def test_rename_and_bot_options(tmp_path: Path) -> None:
    rename_file = tmp_path / "renames.txt"
    rename_file.write_text("# lab\n\n:完了:=kanryo\nあと一息 = ato_hitoiki\n", encoding="utf-8")
    assert parse_emoji_renames(["確認済=kakunin_zumi"], [str(rename_file)]) == {
        "確認済": "kakunin_zumi",
        "完了": "kanryo",
        "あと一息": "ato_hitoiki",
    }
    with pytest.raises(ValueError, match="not a custom emoji name"):
        parse_emoji_renames(["完了=完了"])
    with pytest.raises(ValueError, match="renamed twice"):
        parse_emoji_renames(["完了=a1", "完了=b2"])
    with pytest.raises(ValueError, match="use FROM=TO"):
        parse_emoji_renames(["完了"])
    # the lab's file in the repo is all valid names
    lab = parse_emoji_renames([], [str(REPO / "infra/slack-import/kano-lab.emoji-rename.txt")])
    assert len(lab) == 17 and lab["確認しました"] == "kakunin_shimashita"

    assert parse_bot_as(["Suzuki=U02", "sato=new:佐藤:guest"]) == {
        "suzuki": "U02",
        "sato": "new:佐藤:guest",
    }
    with pytest.raises(ValueError, match="mapped twice"):
        parse_bot_as(["a=x", "A=y"])
    with pytest.raises(ValueError, match="BOTNAME=TARGET"):
        parse_bot_as(["suzuki="])

    base = ["import-slack", str(tmp_path / "x.zip"), "--actor", "admin"]
    assert main([*base, "--bot-as", "nothing"]) == 1
    assert main([*base, "--emoji-rename-file", str(tmp_path / "missing.txt")]) == 1
