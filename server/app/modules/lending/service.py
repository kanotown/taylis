"""備品 (equipment lending, docs/LENDING.md). L1 (M167): the settings, the categories, the items,
their photos and their history.

Every change of an item locks its row first (`FOR UPDATE`; the loans of L2 lock the item and then
the loan, in that order). Creating items or categories and giving a control number go through a
transaction-scoped advisory lock, so the limits and the uniqueness checks see one another. Each
change writes the item's history (`lending_item_events`), the audit row (§10) and a
`lending.updated` (audience all, no content) in the same transaction."""

import uuid
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.collation import name_key as collation_key
from app.core.errors import AppError, bad_request, conflict, forbidden, not_found
from app.core.roles import PERSON_ROLES
from app.core.time import utcnow
from app.events.outbox import write_outbox
from app.modules.attachments import service as attachments
from app.modules.attachments.models import Attachment
from app.modules.attachments.schemas import to_attachment_out
from app.modules.audit import service as audit
from app.modules.lending import access
from app.modules.lending.events import LENDING_UPDATED
from app.modules.lending.models import (
    DEFAULT_KEEPER_OVERDUE_DAYS,
    DEFAULT_MAX_DAYS,
    DEFAULT_MAX_EXTENSIONS,
    DEFAULT_NOTICE_MINUTE,
    DEFAULT_TZ,
    LendingCategory,
    LendingItem,
    LendingItemEvent,
    LendingSettings,
)
from app.modules.lending.schemas import (
    MAX_CATEGORIES,
    MAX_ITEMS,
    LendingCategoryCreate,
    LendingCategoryOut,
    LendingCategoryUpdate,
    LendingItemCreate,
    LendingItemDetailOut,
    LendingItemEventOut,
    LendingItemHistoryOut,
    LendingItemOut,
    LendingItemStatusIn,
    LendingItemUpdate,
    LendingSettingsOut,
    LendingSettingsUpdate,
    LendingSummaryOut,
    LendingUpdatedData,
    Source,
    name_key,
)
from app.modules.users.models import User

# §4.3: the photo is an image of one of these (sniffed at upload).
PHOTO_TYPES = frozenset({"image/jpeg", "image/png", "image/webp", "image/heic"})
_ITEMS_LOCK = text("SELECT pg_advisory_xact_lock(hashtext('lending_items'))")
_CATEGORIES_LOCK = text("SELECT pg_advisory_xact_lock(hashtext('lending_categories'))")


# --- settings (§5.1) ---------------------------------------------------------------------------


async def _settings_row(db: AsyncSession, *, for_update: bool = False) -> LendingSettings | None:
    stmt = select(LendingSettings)
    if for_update:
        stmt = stmt.with_for_update()
    return (await db.execute(stmt)).scalar_one_or_none()


def _require_person(actor: User) -> None:
    if not access.is_person(actor):
        raise forbidden("guest_restricted", "Guests cannot use the equipment ledger")


def _settings_out(row: LendingSettings | None, actor: User) -> LendingSettingsOut:
    if row is None:
        return LendingSettingsOut(
            enabled=False,
            keeper_ids=[],
            default_max_days=DEFAULT_MAX_DAYS,
            max_extensions=DEFAULT_MAX_EXTENSIONS,
            keeper_overdue_days=DEFAULT_KEEPER_OVERDUE_DAYS,
            notice_minute=DEFAULT_NOTICE_MINUTE,
            tz=DEFAULT_TZ,
            is_keeper=access.can_keep(actor, None),
            updated_at=None,
        )
    return LendingSettingsOut(
        enabled=row.enabled,
        keeper_ids=list(row.keeper_ids),
        default_max_days=row.default_max_days,
        max_extensions=row.max_extensions,
        keeper_overdue_days=row.keeper_overdue_days,
        notice_minute=row.notice_minute,
        tz=row.tz,
        is_keeper=access.can_keep(actor, row),
        updated_at=row.updated_at,
    )


async def _emit(
    db: AsyncSession,
    *,
    item_ids: list[uuid.UUID] | None = None,
    categories: bool = False,
    settings: bool = False,
) -> None:
    data = LendingUpdatedData(item_ids=item_ids or [], categories=categories, settings=settings)
    await write_outbox(
        db, event_type=LENDING_UPDATED, audience_type="all", payload=data.model_dump(mode="json")
    )


async def get_settings(db: AsyncSession, actor: User) -> LendingSettingsOut:
    """Every person, also while the feature is off."""
    _require_person(actor)
    return _settings_out(await _settings_row(db), actor)


async def _check_keepers(db: AsyncSession, keeper_ids: list[uuid.UUID]) -> None:
    if not keeper_ids:
        return
    rows = await db.execute(select(User).where(User.id.in_(keeper_ids)))
    fit = {u.id for u in rows.scalars().all() if u.is_active and u.role in PERSON_ROLES}
    invalid = [str(i) for i in keeper_ids if i not in fit]
    if invalid:
        raise bad_request(
            "lending_keeper_invalid",
            "Keepers must be active people (not guests or bots)",
            {"user_ids": invalid},
        )


async def update_settings(
    db: AsyncSession, actor: User, data: LendingSettingsUpdate
) -> LendingSettingsOut:
    """`lending.manage` (checked by the router)."""
    row = await _settings_row(db, for_update=True)
    if row is None:
        row = LendingSettings(
            singleton=True,
            enabled=False,
            keeper_ids=[],
            default_max_days=DEFAULT_MAX_DAYS,
            max_extensions=DEFAULT_MAX_EXTENSIONS,
            keeper_overdue_days=DEFAULT_KEEPER_OVERDUE_DAYS,
            notice_minute=DEFAULT_NOTICE_MINUTE,
            tz=DEFAULT_TZ,
        )
        db.add(row)
        await db.flush()
    changes: dict[str, Any] = {}
    if data.keeper_ids is not None:
        before = list(row.keeper_ids)
        # Only the people added are checked: someone deactivated since may stay on the list (they
        # do not count) until an administrator takes them off.
        await _check_keepers(db, [i for i in data.keeper_ids if i not in before])
        if data.keeper_ids != before:
            row.keeper_ids = list(data.keeper_ids)
            changes["keepers_added"] = [str(i) for i in data.keeper_ids if i not in before]
            changes["keepers_removed"] = [str(i) for i in before if i not in data.keeper_ids]
    for field in (
        "enabled",
        "default_max_days",
        "max_extensions",
        "keeper_overdue_days",
        "notice_minute",
        "tz",
    ):
        value = getattr(data, field)
        if value is not None and value != getattr(row, field):
            changes[field] = value
            setattr(row, field, value)
    if changes:
        row.updated_at = utcnow()
        row.updated_by = actor.id
        await audit.record_in_tx(
            db,
            actor_id=actor.id,
            action="lending_settings.updated",
            target_type="lending_settings",
            target_id=None,
            details=changes,
        )
        await _emit(db, settings=True)
    await db.commit()
    return _settings_out(row, actor)


async def bootstrap(db: AsyncSession, actor: User) -> LendingSummaryOut | None:
    """The bootstrap's `lending`: null for guests and bots and while the feature is off. The loan
    counts come with the loans (L2)."""
    row = await _settings_row(db)
    if not access.may_see_ledger(actor, row):
        return None
    assert row is not None
    return LendingSummaryOut(
        enabled=True,
        is_keeper=access.can_keep(actor, row),
        my_active_count=0,
        my_overdue_count=0,
        keeper_attention_count=0,
        settings_updated_at=row.updated_at,
    )


async def forget_in_tx(db: AsyncSession, user_id: uuid.UUID) -> None:
    """For the admin module: an anonymized person is no longer a keeper (their loans stay, under
    the anonymized name)."""
    row = await _settings_row(db, for_update=True)
    if row is not None and user_id in row.keeper_ids:
        row.keeper_ids = [i for i in row.keeper_ids if i != user_id]
        await _emit(db, settings=True)


# --- who may --------------------------------------------------------------------------------


async def _ledger(db: AsyncSession, actor: User) -> LendingSettings:
    """403 guest_restricted for guests and bots, 409 lending_disabled while off."""
    _require_person(actor)
    row = await _settings_row(db)
    if not access.is_enabled(row):
        raise conflict("lending_disabled", "The equipment ledger is turned off")
    assert row is not None
    return row


def _require_keeper(actor: User, settings: LendingSettings) -> None:
    if not access.can_keep(actor, settings):
        raise forbidden("lending_keeper_required", "Only equipment keepers can do this")


async def _keeper(db: AsyncSession, actor: User) -> LendingSettings:
    settings = await _ledger(db, actor)
    _require_keeper(actor, settings)
    return settings


# --- categories (§5.2) ------------------------------------------------------------------------


def _category_not_found() -> AppError:
    return not_found("lending_category_not_found", "No such category")


async def _ordered_categories(db: AsyncSession) -> list[LendingCategory]:
    rows = await db.execute(
        select(LendingCategory).order_by(LendingCategory.position, LendingCategory.id)
    )
    return list(rows.scalars().all())


async def _item_counts(db: AsyncSession) -> dict[uuid.UUID, int]:
    rows = await db.execute(
        select(LendingItem.category_id, func.count())
        .where(LendingItem.category_id.is_not(None))
        .group_by(LendingItem.category_id)
    )
    return {category_id: count for category_id, count in rows.all() if category_id is not None}


def _category_out(row: LendingCategory, counts: dict[uuid.UUID, int]) -> LendingCategoryOut:
    return LendingCategoryOut(
        id=row.id,
        name=row.name,
        position=row.position,
        requires_permission=row.requires_permission,
        max_days=row.max_days,
        item_count=counts.get(row.id, 0),
    )


async def list_categories(db: AsyncSession, actor: User) -> list[LendingCategoryOut]:
    await _ledger(db, actor)
    counts = await _item_counts(db)
    return [_category_out(c, counts) for c in await _ordered_categories(db)]


async def _check_category_name(
    db: AsyncSession, key: str, exclude: uuid.UUID | None = None
) -> None:
    stmt = select(LendingCategory.id).where(LendingCategory.name_key == key)
    if exclude is not None:
        stmt = stmt.where(LendingCategory.id != exclude)
    existing = (await db.execute(stmt)).scalar_one_or_none()
    if existing is not None:
        raise conflict(
            "lending_category_name_taken",
            "A category with this name exists",
            {"existing_id": str(existing)},
        )


def _category_audit(row: LendingCategory) -> dict[str, Any]:
    return {
        "name": row.name,
        "requires_permission": row.requires_permission,
        "max_days": row.max_days,
    }


async def create_category(
    db: AsyncSession, actor: User, data: LendingCategoryCreate
) -> LendingCategoryOut:
    await _keeper(db, actor)
    await db.execute(_CATEGORIES_LOCK)
    rows = await _ordered_categories(db)
    if len(rows) >= MAX_CATEGORIES:
        raise conflict(
            "too_many_lending_categories", "Too many categories", {"limit": MAX_CATEGORIES}
        )
    key = name_key(data.name)
    await _check_category_name(db, key)
    now = utcnow()
    row = LendingCategory(
        name=data.name,
        name_key=key,
        position=max((r.position for r in rows), default=-1) + 1,
        requires_permission=data.requires_permission,
        max_days=data.max_days,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    await db.flush()
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="lending_category.created",
        target_type="lending_category",
        target_id=row.id,
        details=_category_audit(row),
    )
    await _emit(db, categories=True)
    await db.commit()
    return _category_out(row, {})


async def update_category(
    db: AsyncSession, actor: User, category_id: uuid.UUID, data: LendingCategoryUpdate
) -> LendingCategoryOut:
    await _keeper(db, actor)
    await db.execute(_CATEGORIES_LOCK)
    row = await db.get(LendingCategory, category_id, with_for_update=True)
    if row is None:
        raise _category_not_found()
    sent = data.model_fields_set
    changes: dict[str, Any] = {}
    if data.name is not None and data.name != row.name:
        key = name_key(data.name)
        await _check_category_name(db, key, exclude=row.id)
        changes["name"] = {"from": row.name, "to": data.name}
        row.name, row.name_key = data.name, key
    if data.requires_permission is not None and data.requires_permission != row.requires_permission:
        changes["requires_permission"] = data.requires_permission
        row.requires_permission = data.requires_permission
    if "max_days" in sent and data.max_days != row.max_days:
        changes["max_days"] = data.max_days
        row.max_days = data.max_days
    if data.position is not None:
        ordered = [c for c in await _ordered_categories(db) if c.id != row.id]
        ordered.insert(min(data.position, len(ordered)), row)
        if any(c.position != i for i, c in enumerate(ordered)):
            changes["position"] = ordered.index(row)
            for i, c in enumerate(ordered):
                c.position = i
    if changes:
        row.updated_at = utcnow()
        await audit.record_in_tx(
            db,
            actor_id=actor.id,
            action="lending_category.updated",
            target_type="lending_category",
            target_id=row.id,
            details=changes,
        )
        await _emit(db, categories=True)
    await db.commit()
    return _category_out(row, await _item_counts(db))


async def delete_category(db: AsyncSession, actor: User, category_id: uuid.UUID) -> None:
    """409 lending_category_in_use while items (retired ones too) are in it."""
    await _keeper(db, actor)
    row = await db.get(LendingCategory, category_id, with_for_update=True)
    if row is None:
        raise _category_not_found()
    count = await db.scalar(
        select(func.count()).select_from(LendingItem).where(LendingItem.category_id == row.id)
    )
    if count:
        raise conflict(
            "lending_category_in_use", "Items are still in this category", {"item_count": count}
        )
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="lending_category.deleted",
        target_type="lending_category",
        target_id=row.id,
        details=_category_audit(row),
    )
    await db.delete(row)
    await _emit(db, categories=True)
    await db.commit()


# --- items (§5.2) -----------------------------------------------------------------------------


def _item_not_found() -> AppError:
    return not_found("lending_item_not_found", "No such item")


def _effective(
    item: LendingItem, category: LendingCategory | None, settings: LendingSettings
) -> tuple[bool, Source, int, Source]:
    """(requires_permission, its source, max_days, its source): item → category → default
    (§4.2)."""
    permission: tuple[bool, Source]
    if item.requires_permission is not None:
        permission = (item.requires_permission, "item")
    elif category is not None:
        permission = (category.requires_permission, "category")
    else:
        permission = (False, "default")
    days: tuple[int, Source]
    if item.max_days is not None:
        days = (item.max_days, "item")
    elif category is not None and category.max_days is not None:
        days = (category.max_days, "category")
    else:
        days = (settings.default_max_days, "default")
    return permission[0], permission[1], days[0], days[1]


def _item_out(
    item: LendingItem,
    categories: dict[uuid.UUID, LendingCategory],
    photos: dict[uuid.UUID, Attachment],
    settings: LendingSettings,
) -> LendingItemOut:
    category = categories.get(item.category_id) if item.category_id else None
    permission, permission_source, days, days_source = _effective(item, category, settings)
    photo = photos.get(item.photo_attachment_id) if item.photo_attachment_id else None
    return LendingItemOut(
        id=item.id,
        name=item.name,
        category_id=item.category_id,
        code=item.code,
        location=item.location,
        notes=item.notes,
        photo=to_attachment_out(photo) if photo is not None else None,
        status=item.status,  # type: ignore[arg-type]
        status_note=item.status_note,
        requires_permission=permission,
        requires_permission_source=permission_source,
        max_days=days,
        max_days_source=days_source,
        loan=None,
        watching=False,
        created_at=item.created_at,
        updated_at=item.updated_at,
    )


async def _photos(db: AsyncSession, items: list[LendingItem]) -> dict[uuid.UUID, Attachment]:
    ids = [i.photo_attachment_id for i in items if i.photo_attachment_id is not None]
    rows = await attachments.get_many(db, ids)
    return {a.id: a for a in rows if a.status == "attached" and a.lending_item_id is not None}


async def _categories_by_id(db: AsyncSession) -> dict[uuid.UUID, LendingCategory]:
    return {c.id: c for c in await _ordered_categories(db)}


async def _outs(
    db: AsyncSession, items: list[LendingItem], settings: LendingSettings
) -> list[LendingItemOut]:
    categories = await _categories_by_id(db)
    photos = await _photos(db, items)
    return [_item_out(i, categories, photos, settings) for i in items]


async def _detail(
    db: AsyncSession, item: LendingItem, settings: LendingSettings
) -> LendingItemDetailOut:
    (out,) = await _outs(db, [item], settings)
    return LendingItemDetailOut(**out.model_dump(), recent_loans=[])


async def list_items(
    db: AsyncSession, actor: User, *, include_retired: bool = False
) -> list[LendingItemOut]:
    """Every item in the Japanese name order (core/collation), not paged (at most 2,000)."""
    settings = await _ledger(db, actor)
    stmt = select(LendingItem)
    if not include_retired:
        stmt = stmt.where(LendingItem.status != "retired")
    items = sorted(
        (await db.execute(stmt)).scalars().all(), key=lambda i: (collation_key(i.name), i.id)
    )
    return await _outs(db, items, settings)


async def get_item(db: AsyncSession, actor: User, item_id: uuid.UUID) -> LendingItemDetailOut:
    settings = await _ledger(db, actor)
    item = await db.get(LendingItem, item_id)
    if item is None:
        raise _item_not_found()
    return await _detail(db, item, settings)


async def _locked_item(db: AsyncSession, item_id: uuid.UUID) -> LendingItem:
    item = await db.get(LendingItem, item_id, with_for_update=True, populate_existing=True)
    if item is None:
        raise _item_not_found()
    return item


async def _check_code(db: AsyncSession, key: str | None, exclude: uuid.UUID | None = None) -> None:
    """The control number among the items that are not retired. Call under _ITEMS_LOCK."""
    if key is None:
        return
    stmt = select(LendingItem.id).where(
        LendingItem.code_key == key, LendingItem.status != "retired"
    )
    if exclude is not None:
        stmt = stmt.where(LendingItem.id != exclude)
    existing = (await db.execute(stmt)).scalars().first()
    if existing is not None:
        raise conflict(
            "lending_code_taken",
            "Another item has this control number",
            {"existing_id": str(existing)},
        )


async def _check_category(db: AsyncSession, category_id: uuid.UUID | None) -> None:
    """The category exists (kept until the transaction ends, so it cannot be deleted under the
    item: FOR SHARE)."""
    if category_id is None:
        return
    found = await db.get(LendingCategory, category_id, with_for_update={"read": True})
    if found is None:
        raise _category_not_found()


async def _set_photo(
    db: AsyncSession, actor: User, item: LendingItem, attachment_id: uuid.UUID | None
) -> bool:
    """Binds a new photo (the actor's own pending image upload) or removes it; the old one is
    deleted (the attachments' GC removes its bytes). Whether anything changed."""
    if attachment_id == item.photo_attachment_id:
        return False
    if attachment_id is not None:
        bound = await attachments.bind_to_lending_item_in_tx(
            db, actor.id, attachment_id, lending_item_id=item.id, content_types=PHOTO_TYPES
        )
        if bound is None:
            raise bad_request(
                "lending_photo_invalid",
                "The photo must be your own new upload of a JPEG, PNG, WebP or HEIC image",
            )
    if item.photo_attachment_id is not None:
        await attachments.mark_ids_deleted_in_tx(db, [item.photo_attachment_id])
    item.photo_attachment_id = attachment_id
    return True


async def _record(
    db: AsyncSession,
    item: LendingItem,
    actor: User,
    kind: str,
    details: dict[str, Any],
) -> None:
    db.add(
        LendingItemEvent(
            item_id=item.id, kind=kind, actor_id=actor.id, at=utcnow(), details=details
        )
    )
    await db.flush()


def _item_audit(item: LendingItem) -> dict[str, Any]:
    return {
        "name": item.name,
        "code": item.code,
        "category_id": str(item.category_id) if item.category_id else None,
        "status": item.status,
    }


async def create_item(
    db: AsyncSession, actor: User, data: LendingItemCreate
) -> LendingItemDetailOut:
    settings = await _keeper(db, actor)
    await db.execute(_ITEMS_LOCK)
    count = await db.scalar(select(func.count()).select_from(LendingItem))
    if (count or 0) >= MAX_ITEMS:
        raise conflict("too_many_lending_items", "Too many items", {"limit": MAX_ITEMS})
    await _check_category(db, data.category_id)
    key = name_key(data.code) if data.code else None
    await _check_code(db, key)
    now = utcnow()
    item = LendingItem(
        name=data.name,
        category_id=data.category_id,
        code=data.code,
        code_key=key,
        location=data.location,
        notes=data.notes,
        status="available",
        requires_permission=data.requires_permission,
        max_days=data.max_days,
        created_by=actor.id,
        created_at=now,
        updated_by=actor.id,
        updated_at=now,
    )
    db.add(item)
    await db.flush()
    if data.photo_attachment_id is not None:
        await _set_photo(db, actor, item, data.photo_attachment_id)
    await _record(
        db,
        item,
        actor,
        "created",
        {"name": item.name, "code": item.code, "category_id": _str(item.category_id)},
    )
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="lending_item.created",
        target_type="lending_item",
        target_id=item.id,
        details=_item_audit(item),
    )
    await _emit(db, item_ids=[item.id])
    await db.commit()
    return await _detail(db, item, settings)


def _str(value: uuid.UUID | None) -> str | None:
    return str(value) if value is not None else None


# Fields whose before / after the history keeps (the notes and the photo: only that they changed).
_SMALL_FIELDS = ("name", "category_id", "code", "location", "requires_permission", "max_days")


async def update_item(
    db: AsyncSession, actor: User, item_id: uuid.UUID, data: LendingItemUpdate
) -> LendingItemDetailOut:
    settings = await _keeper(db, actor)
    sent = data.model_fields_set
    if "code" in sent:
        await db.execute(_ITEMS_LOCK)
    item = await _locked_item(db, item_id)
    changes: dict[str, Any] = {}
    fields: list[str] = []

    def change(field: str, value: Any) -> None:
        before = getattr(item, field)
        if value == before:
            return
        fields.append(field)
        if field in _SMALL_FIELDS:
            plain = _str(before) if isinstance(before, uuid.UUID) else before
            after = _str(value) if isinstance(value, uuid.UUID) else value
            changes[field] = {"from": plain, "to": after}
        setattr(item, field, value)

    if data.name is not None:
        change("name", data.name)
    if "category_id" in sent and data.category_id != item.category_id:
        await _check_category(db, data.category_id)
        change("category_id", data.category_id)
    if "code" in sent:
        key = name_key(data.code) if data.code else None
        if key != item.code_key and item.status != "retired":
            await _check_code(db, key, exclude=item.id)
        if data.code != item.code:
            item.code_key = key
        change("code", data.code)
    for field in ("location", "notes", "requires_permission", "max_days"):
        if field in sent:
            change(field, getattr(data, field))
    if "photo_attachment_id" in sent and await _set_photo(
        db, actor, item, data.photo_attachment_id
    ):
        fields.append("photo")
    if fields:
        item.updated_by = actor.id
        item.updated_at = utcnow()
        await _record(db, item, actor, "updated", {"fields": fields, "changes": changes})
        await audit.record_in_tx(
            db,
            actor_id=actor.id,
            action="lending_item.updated",
            target_type="lending_item",
            target_id=item.id,
            details={"fields": fields, "changes": changes},
        )
        await _emit(db, item_ids=[item.id])
    await db.commit()
    return await _detail(db, item, settings)


async def set_status(
    db: AsyncSession, actor: User, item_id: uuid.UUID, data: LendingItemStatusIn
) -> LendingItemDetailOut:
    """available ↔ in_repair ↔ retired (§6.2). 409 lending_item_on_loan while lent; back from
    retired, 409 lending_code_taken if its number was given to another item meanwhile. The same
    status and note again: no change."""
    settings = await _keeper(db, actor)
    await db.execute(_ITEMS_LOCK)
    item = await _locked_item(db, item_id)
    if item.status == "on_loan":
        raise conflict(
            "lending_item_on_loan",
            "The item is on loan: record its return first",
            {"loan_id": _str(item.current_loan_id)},
        )
    note = None if data.status == "available" else data.note
    if data.status == item.status and note == item.status_note:
        await db.commit()
        return await _detail(db, item, settings)
    if item.status == "retired" and data.status != "retired":
        await _check_code(db, item.code_key, exclude=item.id)
    before = item.status
    item.status = data.status
    item.status_note = note
    item.updated_by = actor.id
    item.updated_at = utcnow()
    details = {"from": before, "to": data.status, "note": note}
    await _record(db, item, actor, "status", details)
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="lending_item.status_changed",
        target_type="lending_item",
        target_id=item.id,
        details=details,
    )
    await _emit(db, item_ids=[item.id])
    await db.commit()
    return await _detail(db, item, settings)


async def delete_item(db: AsyncSession, actor: User, item_id: uuid.UUID) -> None:
    """Only an item that was never lent (409 lending_item_has_history: retire it instead). Its
    photo and history go with it."""
    await _keeper(db, actor)
    item = await _locked_item(db, item_id)
    lent = await db.scalar(
        select(LendingItemEvent.id)
        .where(LendingItemEvent.item_id == item.id, LendingItemEvent.kind == "borrowed")
        .limit(1)
    )
    if lent is not None or item.status == "on_loan":
        raise conflict(
            "lending_item_has_history", "The item has been lent: retire it instead of deleting it"
        )
    photos = await db.execute(select(Attachment.id).where(Attachment.lending_item_id == item.id))
    await attachments.mark_ids_deleted_in_tx(db, list(photos.scalars().all()))
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="lending_item.deleted",
        target_type="lending_item",
        target_id=item.id,
        details=_item_audit(item),
    )
    await db.delete(item)
    await _emit(db, item_ids=[item.id])
    await db.commit()


async def history(
    db: AsyncSession,
    actor: User,
    item_id: uuid.UUID,
    *,
    before: uuid.UUID | None,
    limit: int,
) -> LendingItemHistoryOut:
    """Newest first; `before` is the last event id of the previous page."""
    await _ledger(db, actor)
    if await db.get(LendingItem, item_id) is None:
        raise _item_not_found()
    stmt = select(LendingItemEvent).where(LendingItemEvent.item_id == item_id)
    if before is not None:
        stmt = stmt.where(LendingItemEvent.id < before)
    rows = list(
        (await db.execute(stmt.order_by(LendingItemEvent.id.desc()).limit(limit + 1)))
        .scalars()
        .all()
    )
    more = len(rows) > limit
    rows = rows[:limit]
    return LendingItemHistoryOut(
        events=[
            LendingItemEventOut(
                id=r.id,
                kind=r.kind,
                loan_id=r.loan_id,
                actor_id=r.actor_id,
                at=r.at,
                details=r.details,
            )
            for r in rows
        ],
        next_before=rows[-1].id if more and rows else None,
    )
