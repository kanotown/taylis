"""M100 (docs/EMOJI.md): text emoji, labels and keywords, aspect ratio, packs and pack import."""

import io
import json
import zipfile
from collections.abc import Callable
from pathlib import Path
from typing import Any, get_args

from httpx import AsyncClient
from PIL import Image
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.audit.models import AuditLog
from app.modules.emoji.schemas import TextEmojiColor
from app.modules.users.models import User
from tests.helpers import make_user

SHARED = Path(__file__).resolve().parents[2] / "apps" / "shared" / "text-emoji.json"


def _png(width: int = 64, height: int = 64, color: tuple[int, ...] = (255, 0, 0, 255)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGBA", (width, height), color).save(buffer, "PNG")
    return buffer.getvalue()


def _manifest(name: str = "はんぺん", items: list[dict[str, Any]] | None = None) -> bytes:
    body = {
        "name": name,
        "tab": "tab.png",
        "items": items
        if items is not None
        else [
            {
                "file": "001_通常.png",
                "shortcode": "hp-plain",
                "label": "通常",
                "keywords": ["真顔"],
            },
            {
                "file": "032_おじぎ.png",
                "shortcode": "hp-bow",
                "label": "おじぎ",
                "keywords": ["ありがとう", "よろしく"],
            },
        ],
    }
    return json.dumps(body, ensure_ascii=False).encode()


def _folder(manifest: bytes, extra: dict[str, bytes] | None = None) -> list[Any]:
    files = {
        "pack.json": manifest,
        "tab.png": _png(96, 74),
        "001_通常.png": _png(180, 180),
        # macOS hands out decomposed names (NFD): ぎ as き + ゛.
        "032_おじぎ.png": _png(180, 180),
        "タグ案.md": b"# notes",
        **(extra or {}),
    }
    return [("files", (name, data, "application/octet-stream")) for name, data in files.items()]


async def _events(db: AsyncSession, kind: str) -> list[OutboxEvent]:
    stmt = select(OutboxEvent).where(OutboxEvent.event_type == kind).order_by(OutboxEvent.id)
    return list((await db.execute(stmt)).scalars().all())


def test_palette_matches_shared_file() -> None:
    shared = json.loads(SHARED.read_text(encoding="utf-8"))
    assert list(shared["colors"]) == list(get_args(TextEmojiColor))
    assert shared["label_max"] == 12


async def test_text_emoji_and_editing(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    guest = await make_user(db, "guest", role="guest")
    as_user(alice)
    created = await client.post(
        "/api/v1/emoji/text",
        json={
            "name": "kakunin",
            "label": " 確認\nしました ",
            "color": "green",
            "keywords": ["確認", "OK", "確認", " "],
        },
    )
    assert created.status_code == 201, created.text
    emoji = created.json()
    assert emoji["kind"] == "text" and emoji["label"] == "確認 しました"
    assert emoji["color"] == "green" and emoji["keywords"] == ["確認", "ok"]
    assert emoji["width"] == 0 and emoji["content_type"] == ""
    # No image behind a text emoji.
    assert (await client.get(f"/api/v1/emoji/{emoji['id']}/image")).status_code == 404
    for bad in (
        {"name": "toolong", "label": "ありがとうございました!!"},  # 13
        {"name": "empty", "label": "   "},
        {"name": "ctl", "label": "a\x00b"},
        {"name": "color", "label": "ok", "color": "black"},
        {"name": "日本語", "label": "ok"},
    ):
        response = await client.post("/api/v1/emoji/text", json=bad)
        assert response.status_code in (400, 422), (bad, response.text)
    assert (
        await client.post("/api/v1/emoji/text", json={"name": "kakunin", "label": "x"})
    ).status_code == 409
    many = {"name": "many", "label": "x", "keywords": [f"k{i}" for i in range(21)]}
    assert (await client.post("/api/v1/emoji/text", json=many)).status_code == 400

    # The creator edits label, colour and keywords; others cannot; the pack is admin-only.
    patched = await client.patch(
        f"/api/v1/emoji/{emoji['id']}",
        json={"label": "確認済み", "color": None, "keywords": ["かくにん"]},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["label"] == "確認済み" and patched.json()["color"] is None
    assert (
        await client.patch(f"/api/v1/emoji/{emoji['id']}", json={"label": None})
    ).status_code == 400
    assert (
        await client.patch(f"/api/v1/emoji/{emoji['id']}", json={"position": 3})
    ).status_code == 403
    as_user(bob)
    assert (
        await client.patch(f"/api/v1/emoji/{emoji['id']}", json={"keywords": []})
    ).status_code == 403
    as_user(guest)
    assert (
        await client.post("/api/v1/emoji/text", json={"name": "g", "label": "x"})
    ).status_code == 403

    events = await _events(db, "emoji.updated")
    assert [e.payload["emoji"]["label"] for e in events] == ["確認 しました", "確認済み"]
    booted = (await client.get("/api/v1/sync/bootstrap")).json()
    assert booted["custom_emoji"][0]["kind"] == "text"
    assert booted["emoji_packs"] == []


async def test_image_upload_keeps_size_label_and_keywords(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    response = await client.post(
        "/api/v1/emoji",
        data={"name": "wide", "label": "横長", "keywords": ["よこ", "Wide"]},
        files={"file": ("w.png", _png(300, 100), "image/png")},
    )
    assert response.status_code == 201, response.text
    wide = response.json()
    # Clients draw it 3:1 from the stored size (docs/EMOJI.md §2).
    assert (wide["width"], wide["height"], wide["kind"]) == (300, 100, "image")
    assert wide["label"] == "横長" and wide["keywords"] == ["よこ", "wide"]
    assert wide["pack_id"] is None


async def test_packs_crud_and_permissions(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    admin = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(alice)
    assert (await client.post("/api/v1/emoji/packs", json={"name": "x"})).status_code == 403
    files = _folder(_manifest())
    assert (await client.post("/api/v1/emoji/packs/import", files=files)).status_code == 403
    as_user(admin)
    first = (await client.post("/api/v1/emoji/packs", json={"name": " ちくわ "})).json()
    second = (await client.post("/api/v1/emoji/packs", json={"name": "はんぺん"})).json()
    assert first["name"] == "ちくわ" and (first["position"], second["position"]) == (0, 1)
    assert first["tab_version"] is None
    assert (await client.post("/api/v1/emoji/packs", json={"name": "ちくわ"})).status_code == 409
    assert (await client.post("/api/v1/emoji/packs", json={"name": ""})).status_code == 400
    moved = await client.patch(f"/api/v1/emoji/packs/{first['id']}", json={"position": 5})
    assert moved.status_code == 200
    assert [p["name"] for p in (await client.get("/api/v1/emoji/packs")).json()] == [
        "はんぺん",
        "ちくわ",
    ]
    clash = await client.patch(f"/api/v1/emoji/packs/{first['id']}", json={"name": "はんぺん"})
    assert clash.status_code == 409

    # An admin moves an emoji into a pack; deleting the pack keeps the emoji, ungrouped.
    text = (await client.post("/api/v1/emoji/text", json={"name": "ok", "label": "OK"})).json()
    joined = await client.patch(
        f"/api/v1/emoji/{text['id']}", json={"pack_id": first["id"], "position": 2}
    )
    assert joined.json()["pack_id"] == first["id"]
    assert (
        await client.patch(
            f"/api/v1/emoji/{text['id']}",
            json={"pack_id": "00000000-0000-0000-0000-000000000000"},
        )
    ).status_code == 404
    assert (await client.delete(f"/api/v1/emoji/packs/{first['id']}")).status_code == 204
    assert (await client.get("/api/v1/emoji")).json()[0]["pack_id"] is None
    assert (await client.delete(f"/api/v1/emoji/packs/{first['id']}")).status_code == 404
    pack_events = await _events(db, "emoji_pack.updated")
    assert [e.payload["deleted"] for e in pack_events] == [False, False, False, True]
    assert pack_events[0].audience_type == "all"
    last_emoji = (await _events(db, "emoji.updated"))[-1]
    assert last_emoji.payload["emoji"]["pack_id"] is None
    actions = (await db.execute(select(AuditLog.action).order_by(AuditLog.id))).scalars().all()
    assert actions == [
        "emoji_pack.create",
        "emoji_pack.create",
        "emoji_pack.update",
        "emoji_pack.delete",
    ]


async def test_import_from_folder_is_idempotent(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    admin = await make_user(db, "root", role="admin")
    as_user(admin)
    response = await client.post("/api/v1/emoji/packs/import", files=_folder(_manifest()))
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["created"] == ["hp-plain", "hp-bow"]
    assert result["updated"] == [] and result["unchanged"] == []
    pack = result["pack"]
    assert pack["name"] == "はんぺん" and pack["tab_version"]
    tab = await client.get(f"/api/v1/emoji/packs/{pack['id']}/tab")
    assert tab.status_code == 200 and tab.headers["content-type"] == "image/png"
    listed = {e["name"]: e for e in (await client.get("/api/v1/emoji")).json()}
    assert listed["hp-bow"]["label"] == "おじぎ"
    assert listed["hp-bow"]["keywords"] == ["ありがとう", "よろしく"]
    assert listed["hp-bow"]["pack_id"] == pack["id"] and listed["hp-bow"]["position"] == 1
    assert (await client.get(f"/api/v1/emoji/{listed['hp-bow']['id']}/image")).status_code == 200

    # Again with one label changed and one item added: nothing doubles.
    items: list[dict[str, Any]] = [
        {"file": "001_通常.png", "shortcode": "hp-plain", "label": "通常", "keywords": ["真顔"]},
        {"file": "032_おじぎ.png", "shortcode": "hp-bow", "label": "ぺこり", "keywords": []},
        {"file": "040_悪魔.png", "shortcode": "hp-devil", "label": "悪魔"},
    ]
    again = await client.post(
        "/api/v1/emoji/packs/import",
        files=_folder(_manifest(items=items), {"040_悪魔.png": _png(120, 60)}),
    )
    assert again.status_code == 200, again.text
    body = again.json()
    assert (body["created"], body["updated"], body["unchanged"]) == (
        ["hp-devil"],
        ["hp-bow"],
        ["hp-plain"],
    )
    assert body["pack"]["id"] == pack["id"]
    assert body["pack"]["tab_version"] != pack["tab_version"]
    listed = {e["name"]: e for e in (await client.get("/api/v1/emoji")).json()}
    assert len(listed) == 3 and listed["hp-bow"]["label"] == "ぺこり"
    assert (listed["hp-devil"]["width"], listed["hp-devil"]["height"]) == (120, 60)
    booted = (await client.get("/api/v1/sync/bootstrap")).json()
    assert [p["name"] for p in booted["emoji_packs"]] == ["はんぺん"]
    imports = (
        (await db.execute(select(AuditLog).where(AuditLog.action == "emoji_pack.import")))
        .scalars()
        .all()
    )
    assert [(a.details["created"], a.details["updated"]) for a in imports] == [(2, 0), (1, 1)]


async def test_import_from_zip_and_failures(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    admin = await make_user(db, "root", role="admin")
    as_user(admin)

    def zipped(files: dict[str, bytes]) -> list[Any]:
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            for name, data in files.items():
                archive.writestr(f"Hanpen/{name}", data)
            archive.writestr("__MACOSX/Hanpen/._001_通常.png", b"junk")
        return [("archive", ("hanpen.zip", buffer.getvalue(), "application/zip"))]

    good = {
        "pack.json": _manifest(),
        "tab.png": _png(96, 74),
        "001_通常.png": _png(),
        "032_おじぎ.png": _png(),
    }
    response = await client.post("/api/v1/emoji/packs/import", files=zipped(good))
    assert response.status_code == 200, response.text
    assert response.json()["created"] == ["hp-plain", "hp-bow"]

    # All or nothing: a missing file, a bad image, a shortcode used outside the pack.
    missing = {k: v for k, v in good.items() if k != "001_通常.png"}
    other = _manifest(name="別のセット")
    fresh = [{"file": "001_通常.png", "shortcode": "x-plain"}]
    cases = [
        (zipped({**good, "pack.json": _manifest("x", fresh), "001_通常.png": b"nope"}), 400),
        (zipped({**missing, "pack.json": _manifest("y", fresh)}), 400),
        (zipped({**good, "pack.json": other}), 409),
        (zipped({k: v for k, v in good.items() if k != "pack.json"}), 400),
        (zipped({**good, "pack.json": b"{not json"}), 400),
        ([("archive", ("x.zip", b"not a zip", "application/zip"))], 400),
        (
            zipped(
                {
                    **good,
                    "pack.json": _manifest(
                        name="z",
                        items=[
                            {"file": "001_通常.png", "shortcode": "Bad Name"},
                        ],
                    ),
                }
            ),
            400,
        ),
    ]
    for files, status in cases:
        failed = await client.post("/api/v1/emoji/packs/import", files=files)
        assert failed.status_code == status, failed.text
    conflict = await client.post(
        "/api/v1/emoji/packs/import", files=zipped({**good, "pack.json": other})
    )
    assert conflict.json()["error"]["details"]["shortcodes"] == ["hp-bow", "hp-plain"]
    assert len((await client.get("/api/v1/emoji/packs")).json()) == 1
    assert len((await client.get("/api/v1/emoji")).json()) == 2
