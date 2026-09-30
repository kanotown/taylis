from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator

from app.core.time import utcnow
from app.modules.users.models import User

EMAIL_PATTERN = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"


TIME_PATTERN = r"^([01]\d|2[0-3]):[0-5]\d$"


class QuietHours(BaseModel):
    """A daily window (in the user's zone) during which pushes are held back (M12c)."""

    model_config = ConfigDict(extra="forbid")

    start: str = Field(pattern=TIME_PATTERN, description="HH:MM local time")
    end: str = Field(pattern=TIME_PATTERN, description="HH:MM local time; before start = overnight")
    days: list[int] = Field(default_factory=lambda: list(range(7)), max_length=7)
    tz: str = Field(min_length=1, max_length=64, description="IANA zone, e.g. Asia/Tokyo")

    @field_validator("days")
    @classmethod
    def days_are_weekdays(cls, value: list[int]) -> list[int]:
        cleaned = sorted(set(value))
        if not cleaned or any(day < 0 or day > 6 for day in cleaned):
            raise ValueError("days must be weekdays 0 (Monday) to 6 (Sunday)")
        return cleaned

    @field_validator("tz")
    @classmethod
    def tz_is_known(cls, value: str) -> str:
        from app.modules.users.dnd import valid_zone

        if not valid_zone(value):
            raise ValueError("Unknown time zone")
        return value

    @property
    def start_minutes(self) -> int:
        return _minutes(self.start)

    @property
    def end_minutes(self) -> int:
        return _minutes(self.end)


def _minutes(text: str) -> int:
    hours, minutes = text.split(":")
    return int(hours) * 60 + int(minutes)


def _hhmm(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


class UserPublic(BaseModel):
    id: UUID
    username: str
    display_name: str
    role: str
    deactivated_at: datetime | None
    created_at: datetime
    updated_at: datetime
    # Profile card (M11d). An expired status is reported as no status.
    title: str | None = None
    status_text: str | None = None
    status_emoji: str | None = None
    status_expires_at: datetime | None = None
    # Do not disturb (M12c): public so that clients can show 🔕 next to the name.
    dnd_until: datetime | None = None
    quiet_hours: QuietHours | None = None
    # M14a: when the picture changed (clients cache by it); null = no picture.
    avatar_updated_at: datetime | None = None


class UserMe(UserPublic):
    email: str | None
    must_change_password: bool
    # M12g: words that make a message count as a mention of me (case-insensitive substring).
    notify_keywords: list[str] = []
    # L4 (M31): others see me as offline.
    presence_hidden: bool = False
    # M35: what channels without a level of their own notify me of (PUSH_NOTIFICATIONS.md §4).
    notification_default: Literal["all", "mentions", "none"] = "mentions"
    # M39: a push when someone reacts to my message (banner); the activity lists reactions either
    # way.
    notify_reactions: bool = False


class UserUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    display_name: str | None = Field(default=None, min_length=1, max_length=80)
    email: str | None = Field(default=None, max_length=254, pattern=EMAIL_PATTERN)
    # M11d: send null to clear. Omitted fields keep their value (model_fields_set).
    title: str | None = Field(default=None, max_length=80)
    status_text: str | None = Field(default=None, max_length=100)
    status_emoji: str | None = Field(default=None, max_length=32)
    status_expires_at: AwareDatetime | None = None
    # M12c: null clears; a past dnd_until also clears.
    dnd_until: AwareDatetime | None = None
    quiet_hours: QuietHours | None = None
    # M12g: at most 20 keywords of 1-40 characters; blanks and duplicates are dropped.
    notify_keywords: list[str] | None = Field(default=None, max_length=20)
    # L4 (M31): hide my presence from everyone else.
    presence_hidden: bool | None = None
    # M35: my overall notification setting.
    notification_default: Literal["all", "mentions", "none"] | None = None
    # M39: reaction banners on or off.
    notify_reactions: bool | None = None

    @field_validator("notify_keywords")
    @classmethod
    def keywords_are_short_and_unique(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        cleaned: list[str] = []
        seen: set[str] = set()
        for raw in value:
            word = raw.strip()
            if not word:
                continue
            if len(word) > 40:
                raise ValueError("Keywords are at most 40 characters")
            if word.lower() in seen:
                continue
            seen.add(word.lower())
            cleaned.append(word)
        return cleaned

    @field_validator("display_name")
    @classmethod
    def display_name_not_null(cls, value: str | None) -> str:
        if value is None:
            raise ValueError("Display name cannot be null")
        return value


def to_user_public(user: User, now: datetime | None = None) -> UserPublic:
    expired = user.status_expires_at is not None and user.status_expires_at <= (now or utcnow())
    return UserPublic(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        role=user.role,
        deactivated_at=user.deactivated_at,
        created_at=user.created_at,
        updated_at=user.updated_at,
        title=user.title,
        status_text=None if expired else user.status_text,
        status_emoji=None if expired else user.status_emoji,
        status_expires_at=None if expired else user.status_expires_at,
        dnd_until=user.dnd_until if user.dnd_until and user.dnd_until > (now or utcnow()) else None,
        quiet_hours=quiet_hours_of(user),
        avatar_updated_at=user.avatar_updated_at,
    )


def quiet_hours_of(user: User) -> QuietHours | None:
    if user.quiet_hours_start is None or user.quiet_hours_end is None or not user.quiet_hours_tz:
        return None
    return QuietHours(
        start=_hhmm(user.quiet_hours_start),
        end=_hhmm(user.quiet_hours_end),
        days=user.quiet_hours_days or list(range(7)),
        tz=user.quiet_hours_tz,
    )


def to_user_me(user: User) -> UserMe:
    return UserMe(
        **to_user_public(user).model_dump(),
        email=user.email,
        must_change_password=user.must_change_password,
        notify_keywords=list(user.notify_keywords or []),
        presence_hidden=user.presence_hidden,
        notification_default=user.notification_default,  # type: ignore[arg-type]
        notify_reactions=user.notify_reactions,
    )
