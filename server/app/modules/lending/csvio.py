"""備品の CSV (equipment CSV, L7 = M173, docs/LENDING.md §5.4, §13.3, §17.7).

The export (`GET /lending/items/export.csv`, keepers) writes the ledger as UTF-8 with a byte order
mark (Excel opens Japanese right). Every text cell that a spreadsheet would read as a formula
(`=`, `+`, `-`, `@`, a tab or a carriage return first) gets a `'` in front (CSV injection); the
import takes that `'` off again, so an exported file imports unchanged.

The import (`POST /lending/items/import`, keepers) reads the same columns (by their header, in any
order; English names too), UTF-8 (with or without the mark) or Shift_JIS (what Japanese Excel
saves). An item is matched by its control number among the items not retired; a row without one is
matched by its name among the items without a number. Unmatched rows create items; a category
named but missing is created. Only the columns present are compared and written (an empty cell
clears that field); the status, the borrower and the due date are never imported, and a row whose
status says 廃棄 (retired) is skipped. A dry run reports what would happen; applying does it in one
transaction, or nothing at all while any row has an error (400 lending_csv_invalid with
details.errors). The same file imported twice reports every row unchanged the second time."""

import csv
import enum
import io
import unicodedata
import uuid
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Literal

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app import i18n
from app.core.collation import name_key as collation_key
from app.core.errors import bad_request
from app.core.time import utcnow
from app.modules.audit import service as audit
from app.modules.lending import service
from app.modules.lending.models import LendingCategory, LendingItem, LendingLoan
from app.modules.lending.schemas import (
    CATEGORY_NAME_MAX,
    CODE_MAX,
    CSV_MAX_BYTES,
    CSV_MAX_ROWS,
    ITEM_NAME_MAX,
    LOCATION_MAX,
    MAX_CATEGORIES,
    MAX_DAYS_LIMIT,
    MAX_ITEMS,
    NOTES_MAX,
    LendingImportChangeOut,
    LendingImportErrorOut,
    LendingImportOut,
    LendingImportRowOut,
    _notes,
    clean_line,
    name_key,
)
from app.modules.users.models import User

# The same advisory keys as service.py: creating items or categories, and the import, take turns.
_ITEMS_LOCK = text("SELECT pg_advisory_xact_lock(hashtext('lending_items'))")
_CATEGORIES_LOCK = text("SELECT pg_advisory_xact_lock(hashtext('lending_categories'))")

EXPORT_COLUMNS = (
    "管理番号",
    "名前",
    "分類",
    "置き場所",
    "状態",
    "許可が要る",
    "最長の日数",
    "付属品とメモ",
    "借りている人",
    "返す日",
)
STATUS_LABELS = {
    "available": "貸出可",
    "on_loan": "貸出中",
    "in_repair": "修理中",
    "retired": "廃棄",
}
PERMISSION_YES = "要る"
PERMISSION_NO = "要らない"

Field = Literal["code", "name", "category", "location", "status", "permission", "max_days", "notes"]
# Header cells (NFKC, case-folded, spaces and hyphens as "_") → the field. 借りている人 and 返す日
# are known but never imported.
_HEADERS: dict[str, Field | None] = {
    "管理番号": "code",
    "code": "code",
    "control_number": "code",
    "名前": "name",
    "name": "name",
    "備品名": "name",
    "分類": "category",
    "category": "category",
    "置き場所": "location",
    "location": "location",
    "状態": "status",
    "status": "status",
    "許可が要る": "permission",
    "requires_permission": "permission",
    "permission": "permission",
    "最長の日数": "max_days",
    "max_days": "max_days",
    "付属品とメモ": "notes",
    "notes": "notes",
    "メモ": "notes",
    "借りている人": None,
    "borrower": None,
    "返す日": None,
    "due_on": None,
}
_YES = {"要る", "はい", "yes", "true", "1", "○", "◯", "y", "required"}
_NO = {"要らない", "いいえ", "no", "false", "0", "\u00d7", "n", "not_required"}
_DEFAULT = {"", "既定", "分類の既定", "default"}
_RETIRED = {"廃棄", "除籍", "retired"}
_FORMULA_FIRST = ("=", "+", "-", "@", "\t", "\r")


def _norm(value: str) -> str:
    return (
        unicodedata.normalize("NFKC", value).strip().casefold().replace(" ", "_").replace("-", "_")
    )


def cell(value: str | None) -> str:
    """A text cell a spreadsheet must not read as a formula (CSV injection, SECURITY §11)."""
    if not value:
        return ""
    return "'" + value if value.startswith(_FORMULA_FIRST) else value


def _uncell(value: str) -> str:
    """The import's side of `cell`: the `'` the export put in front comes off."""
    return value[1:] if value.startswith("'") and value[1:].startswith(_FORMULA_FIRST) else value


# --- the export ------------------------------------------------------------------------------


def _sorted(items: list[LendingItem]) -> list[LendingItem]:
    return sorted(items, key=lambda i: (collation_key(i.name), i.id))


async def export_csv(db: AsyncSession, actor: User, *, include_retired: bool) -> bytes:
    """Keepers. The items in the ledger's name order (retired ones with `include_retired`)."""
    await service.require_keeper(db, actor)
    stmt = select(LendingItem)
    if not include_retired:
        stmt = stmt.where(LendingItem.status != "retired")
    items = _sorted(list((await db.execute(stmt)).scalars().all()))
    categories = {c.id: c.name for c in (await db.execute(select(LendingCategory))).scalars().all()}
    loan_ids = [i.current_loan_id for i in items if i.current_loan_id is not None]
    loans: dict[uuid.UUID, tuple[str, date]] = {}
    if loan_ids:
        rows = await db.execute(
            select(LendingLoan.id, User.display_name, LendingLoan.due_on)
            .join(User, User.id == LendingLoan.borrower_id)
            .where(LendingLoan.id.in_(loan_ids))
        )
        loans = {loan_id: (who, due) for loan_id, who, due in rows.all()}
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow(EXPORT_COLUMNS)
    for item in items:
        loan = loans.get(item.current_loan_id) if item.current_loan_id else None
        permission = ""
        if item.requires_permission is not None:
            permission = PERMISSION_YES if item.requires_permission else PERMISSION_NO
        writer.writerow(
            [
                cell(item.code),
                cell(item.name),
                cell(categories.get(item.category_id) if item.category_id else None),
                cell(item.location),
                STATUS_LABELS.get(item.status, item.status),
                permission,
                str(item.max_days) if item.max_days is not None else "",
                cell(item.notes),
                cell(loan[0]) if loan else "",
                loan[1].isoformat() if loan else "",
            ]
        )
    await db.rollback()
    return ("\ufeff" + buffer.getvalue()).encode("utf-8")


# --- reading the file --------------------------------------------------------------------------


@dataclass
class _Row:
    line: int
    cells: dict[Field, str]
    headers: dict[Field, str]


class _FileError(Exception):
    def __init__(self, code: str, **params: object) -> None:
        super().__init__(code)
        self.code = code
        self.params = params


def _decode(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "cp932"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise _FileError("encoding")


def parse(raw: bytes) -> list[_Row]:
    """The data rows (blank ones left out) with the line each starts on."""
    if len(raw) > CSV_MAX_BYTES:
        raise _FileError("too_large")
    reader = csv.reader(io.StringIO(_decode(raw), newline=""))
    columns: dict[int, Field] | None = None
    headers: dict[Field, str] = {}
    rows: list[_Row] = []
    start = 1
    try:
        for record in reader:
            line, start = start, reader.line_num + 1
            if not any(value.strip() for value in record):
                continue
            if columns is None:
                columns = {}
                for index, title in enumerate(record):
                    known = _HEADERS.get(_norm(title.lstrip("\ufeff")))
                    if known is not None and known not in headers:
                        columns[index] = known
                        headers[known] = title.strip()
                if "name" not in headers:
                    raise _FileError("no_name_column")
                continue
            if len(rows) >= CSV_MAX_ROWS:
                raise _FileError("too_many_rows", limit=CSV_MAX_ROWS)
            cells: dict[Field, str] = {
                key: _uncell(record[index]) if index < len(record) else ""
                for index, key in columns.items()
            }
            rows.append(_Row(line, cells, headers))
    except csv.Error as exc:
        raise _FileError("unreadable") from exc
    if not rows:
        raise _FileError("empty")
    return rows


# --- planning ----------------------------------------------------------------------------------


class _Absent(enum.Enum):
    """A column the file does not have: the field is left as it is."""

    ABSENT = enum.auto()


ABSENT = _Absent.ABSENT


@dataclass
class _Values:
    """A row's cleaned values; ABSENT for the columns the file does not have."""

    name: str
    code: str | None
    status: str
    category: tuple[str, str] | _Absent | None = ABSENT  # (name, key)
    location: str | _Absent | None = ABSENT
    notes: str | _Absent | None = ABSENT
    permission: bool | _Absent | None = ABSENT
    max_days: int | _Absent | None = ABSENT


@dataclass
class _Plan:
    rows: list[LendingImportRowOut] = field(default_factory=list)
    errors: list[LendingImportErrorOut] = field(default_factory=list)
    # (row index in `rows`, values) for the new items; (item, values) for the changed ones.
    creates: list[tuple[int, _Values]] = field(default_factory=list)
    updates: list[tuple[LendingItem, _Values]] = field(default_factory=list)
    # key → the name as first written, in the order met.
    new_categories: dict[str, str] = field(default_factory=dict)

    def count(self, action: str) -> int:
        return sum(1 for r in self.rows if r.action == action)


class _RowErrors:
    def __init__(self, plan: _Plan, row: _Row, locale: str) -> None:
        self.plan, self.row, self.locale = plan, row, locale
        self.failed = False

    def add(self, error: str, /, **params: object) -> None:
        self.failed = True
        self.plan.errors.append(
            LendingImportErrorOut(
                line=self.row.line,
                code=error,
                message=i18n.t(f"lending.csv.{error}", self.locale, **params),
            )
        )

    def text(self, key: Field, limit: int, *, notes: bool = False) -> str | None:
        raw = self.row.cells.get(key, "")
        try:
            value = _notes(raw, limit) if notes else clean_line(raw)
        except ValueError:
            value = None
            self.add("too_long", column=self.row.headers[key], limit=limit)
            return None
        if value and len(value) > limit:
            self.add("too_long", column=self.row.headers[key], limit=limit)
            return None
        return value or None


def _values(row: _Row, errors: _RowErrors) -> _Values | None:
    name = errors.text("name", ITEM_NAME_MAX)
    if name is None and not errors.failed:
        errors.add("name_required", column=row.headers["name"])
    code = errors.text("code", CODE_MAX) if "code" in row.cells else None
    status = _norm(row.cells.get("status", ""))
    values = _Values(name=name or "", code=code, status=status)
    if "category" in row.cells:
        category = errors.text("category", CATEGORY_NAME_MAX)
        values.category = (category, name_key(category)) if category else None
    if "location" in row.cells:
        values.location = errors.text("location", LOCATION_MAX)
    if "notes" in row.cells:
        values.notes = errors.text("notes", NOTES_MAX, notes=True)
    if "permission" in row.cells:
        raw = row.cells["permission"]
        word = _norm(raw)
        if word in _YES:
            values.permission = True
        elif word in _NO:
            values.permission = False
        elif word in _DEFAULT:
            values.permission = None
        else:
            errors.add("permission_invalid", column=row.headers["permission"], value=raw.strip())
    if "max_days" in row.cells:
        raw = row.cells["max_days"]
        word = _norm(raw).removesuffix("日").removesuffix("days").removesuffix("d").strip("_")
        if word in _DEFAULT:
            values.max_days = None
        elif word.isdigit() and 1 <= int(word) <= MAX_DAYS_LIMIT:
            values.max_days = int(word)
        else:
            errors.add("max_days_invalid", column=row.headers["max_days"], value=raw.strip())
    return None if errors.failed else values


def _flag(value: bool | None) -> str | None:
    return None if value is None else ("true" if value else "false")


def _changes(
    item: LendingItem | None, values: _Values, categories: dict[uuid.UUID, LendingCategory]
) -> list[LendingImportChangeOut]:
    """What the row changes on the item (all its values for a new one)."""
    out: list[LendingImportChangeOut] = []

    def compare(field_name: Any, before: str | None, after: str | None) -> None:
        if before != after:
            out.append(LendingImportChangeOut(field=field_name, before=before, after=after))

    compare("name", item.name if item else None, values.name)
    if values.category is not ABSENT:
        current = categories.get(item.category_id) if item and item.category_id else None
        if values.category is None:
            compare("category", current.name if current else None, None)
        elif current is None or current.name_key != values.category[1]:
            compare("category", current.name if current else None, values.category[0])
    if values.location is not ABSENT:
        compare("location", item.location if item else None, values.location)
    if values.notes is not ABSENT:
        compare("notes", item.notes if item else None, values.notes)
    if values.permission is not ABSENT:
        compare(
            "requires_permission",
            _flag(item.requires_permission) if item else None,
            _flag(values.permission),
        )
    if values.max_days is not ABSENT:
        before = item.max_days if item else None
        compare(
            "max_days",
            str(before) if before is not None else None,
            str(values.max_days) if values.max_days is not None else None,
        )
    return out


async def _plan(
    db: AsyncSession, parsed: list[_Row], locale: str, *, for_update: bool
) -> tuple[_Plan, dict[uuid.UUID, LendingCategory]]:
    stmt = select(LendingItem)
    if for_update:
        stmt = stmt.with_for_update()
    items = list((await db.execute(stmt)).scalars().all())
    categories = {c.id: c for c in (await db.execute(select(LendingCategory))).scalars().all()}
    category_keys = {c.name_key for c in categories.values()}
    by_code: dict[str, LendingItem] = {}
    by_name: dict[str, list[LendingItem]] = {}
    for item in items:
        if item.status == "retired":
            continue
        if item.code_key is not None:
            by_code[item.code_key] = item
        else:
            by_name.setdefault(name_key(item.name), []).append(item)
    room = MAX_ITEMS - len(items)
    seen_codes: dict[str, int] = {}
    seen_names: dict[str, int] = {}
    plan = _Plan()
    for row in parsed:
        errors = _RowErrors(plan, row, locale)
        values = _values(row, errors)
        if values is None:
            continue
        if values.status in _RETIRED:
            plan.rows.append(
                LendingImportRowOut(
                    line=row.line,
                    action="skipped",
                    item_id=None,
                    name=values.name,
                    code=values.code,
                )
            )
            continue
        match: LendingItem | None = None
        if values.code is not None:
            key = name_key(values.code)
            if key in seen_codes:
                errors.add("code_duplicate", code=values.code, first=seen_codes[key])
                continue
            seen_codes[key] = row.line
            match = by_code.get(key)
        else:
            key = name_key(values.name)
            if key in seen_names:
                errors.add("name_duplicate", name=values.name, first=seen_names[key])
                continue
            seen_names[key] = row.line
            found = by_name.get(key, [])
            if len(found) > 1:
                errors.add("name_ambiguous", name=values.name, count=len(found))
                continue
            match = found[0] if found else None
        new_category = (
            isinstance(values.category, tuple)
            and values.category[1] not in category_keys
            and values.category[1] not in plan.new_categories
        )
        if new_category and len(categories) + len(plan.new_categories) >= MAX_CATEGORIES:
            assert isinstance(values.category, tuple)
            errors.add("too_many_categories", limit=MAX_CATEGORIES, name=values.category[0])
            continue
        if match is None and room <= 0:
            errors.add("too_many_items", limit=MAX_ITEMS)
            continue
        if isinstance(values.category, tuple) and values.category[1] not in category_keys:
            plan.new_categories.setdefault(values.category[1], values.category[0])
        changes = _changes(match, values, categories)
        if match is None:
            room -= 1
            action: Literal["created", "updated", "unchanged"] = "created"
            plan.creates.append((len(plan.rows), values))
        elif changes:
            action = "updated"
            plan.updates.append((match, values))
        else:
            action = "unchanged"
        plan.rows.append(
            LendingImportRowOut(
                line=row.line,
                action=action,
                item_id=match.id if match else None,
                name=values.name,
                code=values.code if match is None else match.code,
                changes=changes,
            )
        )
    return plan, categories


def _given[T](value: T | _Absent) -> T | None:
    return None if isinstance(value, _Absent) else value


class _Update:
    """An item's fields set from a row, kept for its history (as service.update_item does: the
    notes only by name)."""

    def __init__(self, item: LendingItem) -> None:
        self.item = item
        self.fields: list[str] = []
        self.changes: dict[str, Any] = {}

    def set(self, name: str, value: Any, *, small: bool = True) -> None:
        before = getattr(self.item, name)
        if value == before:
            return
        self.fields.append(name)
        if small:
            plain = str(before) if isinstance(before, uuid.UUID) else before
            after = str(value) if isinstance(value, uuid.UUID) else value
            self.changes[name] = {"from": plain, "to": after}
        setattr(self.item, name, value)


def _out(plan: _Plan, *, dry_run: bool) -> LendingImportOut:
    return LendingImportOut(
        dry_run=dry_run,
        created=plan.count("created"),
        updated=plan.count("updated"),
        unchanged=plan.count("unchanged"),
        skipped=plan.count("skipped"),
        new_categories=list(plan.new_categories.values()),
        rows=plan.rows,
        errors=plan.errors,
    )


def _file_error(error: _FileError, locale: str) -> Exception:
    message = i18n.t(f"lending.csv.{error.code}", locale, **error.params)
    return bad_request(
        "lending_csv_invalid",
        "The CSV cannot be imported",
        {"errors": [{"line": 0, "code": error.code, "message": message}]},
    )


# --- the import --------------------------------------------------------------------------------


async def import_items(
    db: AsyncSession, actor: User, raw: bytes, *, dry_run: bool, locale: str
) -> LendingImportOut:
    """Keepers. See the module's docstring."""
    await service.require_keeper(db, actor)
    try:
        parsed = parse(raw)
    except _FileError as error:
        raise _file_error(error, locale) from None
    if dry_run:
        plan, _ = await _plan(db, parsed, locale, for_update=False)
        await db.rollback()
        return _out(plan, dry_run=True)
    await db.execute(_CATEGORIES_LOCK)
    await db.execute(_ITEMS_LOCK)
    plan, categories = await _plan(db, parsed, locale, for_update=True)
    if plan.errors:
        await db.rollback()
        raise bad_request(
            "lending_csv_invalid",
            "The CSV has errors: nothing was imported",
            {"errors": [e.model_dump() for e in plan.errors]},
        )
    if not plan.creates and not plan.updates:
        await db.rollback()
        return _out(plan, dry_run=False)
    now = utcnow()
    by_key = {c.name_key: c for c in categories.values()}
    position = max((c.position for c in categories.values()), default=-1)
    for key, name in plan.new_categories.items():
        position += 1
        category = LendingCategory(
            name=name,
            name_key=key,
            position=position,
            requires_permission=False,
            max_days=None,
            created_at=now,
            updated_at=now,
        )
        db.add(category)
        await db.flush()
        by_key[key] = category
        await audit.record_in_tx(
            db,
            actor_id=actor.id,
            action="lending_category.created",
            target_type="lending_category",
            target_id=category.id,
            details={"name": name, "via": "import"},
        )

    def category_id(values: _Values, current: uuid.UUID | None) -> uuid.UUID | None:
        if values.category is ABSENT:
            return current
        if values.category is None:
            return None
        return by_key[values.category[1]].id

    changed: list[uuid.UUID] = []
    for index, values in plan.creates:
        item = LendingItem(
            name=values.name,
            category_id=category_id(values, None),
            code=values.code,
            code_key=name_key(values.code) if values.code else None,
            location=_given(values.location),
            notes=_given(values.notes),
            status="available",
            requires_permission=_given(values.permission),
            max_days=_given(values.max_days),
            created_by=actor.id,
            created_at=now,
            updated_by=actor.id,
            updated_at=now,
        )
        db.add(item)
        await db.flush()
        plan.rows[index].item_id = item.id
        changed.append(item.id)
        await service.record(
            db,
            item,
            actor,
            "created",
            {
                "name": item.name,
                "code": item.code,
                "category_id": str(item.category_id) if item.category_id else None,
                "via": "import",
            },
        )
    for item, values in plan.updates:
        update = _Update(item)
        update.set("name", values.name)
        update.set("category_id", category_id(values, item.category_id))
        if values.location is not ABSENT:
            update.set("location", values.location)
        if values.notes is not ABSENT:
            update.set("notes", values.notes, small=False)
        if values.permission is not ABSENT:
            update.set("requires_permission", values.permission)
        if values.max_days is not ABSENT:
            update.set("max_days", values.max_days)
        if not update.fields:
            continue
        item.updated_by = actor.id
        item.updated_at = now
        changed.append(item.id)
        details = {"fields": update.fields, "changes": update.changes, "via": "import"}
        await service.record(db, item, actor, "updated", details)
    out = _out(plan, dry_run=False)
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="lending_import.applied",
        target_type="lending_settings",
        target_id=None,
        details={
            "created": out.created,
            "updated": out.updated,
            "unchanged": out.unchanged,
            "skipped": out.skipped,
            "categories_created": out.new_categories,
        },
    )
    await service.emit(db, item_ids=changed, categories=bool(plan.new_categories))
    await db.commit()
    return out
