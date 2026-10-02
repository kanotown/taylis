from uuid import UUID

from fastapi import APIRouter, Path, Query, Request, Response
from pydantic import AwareDatetime

from app.core.db import Db
from app.core.errors import bad_request, not_found, rate_limited
from app.core.ratelimit import RateLimiter
from app.modules.auth.deps import CurrentUser
from app.modules.calendar import service
from app.modules.calendar.schemas import (
    CalendarAlarmIn,
    CalendarEventCreate,
    CalendarEventOut,
    CalendarEventUpdate,
    CalendarFeedCreate,
    CalendarFeedCreated,
    CalendarFeedOut,
    CalendarOccurrenceUpdate,
    OccurrenceScope,
)
from app.modules.users.dnd import valid_zone

router = APIRouter(tags=["calendar"])

# CALENDAR.md §4. Personal events: their owner only; a channel's: its members (§3). An event
# someone cannot see is 404.


@router.get("/calendar/events", response_model=list[CalendarEventOut])
async def list_events(
    user: CurrentUser,
    db: Db,
    start: AwareDatetime = Query(alias="from", description="Start of the range (with offset)"),
    end: AwareDatetime = Query(
        alias="to", description="End of the range, excluded; at most 100 days after `from`"
    ),
    channel_id: UUID | None = Query(default=None, description="Only this channel's calendar"),
) -> list[CalendarEventOut]:
    """Events overlapping the range: my own and those of the channels I belong to (at most
    1000). All-day events overlap by date, in the offsets `from` and `to` carry (pass the
    device's local midnights)."""
    return await service.list_range(db, user, start, end, channel_id)


@router.get("/calendar/upcoming", response_model=list[CalendarEventOut])
async def upcoming(
    user: CurrentUser,
    db: Db,
    days: int = Query(default=2, ge=1, le=7, description="Today and the next days"),
    channel_id: UUID | None = Query(default=None),
    tz: str | None = Query(default=None, max_length=64, description="IANA zone of the days"),
) -> list[CalendarEventOut]:
    """Events of today (and tomorrow) not over yet, earliest first, at most 10: a channel's
    header and the home."""
    if tz is not None and not valid_zone(tz):
        raise bad_request("validation_error", "Unknown time zone")
    return await service.upcoming(db, user, days=days, channel_id=channel_id, tz=tz)


@router.post(
    "/calendar/events",
    response_model=CalendarEventOut,
    status_code=201,
    responses={200: {"model": CalendarEventOut, "description": "A retry: the event made before"}},
)
async def create_event(
    body: CalendarEventCreate, user: CurrentUser, db: Db, response: Response
) -> CalendarEventOut:
    """A new event in my calendar or a channel's (a member who may post there)."""
    out, created = await service.create(db, user, body)
    response.status_code = 201 if created else 200
    return out


@router.get("/calendar/events/{event_id}", response_model=CalendarEventOut)
async def get_event(event_id: UUID, user: CurrentUser, db: Db) -> CalendarEventOut:
    return await service.get_event(db, user, event_id)


@router.patch("/calendar/events/{event_id}", response_model=CalendarEventOut)
async def update_event(
    event_id: UUID, body: CalendarEventUpdate, user: CurrentUser, db: Db
) -> CalendarEventOut:
    """The creator, the channel's owners and administrators (not in an archived channel)."""
    return await service.update(db, user, event_id, body)


@router.delete("/calendar/events/{event_id}", status_code=204)
async def delete_event(event_id: UUID, user: CurrentUser, db: Db) -> Response:
    await service.delete(db, user, event_id)
    return Response(status_code=204)


@router.put("/calendar/events/{event_id}/alarm", response_model=CalendarEventOut)
async def set_alarm(
    event_id: UUID, body: CalendarAlarmIn, user: CurrentUser, db: Db
) -> CalendarEventOut:
    """My alarm on an event I can see (only I am notified). Timed: 0 / 5 / 10 / 15 / 30 / 60 /
    1440 minutes before; all-day: 1440 (前日 8:00) or -480 (当日 8:00)."""
    return await service.set_alarm(db, user, event_id, body)


@router.delete("/calendar/events/{event_id}/alarm", status_code=204)
async def clear_alarm(event_id: UUID, user: CurrentUser, db: Db) -> Response:
    await service.clear_alarm(db, user, event_id)
    return Response(status_code=204)


# --- M68: occurrences of a recurring event (CALENDAR.md §10.3) -----------------------------------

OccurrenceKey = Path(
    description="The occurrence's original start: `2030-01-10T05:00:00Z` (timed; any offset is "
    "read) or `2030-01-10` (all-day)",
    max_length=40,
)


@router.patch(
    "/calendar/events/{series_id}/occurrences/{occurrence_start}",
    response_model=CalendarEventOut,
)
async def update_occurrence(
    series_id: UUID,
    body: CalendarOccurrenceUpdate,
    user: CurrentUser,
    db: Db,
    occurrence_start: str = OccurrenceKey,
) -> CalendarEventOut:
    """Changes one occurrence (`this`), it and the later ones (`following`: a new series from it)
    or the whole series (`all`: moved by as much as this occurrence moved). The answer: the
    occurrence (`this`) or the first occurrence of the series changed or made."""
    return await service.update_occurrence(db, user, series_id, occurrence_start, body)


@router.delete("/calendar/events/{series_id}/occurrences/{occurrence_start}", status_code=204)
async def delete_occurrence(
    series_id: UUID,
    user: CurrentUser,
    db: Db,
    occurrence_start: str = OccurrenceKey,
    scope: OccurrenceScope = Query(description="this, following or all"),
) -> Response:
    await service.delete_occurrence(db, user, series_id, occurrence_start, scope)
    return Response(status_code=204)


# --- M68: iCal feeds (CALENDAR.md §10.6) ---------------------------------------------------------


@router.post("/calendar/ical-feeds", response_model=CalendarFeedCreated, status_code=201)
async def create_feed(
    body: CalendarFeedCreate, user: CurrentUser, db: Db, request: Request
) -> CalendarFeedCreated:
    """A private feed URL of my calendars (at most 5). The URL is in this answer only: anyone
    who has it sees the events."""
    configured: str = request.app.state.settings.public_base_url.strip()
    base = (configured or str(request.base_url)).rstrip("/")  # as messages' links (M53)
    return await service.create_feed(db, user, body, base)


@router.get("/calendar/ical-feeds", response_model=list[CalendarFeedOut])
async def list_feeds(user: CurrentUser, db: Db) -> list[CalendarFeedOut]:
    return await service.list_feeds(db, user)


@router.delete("/calendar/ical-feeds/{feed_id}", status_code=204)
async def delete_feed(feed_id: UUID, user: CurrentUser, db: Db) -> Response:
    """The URL stops working at once (make a new one to change it)."""
    await service.delete_feed(db, user, feed_id)
    return Response(status_code=204)


@router.get(
    "/calendar/ical/{token}.ics",
    response_class=Response,
    responses={200: {"content": {"text/calendar": {}}, "description": "The calendar"}},
)
async def ical_feed(token: str, request: Request, db: Db) -> Response:
    """No login: the token is the secret. Rate limited per IP; unknown or deleted tokens are
    404."""
    limiter: RateLimiter = request.app.state.limiters["ical"]
    key = (request.client.host[:45] if request.client else None) or "unknown"
    if not limiter.try_acquire(key):
        raise rate_limited(limiter.retry_after_seconds(key))
    if len(token) > 100:
        raise not_found("calendar_feed_not_found", "Feed not found")
    body = await service.feed_ics(db, token)
    if body is None:
        raise not_found("calendar_feed_not_found", "Feed not found")
    return Response(
        content=body,
        media_type="text/calendar; charset=utf-8",
        headers={"Cache-Control": "private, max-age=300", "Content-Disposition": "inline"},
    )
