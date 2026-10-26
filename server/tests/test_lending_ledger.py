"""備品 L1 (M167, docs/LENDING.md §3-§5, §9, §10, §14): the settings and the switch, who may see
and keep the ledger, categories, items (control numbers unique among those not retired, the
status, deletion), photos (bind and read), the history's cursor, the bootstrap, events and the
audit."""

import io
import uuid
from collections.abc import Callable
from typing import Any

from fastapi import FastAPI
from httpx import AsyncClient, Response
from PIL import Image
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.attachments.models import Attachment
from app.modules.audit.models import AuditLog
from app.modules.lending.models import LendingItem, LendingLoan
from app.modules.users.models import User
from tests.helpers import make_user

API = "/api/v1"


def _png() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (16, 12), (1, 2, 3)).save(out, format="PNG")
    return out.getvalue()


async def _upload(client: AsyncClient, *, image: bool = True) -> str:
    file = ("x.png", _png(), "image/png") if image else ("x.txt", b"hello there", "text/plain")
    response = await client.post(f"{API}/attachments", files={"file": file})
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


def _loan(item_id: uuid.UUID, borrower_id: uuid.UUID) -> LendingLoan:
    today = utcnow().date()
    return LendingLoan(
        item_id=item_id,
        borrower_id=borrower_id,
        client_request_id=uuid.uuid4(),
        status="active",
        borrowed_at=utcnow(),
        due_on=today,
        original_due_on=today,
        purpose="test",
        permission_required=False,
    )


def _code(response: Response) -> str:
    code: str = response.json()["error"]["code"]
    return code


async def _ok(response: Response, status: int = 200) -> Any:
    assert response.status_code == status, response.text
    return response.json() if response.content else None


class Lab:
    """An administrator, a manager, a member, a keeper (a member on keeper_ids) and a guest."""

    def __init__(self, client: AsyncClient, as_user: Callable[[User], None]) -> None:
        self.client = client
        self.as_user = as_user

    async def setup(self, db: AsyncSession) -> None:
        self.admin = await make_user(db, "root", role="admin")
        self.manager = await make_user(db, "boss", role="manager")
        self.member = await make_user(db, "alice")
        self.keeper = await make_user(db, "kee")
        self.guest = await make_user(db, "visitor", role="guest")

    async def enable(self, **extra: Any) -> dict[str, Any]:
        self.as_user(self.admin)
        body = {"enabled": True, "keeper_ids": [str(self.keeper.id)], **extra}
        out: dict[str, Any] = await _ok(
            await self.client.patch(f"{API}/admin/lending/settings", json=body)
        )
        return out

    async def item(self, **fields: Any) -> dict[str, Any]:
        self.as_user(self.keeper)
        body = {"name": "カメラ A", **fields}
        out: dict[str, Any] = await _ok(
            await self.client.post(f"{API}/lending/items", json=body), 201
        )
        return out


async def _lab(db: AsyncSession, client: AsyncClient, as_user: Callable[[User], None]) -> Lab:
    lab = Lab(client, as_user)
    await lab.setup(db)
    return lab


# --- the switch and the settings -----------------------------------------------------------


async def test_off_by_default_and_settings(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    lab = await _lab(db, client, as_user)
    as_user(lab.member)
    settings = await _ok(await client.get(f"{API}/lending/settings"))
    assert settings == {
        "enabled": False,
        "keeper_ids": [],
        "default_max_days": 14,
        "max_extensions": 2,
        "keeper_overdue_days": 3,
        "notice_minute": 540,
        "tz": "Asia/Tokyo",
        "is_keeper": False,
        "updated_at": None,
    }
    off = await client.get(f"{API}/lending/items")
    assert off.status_code == 409 and _code(off) == "lending_disabled"
    assert (await _ok(await client.get(f"{API}/sync/bootstrap")))["lending"] is None
    as_user(lab.admin)
    # Even administrators build the ledger only once it is on.
    off = await client.post(f"{API}/lending/categories", json={"name": "PC"})
    assert off.status_code == 409 and _code(off) == "lending_disabled"
    assert (await _ok(await client.get(f"{API}/lending/settings")))["is_keeper"] is True

    as_user(lab.guest)
    denied = await client.get(f"{API}/lending/settings")
    assert denied.status_code == 403 and _code(denied) == "guest_restricted"

    out = await lab.enable(default_max_days=30, notice_minute=480, tz="UTC")
    assert out["enabled"] is True and out["keeper_ids"] == [str(lab.keeper.id)]
    assert (out["default_max_days"], out["notice_minute"], out["tz"]) == (30, 480, "UTC")
    as_user(lab.keeper)
    boot = (await _ok(await client.get(f"{API}/sync/bootstrap")))["lending"]
    assert boot["enabled"] is True and boot["is_keeper"] is True
    assert boot["my_active_count"] == 0 and boot["settings_updated_at"] is not None
    as_user(lab.guest)
    assert (await _ok(await client.get(f"{API}/sync/bootstrap")))["lending"] is None
    denied = await client.get(f"{API}/lending/items")
    assert denied.status_code == 403 and _code(denied) == "guest_restricted"

    audit = (
        (await db.execute(select(AuditLog).where(AuditLog.action == "lending_settings.updated")))
        .scalars()
        .all()
    )
    assert len(audit) == 1 and audit[0].details["keepers_added"] == [str(lab.keeper.id)]
    events = (
        (await db.execute(select(OutboxEvent).where(OutboxEvent.event_type == "lending.updated")))
        .scalars()
        .all()
    )
    assert [e.payload for e in events] == [{"item_ids": [], "categories": False, "settings": True}]
    assert all(e.audience_type == "all" for e in events)


async def test_settings_validation(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    lab = await _lab(db, client, as_user)
    bot = await make_user(db, "robot", role="bot")
    gone = await make_user(db, "gone")
    await db.execute(update(User).where(User.id == gone.id).values(deactivated_at=utcnow()))
    await db.commit()
    as_user(lab.admin)
    path = f"{API}/admin/lending/settings"
    unknown = uuid.uuid4()
    bad = await client.patch(
        path,
        json={"keeper_ids": [str(lab.member.id), str(lab.guest.id), str(bot.id), str(unknown)]},
    )
    assert bad.status_code == 400 and _code(bad) == "lending_keeper_invalid"
    assert set(bad.json()["error"]["details"]["user_ids"]) == {
        str(lab.guest.id),
        str(bot.id),
        str(unknown),
    }
    bad = await client.patch(path, json={"keeper_ids": [str(gone.id)]})
    assert bad.status_code == 400
    many = [str(uuid.uuid4()) for _ in range(21)]
    assert (await client.patch(path, json={"keeper_ids": many})).status_code == 422
    assert (await client.patch(path, json={"tz": "Mars/Base"})).status_code == 422
    assert (await client.patch(path, json={"default_max_days": 0})).status_code == 422
    assert (await client.patch(path, json={"max_extensions": 11})).status_code == 422
    assert (await client.patch(path, json={"keeper_overdue_days": 31})).status_code == 422
    assert (await client.patch(path, json={"notice_minute": 1440})).status_code == 422
    # Managers do not have lending.manage (docs/LENDING.md §15 Q1: administrators only).
    as_user(lab.manager)
    denied = await client.patch(path, json={"enabled": True})
    assert denied.status_code == 403 and _code(denied) == "admin_required"
    # The same values again: no audit row, no event.
    await lab.enable()
    await lab.enable()
    rows = (
        (await db.execute(select(AuditLog).where(AuditLog.action == "lending_settings.updated")))
        .scalars()
        .all()
    )
    assert len(rows) == 1


async def test_who_may_keep(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """§3.2: the ledger is every person's to see; only keepers and lending.manage change it. A
    keeper deactivated, or made a guest, is a keeper no more."""
    lab = await _lab(db, client, as_user)
    await lab.enable()
    made = await lab.item(code="CAM-02")
    item_path = f"{API}/lending/items/{made['id']}"
    writes: list[tuple[str, str, dict[str, Any] | None]] = [
        ("POST", f"{API}/lending/categories", {"name": "PC"}),
        ("POST", f"{API}/lending/items", {"name": "PC-03"}),
        ("PATCH", item_path, {"location": "棚"}),
        ("POST", f"{item_path}/status", {"status": "in_repair"}),
        ("DELETE", item_path, None),
    ]
    for user, allowed in (
        (lab.admin, True),
        (lab.keeper, True),
        (lab.manager, False),
        (lab.member, False),
    ):
        as_user(user)
        assert (await client.get(f"{API}/lending/items")).status_code == 200
        assert (await client.get(item_path)).status_code == 200
        assert (await client.get(f"{item_path}/history")).status_code == 200
        assert (await client.get(f"{API}/lending/categories")).status_code == 200
        if not allowed:
            for method, path, body in writes:
                response = await client.request(method, path, json=body)
                assert response.status_code == 403, (user.username, method, path)
                assert _code(response) == "lending_keeper_required"
    as_user(lab.guest)
    for method, path, body in [("GET", item_path, None), *writes]:
        response = await client.request(method, path, json=body)
        assert response.status_code == 403 and _code(response) == "guest_restricted"

    as_user(lab.keeper)
    for method, path, body in writes[:4]:
        assert (await client.request(method, path, json=body)).status_code in (200, 201)
    await db.execute(update(User).where(User.id == lab.keeper.id).values(role="guest"))
    await db.commit()
    await db.refresh(lab.keeper)
    as_user(lab.keeper)
    assert (await client.patch(item_path, json={"location": "x"})).status_code == 403
    await db.execute(
        update(User).where(User.id == lab.keeper.id).values(role="member", deactivated_at=utcnow())
    )
    await db.commit()
    await db.refresh(lab.keeper)
    as_user(lab.keeper)
    assert (await client.patch(item_path, json={"location": "x"})).status_code == 403


# --- categories ------------------------------------------------------------------------------


async def test_categories(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    lab = await _lab(db, client, as_user)
    await lab.enable()
    as_user(lab.keeper)
    path = f"{API}/lending/categories"
    pc = await _ok(
        await client.post(path, json={"name": " PC ", "requires_permission": True, "max_days": 30}),
        201,
    )
    assert (pc["name"], pc["position"], pc["requires_permission"], pc["max_days"]) == (
        "PC",
        0,
        True,
        30,
    )
    camera = await _ok(await client.post(path, json={"name": "カメラ"}), 201)
    book = await _ok(await client.post(path, json={"name": "本"}), 201)
    taken = await client.post(path, json={"name": "pc"})
    assert taken.status_code == 409 and _code(taken) == "lending_category_name_taken"
    assert taken.json()["error"]["details"]["existing_id"] == pc["id"]
    assert (await client.post(path, json={"name": "   "})).status_code == 422

    moved = await _ok(await client.patch(f"{path}/{book['id']}", json={"position": 0}))
    assert moved["position"] == 0
    listed = await _ok(await client.get(path))
    assert [c["name"] for c in listed] == ["本", "PC", "カメラ"]
    assert [c["position"] for c in listed] == [0, 1, 2]
    renamed = await client.patch(f"{path}/{camera['id']}", json={"name": "PC"})
    assert renamed.status_code == 409
    cleared = await _ok(await client.patch(f"{path}/{pc['id']}", json={"max_days": None}))
    assert cleared["max_days"] is None and cleared["requires_permission"] is True

    item = await lab.item(category_id=pc["id"])
    assert item["requires_permission"] is True and item["requires_permission_source"] == "category"
    assert item["max_days"] == 14 and item["max_days_source"] == "default"
    listed = await _ok(await client.get(path))
    assert {c["name"]: c["item_count"] for c in listed} == {"本": 0, "PC": 1, "カメラ": 0}
    in_use = await client.delete(f"{path}/{pc['id']}")
    assert in_use.status_code == 409 and _code(in_use) == "lending_category_in_use"
    assert in_use.json()["error"]["details"]["item_count"] == 1
    # A retired item keeps the category too.
    await _ok(
        await client.post(f"{API}/lending/items/{item['id']}/status", json={"status": "retired"})
    )
    assert (await client.delete(f"{path}/{pc['id']}")).status_code == 409
    await _ok(await client.delete(f"{API}/lending/items/{item['id']}"), 204)
    await _ok(await client.delete(f"{path}/{pc['id']}"), 204)
    missing = await client.delete(f"{path}/{pc['id']}")
    assert missing.status_code == 404 and _code(missing) == "lending_category_not_found"
    actions = (await db.execute(select(AuditLog.action))).scalars().all()
    assert "lending_category.created" in actions and "lending_category.deleted" in actions


async def test_category_limit(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    lab = await _lab(db, client, as_user)
    await lab.enable()
    as_user(lab.keeper)
    for i in range(50):
        await _ok(await client.post(f"{API}/lending/categories", json={"name": f"c{i}"}), 201)
    full = await client.post(f"{API}/lending/categories", json={"name": "one more"})
    assert full.status_code == 409 and _code(full) == "too_many_lending_categories"
    assert full.json()["error"]["details"]["limit"] == 50


# --- items -----------------------------------------------------------------------------------


async def test_items_effective_values_and_order(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    lab = await _lab(db, client, as_user)
    await lab.enable(default_max_days=10)
    as_user(lab.keeper)
    cat = await _ok(
        await client.post(
            f"{API}/lending/categories",
            json={"name": "PC", "requires_permission": True, "max_days": 30},
        ),
        201,
    )
    own = await lab.item(
        name="ノート PC",
        category_id=cat["id"],
        code=" PC-03 ",
        location="302 机",
        notes="充電器・ケース\r\nSD 64 GB",
        requires_permission=False,
        max_days=7,
    )
    assert own["code"] == "PC-03" and own["notes"] == "充電器・ケース\nSD 64 GB"
    assert (own["requires_permission"], own["requires_permission_source"]) == (False, "item")
    assert (own["max_days"], own["max_days_source"]) == (7, "item")
    assert own["status"] == "available" and own["loan"] is None and own["watching"] is False
    assert own["recent_loans"] == []
    inherited = await lab.item(name="デスクトップ", category_id=cat["id"])
    assert (inherited["requires_permission"], inherited["max_days"]) == (True, 30)
    plain = await lab.item(name="統計学入門")
    assert (plain["requires_permission"], plain["requires_permission_source"]) == (False, "default")
    assert (plain["max_days"], plain["max_days_source"]) == (10, "default")
    # null clears an item's own value: back to the category's.
    cleared = await _ok(
        await client.patch(
            f"{API}/lending/items/{own['id']}",
            json={"requires_permission": None, "max_days": None, "code": None},
        )
    )
    assert cleared["requires_permission_source"] == "category" and cleared["max_days"] == 30
    assert cleared["code"] is None
    missing = await client.post(
        f"{API}/lending/items", json={"name": "x", "category_id": str(uuid.uuid4())}
    )
    assert missing.status_code == 404 and _code(missing) == "lending_category_not_found"
    assert (await client.post(f"{API}/lending/items", json={"name": " "})).status_code == 422
    assert (
        await client.post(f"{API}/lending/items", json={"name": "x", "max_days": 366})
    ).status_code == 422

    as_user(lab.member)
    names = [i["name"] for i in await _ok(await client.get(f"{API}/lending/items"))]
    # The sidebar's Japanese name order (core/collation): kana, then kanji.
    assert names == ["デスクトップ", "ノート PC", "統計学入門"]
    detail = await _ok(await client.get(f"{API}/lending/items/{own['id']}"))
    assert detail["id"] == own["id"]
    nothing = await client.get(f"{API}/lending/items/{uuid.uuid4()}")
    assert nothing.status_code == 404 and _code(nothing) == "lending_item_not_found"


async def test_control_numbers_unique_among_items_not_retired(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    lab = await _lab(db, client, as_user)
    await lab.enable()
    old = await lab.item(name="PC 旧", code="PC-03")
    taken = await client.post(f"{API}/lending/items", json={"name": "PC 新", "code": "pc-03"})
    assert taken.status_code == 409 and _code(taken) == "lending_code_taken"
    assert taken.json()["error"]["details"]["existing_id"] == old["id"]
    other = await lab.item(name="PC 別", code="PC-04")
    clash = await client.patch(f"{API}/lending/items/{other['id']}", json={"code": "PC-03"})
    assert clash.status_code == 409
    # Retire the old one: its number is free again.
    status = f"{API}/lending/items/{old['id']}/status"
    retired = await _ok(await client.post(status, json={"status": "retired", "note": "故障"}))
    assert retired["status"] == "retired" and retired["status_note"] == "故障"
    new = await lab.item(name="PC 新", code="PC-03")
    as_user(lab.member)
    listed = {i["id"] for i in await _ok(await client.get(f"{API}/lending/items"))}
    assert old["id"] not in listed and new["id"] in listed
    everything = await _ok(
        await client.get(f"{API}/lending/items", params={"include_retired": True})
    )
    assert old["id"] in {i["id"] for i in everything}
    # Back from retired while the number is taken: refused.
    as_user(lab.keeper)
    back = await client.post(status, json={"status": "available"})
    assert back.status_code == 409 and _code(back) == "lending_code_taken"
    assert back.json()["error"]["details"]["existing_id"] == new["id"]
    # A retired item's number may be changed freely (it does not count).
    await _ok(await client.patch(f"{API}/lending/items/{old['id']}", json={"code": "PC-04"}))
    await _ok(await client.patch(f"{API}/lending/items/{old['id']}", json={"code": "PC-03-old"}))
    back = await _ok(await client.post(status, json={"status": "available", "note": "x"}))
    assert back["status"] == "available" and back["status_note"] is None


async def test_status_changes_and_history(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    lab = await _lab(db, client, as_user)
    await lab.enable()
    item = await lab.item()
    status = f"{API}/lending/items/{item['id']}/status"
    repair = await _ok(
        await client.post(status, json={"status": "in_repair", "note": "表紙の破れ"})
    )
    assert repair["status"] == "in_repair"
    again = await _ok(await client.post(status, json={"status": "in_repair", "note": "表紙の破れ"}))
    assert again["updated_at"] == repair["updated_at"]
    assert (await client.post(status, json={"status": "on_loan"})).status_code == 422
    await _ok(await client.patch(f"{API}/lending/items/{item['id']}", json={"location": "棚 B"}))

    as_user(lab.member)
    page = await _ok(
        await client.get(f"{API}/lending/items/{item['id']}/history", params={"limit": 2})
    )
    kinds = [e["kind"] for e in page["events"]]
    assert kinds == ["updated", "status"] and page["next_before"] == page["events"][-1]["id"]
    assert page["events"][0]["details"]["changes"]["location"] == {"from": None, "to": "棚 B"}
    assert page["events"][1]["details"] == {
        "from": "available",
        "to": "in_repair",
        "note": "表紙の破れ",
    }
    rest = await _ok(
        await client.get(
            f"{API}/lending/items/{item['id']}/history", params={"before": page["next_before"]}
        )
    )
    assert [e["kind"] for e in rest["events"]] == ["created"] and rest["next_before"] is None
    assert rest["events"][0]["actor_id"] == str(lab.keeper.id)

    # On loan: the status cannot be changed by hand, nor the item deleted.
    loan = _loan(uuid.UUID(item["id"]), lab.member.id)
    db.add(loan)
    await db.flush()
    await db.execute(
        update(LendingItem)
        .where(LendingItem.id == uuid.UUID(item["id"]))
        .values(status="on_loan", current_loan_id=loan.id)
    )
    await db.commit()
    as_user(lab.keeper)
    lent = await client.post(status, json={"status": "available"})
    assert lent.status_code == 409 and _code(lent) == "lending_item_on_loan"
    assert (await client.delete(f"{API}/lending/items/{item['id']}")).status_code == 409
    actions = (await db.execute(select(AuditLog.action))).scalars().all()
    assert "lending_item.status_changed" in actions and "lending_item.updated" in actions


async def test_delete_only_without_loans(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    lab = await _lab(db, client, as_user)
    await lab.enable()
    lent = await lab.item(name="貸したもの")
    fresh = await lab.item(name="新品")
    # A loan returned long ago is enough.
    returned = _loan(uuid.UUID(lent["id"]), lab.member.id)
    returned.status, returned.returned_at = "returned", utcnow()
    db.add(returned)
    await db.commit()
    as_user(lab.keeper)
    refused = await client.delete(f"{API}/lending/items/{lent['id']}")
    assert refused.status_code == 409 and _code(refused) == "lending_item_has_history"
    await _ok(await client.delete(f"{API}/lending/items/{fresh['id']}"), 204)
    assert (await client.get(f"{API}/lending/items/{fresh['id']}")).status_code == 404
    events = (
        (await db.execute(select(OutboxEvent).where(OutboxEvent.event_type == "lending.updated")))
        .scalars()
        .all()
    )
    assert events[-1].payload["item_ids"] == [fresh["id"]]


async def test_item_limit(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    lab = await _lab(db, client, as_user)
    await lab.enable()
    now = utcnow()
    db.add_all(
        [
            LendingItem(name=f"item {i}", status="available", created_at=now, updated_at=now)
            for i in range(2000)
        ]
    )
    await db.commit()
    as_user(lab.keeper)
    full = await client.post(f"{API}/lending/items", json={"name": "one more"})
    assert full.status_code == 409 and _code(full) == "too_many_lending_items"
    assert full.json()["error"]["details"]["limit"] == 2000


# --- photos ----------------------------------------------------------------------------------


async def test_photos(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    lab = await _lab(db, client, as_user)
    await lab.enable()
    as_user(lab.member)
    someone_elses = await _upload(client)
    as_user(lab.keeper)
    text_file = await _upload(client, image=False)
    for bad in (someone_elses, text_file, str(uuid.uuid4())):
        refused = await client.post(
            f"{API}/lending/items", json={"name": "x", "photo_attachment_id": bad}
        )
        assert refused.status_code == 400 and _code(refused) == "lending_photo_invalid"
    first = await _upload(client)
    item = await lab.item(photo_attachment_id=first)
    assert item["photo"]["id"] == first and item["photo"]["has_thumbnail"] is True
    # Bound now: it cannot be used for another item.
    reused = await client.post(
        f"{API}/lending/items", json={"name": "y", "photo_attachment_id": first}
    )
    assert reused.status_code == 400

    as_user(lab.member)
    assert (await client.get(f"{API}/attachments/{first}")).status_code == 200
    assert (await client.get(f"{API}/attachments/{first}/thumbnail")).status_code == 200
    as_user(lab.guest)
    assert (await client.get(f"{API}/attachments/{first}")).status_code == 404

    as_user(lab.keeper)
    second = await _upload(client)
    swapped = await _ok(
        await client.patch(
            f"{API}/lending/items/{item['id']}", json={"photo_attachment_id": second}
        )
    )
    assert swapped["photo"]["id"] == second
    old = await db.get(Attachment, uuid.UUID(first), populate_existing=True)
    assert old is not None and old.status == "deleted"
    assert (await client.get(f"{API}/attachments/{first}")).status_code == 404
    removed = await _ok(
        await client.patch(f"{API}/lending/items/{item['id']}", json={"photo_attachment_id": None})
    )
    assert removed["photo"] is None
    gone = await db.get(Attachment, uuid.UUID(second), populate_existing=True)
    assert gone is not None and gone.status == "deleted"

    third = await _upload(client)
    await _ok(
        await client.patch(f"{API}/lending/items/{item['id']}", json={"photo_attachment_id": third})
    )
    # Off: the photo is not served (not even to the keepers).
    await lab.enable(enabled=False)
    as_user(lab.keeper)
    assert (await client.get(f"{API}/attachments/{third}")).status_code == 404
    await lab.enable()
    as_user(lab.keeper)
    await _ok(await client.delete(f"{API}/lending/items/{item['id']}"), 204)
    deleted = await db.get(Attachment, uuid.UUID(third), populate_existing=True)
    assert deleted is not None and deleted.status == "deleted" and deleted.lending_item_id is None


async def test_anonymized_keeper_leaves_the_list(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    lab = await _lab(db, client, as_user)
    await lab.enable()
    as_user(lab.admin)
    await _ok(await client.post(f"{API}/admin/users/{lab.keeper.id}/anonymize"))
    as_user(lab.member)
    assert (await _ok(await client.get(f"{API}/lending/settings")))["keeper_ids"] == []
