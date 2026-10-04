"""M102 (docs/EMOJI.md §8): preset emoji packs from a folder on the server."""

import io
import json
import unicodedata
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import func, select, text

from app.cli import build_parser
from app.core.settings import Settings
from app.events.models import OutboxEvent
from app.modules.attachments.blobstore import MemoryBlobStore
from app.modules.audit.models import AuditLog
from app.modules.emoji import presets
from app.modules.emoji.models import CustomEmoji, EmojiPack
from app.modules.users.models import User
from tests.helpers import make_user


def _png(color: tuple[int, ...] = (255, 0, 0, 255), size: tuple[int, int] = (180, 180)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGBA", size, color).save(buffer, "PNG")
    return buffer.getvalue()


ITEMS: list[dict[str, Any]] = [
    {"file": "001_通常.png", "shortcode": "hp-plain", "label": "通常", "keywords": ["真顔"]},
    {
        "file": "032_おじぎ.png",
        "shortcode": "hp-bow",
        "label": "おじぎ",
        "keywords": ["ありがとう"],
    },
]


def _write_pack(
    root: Path,
    folder: str,
    *,
    name: str = "はんぺん",
    items: list[dict[str, Any]] | None = None,
    colors: dict[str, tuple[int, ...]] | None = None,
) -> Path:
    path = root / folder
    path.mkdir(parents=True, exist_ok=True)
    entries = ITEMS if items is None else items
    manifest = {"name": name, "tab": "tab.png", "items": entries}
    (path / "pack.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    (path / "tab.png").write_bytes(_png((0, 0, 255, 255), (96, 74)))
    (path / "タグ案.md").write_text("# notes", encoding="utf-8")
    for entry in entries:
        # macOS hands out decomposed names (NFD), and scp keeps them so on the server.
        disk_name = unicodedata.normalize("NFD", entry["file"])
        color = (colors or {}).get(entry["shortcode"], (255, 0, 0, 255))
        (path / disk_name).write_bytes(_png(color))
    return path


async def _run(
    app: FastAPI, root: Path, settings: Settings, restore: tuple[str, ...] = ()
) -> presets.PresetReport:
    async with app.state.db.session_factory() as session:
        return await presets.import_presets(
            session, root, settings, app.state.blobs, restore=restore
        )


async def _emoji(app: FastAPI) -> dict[str, CustomEmoji]:
    async with app.state.db.session_factory() as session:
        rows = (await session.execute(select(CustomEmoji))).scalars().all()
        return {row.name: row for row in rows}


async def _packs(app: FastAPI) -> list[EmojiPack]:
    async with app.state.db.session_factory() as session:
        return list((await session.execute(select(EmojiPack))).scalars().all())


async def _count(app: FastAPI, model: Any) -> int:
    async with app.state.db.session_factory() as session:
        return int((await session.execute(select(func.count()).select_from(model))).scalar_one())


async def test_import_is_idempotent_and_follows_the_manifest(
    app: FastAPI, tmp_path: Path, test_settings: Settings
) -> None:
    async with app.state.db.session_factory() as session:
        await make_user(session, "admin", role="admin")
    blobs: MemoryBlobStore = app.state.blobs
    _write_pack(tmp_path, "Hanpen")
    (tmp_path / "notes").mkdir()  # no pack.json: not a pack
    (tmp_path / "REVIEW.md").write_text("x")

    report = await _run(app, tmp_path, test_settings)
    assert list(report.changed) == ["Hanpen"] and not report.failed, report.summary()
    [pack] = await _packs(app)
    assert pack.name == "はんぺん" and pack.preset_key == "Hanpen" and pack.tab_storage_key
    emoji = await _emoji(app)
    assert set(emoji) == {"hp-plain", "hp-bow"}
    assert emoji["hp-bow"].label == "おじぎ" and emoji["hp-bow"].position == 1
    assert emoji["hp-bow"].pack_id == pack.id and emoji["hp-bow"].preset_key == "Hanpen"
    async with app.state.db.session_factory() as session:
        [entry] = (await session.execute(select(AuditLog))).scalars().all()
    assert entry.action == "emoji_pack.preset" and entry.actor_id is None
    assert entry.details["created"] == 2
    events = await _count(app, OutboxEvent)
    objects = len(blobs.objects)

    # Again: nothing changes, nothing is written.
    report = await _run(app, tmp_path, test_settings)
    assert report.unchanged == ["Hanpen"] and not report.changed
    assert await _count(app, OutboxEvent) == events
    assert await _count(app, AuditLog) == 1
    assert len(blobs.objects) == objects

    # A changed manifest (label, order, a new item) and a changed image apply; the rest stays.
    items = [
        {**ITEMS[1], "label": "ぺこり"},
        ITEMS[0],
        {"file": "040_ねる.png", "shortcode": "hp-sleep", "label": "ねる"},
    ]
    old_key = emoji["hp-plain"].storage_key
    bow_key = emoji["hp-bow"].storage_key
    _write_pack(tmp_path, "Hanpen", name="改名", items=items, colors={"hp-plain": (0, 255, 0, 255)})
    report = await _run(app, tmp_path, test_settings)
    assert "1 added" in report.changed["Hanpen"] and "1 images replaced" in report.changed["Hanpen"]
    emoji = await _emoji(app)
    assert emoji["hp-bow"].label == "ぺこり" and emoji["hp-bow"].position == 0
    assert emoji["hp-bow"].storage_key == bow_key
    assert emoji["hp-plain"].position == 1 and emoji["hp-plain"].storage_key != old_key
    assert old_key not in blobs.objects and emoji["hp-plain"].storage_key in blobs.objects
    assert emoji["hp-sleep"].pack_id == pack.id
    [pack] = await _packs(app)
    assert pack.name == "はんぺん"  # the manifest's name only names a new pack


async def test_deleted_presets_stay_deleted(
    app: FastAPI,
    client: AsyncClient,
    as_user: Callable[[User], None],
    tmp_path: Path,
    test_settings: Settings,
) -> None:
    async with app.state.db.session_factory() as session:
        admin = await make_user(session, "admin", role="admin")
    as_user(admin)
    _write_pack(tmp_path, "Hanpen")
    await _run(app, tmp_path, test_settings)
    emoji = await _emoji(app)

    assert (await client.delete(f"/api/v1/emoji/{emoji['hp-bow'].id}")).status_code == 204
    report = await _run(app, tmp_path, test_settings)
    assert report.unchanged == ["Hanpen"]
    assert set(await _emoji(app)) == {"hp-plain"}

    [pack] = await _packs(app)
    assert (await client.delete(f"/api/v1/emoji/packs/{pack.id}")).status_code == 204
    report = await _run(app, tmp_path, test_settings)
    assert report.removed == ["Hanpen"] and not report.changed
    assert await _packs(app) == []
    assert (await _emoji(app))["hp-plain"].pack_id is None  # kept, ungrouped

    # The operator brings it back on purpose: the pack again, its emoji rejoin.
    report = await _run(app, tmp_path, test_settings, restore=("Hanpen",))
    assert "new pack" in report.changed["Hanpen"], report.summary()
    [pack] = await _packs(app)
    emoji = await _emoji(app)
    assert {name: row.pack_id for name, row in emoji.items()} == {
        "hp-plain": pack.id,
        "hp-bow": pack.id,
    }


async def test_bad_folders_are_skipped(
    app: FastAPI,
    client: AsyncClient,
    as_user: Callable[[User], None],
    tmp_path: Path,
    test_settings: Settings,
) -> None:
    async with app.state.db.session_factory() as session:
        admin = await make_user(session, "admin", role="admin")
    as_user(admin)
    blobs: MemoryBlobStore = app.state.blobs
    bad = tmp_path / "Bad"
    bad.mkdir()
    (bad / "pack.json").write_text("{not json")
    missing = _write_pack(
        tmp_path,
        "Missing",
        name="欠け",
        items=[
            {"file": "a.png", "shortcode": "ms-a"},
            {"file": "b.png", "shortcode": "ms-b"},
        ],
    )
    (missing / "b.png").unlink()
    broken = _write_pack(
        tmp_path, "Broken", name="壊れ", items=[{"file": "x.png", "shortcode": "br-x"}]
    )
    (broken / "x.png").write_bytes(b"not an image")
    hidden = _write_pack(
        tmp_path, ".hidden", name="隠し", items=[{"file": "h.png", "shortcode": "hd-h"}]
    )
    assert hidden.exists()
    # A shortcode someone already took by hand: that one emoji is skipped, not the pack.
    taken = await client.post("/api/v1/emoji/text", json={"name": "hp-plain", "label": "先に"})
    assert taken.status_code == 201
    _write_pack(tmp_path, "Good")

    report = await _run(app, tmp_path, test_settings)
    assert list(report.changed) == ["Good"]
    assert set(report.failed) == {"Bad", "Missing", "Broken"}
    assert "b.png" in report.failed["Missing"]
    assert any("hp-plain" in warning for warning in report.warnings)
    emoji = await _emoji(app)
    assert set(emoji) == {"hp-plain", "hp-bow"}
    assert emoji["hp-plain"].kind == "text" and emoji["hp-plain"].preset_key is None
    assert [pack.name for pack in await _packs(app)] == ["はんぺん"]
    # The failed folder's tab icon and image were removed from the store again.
    keys = {row.storage_key for row in emoji.values() if row.storage_key}
    keys |= {pack.tab_storage_key or "" for pack in await _packs(app)}
    assert set(blobs.objects) == keys

    # Startup never raises, even for a folder that does not exist.
    async with app.state.db.session_factory() as session:
        missing_dir = test_settings.model_copy(update={"emoji_presets_dir": str(tmp_path / "x")})
        await presets.run_at_startup(session, missing_dir, blobs)


async def test_a_pack_imported_by_hand_is_adopted(
    app: FastAPI,
    client: AsyncClient,
    as_user: Callable[[User], None],
    tmp_path: Path,
    test_settings: Settings,
) -> None:
    async with app.state.db.session_factory() as session:
        admin = await make_user(session, "admin", role="admin")
    as_user(admin)
    path = _write_pack(tmp_path, "Hanpen")
    files = [
        ("files", (name.name, name.read_bytes(), "application/octet-stream"))
        for name in path.iterdir()
    ]
    assert (await client.post("/api/v1/emoji/packs/import", files=files)).status_code == 200
    before = await _emoji(app)

    report = await _run(app, tmp_path, test_settings)
    assert report.changed["Hanpen"].startswith("adopted"), report.summary()
    [pack] = await _packs(app)
    assert pack.preset_key == "Hanpen"
    after = await _emoji(app)
    assert {n: r.storage_key for n, r in after.items()} == {
        n: r.storage_key for n, r in before.items()
    }
    assert all(row.preset_key == "Hanpen" and row.preset_hash for row in after.values())
    assert (await _run(app, tmp_path, test_settings)).unchanged == ["Hanpen"]


async def test_one_process_at_a_time_and_an_owner_is_needed(
    app: FastAPI, tmp_path: Path, test_settings: Settings
) -> None:
    _write_pack(tmp_path, "Hanpen")
    report = await _run(app, tmp_path, test_settings)
    assert report.no_admin and await _packs(app) == []

    async with app.state.db.session_factory() as session:
        await make_user(session, "admin", role="admin")
    async with app.state.db.engine.connect() as other:
        transaction = await other.begin()
        await other.execute(text("SELECT pg_advisory_xact_lock(hashtext('emoji_presets'))"))
        report = await _run(app, tmp_path, test_settings)
        assert report.busy and await _packs(app) == []
        await transaction.rollback()
    report = await _run(app, tmp_path, test_settings)
    assert list(report.changed) == ["Hanpen"]


def test_cli_command() -> None:
    args = build_parser().parse_args(
        ["import-emoji-presets", "--dir", "/presets", "--restore", "Hanpen", "--restore", "X"]
    )
    assert args.dir == "/presets" and args.restore == ["Hanpen", "X"]
