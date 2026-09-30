from uuid import UUID

from fastapi import APIRouter, Query, Response
from pydantic import AwareDatetime

from app.core.db import Db
from app.core.errors import bad_request
from app.modules.auth.deps import CurrentUser
from app.modules.calendar import service
from app.modules.calendar.schemas import (
    CalendarAlarmIn,
    CalendarEventCreate,
    CalendarEventOut,
    CalendarEventUpdate,
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
