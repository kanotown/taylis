"""Administrators' analytics (M116, docs/ANALYTICS.md §3-§4).

Computed on request: a few grouped queries over the last days of messages (a range scan of the
existing partial index ``messages_created_idx``, 0037), the hourly activity rows and the users
table. No rollup table to keep right: with a million messages (90 days = about 50,000 rows) each
query takes 10-25 ms (docs/ANALYTICS.md §3). People only: bots (webhooks, feeds, AI) neither count
as members nor as posters.
"""

import csv
import io
from collections.abc import Sequence
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.modules.analytics.schemas import (
    AnalyticsMemberOut,
    AnalyticsMembersOut,
    AnalyticsOverviewOut,
    ChannelStatOut,
    DayOut,
    HiddenConversationsOut,
    MemberSort,
    MemberStatus,
    MemberTotalsOut,
    PosterOut,
)
from app.modules.users.models import User

TOP_CHANNELS = 10
TOP_POSTERS = 10
MEMBER_MESSAGES_DAYS = 30

# People's posts that are still there (implies the partial index's predicate, so it is used).
_POSTS = "m.deleted_at IS NULL AND m.type = 'user'"


def parse_tz(name: str) -> ZoneInfo:
    """An IANA time zone (the client's own); 422 for anything else."""
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise AppError(422, "validation_error", "Unknown time zone", details={"tz": name}) from exc


def period(now: datetime, days: int, tz: ZoneInfo) -> tuple[date, date, datetime]:
    """The last `days` calendar days in `tz`, today included: first day, last day, and the
    first day's local midnight in UTC."""
    end = now.astimezone(tz).date()
    start = end - timedelta(days=days - 1)
    since = datetime.combine(start, time(0), tz).astimezone(UTC)
    return start, end, since


async def _rows(db: AsyncSession, sql: str, params: dict[str, Any]) -> Sequence[Any]:
    return (await db.execute(text(sql), params)).all()


async def overview(
    db: AsyncSession, admin: User, *, days: int, tz: ZoneInfo, now: datetime
) -> AnalyticsOverviewOut:
    start, end, since = period(now, days, tz)
    params: dict[str, Any] = {"since": since, "tz": tz.key}

    totals = (
        await db.execute(
            text(
                """
                SELECT
                  count(*) FILTER (WHERE deactivated_at IS NULL) AS accounts,
                  count(*) FILTER (WHERE deactivated_at IS NULL AND role = 'admin') AS admins,
                  count(*) FILTER (WHERE deactivated_at IS NULL AND role = 'guest') AS guests,
                  count(*) FILTER (WHERE deactivated_at IS NOT NULL) AS deactivated,
                  count(*) FILTER (WHERE deactivated_at IS NULL AND last_active_at >= :d1)
                    AS active_1d,
                  count(*) FILTER (WHERE deactivated_at IS NULL AND last_active_at >= :d7)
                    AS active_7d,
                  count(*) FILTER (WHERE deactivated_at IS NULL AND last_active_at >= :d30)
                    AS active_30d,
                  count(*) FILTER (WHERE created_at >= :since) AS new_in_period,
                  count(*) FILTER (WHERE deactivated_at IS NULL AND last_login_at IS NULL)
                    AS never_signed_in
                FROM users WHERE role <> 'bot'
                """
            ),
            {
                "since": since,
                "d1": now - timedelta(days=1),
                "d7": now - timedelta(days=7),
                "d30": now - timedelta(days=30),
            },
        )
    ).one()

    messages_by_day = {
        row.day: int(row.n)
        for row in await _rows(
            db,
            f"""
            SELECT (m.created_at AT TIME ZONE :tz)::date AS day, count(*) AS n
            FROM messages m JOIN users u ON u.id = m.sender_id AND u.role <> 'bot'
            WHERE m.created_at >= :since AND {_POSTS}
            GROUP BY 1
            """,
            params,
        )
    }
    active_by_day = {
        row.day: int(row.n)
        for row in await _rows(
            db,
            """
            SELECT (hour AT TIME ZONE :tz)::date AS day, count(DISTINCT user_id) AS n
            FROM user_activity_hours WHERE hour >= date_trunc('hour', CAST(:since AS timestamptz))
            GROUP BY 1
            """,
            params,
        )
    }
    new_by_day = {
        row.day: int(row.n)
        for row in await _rows(
            db,
            """
            SELECT (created_at AT TIME ZONE :tz)::date AS day, count(*) AS n
            FROM users WHERE role <> 'bot' AND created_at >= :since GROUP BY 1
            """,
            params,
        )
    }
    series = []
    for offset in range(days):
        day = start + timedelta(days=offset)
        series.append(
            DayOut(
                date=day,
                messages=messages_by_day.get(day, 0),
                active_members=active_by_day.get(day, 0),
                new_members=new_by_day.get(day, 0),
            )
        )

    top_channels, other_private, direct = await _channels(db, admin, since)
    posters = await _rows(
        db,
        f"""
        SELECT u.id, u.username, u.display_name, count(*) AS n
        FROM messages m JOIN users u ON u.id = m.sender_id AND u.role <> 'bot'
        WHERE m.created_at >= :since AND {_POSTS}
        GROUP BY u.id ORDER BY n DESC, u.username LIMIT :limit
        """,
        {**params, "limit": TOP_POSTERS},
    )
    return AnalyticsOverviewOut(
        generated_at=now,
        days=days,
        tz=tz.key,
        start=start,
        end=end,
        members=MemberTotalsOut(**{k: int(v) for k, v in totals._mapping.items()}),
        messages_in_period=sum(d.messages for d in series),
        series=series,
        top_channels=top_channels,
        other_private_channels=other_private,
        direct_messages=direct,
        top_posters=[
            PosterOut(user_id=r.id, username=r.username, display_name=r.display_name, messages=r.n)
            for r in posters
        ],
    )


async def _channels(
    db: AsyncSession, admin: User, since: datetime
) -> tuple[list[ChannelStatOut], HiddenConversationsOut, HiddenConversationsOut]:
    """Per conversation counts, split by what the administrator may see (docs/ANALYTICS.md §5):
    public channels and private ones they are in by name; other private channels and every DM /
    group DM only as totals (no names, no members)."""
    rows = await _rows(
        db,
        f"""
        SELECT c.id, c.type, c.name, c.archived_at IS NOT NULL AS archived,
               count(*) AS n, count(DISTINCT m.sender_id) AS posters,
               EXISTS (SELECT 1 FROM channel_members cm
                       WHERE cm.channel_id = c.id AND cm.user_id = :admin) AS is_member
        FROM messages m
        JOIN users u ON u.id = m.sender_id AND u.role <> 'bot'
        JOIN channels c ON c.id = m.channel_id
        WHERE m.created_at >= :since AND {_POSTS}
        GROUP BY c.id
        """,
        {"since": since, "admin": admin.id},
    )
    named: list[ChannelStatOut] = []
    hidden = [0, 0]
    direct = [0, 0]
    for row in rows:
        if row.type == "public" or (row.type == "private" and row.is_member):
            named.append(
                ChannelStatOut(
                    channel_id=row.id,
                    name=row.name or "",
                    type=row.type,
                    archived=row.archived,
                    messages=row.n,
                    posters=row.posters,
                )
            )
        elif row.type == "private":
            hidden[0] += 1
            hidden[1] += row.n
        else:  # dm, group_dm
            direct[0] += 1
            direct[1] += row.n
    named.sort(key=lambda c: (-c.messages, c.name))
    return (
        named[:TOP_CHANNELS],
        HiddenConversationsOut(conversations=hidden[0], messages=hidden[1]),
        HiddenConversationsOut(conversations=direct[0], messages=direct[1]),
    )


async def members(db: AsyncSession, *, now: datetime) -> list[AnalyticsMemberOut]:
    """Every person (no bots) with their sign-in, activity, posts in the last 30 days and the
    devices that are signed in now."""
    rows = await _rows(
        db,
        f"""
        SELECT u.id, u.username, u.display_name, u.role, u.created_at, u.deactivated_at,
               u.last_login_at, u.last_active_at,
               coalesce(mc.n, 0) AS messages_30d,
               coalesce(d.n, 0) AS devices,
               coalesce(d.platforms, ARRAY[]::text[]) AS platforms
        FROM users u
        LEFT JOIN (
          SELECT m.sender_id, count(*) AS n FROM messages m
          WHERE m.created_at >= :since AND {_POSTS} GROUP BY m.sender_id
        ) mc ON mc.sender_id = u.id
        LEFT JOIN (
          SELECT user_id, count(*) AS n, array_agg(DISTINCT platform ORDER BY platform) AS platforms
          FROM devices WHERE enabled GROUP BY user_id
        ) d ON d.user_id = u.id
        WHERE u.role <> 'bot'
        """,
        {"since": now - timedelta(days=MEMBER_MESSAGES_DAYS)},
    )
    return [
        AnalyticsMemberOut(
            id=r.id,
            username=r.username,
            display_name=r.display_name,
            role=r.role,
            status="deactivated" if r.deactivated_at is not None else "active",
            created_at=r.created_at,
            deactivated_at=r.deactivated_at,
            last_login_at=r.last_login_at,
            last_active_at=r.last_active_at,
            messages_30d=r.messages_30d,
            devices=r.devices,
            platforms=list(r.platforms),
        )
        for r in rows
    ]


_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_ROLE_ORDER = {"admin": 0, "member": 1, "guest": 2}


def _sort_key(sort: MemberSort, m: AnalyticsMemberOut) -> tuple[Any, ...]:
    name = (m.display_name.casefold(), m.username)
    if sort == "role":
        return (_ROLE_ORDER.get(m.role, 9), *name)
    if sort == "status":
        return (m.status, *name)
    if sort == "messages_30d":
        return (m.messages_30d, *name)
    if sort in ("created_at", "last_login_at", "last_active_at"):
        # Never = the oldest: first going up, last going down.
        return (getattr(m, sort) or _EPOCH, *name)
    return name


def select_members(
    rows: list[AnalyticsMemberOut],
    *,
    now: datetime,
    sort: MemberSort,
    order: str,
    status: MemberStatus | None,
    inactive_days: int | None,
    q: str | None,
) -> list[AnalyticsMemberOut]:
    """Filter and sort in memory (a few hundred rows at most): the same rules for the page and
    the CSV."""
    out = rows
    if status is not None:
        out = [m for m in out if m.status == status]
    if inactive_days is not None:
        cutoff = now - timedelta(days=inactive_days)
        out = [
            m
            for m in out
            if m.status == "active" and (m.last_active_at is None or m.last_active_at < cutoff)
        ]
    if q:
        needle = q.casefold().lstrip("@")
        out = [
            m for m in out if needle in m.username.casefold() or needle in m.display_name.casefold()
        ]
    return sorted(out, key=lambda m: _sort_key(sort, m), reverse=order == "desc")


def page(rows: list[AnalyticsMemberOut], *, limit: int, offset: int) -> AnalyticsMembersOut:
    return AnalyticsMembersOut(
        items=rows[offset : offset + limit], total=len(rows), limit=limit, offset=offset
    )


def _cell(value: str) -> str:
    """A spreadsheet must not read a name as a formula (CSV injection)."""
    return "'" + value if value[:1] in ("=", "+", "-", "@", "\t", "\r") else value


def _ts(value: datetime | None) -> str:
    if value is None:
        return ""
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


CSV_COLUMNS = (
    "id",
    "username",
    "display_name",
    "role",
    "status",
    "created_at",
    "last_login_at",
    "last_active_at",
    "messages_30d",
    "devices",
    "platforms",
)


def members_csv(rows: list[AnalyticsMemberOut]) -> str:
    """UTF-8 with a byte order mark (Excel opens Japanese names right), times in UTC ISO 8601."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow(CSV_COLUMNS)
    for m in rows:
        writer.writerow(
            [
                str(m.id),
                _cell(m.username),
                _cell(m.display_name),
                m.role,
                m.status,
                _ts(m.created_at),
                _ts(m.last_login_at),
                _ts(m.last_active_at),
                m.messages_30d,
                m.devices,
                " ".join(m.platforms),
            ]
        )
    return "\ufeff" + buffer.getvalue()
