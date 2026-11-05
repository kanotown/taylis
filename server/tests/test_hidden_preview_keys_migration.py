"""0132 (2026-11-05): a link card removed under the clients' old reading of links stays removed
under the new one (apps/shared/link-cards.json legacy_keys). The stored key of the old reading of a
link becomes that link's key now, and the message takes a new updated_seq so every client syncs it
again. The test migrates its worker's database down and back up (test_review_v082_migrations.py)."""

import argparse
import importlib.util
import json
import os
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

from alembic import command
from alembic.config import Config
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User
from tests.conftest import SERVER_DIR, _run_in_thread
from tests.helpers import make_user

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = json.loads((ROOT / "apps" / "shared" / "link-cards.json").read_text())


def _migration() -> Any:
    path = SERVER_DIR / "migrations" / "versions" / "0132_hidden_preview_keys.py"
    spec = importlib.util.spec_from_file_location("migration_0132", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _config(database_url: str) -> Config:
    cfg = Config(str(SERVER_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(SERVER_DIR / "migrations"))
    cfg.cmd_opts = argparse.Namespace(x=[])
    os.environ["DATABASE_URL"] = database_url
    return cfg


def test_the_old_keys_become_the_keys_of_the_same_links() -> None:
    migrated_keys = _migration().migrated_keys
    assert len(FIXTURE["legacy_keys"]) >= 4
    for case in FIXTURE["legacy_keys"]:
        assert migrated_keys(case["body"], case["stored"]) == case["migrated"], case
    # Keys that are right already stay as they are, in their order.
    assert migrated_keys(
        "https://a.example/ https://b.example/", ["https://b.example/", "https://a.example/"]
    ) == [
        "https://b.example/",
        "https://a.example/",
    ]


async def test_0132_moves_the_stored_keys_and_bumps_the_rows(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    migrated_database: str,
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    channel = (await client.post("/api/v1/channels", json={"name": "keys"})).json()["id"]

    async def post(body: str) -> str:
        response = await client.post(
            f"/api/v1/channels/{channel}/messages",
            json={"client_msg_id": str(uuid.uuid4()), "body": body},
        )
        assert response.status_code == 201, response.text
        return str(response.json()["id"])

    cases = FIXTURE["legacy_keys"]
    ids = [await post(case["body"]) for case in cases]
    untouched = await post("https://plain.example/ nothing removed")
    async with app.state.db.engine.begin() as conn:
        for message_id, case in zip(ids, cases, strict=True):
            await conn.execute(
                text("UPDATE messages SET hidden_previews = :keys WHERE id = :id"),
                {"keys": case["stored"], "id": uuid.UUID(message_id)},
            )

    async def rows() -> dict[str, tuple[list[str], int]]:
        async with app.state.db.engine.connect() as conn:
            found = (
                await conn.execute(
                    text(
                        "SELECT id, hidden_previews, updated_seq FROM messages "
                        "WHERE channel_id = :c"
                    ),
                    {"c": uuid.UUID(channel)},
                )
            ).all()
        return {str(r[0]): (list(r[1]), int(r[2])) for r in found}

    async def last_seq() -> int:
        async with app.state.db.engine.connect() as conn:
            return int(
                (
                    await conn.execute(
                        text("SELECT last_seq FROM channels WHERE id = :c"),
                        {"c": uuid.UUID(channel)},
                    )
                ).scalar_one()
            )

    before = await rows()
    seq_before = await last_seq()
    await db.close()
    try:
        _run_in_thread(lambda: command.downgrade(_config(migrated_database), "0131"))
        _run_in_thread(lambda: command.upgrade(_config(migrated_database), "head"))
        await app.state.db.engine.dispose()
        after = await rows()
        changed = 0
        for message_id, case in zip(ids, cases, strict=True):
            keys, updated_seq = after[message_id]
            assert keys == case["migrated"], case
            if case["migrated"] != case["stored"]:
                changed += 1
                assert updated_seq > seq_before  # synced again by every client (delta sync)
            else:
                assert updated_seq == before[message_id][1]
        assert after[untouched] == before[untouched]
        assert await last_seq() == seq_before + changed
        # The server reads the message's cards as removed under their new keys.
        response = await client.get(f"/api/v1/messages/{ids[0]}")
        assert response.json()["hidden_previews"] == cases[0]["migrated"]
    finally:
        _run_in_thread(lambda: command.upgrade(_config(migrated_database), "head"))
        await app.state.db.engine.dispose()
