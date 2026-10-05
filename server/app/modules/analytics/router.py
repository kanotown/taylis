"""``/admin/analytics`` (M116, docs/ANALYTICS.md §4): administrators only."""

from typing import Annotated, Literal

from fastapi import APIRouter, Query, Response

from app.core.db import Db
from app.core.time import utcnow
from app.modules.analytics import service
from app.modules.analytics.schemas import (
    AnalyticsMemberOut,
    AnalyticsMembersOut,
    AnalyticsOverviewOut,
    MemberSort,
    MemberStatus,
)
from app.modules.auth.deps import CurrentAdmin

router = APIRouter(prefix="/admin/analytics", tags=["admin"])

Order = Literal["asc", "desc"]


@router.get("/overview", response_model=AnalyticsOverviewOut)
async def overview(
    admin: CurrentAdmin,
    db: Db,
    days: Annotated[int, Query(ge=1, le=90)] = 30,
    tz: Annotated[str, Query(max_length=64)] = "UTC",
) -> AnalyticsOverviewOut:
    """Totals, a daily series (messages, active members, new members) of the last `days` days in
    the time zone `tz` (IANA), the busiest channels and posters. Private channels the
    administrator is not in and DMs appear only as totals."""
    return await service.overview(db, admin, days=days, tz=service.parse_tz(tz), now=utcnow())


async def _selected(
    db: Db,
    sort: MemberSort,
    order: Order,
    status: MemberStatus | None,
    inactive_days: int | None,
    q: str | None,
) -> list[AnalyticsMemberOut]:
    now = utcnow()
    return service.select_members(
        await service.members(db, now=now),
        now=now,
        sort=sort,
        order=order,
        status=status,
        inactive_days=inactive_days,
        q=q,
    )


@router.get("/members", response_model=AnalyticsMembersOut)
async def members(
    _: CurrentAdmin,
    db: Db,
    sort: MemberSort = "name",
    order: Order = "asc",
    status: MemberStatus | None = None,
    inactive_days: Annotated[int | None, Query(ge=1, le=3650)] = None,
    q: Annotated[str | None, Query(max_length=80)] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> AnalyticsMembersOut:
    """People (no bots) with the last sign-in, the last activity, posts in the last 30 days and
    the signed-in devices. `inactive_days`: active accounts not used for that many days (or
    never)."""
    rows = await _selected(db, sort, order, status, inactive_days, q)
    return service.page(rows, limit=limit, offset=offset)


@router.get(
    "/members.csv",
    response_class=Response,
    responses={200: {"content": {"text/csv": {}}, "description": "The members table as CSV"}},
)
async def members_csv(
    _: CurrentAdmin,
    db: Db,
    sort: MemberSort = "name",
    order: Order = "asc",
    status: MemberStatus | None = None,
    inactive_days: Annotated[int | None, Query(ge=1, le=3650)] = None,
    q: Annotated[str | None, Query(max_length=80)] = None,
) -> Response:
    """The same rows as /members with the same filters, all of them, as CSV (UTF-8 with BOM)."""
    rows = await _selected(db, sort, order, status, inactive_days, q)
    stamp = utcnow().strftime("%Y%m%d")
    return Response(
        content=service.members_csv(rows).encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="members-{stamp}.csv"',
            "Cache-Control": "no-store",
        },
    )
