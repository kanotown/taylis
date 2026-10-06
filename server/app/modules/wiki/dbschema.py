"""Wiki databases without the database (docs/WIKI.md §5, M123): property values, conversions
between types, filters and sorts. Pure functions on the stored JSON, so the query of 5,000 rows
stays in plain Python (§5.4) and the tests can call them directly.

A schema is {"properties": [prop]}; a prop is {"id", "name", "type", "options"?, "number_format"?,
"relation"?: {"database_id", "pair_id", "primary"}}. A row's values are {prop_id: value} for the
stored types; relations are kept in wiki_relations and come in as `Ctx.relations`.
"""

import math
import re
import secrets
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any
from uuid import UUID

from app.core.collation import name_key

MAX_ROWS = 5000
MAX_PROPERTIES = 50
MAX_OPTIONS = 200
MAX_VIEWS = 20
MAX_TEXT = 2000
MAX_URL = 2000

TITLE_ID = "title"
# The types whose values a row keeps in `props`.
STORED = frozenset(
    ("text", "number", "select", "multi_select", "date", "person", "checkbox", "url")
)
COMPUTED = frozenset(("created_time", "updated_time", "created_by", "updated_by"))
TEXTUAL = frozenset(("title", "text", "url"))
DATEISH = frozenset(("date", "created_time", "updated_time"))
PEOPLE = frozenset(("person", "created_by", "updated_by"))
COLORS = ("gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red")


class InvalidValue(ValueError):
    """A value that does not fit its property (422 wiki_invalid_property_value)."""


class InvalidView(ValueError):
    """A sort or filter that does not fit the schema (400 wiki_invalid_view)."""


def new_id(taken: Iterable[str] = ()) -> str:
    used = set(taken)
    while True:
        candidate = secrets.token_hex(5)
        if candidate not in used and not candidate.isdigit():
            return candidate


@dataclass
class Row:
    """A row as the query needs it (no body)."""

    id: UUID
    title: str
    icon: str | None
    props: dict[str, Any]
    position: str
    version: int
    head_rev_id: UUID
    created_at: datetime
    created_by: UUID
    updated_at: datetime
    updated_by: UUID


@dataclass
class Ctx:
    """What values are read with: people's names, who asks, and the relation cells (the linked
    rows the asker can read, and which cells also link to rows they cannot)."""

    names: Mapping[str, str] = field(default_factory=dict)
    actor_id: str | None = None
    # prop_id → row id → linked row ids the asker can read, in order.
    relations: Mapping[str, Mapping[UUID, Sequence[UUID]]] = field(default_factory=dict)
    # prop_id → rows whose cell also links to rows the asker cannot read.
    hidden: Mapping[str, set[UUID]] = field(default_factory=dict)
    # row id → title (relation cells as text: only readable rows).
    titles: Mapping[UUID, str] = field(default_factory=dict)


def default_schema() -> dict[str, Any]:
    """A new database: the title property alone (its name "" is the clients' word, 「名前」)."""
    return {"properties": [{"id": TITLE_ID, "name": "", "type": "title"}]}


def view_doc(view_id: str, view: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "id": view_id,
        "name": view.get("name", ""),
        "type": view.get("type", "table"),
        "columns": list(view.get("columns") or []),
        "sort": list(view.get("sort") or []),
        "filter": view.get("filter"),
        "date_prop_id": view.get("date_prop_id"),
    }


def default_views() -> list[dict[str, Any]]:
    """A new database's one table view (name "": the clients' word, 「表」)."""
    return [view_doc(new_id(), {})]


def props_by_id(schema: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    return {p["id"]: p for p in schema.get("properties", [])}


# --- values --------------------------------------------------------------------------------------

_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _parse_day(text: str) -> date:
    if not _DATE.match(text):
        raise InvalidValue("A date is YYYY-MM-DD")
    try:
        return date.fromisoformat(text)
    except ValueError as exc:
        raise InvalidValue("Not a date") from exc


def _parse_moment(text: str) -> datetime:
    try:
        moment = datetime.fromisoformat(text)
    except ValueError as exc:
        raise InvalidValue("A time is ISO 8601 with its offset") from exc
    if moment.tzinfo is None:
        raise InvalidValue("A time needs its offset (+09:00)")
    return moment


def _date_value(raw: Any) -> dict[str, Any]:
    if isinstance(raw, str):
        raw = {"start": raw, "end": None, "time": "T" in raw}
    if not isinstance(raw, dict) or not isinstance(raw.get("start"), str):
        raise InvalidValue("A date is {start, end, time}")
    timed = bool(raw.get("time", False))
    end = raw.get("end")
    if end is not None and not isinstance(end, str):
        raise InvalidValue("A date's end is a string or null")
    if timed:
        start_at = _parse_moment(raw["start"])
        end_at = _parse_moment(end) if end else None
        if end_at is not None and end_at < start_at:
            raise InvalidValue("A date range ends before it starts")
        return {
            "start": start_at.isoformat(),
            "end": end_at.isoformat() if end_at else None,
            "time": True,
        }
    start_day = _parse_day(raw["start"])
    end_day = _parse_day(end) if end else None
    if end_day is not None and end_day < start_day:
        raise InvalidValue("A date range ends before it starts")
    return {
        "start": start_day.isoformat(),
        "end": end_day.isoformat() if end_day else None,
        "time": False,
    }


def day_of(text: str) -> date:
    """The calendar day of a stored date or time (a time on its own offset's day)."""
    return date.fromisoformat(text[:10])


def date_span(value: Any) -> tuple[date, date] | None:
    """(first day, last day) of a stored date value."""
    if not isinstance(value, dict) or not isinstance(value.get("start"), str):
        return None
    first = day_of(value["start"])
    last = day_of(value["end"]) if value.get("end") else first
    return first, max(first, last)


def is_url(text: str) -> bool:
    return bool(re.match(r"^https?://[^\s/$.?#][^\s]*$", text, re.IGNORECASE))


def normalize_value(prop: Mapping[str, Any], raw: Any, *, known_users: set[str] | None) -> Any:
    """The stored form of a value for `prop` (None: the cell is empty), or InvalidValue.
    `known_users`: the ids a person value may name (None: not checked)."""
    kind = prop["type"]
    if raw is None:
        return None
    if kind == "text":
        if not isinstance(raw, str):
            raise InvalidValue("Text is a string")
        text = raw.replace("\r\n", "\n").strip()
        if len(text) > MAX_TEXT:
            raise InvalidValue(f"Text is at most {MAX_TEXT} characters")
        return text or None
    if kind == "url":
        if not isinstance(raw, str):
            raise InvalidValue("A URL is a string")
        text = raw.strip()
        if not text:
            return None
        if len(text) > MAX_URL or not is_url(text):
            raise InvalidValue("A URL starts with http:// or https://")
        return text
    if kind == "number":
        if isinstance(raw, bool) or not isinstance(raw, int | float):
            raise InvalidValue("A number is a number")
        number = float(raw)
        if not math.isfinite(number) or abs(number) > 1e15:
            raise InvalidValue("The number is out of range")
        return number
    if kind == "checkbox":
        if not isinstance(raw, bool):
            raise InvalidValue("A checkbox is true or false")
        return raw or None
    if kind == "select":
        if not isinstance(raw, str):
            raise InvalidValue("A select is an option id")
        if raw not in {o["id"] for o in prop.get("options", [])}:
            raise InvalidValue("No such option")
        return raw
    if kind == "multi_select":
        if not isinstance(raw, list) or not all(isinstance(v, str) for v in raw):
            raise InvalidValue("A multi-select is a list of option ids")
        options = {o["id"] for o in prop.get("options", [])}
        ids = list(dict.fromkeys(raw))
        if any(v not in options for v in ids):
            raise InvalidValue("No such option")
        return ids or None
    if kind == "person":
        if not isinstance(raw, list) or not all(isinstance(v, str) for v in raw):
            raise InvalidValue("A person value is a list of user ids")
        try:
            ids = list(dict.fromkeys(str(UUID(v)) for v in raw))
        except ValueError as exc:
            raise InvalidValue("Not a user id") from exc
        if len(ids) > 50:
            raise InvalidValue("At most 50 people")
        if known_users is not None and any(v not in known_users for v in ids):
            raise InvalidValue("No such user")
        return ids or None
    if kind == "date":
        return _date_value(raw)
    raise InvalidValue("This property cannot be set")


# --- values as text (CSV, search, conversions) ---------------------------------------------------


def _number_text(number: float) -> str:
    if number.is_integer():
        return str(int(number))
    return f"{number:.15g}"


def _option_names(prop: Mapping[str, Any]) -> dict[str, str]:
    return {o["id"]: o["name"] for o in prop.get("options", [])}


def _date_text(value: Mapping[str, Any]) -> str:
    if value.get("end"):
        return f"{value['start']} → {value['end']}"
    return str(value["start"])


def cell_value(prop: Mapping[str, Any], row: Row) -> Any:
    """The value of `prop` for the row, computed ones too (relations are in Ctx)."""
    kind = prop["type"]
    if kind == "title":
        return row.title or None
    if kind == "created_time":
        return {"start": row.created_at.isoformat(), "end": None, "time": True}
    if kind == "updated_time":
        return {"start": row.updated_at.isoformat(), "end": None, "time": True}
    if kind == "created_by":
        return [str(row.created_by)]
    if kind == "updated_by":
        return [str(row.updated_by)]
    return row.props.get(prop["id"])


def value_text(prop: Mapping[str, Any], value: Any, ctx: Ctx) -> str:
    """A stored value as plain text (CSV, the search text, a conversion to text)."""
    if value is None:
        return ""
    kind = prop["type"]
    if kind in ("title", "text", "url"):
        return str(value)
    if kind == "number":
        return _number_text(float(value))
    if kind == "checkbox":
        return "Yes" if value else "No"
    if kind == "select":
        return _option_names(prop).get(value, "")
    if kind == "multi_select":
        names = _option_names(prop)
        return ", ".join(names[v] for v in value if v in names)
    if kind in DATEISH:
        return _date_text(value)
    if kind in PEOPLE:
        return ", ".join(ctx.names.get(v, "") for v in value if ctx.names.get(v))
    return ""


def relation_text(prop_id: str, row_id: UUID, ctx: Ctx, hidden_label: str) -> str:
    titles = [ctx.titles.get(t, "") for t in ctx.relations.get(prop_id, {}).get(row_id, ())]
    if row_id in ctx.hidden.get(prop_id, set()):
        titles.append(hidden_label)
    return ", ".join(titles)


def search_text(
    schema: Mapping[str, Any], props: Mapping[str, Any], names: Mapping[str, str]
) -> str:
    """wiki_pages.props_text: the stored values as words for search (WIKI.md §8.1). Relations
    are not in it (a linked row's title must not be found through a row that links to it)."""
    ctx = Ctx(names=names)
    out = []
    for prop in schema.get("properties", []):
        if prop["type"] in STORED:
            text = value_text(prop, props.get(prop["id"]), ctx)
            if text:
                out.append(text)
    return "\n".join(out)


# --- conversions (WIKI.md §5.2) ------------------------------------------------------------------

_YES = {"yes", "true", "1", "✓", "✔", "☑", "x", "はい", "済", "on"}
_NO = {"no", "false", "0", "いいえ", "off", "-"}
_JP_DATE = re.compile(r"^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日$")
_SLASH_DATE = re.compile(r"^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$")
_MONTHS = {
    m: i + 1
    for i, m in enumerate(
        ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")
    )
}
_EN_DATE = re.compile(r"^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})$")


def _day_from_text(text: str) -> date | None:
    text = text.strip()
    for pattern in (_JP_DATE, _SLASH_DATE):
        found = pattern.match(text)
        if found:
            try:
                return date(int(found[1]), int(found[2]), int(found[3]))
            except ValueError:
                return None
    found = _EN_DATE.match(text)
    if found and found[1].lower() in _MONTHS:
        try:
            return date(int(found[3]), _MONTHS[found[1].lower()], int(found[2]))
        except ValueError:
            return None
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None


def date_from_text(text: str) -> dict[str, Any] | None:
    parts = [p.strip() for p in text.split("→")]
    if len(parts) > 2 or not parts[0]:
        return None
    try:
        timed = "T" in parts[0] and _parse_moment(parts[0]) is not None
    except InvalidValue:
        timed = False
    if timed:
        try:
            return _date_value(
                {"start": parts[0], "end": parts[1] if len(parts) == 2 else None, "time": True}
            )
        except InvalidValue:
            return None
    days = [_day_from_text(p) for p in parts]
    if any(d is None for d in days):
        return None
    first = days[0]
    last = days[1] if len(days) == 2 else None
    assert first is not None
    if last is not None and last < first:
        return None
    return {"start": first.isoformat(), "end": last.isoformat() if last else None, "time": False}


def number_from_text(text: str) -> float | None:
    cleaned = text.strip().replace(",", "").replace("\uff0c", "")
    cleaned = cleaned.removeprefix("¥").removeprefix("￥").removesuffix("円").strip()
    percent = cleaned.endswith("%")
    cleaned = cleaned.removesuffix("%").strip()
    try:
        number = float(cleaned)
    except ValueError:
        return None
    if not math.isfinite(number) or abs(number) > 1e15:
        return None
    return number / 100 if percent else number


def split_list(text: str) -> list[str]:
    parts = (" ".join(p.split()) for p in re.split("[,\u3001\uff0c]", text))
    return [part for part in parts if part]


@dataclass
class Conversion:
    """Turning every row's value of one property into a new type."""

    old: Mapping[str, Any]
    new: dict[str, Any]
    ctx: Ctx
    # A person's name (display name or username, case folded) → user id.
    people: Mapping[str, str] = field(default_factory=dict)

    def prepare(self, values: Iterable[Any]) -> None:
        """Before converting to a select / multi-select: one option for each distinct word, in
        first-seen order (the old type's options keep their ids and colours)."""
        if self.new["type"] not in ("select", "multi_select"):
            return
        options: list[dict[str, Any]] = []
        by_name: dict[str, dict[str, Any]] = {}
        if self.old["type"] in ("select", "multi_select"):
            for option in self.old.get("options", []):
                options.append(dict(option))
                by_name.setdefault(option["name"].casefold(), options[-1])
        for value in values:
            for word in self._words(value):
                if word.casefold() in by_name or len(options) >= MAX_OPTIONS:
                    continue
                option = {
                    "id": new_id(o["id"] for o in options),
                    "name": word[:100],
                    "color": COLORS[len(options) % len(COLORS)],
                }
                options.append(option)
                by_name[word.casefold()] = option
        self.new["options"] = options
        self._by_name = {k: v["id"] for k, v in by_name.items()}

    def _words(self, value: Any) -> list[str]:
        if value is None:
            return []
        if self.old["type"] in ("select", "multi_select"):
            return []  # the old options are kept as they are
        text = value_text(self.old, value, self.ctx)
        if not text:
            return []
        if self.new["type"] == "multi_select":
            return split_list(text)
        return [" ".join(text.split())[:100]]

    def convert(self, value: Any) -> tuple[Any, bool]:
        """(the new value or None, whether something was lost)."""
        if value is None:
            return None, False
        old, new = self.old["type"], self.new["type"]
        if new in COMPUTED or new == "relation" or old == "relation":
            return None, True
        if old == new:
            return value, False
        if old == "select" and new == "multi_select":
            return [value], False
        if old == "multi_select" and new == "select":
            return (value[0] if value else None), len(value) > 1
        if old in PEOPLE and new == "person":
            return list(value), False
        if old in DATEISH and new == "date":
            return dict(value), False
        if old == "number" and new == "checkbox":
            return (float(value) != 0) or None, False
        if old == "checkbox" and new == "number":
            return (1.0 if value else 0.0), False
        text = value_text(self.old, value, self.ctx)
        converted = self.from_text(text)
        if new == "checkbox":
            return converted, self.lost_checkbox(text)
        return converted, converted is None and bool(text)

    def from_text(self, text: str) -> Any:
        new = self.new["type"]
        text = text.strip()
        if not text:
            return None
        if new == "text":
            return text[:MAX_TEXT]
        if new == "url":
            return text if is_url(text) and len(text) <= MAX_URL else None
        if new == "number":
            return number_from_text(text)
        if new == "checkbox":
            return True if text.casefold() in _YES else None
        if new == "date":
            return date_from_text(text)
        if new == "select":
            return getattr(self, "_by_name", {}).get(" ".join(text.split())[:100].casefold())
        if new == "multi_select":
            by_name = getattr(self, "_by_name", {})
            ids = [by_name[w.casefold()] for w in split_list(text) if w.casefold() in by_name]
            return list(dict.fromkeys(ids)) or None
        if new == "person":
            ids = [self.people.get(w.casefold()) for w in split_list(text)]
            found = [i for i in ids if i]
            return list(dict.fromkeys(found)) if found and len(found) == len(ids) else None
        return None

    def lost_checkbox(self, text: str) -> bool:
        return text.casefold() not in _YES | _NO


# --- filters -------------------------------------------------------------------------------------

Predicate = Callable[[Row], bool]

_OPS: dict[str, frozenset[str]] = {
    "text": frozenset(
        (
            "contains",
            "not_contains",
            "equals",
            "not_equals",
            "starts_with",
            "is_empty",
            "is_not_empty",
        )
    ),
    "number": frozenset(
        ("equals", "not_equals", "gt", "gte", "lt", "lte", "is_empty", "is_not_empty")
    ),
    "select": frozenset(("equals", "not_equals", "is_empty", "is_not_empty")),
    "multi_select": frozenset(("contains", "not_contains", "is_empty", "is_not_empty")),
    "date": frozenset(
        (
            "equals",
            "before",
            "after",
            "on_or_before",
            "on_or_after",
            "between",
            "is_empty",
            "is_not_empty",
        )
    ),
    "person": frozenset(("contains", "not_contains", "is_empty", "is_not_empty")),
    "checkbox": frozenset(("equals",)),
    "relation": frozenset(("contains", "not_contains", "is_empty", "is_not_empty")),
}


def _family(kind: str) -> str:
    if kind in TEXTUAL:
        return "text"
    if kind in DATEISH:
        return "date"
    if kind in PEOPLE:
        return "person"
    return kind


def ops_for(kind: str) -> frozenset[str]:
    return _OPS[_family(kind)]


def _filter_day(value: Any) -> date:
    if not isinstance(value, str):
        raise InvalidView("A date filter takes YYYY-MM-DD")
    try:
        return _parse_day(value)
    except InvalidValue as exc:
        raise InvalidView(str(exc)) from exc


def _condition(prop: Mapping[str, Any], op: str, value: Any, ctx: Ctx) -> Predicate:
    kind = prop["type"]
    pid = prop["id"]
    if op not in ops_for(kind):
        raise InvalidView(f"{op} does not apply to a {kind} property")
    if kind == "relation":
        links = ctx.relations.get(pid, {})
        hidden = ctx.hidden.get(pid, set())
        if op in ("is_empty", "is_not_empty"):
            want = op == "is_empty"
            return lambda r: (not links.get(r.id) and r.id not in hidden) == want
        try:
            target = UUID(str(value))
        except ValueError as exc:
            raise InvalidView("A relation filter takes a row id") from exc
        # Only the rows the asker can read are looked at (an unreadable row matches nothing).
        if op == "contains":
            return lambda r: target in links.get(r.id, ())
        return lambda r: target not in links.get(r.id, ())

    def get(row: Row) -> Any:
        return cell_value(prop, row)

    if op == "is_empty":
        return lambda r: get(r) in (None, "", [])
    if op == "is_not_empty":
        return lambda r: get(r) not in (None, "", [])
    family = _family(kind)
    if family == "text":
        if not isinstance(value, str):
            raise InvalidView("A text filter takes text")
        needle = value.casefold()
        if op == "contains":
            return lambda r: needle in (get(r) or "").casefold()
        if op == "not_contains":
            return lambda r: needle not in (get(r) or "").casefold()
        if op == "equals":
            return lambda r: (get(r) or "").casefold() == needle
        if op == "not_equals":
            return lambda r: (get(r) or "").casefold() != needle
        return lambda r: (get(r) or "").casefold().startswith(needle)
    if family == "number":
        if isinstance(value, bool) or not isinstance(value, int | float):
            raise InvalidView("A number filter takes a number")
        n = float(value)
        compare: dict[str, Callable[[float], bool]] = {
            "equals": lambda v: v == n,
            "not_equals": lambda v: v != n,
            "gt": lambda v: v > n,
            "gte": lambda v: v >= n,
            "lt": lambda v: v < n,
            "lte": lambda v: v <= n,
        }
        test = compare[op]
        if op == "not_equals":
            return lambda r: get(r) is None or test(float(get(r)))
        return lambda r: get(r) is not None and test(float(get(r)))
    if family == "checkbox":
        if not isinstance(value, bool):
            raise InvalidView("A checkbox filter takes true or false")
        return lambda r: bool(get(r)) == value
    if family == "select":
        if not isinstance(value, str):
            raise InvalidView("A select filter takes an option id")
        if op == "equals":
            return lambda r: get(r) == value
        return lambda r: get(r) != value
    if family == "multi_select":
        if not isinstance(value, str):
            raise InvalidView("A multi-select filter takes an option id")
        if op == "contains":
            return lambda r: value in (get(r) or ())
        return lambda r: value not in (get(r) or ())
    if family == "person":
        if not isinstance(value, str):
            raise InvalidView("A person filter takes a user id or me")
        who = ctx.actor_id if value == "me" else value
        if op == "contains":
            return lambda r: who in (get(r) or ())
        return lambda r: who not in (get(r) or ())
    # dates: a range matches when it touches the day(s) asked for.
    if op == "between":
        if not isinstance(value, dict):
            raise InvalidView("between takes {start, end}")
        low, high = _filter_day(value.get("start")), _filter_day(value.get("end"))
    else:
        low = high = _filter_day(value)

    def span(row: Row) -> tuple[date, date] | None:
        return date_span(get(row))

    tests: dict[str, Callable[[tuple[date, date]], bool]] = {
        "equals": lambda s: s[0] <= low and s[1] >= low,
        "between": lambda s: s[0] <= high and s[1] >= low,
        "before": lambda s: s[0] < low,
        "after": lambda s: s[1] > low,
        "on_or_before": lambda s: s[0] <= low,
        "on_or_after": lambda s: s[1] >= low,
    }
    date_test = tests[op]

    def matches(row: Row) -> bool:
        found = span(row)
        return found is not None and date_test(found)

    return matches


def compile_filter(
    schema: Mapping[str, Any], group: Mapping[str, Any] | None, ctx: Ctx
) -> Predicate | None:
    """One predicate for a filter group (None: everything). Conditions on a property that is
    gone are left out (a saved view may name one)."""
    if not group or not group.get("conditions"):
        return None
    props = props_by_id(schema)
    tests = [
        _condition(props[c["prop_id"]], c["op"], c.get("value"), ctx)
        for c in group["conditions"]
        if c["prop_id"] in props
    ]
    if not tests:
        return None
    if group.get("combinator", "and") == "or":
        return lambda r: any(t(r) for t in tests)
    return lambda r: all(t(r) for t in tests)


def check_view(schema: Mapping[str, Any], view: Mapping[str, Any]) -> None:
    """A saved view's sort, filter and calendar property fit the schema (InvalidView)."""
    props = props_by_id(schema)
    for key in view.get("sort") or []:
        prop = props.get(key["prop_id"])
        if prop is None or prop["type"] == "relation":
            raise InvalidView("Sort by a property of the database (not a relation)")
    group = view.get("filter")
    if group:
        for c in group.get("conditions", []):
            if c["prop_id"] not in props:
                raise InvalidView("Filter by a property of the database")
        compile_filter(schema, group, Ctx(actor_id="me"))
    if view.get("type") == "calendar":
        prop = props.get(view.get("date_prop_id") or "")
        if prop is None or prop["type"] not in DATEISH:
            raise InvalidView("A calendar needs a date property")


def in_range(prop: Mapping[str, Any], first: date, last: date) -> Predicate:
    def test(row: Row) -> bool:
        found = date_span(cell_value(prop, row))
        return found is not None and found[0] <= last and found[1] >= first

    return test


# --- sorting -------------------------------------------------------------------------------------


def _sort_key(prop: Mapping[str, Any], ctx: Ctx) -> Callable[[Any], Any]:
    kind = prop["type"]
    if kind in TEXTUAL:
        return lambda v: name_key(v)
    if kind == "number":
        return float
    if kind == "checkbox":
        return bool
    if kind in ("select", "multi_select"):
        order = {o["id"]: i for i, o in enumerate(prop.get("options", []))}
        if kind == "select":
            return lambda v: order.get(v, len(order))
        return lambda v: tuple(sorted(order.get(x, len(order)) for x in v))
    if kind in DATEISH:

        def moment(v: Any) -> tuple[str, int, float]:
            start = str(v["start"])
            # By day; on a day, a date before the times, the times by their instant.
            if len(start) == 10:
                return (start, 0, 0.0)
            return (start[:10], 1, datetime.fromisoformat(start).timestamp())

        return moment
    if kind in PEOPLE:
        return lambda v: tuple(name_key(ctx.names.get(x, "")) for x in v)
    raise InvalidView("This property cannot be sorted")


def sort_rows(
    rows: list[Row], schema: Mapping[str, Any], keys: Sequence[Mapping[str, Any]], ctx: Ctx
) -> list[Row]:
    """`rows` (already in the database's own order) by the keys; empty cells last in either
    direction (as Notion)."""
    props = props_by_id(schema)
    out = rows
    for key in reversed(list(keys)):
        prop = props.get(key["prop_id"])
        if prop is None:
            continue
        make = _sort_key(prop, ctx)
        values = [
            (cell_value(prop, r) if prop["type"] != "checkbox" else bool(cell_value(prop, r)))
            for r in out
        ]
        if prop["type"] == "checkbox":
            filled = list(zip(out, values, strict=True))
            empty: list[tuple[Row, Any]] = []
        else:
            filled = [(r, v) for r, v in zip(out, values, strict=True) if v not in (None, "", [])]
            empty = [(r, v) for r, v in zip(out, values, strict=True) if v in (None, "", [])]
        filled.sort(key=lambda pair: make(pair[1]), reverse=key.get("direction") == "desc")
        out = [r for r, _ in filled] + [r for r, _ in empty]
    return out
