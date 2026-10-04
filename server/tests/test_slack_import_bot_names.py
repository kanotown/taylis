"""M98: a Slack bot that posted under several usernames (the Slack RSS app) is not named after
its first post; ``--bot-name`` names a bot outright."""

from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.cli import parse_bot_names
from app.modules.importer.core import ImportFailed, Report
from app.modules.importer.slack_import import FileSource, Options, import_slack, shared_bot_name
from app.modules.messages.models import Message
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_slack_import import DAY1, _user, ts, write_zip


def _export() -> dict[str, Any]:
    rss = [
        {
            "type": "message",
            "subtype": "bot_message",
            "bot_id": "BRSS",
            "username": f"週報 - {who}の週報",
            "text": f"<https://{n}.example.com/1|第{n}週>",
            "ts": ts(DAY1 + n),
        }
        for n, who in ((1, "中村"), (2, "田中"), (3, "中村"), (4, "佐藤"))
    ]
    hook = [
        {
            "type": "message",
            "subtype": "bot_message",
            "bot_id": "BHOOK",
            "username": "GitHub",
            "bot_profile": {"id": "BHOOK", "name": "incoming-webhook"},
            "text": f"build {n}",
            "ts": ts(DAY1 + 100 + n),
        }
        for n in range(2)
    ]
    return {
        "users.json": [_user("U1", "taro")],
        "channels.json": [
            {"id": "C1", "name": "weekly-rss", "created": DAY1 - 10, "members": ["U1"]},
            {"id": "C2", "name": "dev", "created": DAY1 - 10, "members": ["U1"]},
        ],
        "weekly-rss/2024-05-01.json": rss,
        "dev/2024-05-01.json": hook,
    }


async def _run(
    app: FastAPI, db: AsyncSession, path: Path, bot_names: dict[str, str] | None = None
) -> Report:
    return await import_slack(
        db,
        path,
        files=FileSource(),
        options=Options(bot_names=bot_names or {}),
        user_map={},
        actor_username="admin",
        blobs=app.state.blobs,
        settings=app.state.settings,
        dry_run=False,
    )


async def _senders(db: AsyncSession) -> set[str]:
    rows = await db.execute(
        select(User.display_name).join(Message, Message.sender_id == User.id).distinct()
    )
    return set(rows.scalars().all())


def test_shared_bot_name_and_the_option() -> None:
    assert shared_bot_name(["週報 - 中村の週報", "週報 - 田中の週報"]) == "週報"
    assert shared_bot_name(["Alpha", "Beta"]) is None
    assert parse_bot_names(["BRSS=週報RSS", " 週報 - 中村の週報 = x "]) == {
        "brss": "週報RSS",
        "週報 - 中村の週報": "x",
    }
    with pytest.raises(ValueError):
        parse_bot_names(["brss=a", "BRSS=b"])
    with pytest.raises(ValueError):
        parse_bot_names(["brss="])


async def test_a_bot_with_many_usernames_is_named_by_what_they_share(
    app: FastAPI, db: AsyncSession, tmp_path: Path
) -> None:
    await make_user(db, "admin", role="admin")
    path = write_zip(tmp_path / "e.zip", _export())
    report = await _run(app, db, path)
    # One bot per bot_id; the RSS one is not 「週報 - 中村の週報」, the webhook keeps its username.
    assert await _senders(db) == {"週報", "GitHub"}
    warned = [w for w in report.warnings if w.startswith("bot BRSS")]
    assert len(warned) == 1
    assert "3 種類の名前" in warned[0] and "「週報 - 佐藤の週報」" in warned[0]
    assert "--bot-name BRSS=" in warned[0]


async def test_bot_name_option(app: FastAPI, db: AsyncSession, tmp_path: Path) -> None:
    await make_user(db, "admin", role="admin")
    path = write_zip(tmp_path / "e.zip", _export())
    with pytest.raises(ImportFailed, match="--bot-name nobody"):
        await _run(app, db, path, {"nobody": "x"})
    report = await _run(app, db, path, {"brss": "週報RSS", "github": "GitHub Actions"})
    assert await _senders(db) == {"週報RSS", "GitHub Actions"}
    assert not [w for w in report.warnings if w.startswith("bot ")]
