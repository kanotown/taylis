"""The UI languages of server-written texts (M115, docs/I18N.md).

The server writes in a person's language what only that person reads: error messages, pushes,
activity items such as reservation notices and reminder notes, the test notification. What many
people share (a channel's join / leave lines, polls, bots' channel posts, AI answers) stays in the
workspace's language, ja.

A person's language: `users.locale` when they chose one ("ja" / "en" / "zh-Hans"), else the one
their app asks for (`Accept-Language`, remembered per device as `devices.locale` for pushes and
stored texts), else ja.

Texts: `errors.json` (generated from apps/shared/errors.json by apps/shared/gen_errors.py) by error
code, `messages.json` (edited here) by key; both {key: {"ja", "en", "zh-Hans"}}. Parameters are
`{name}` (str.format).
"""

import json
import re
import uuid
from functools import cache
from pathlib import Path
from typing import Any, Final, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

Locale = Literal["ja", "en", "zh-Hans"]
LOCALES: Final[tuple[Locale, ...]] = ("ja", "en", "zh-Hans")
DEFAULT: Final[Locale] = "ja"

_HERE = Path(__file__).parent
_RANGE = re.compile(
    r"^\s*([A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*|\*)\s*(?:;\s*q\s*=\s*([0-9.]+))?\s*$"
)


@cache
def _errors() -> dict[str, dict[str, str]]:
    data: dict[str, Any] = json.loads((_HERE / "errors.json").read_text())
    table: dict[str, dict[str, str]] = dict(data["codes"])
    for status, texts in data["status"].items():
        table[f"status:{status}"] = texts
    return table


@cache
def messages() -> dict[str, dict[str, str]]:
    data: dict[str, Any] = json.loads((_HERE / "messages.json").read_text())
    return {k: v for k, v in data.items() if not k.startswith("_")}


def normalize(tag: str | None) -> Locale | None:
    """A language tag as one of ours: ja*, en*, any Chinese (zh, zh-CN, zh-Hans, zh-TW…: the
    only Chinese there is); anything else is None."""
    if not tag:
        return None
    primary = tag.strip().replace("_", "-").split("-")[0].lower()
    if primary == "ja":
        return "ja"
    if primary == "en":
        return "en"
    if primary == "zh":
        return "zh-Hans"
    return None


def from_accept_language(header: str | None) -> Locale | None:
    """The best of ours in an Accept-Language header (by q, then order); None without one."""
    if not header:
        return None
    ranked: list[tuple[float, int, Locale]] = []
    for index, part in enumerate(header.split(",")[:20]):
        match = _RANGE.match(part)
        if match is None:
            continue
        try:
            q = float(match.group(2)) if match.group(2) is not None else 1.0
        except ValueError:
            continue
        found = normalize(match.group(1))
        if found is not None and q > 0:
            ranked.append((-q, index, found))
    return min(ranked)[2] if ranked else None


def effective(user_locale: str | None, accept_language: str | None = None) -> Locale:
    """users.locale, else the request's (or device's) language, else ja."""
    return normalize(user_locale) or from_accept_language(accept_language) or DEFAULT


def error_text(code: str, locale: str, status: int | None = None) -> str | None:
    """The message for an error code (else its HTTP status) in `locale`; None for neither."""
    table = _errors()
    texts = table.get(code)
    if texts is None and status is not None:
        texts = table.get(f"status:{'5xx' if status >= 500 else status}")
    if texts is None:
        return None
    return texts.get(locale) or texts.get(DEFAULT)


def t(key: str, locale: str | None, /, **params: object) -> str:
    """The text for `key` in `locale` (ja when it has none), with `{name}` parameters."""
    texts = messages()[key]
    text = texts.get(normalize(locale) or DEFAULT) or texts[DEFAULT]
    return text.format(**params) if params else text


def weekday(day_index: int, locale: str | None) -> str:
    """Short weekday name, date.weekday() numbering (0 = Monday)."""
    return t("weekdays", locale).split(",")[day_index]


async def text_locale(db: AsyncSession, user: Any) -> Locale:
    """The language of a text stored for one person (an activity item, a reminder note): their
    choice, else the language of the device they used last, else ja."""
    chosen = normalize(getattr(user, "locale", None))
    if chosen is not None:
        return chosen
    from app.modules.auth.models import Device

    user_id: uuid.UUID = user.id
    row = (
        await db.execute(
            select(Device.locale)
            .where(Device.user_id == user_id, Device.enabled.is_(True), Device.locale.is_not(None))
            .order_by(Device.last_seen_at.desc().nulls_last())
            .limit(1)
        )
    ).scalar_one_or_none()
    return normalize(row) or DEFAULT


def device_locale(user: Any, device: Any) -> Locale:
    """The language of a push to one device: the person's choice, else the device's, else ja."""
    return normalize(getattr(user, "locale", None)) or normalize(device.locale) or DEFAULT
