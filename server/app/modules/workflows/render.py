"""The pure parts of workflows (WORKFLOWS.md §3): field keys, the values a submitter sends, and
the template they are rendered into. The clients' preview follows the same rules; the vectors in
apps/shared/workflows.json hold both to them.

A value typed by a person never makes a mention: `<` before `@` or `!` becomes the full-width
less-than sign U+FF1C (WORKFLOWS.md D3). Mentions come from user fields (`<@id>`) and from what
the workflow's managers wrote in the template. Review v0.1.30 #4: nor across the boundary between
a value and the template or another value (`<{{link}}>` with `!channel`, or `<` and `!channel>`
in two fields): every `<@`, `<!` or `<#` up to its `>` must be written wholly by the template or
a user field, else its `<` becomes U+FF1C too (`_neutralize`).
"""

import re
import unicodedata
import uuid
from datetime import date, datetime
from typing import Any

from app.modules.messages.schemas import strip_control_chars

WEEKDAYS_JA = ("月", "火", "水", "木", "金", "土", "日")  # date.weekday(): 0 = Monday
FIELD_TYPES = ("text", "textarea", "date", "time", "datetime", "select", "user", "checkbox")
MAX_KEY_LENGTH = 30
MAX_TEXT = 200
MAX_TEXTAREA = 4000
MAX_USERS = 20
PLACEHOLDER = re.compile(r"\{\{\s*([^{}\s]+)\s*\}\}")
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_PATTERN = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
DATETIME_PATTERN = re.compile(r"^(\d{4}-\d{2}-\d{2})T(([01]\d|2[0-3]):([0-5]\d))$")
_MENTION_START = re.compile(r"<(?=[@!])")
# What starts a mention or channel token (`<@id>`, `<@group:id>`, `<!here>`, `<#…>`).
_TOKEN_SIGILS = "@!#"
FULLWIDTH_LT = "\uff1c"


class ValuesError(Exception):
    """Values that do not fit the fields: {key: reason} (required, invalid, too_long,
    not_an_option, user_not_found)."""

    def __init__(self, fields: dict[str, str]) -> None:
        super().__init__("Invalid values")
        self.fields = fields


def normalize_key(key: str) -> str:
    return unicodedata.normalize("NFC", key.strip())


def valid_key(key: str) -> bool:
    """1-30 letters (any script), digits or `_`."""
    return (
        0 < len(key) <= MAX_KEY_LENGTH
        and key == unicodedata.normalize("NFC", key)
        and all(unicodedata.category(ch)[0] in "LN" or ch == "_" for ch in key)
    )


def placeholders(template: str) -> list[str]:
    """The keys of `{{key}}` in order of first appearance."""
    keys: list[str] = []
    for raw in PLACEHOLDER.findall(template):
        key = unicodedata.normalize("NFC", raw)
        if key not in keys:
            keys.append(key)
    return keys


def unknown_placeholders(template: str, keys: list[str]) -> list[str]:
    known = set(keys)
    return [key for key in placeholders(template) if key not in known]


def parse_date(value: str) -> date | None:
    if not DATE_PATTERN.match(value):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def parse_datetime(value: str) -> datetime | None:
    match = DATETIME_PATTERN.match(value)
    if match is None or parse_date(match.group(1)) is None:
        return None
    return datetime.fromisoformat(value)


def valid_time(value: str) -> bool:
    return TIME_PATTERN.match(value) is not None


def _empty(field: dict[str, Any]) -> Any:
    kind = field["type"]
    if kind == "user":
        return []
    if kind == "checkbox":
        return False
    return ""


def _clean_one(field: dict[str, Any], raw: Any) -> Any:
    """The value in its stored shape, or a ValueError whose text is the reason."""
    kind = field["type"]
    if raw is None:
        return _empty(field)
    if kind == "checkbox":
        if not isinstance(raw, bool):
            raise ValueError("invalid")
        return raw
    if kind == "user":
        items = [raw] if isinstance(raw, str) else raw
        if not isinstance(items, list) or not all(isinstance(i, str) for i in items):
            raise ValueError("invalid")
        ids: list[str] = []
        for item in items:
            try:
                user_id = str(uuid.UUID(item))
            except ValueError as exc:
                raise ValueError("invalid") from exc
            if user_id not in ids:
                ids.append(user_id)
        if len(ids) > (MAX_USERS if field.get("multiple") else 1):
            raise ValueError("too_long")
        return ids
    if not isinstance(raw, str):
        raise ValueError("invalid")
    value = strip_control_chars(raw.replace("\r\n", "\n"))
    if kind == "text":
        value = " ".join(value.split())
        if len(value) > MAX_TEXT:
            raise ValueError("too_long")
        return value
    value = value.strip()
    if kind == "textarea":
        if len(value) > MAX_TEXTAREA:
            raise ValueError("too_long")
        return value
    if not value:
        return ""
    if kind == "select":
        if value not in field.get("options", []):
            raise ValueError("not_an_option")
        return value
    if kind == "date" and parse_date(value) is None:
        raise ValueError("invalid")
    if kind == "time" and not valid_time(value):
        raise ValueError("invalid")
    if kind == "datetime" and parse_datetime(value) is None:
        raise ValueError("invalid")
    return value


def is_blank(field: dict[str, Any], value: Any) -> bool:
    """What `required` refuses: nothing typed, nobody chosen, a box left off."""
    if field["type"] == "checkbox":
        return value is not True
    return value in ("", [])


def clean_values(fields: list[dict[str, Any]], values: dict[str, Any]) -> dict[str, Any]:
    """Every field's value in its stored shape (an optional one left out is empty). Raises
    ValuesError with a reason per key, unknown keys included."""
    errors: dict[str, str] = {}
    known = {field["key"] for field in fields}
    for key in values:
        if key not in known:
            errors[key] = "invalid"
    cleaned: dict[str, Any] = {}
    for field in fields:
        key = field["key"]
        try:
            value = _clean_one(field, values.get(key))
        except ValueError as exc:
            errors[key] = str(exc)
            continue
        if field.get("required") and is_blank(field, value):
            errors[key] = "required"
            continue
        cleaned[key] = value
    if errors:
        raise ValuesError(errors)
    return cleaned


def escape_text(value: str) -> str:
    """A typed value cannot call anyone: `<@…` and `<!…` lose their `<`."""
    return _MENTION_START.sub(FULLWIDTH_LT, value)


def _neutralize(text: str, trusted: list[bool]) -> str:
    """`trusted[i]`: whether `text[i]` came from the template or a user field. A `<` followed by
    `@`, `!` or `#` starts a token that runs to the next `>` (or is just those two characters
    when no `>` follows); when any character of it came from a typed value, the `<` becomes
    U+FF1C, so no mention can be put together from a value and its surroundings."""
    chars = list(text)
    for i, ch in enumerate(chars):
        if ch != "<" or i + 1 >= len(chars) or chars[i + 1] not in _TOKEN_SIGILS:
            continue
        close = text.find(">", i + 2)
        end = close if close != -1 else i + 1
        if not all(trusted[i : end + 1]):
            chars[i] = FULLWIDTH_LT
    return "".join(chars)


def date_label(day: date) -> str:
    """「2026年7月28日 (火)」."""
    return f"{day.year}年{day.month}月{day.day}日 ({WEEKDAYS_JA[day.weekday()]})"


def format_value(field: dict[str, Any], value: Any) -> str:
    kind = field["type"]
    if kind == "checkbox":
        return "はい" if value is True else "いいえ"
    if kind == "user":
        return " ".join(f"<@{user_id}>" for user_id in value or [])
    if not value:
        return ""
    if kind == "date":
        day = parse_date(value)
        return date_label(day) if day else ""
    if kind == "datetime":
        moment = parse_datetime(value)
        return f"{date_label(moment.date())} {moment:%H:%M}" if moment else ""
    if kind == "time":
        return str(value)
    return escape_text(str(value))


def render(template: str, fields: list[dict[str, Any]], values: dict[str, Any]) -> str:
    """The message body. A line whose placeholders are all empty is left out; a placeholder
    that names no field stays as it is (saving refuses those). Replaced once: a value holding
    `{{…}}` is not read again. Mentions only from the template and user fields (`_neutralize`)."""
    by_key = {field["key"]: field for field in fields}
    texts = {
        key: format_value(field, values.get(key, _empty(field))) for key, field in by_key.items()
    }
    trusted_keys = {key for key, field in by_key.items() if field["type"] == "user"}

    out: list[str] = []
    trusted: list[bool] = []

    def emit(piece: str, is_trusted: bool) -> None:
        out.append(piece)
        trusted.extend([is_trusted] * len(piece))

    for line in template.replace("\r\n", "\n").split("\n"):
        keys = [unicodedata.normalize("NFC", k) for k in PLACEHOLDER.findall(line)]
        if keys and all(texts.get(key, "x") == "" for key in keys):
            continue
        if out:
            emit("\n", True)
        at = 0
        for match in PLACEHOLDER.finditer(line):
            emit(line[at : match.start()], True)
            key = unicodedata.normalize("NFC", match.group(1))
            if key in texts:
                emit(texts[key], key in trusted_keys)
            else:
                emit(match.group(0), True)  # names no field: the template's own text
            at = match.end()
        emit(line[at:], True)
    return _neutralize("".join(out), trusted).strip("\n")
