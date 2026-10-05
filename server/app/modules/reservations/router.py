from uuid import UUID

from fastapi import APIRouter, Response

from app.core.db import Db
from app.modules.auth.deps import CurrentUser
from app.modules.reservations import service
from app.modules.reservations.schemas import (
    BookingIn,
    ExtendIn,
    PoolCreate,
    PoolOut,
    PoolUpdate,
    SwapIn,
)

router = APIRouter(tags=["reservations"])

# docs/RESERVATIONS.md §3 (M112). Members see the pools (unless one is narrowed to a channel's or
# a group's members), book them by the hour or queue for one now, cancel, extend and return;
# operators (and the pool's creator and administrators) assign, remove and swap; administrators
# create pools, and they and a pool's creator change it. Every action answers with the pool as the
# caller sees it; pressing twice changes nothing the second time.


@router.get("/reservation-pools", response_model=list[PoolOut])
async def list_pools(user: CurrentUser, db: Db) -> list[PoolOut]:
    """The pools the caller sees, oldest first, with today's and the coming bookings, the queue,
    the holders and (for operators) the to-do."""
    return await service.list_pools(db, user)


@router.post("/reservation-pools", response_model=PoolOut, status_code=201)
async def create_pool(body: PoolCreate, user: CurrentUser, db: Db) -> PoolOut:
    """A new pool (administrators; at most 20, 409 too_many_reservation_pools). With a
    `log_channel_id` (a channel the caller is a member of) the 「予約」 bot joins it."""
    return await service.create_pool(db, user, body)


@router.get("/reservation-pools/{pool_id}", response_model=PoolOut)
async def get_pool(pool_id: UUID, user: CurrentUser, db: Db) -> PoolOut:
    return await service.get_pool(db, user, pool_id)


@router.patch("/reservation-pools/{pool_id}", response_model=PoolOut)
async def update_pool(pool_id: UUID, body: PoolUpdate, user: CurrentUser, db: Db) -> PoolOut:
    return await service.update_pool(db, user, pool_id, body)


@router.delete("/reservation-pools/{pool_id}", status_code=204)
async def delete_pool(pool_id: UUID, user: CurrentUser, db: Db) -> Response:
    """The pool, its bookings, its queue and its notices go; log lines stay. Seats handed out in
    the resource's console are not touched there."""
    await service.delete_pool(db, user, pool_id)
    return Response(status_code=204)


@router.post("/reservation-pools/{pool_id}/reserve", response_model=PoolOut)
async def reserve(pool_id: UUID, user: CurrentUser, db: Db) -> PoolOut:
    """「今すぐ (順番待ち)」: join the walk-in queue (members, not guests). Already in it or on a
    seat: no change. 409 reservation_already_active with a booking in the pool (one reservation
    per person and pool), reservation_pool_disabled while the pool is paused."""
    return await service.reserve(db, user, pool_id)


@router.post("/reservation-pools/{pool_id}/bookings", response_model=PoolOut)
async def book(pool_id: UUID, body: BookingIn, user: CurrentUser, db: Db) -> PoolOut:
    """A booking: on the hour, 1 h to max_hours, from the current hour to 14 days ahead.
    400 reservation_booking_invalid (details.reason grid / past / horizon / duration), 409
    reservation_slot_full (details.at: the first full hour), reservation_already_active (one
    reservation per person and pool: a booking, a walk-in request or a seat already;
    details.reservation_id / kind / status). The same slot again: no change."""
    return await service.book(db, user, pool_id, body)


@router.post("/reservation-pools/{pool_id}/swap", response_model=PoolOut)
async def swap(pool_id: UUID, body: SwapIn, user: CurrentUser, db: Db) -> PoolOut:
    """「入れ替えた」 (operators): `remove_id` out and `assign_id` in, together."""
    return await service.swap(db, user, pool_id, body)


@router.post("/reservations/{reservation_id}/extend", response_model=PoolOut)
async def extend(reservation_id: UUID, body: ExtendIn, user: CurrentUser, db: Db) -> PoolOut:
    """「延長」: a booking (booked or on a seat) grows by `hours` if they have a seat (the booker or
    an operator). 409 reservation_slot_full, 400 reservation_booking_invalid."""
    return await service.extend(db, user, reservation_id, body)


@router.post("/reservations/{reservation_id}/cancel", response_model=PoolOut)
async def cancel(reservation_id: UUID, user: CurrentUser, db: Db) -> PoolOut:
    """「取り消す」: a waiting walk-in or a booking not on a seat yet (its member, or an
    operator)."""
    return await service.cancel(db, user, reservation_id)


@router.post("/reservations/{reservation_id}/return", response_model=PoolOut)
async def give_back(reservation_id: UUID, user: CurrentUser, db: Db) -> PoolOut:
    """「返却する」 (the holder): the operators are told to take the seat out (「外した」)."""
    return await service.give_back(db, user, reservation_id)


@router.post("/reservations/{reservation_id}/assign", response_model=PoolOut)
async def assign(reservation_id: UUID, user: CurrentUser, db: Db) -> PoolOut:
    """「割り当てた」 (operators): the member got a seat. A walk-in's guarantee starts now; a
    booking's runs to its end (from 10 minutes before its start, else 409
    reservation_too_early). 409 reservation_pool_full when every seat is taken."""
    return await service.assign(db, user, reservation_id)


@router.post("/reservations/{reservation_id}/remove", response_model=PoolOut)
async def remove(reservation_id: UUID, user: CurrentUser, db: Db) -> PoolOut:
    """「外した」 (operators): the seat was taken back (a return, or a removal)."""
    return await service.remove(db, user, reservation_id)


@router.get(
    "/channels/{channel_id}/reservation-pools", response_model=list[PoolOut], deprecated=True
)
async def list_channel_pools(channel_id: UUID, user: CurrentUser) -> list[PoolOut]:
    """Deprecated (M112): pools are no longer a channel's. Always empty, so the clients of
    M99-M111 show no chips; the reservations page reads GET /reservation-pools."""
    del channel_id, user
    return []
