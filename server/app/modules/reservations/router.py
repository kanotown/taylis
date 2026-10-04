from uuid import UUID

from fastapi import APIRouter, Response

from app.core.db import Db
from app.modules.auth.deps import CurrentUser
from app.modules.reservations import service
from app.modules.reservations.schemas import PoolCreate, PoolOut, PoolUpdate, SwapIn

router = APIRouter(tags=["reservations"])

# docs/RESERVATIONS.md §3. Whoever reads the channel sees its pools; members reserve, cancel and
# return; operators (and the channel's owners and administrators) assign, remove and swap; the
# channel's owners and administrators change the settings. Every action answers with the pool as
# the caller sees it; pressing twice changes nothing the second time.


@router.get("/channels/{channel_id}/reservation-pools", response_model=list[PoolOut])
async def list_pools(channel_id: UUID, user: CurrentUser, db: Db) -> list[PoolOut]:
    """The channel's pools, oldest first, with their holders and queue."""
    return await service.list_for_channel(db, user, channel_id)


@router.post("/channels/{channel_id}/reservation-pools", response_model=PoolOut, status_code=201)
async def create_pool(channel_id: UUID, body: PoolCreate, user: CurrentUser, db: Db) -> PoolOut:
    """A new pool (channel owners and administrators who are members; at most 5 per channel,
    409 too_many_reservation_pools). The channel's reservation bot joins with the first one."""
    return await service.create_pool(db, user, channel_id, body)


@router.patch("/reservation-pools/{pool_id}", response_model=PoolOut)
async def update_pool(pool_id: UUID, body: PoolUpdate, user: CurrentUser, db: Db) -> PoolOut:
    return await service.update_pool(db, user, pool_id, body)


@router.delete("/reservation-pools/{pool_id}", status_code=204)
async def delete_pool(pool_id: UUID, user: CurrentUser, db: Db) -> Response:
    """The pool and its queue go; the bot's posts stay. Seats handed out in the resource's
    console are not touched there."""
    await service.delete_pool(db, user, pool_id)
    return Response(status_code=204)


@router.post("/reservation-pools/{pool_id}/reserve", response_model=PoolOut)
async def reserve(pool_id: UUID, user: CurrentUser, db: Db) -> PoolOut:
    """「予約する」: join the queue (members, not guests). Already in it or holding a seat: no
    change. 409 reservation_pool_disabled while the pool is paused."""
    return await service.reserve(db, user, pool_id)


@router.post("/reservation-pools/{pool_id}/swap", response_model=PoolOut)
async def swap(pool_id: UUID, body: SwapIn, user: CurrentUser, db: Db) -> PoolOut:
    """「入れ替えた」 (operators): `remove_id` out and `assign_id` in, together."""
    return await service.swap(db, user, pool_id, body)


@router.post("/reservations/{reservation_id}/cancel", response_model=PoolOut)
async def cancel(reservation_id: UUID, user: CurrentUser, db: Db) -> PoolOut:
    """「取り消す」: a waiting request (its member, or an operator)."""
    return await service.cancel(db, user, reservation_id)


@router.post("/reservations/{reservation_id}/return", response_model=PoolOut)
async def give_back(reservation_id: UUID, user: CurrentUser, db: Db) -> PoolOut:
    """「返却する」 (the holder): the operators are told to take the seat out (「外した」)."""
    return await service.give_back(db, user, reservation_id)


@router.post("/reservations/{reservation_id}/assign", response_model=PoolOut)
async def assign(reservation_id: UUID, user: CurrentUser, db: Db) -> PoolOut:
    """「割り当てた」 (operators): the member got a seat; their guarantee starts now. 409
    reservation_pool_full when every seat is taken."""
    return await service.assign(db, user, reservation_id)


@router.post("/reservations/{reservation_id}/remove", response_model=PoolOut)
async def remove(reservation_id: UUID, user: CurrentUser, db: Db) -> PoolOut:
    """「外した」 (operators): the seat was taken back (a return, or a removal)."""
    return await service.remove(db, user, reservation_id)
