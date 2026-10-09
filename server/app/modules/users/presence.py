"""The quick status menu (docs/PRESENCE.md §11).

オンライン（自動）/ 離席中 / 取り込み中 / オフライン表示.

One choice at a time, stored in the columns that already meant it:

- 取り込み中 = `users.dnd_until` (M12c 「通知を一時停止」: pushes stop while it is ahead).
  「解除するまで」 = DND_INDEFINITE, a fixed far-future instant (clients show 「解除するまで」).
- オフライン表示 = `users.presence_hidden` (L4 「在席を隠す」: others always see me offline).
- 離席中 = `users.presence_manual = 'away'` (the hub announces me as away while connected).
- オンライン（自動）= none of them.

Choosing one clears the others. Expiry needs no job: dnd_until is compared with the clock by the
push planner and by every client.
"""

from datetime import UTC, date, datetime, time, timedelta
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.modules.users.dnd import valid_zone
from app.modules.users.events import USER_UPDATED, emit_user_event
from app.modules.users.models import User

# 「解除するまで」: far enough to never lapse, and every client's date type still parses it.
DND_INDEFINITE = datetime(9999, 12, 31, tzinfo=UTC)
# Clients treat any dnd_until at or after this as 「解除するまで」.
DND_INDEFINITE_FROM = datetime(9999, 1, 1, tzinfo=UTC)
# The zone for 「今日の終わり」 when the request names none and I have no quiet hours.
DEFAULT_TZ = "Asia/Tokyo"

PresenceChoice = Literal["auto", "away", "dnd", "invisible"]
DndDuration = Literal["30m", "1h", "2h", "4h", "today", "tomorrow", "forever"]

_MINUTES: dict[str, int] = {"30m": 30, "1h": 60, "2h": 120, "4h": 240}


class PresenceUpdate(BaseModel):
    """PUT /users/me/presence. `dnd` takes exactly one of `duration` (the menu's choices; the
    server works out 「今日の終わり」 / 「明日まで」 in `tz`) or `until` (a custom instant, ahead of
    now). The other choices take neither."""

    model_config = ConfigDict(extra="forbid")

    status: PresenceChoice
    duration: DndDuration | None = None
    until: AwareDatetime | None = None
    tz: str | None = Field(
        default=None,
        max_length=64,
        description="IANA zone for today / tomorrow; else my quiet hours' zone, else Asia/Tokyo",
    )

    @field_validator("tz")
    @classmethod
    def tz_is_known(cls, value: str | None) -> str | None:
        if value is not None and not valid_zone(value):
            raise ValueError("Unknown time zone")
        return value

    @model_validator(mode="after")
    def until_only_for_dnd(self) -> "PresenceUpdate":
        if self.status == "dnd":
            if (self.duration is None) == (self.until is None):
                raise ValueError("dnd takes exactly one of duration or until")
            if self.until is not None and self.until <= utcnow():
                raise ValueError("until must be in the future")
        elif self.duration is not None or self.until is not None:
            raise ValueError("Only dnd takes duration or until")
        return self


def zone_of(tz: str | None, user: User) -> ZoneInfo:
    if tz:
        return ZoneInfo(tz)
    if user.quiet_hours_tz and valid_zone(user.quiet_hours_tz):
        return ZoneInfo(user.quiet_hours_tz)
    return ZoneInfo(DEFAULT_TZ)


def _end_of(day: date, zone: ZoneInfo) -> datetime:
    """23:59:59 local on `day` (shown as 「〜23:59」; the second left is not worth a push)."""
    return datetime.combine(day, time(23, 59, 59), zone).astimezone(UTC)


def dnd_until_for(duration: DndDuration, now: datetime, zone: ZoneInfo) -> datetime:
    if duration in _MINUTES:
        return now + timedelta(minutes=_MINUTES[duration])
    if duration == "forever":
        return DND_INDEFINITE
    today = now.astimezone(zone).date()
    return _end_of(today if duration == "today" else today + timedelta(days=1), zone)


def apply_choice(user: User, data: PresenceUpdate, now: datetime) -> None:
    user.presence_manual = "away" if data.status == "away" else None
    user.presence_hidden = data.status == "invisible"
    if data.status != "dnd":
        user.dnd_until = None
    elif data.until is not None:
        user.dnd_until = data.until
    else:
        assert data.duration is not None  # the validator's rule
        user.dnd_until = dnd_until_for(data.duration, now, zone_of(data.tz, user))


async def set_presence(db: AsyncSession, user: User, data: PresenceUpdate) -> User:
    """Applies the choice and tells everyone (user.updated: others see dnd_until, my other devices
    read /users/me again). The caller updates the hub."""
    now = utcnow()
    apply_choice(user, data, now)
    user.updated_at = now
    await db.flush()
    await emit_user_event(db, USER_UPDATED, user)
    await db.commit()
    return user
