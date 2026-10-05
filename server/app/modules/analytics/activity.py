"""When people last used an app (M116, docs/ANALYTICS.md §2).

Every authenticated request and every WebSocket that connects or reports activity calls
``ActivityTracker.touch``: a dictionary lookup, never a database write. A person is noted at most
once per ``write_interval`` seconds (per process); the noted times are written in one batch by
``flush`` (the background loop, every ACTIVITY_FLUSH_INTERVAL_SECONDS, and at shutdown):
``users.last_active_at`` (only forwards) and one ``user_activity_hours`` row per person and UTC
hour.
The UPDATE's own condition keeps several processes from moving the time backwards.
"""

import logging
import time
import uuid
from datetime import datetime, timedelta

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow

log = logging.getLogger("app.analytics")

_UPDATE_USERS = text(
    """
    UPDATE users AS u SET last_active_at = v.at
    FROM unnest(CAST(:ids AS uuid[]), CAST(:ats AS timestamptz[])) AS v(id, at)
    WHERE u.id = v.id AND (u.last_active_at IS NULL OR u.last_active_at < v.at)
    """
)
_INSERT_HOURS = text(
    """
    INSERT INTO user_activity_hours (user_id, hour)
    SELECT v.id, date_trunc('hour', v.at, 'UTC')
    FROM unnest(CAST(:ids AS uuid[]), CAST(:ats AS timestamptz[])) AS v(id, at)
    JOIN users ON users.id = v.id
    ON CONFLICT DO NOTHING
    """
)


class ActivityTracker:
    def __init__(self, write_interval_seconds: float) -> None:
        self.write_interval = write_interval_seconds
        self._noted: dict[uuid.UUID, float] = {}  # monotonic time of the last note
        self._pending: dict[uuid.UUID, datetime] = {}

    def touch(self, user_id: uuid.UUID, *, now: datetime | None = None) -> bool:
        """Note that the person is using an app; True when it was noted (not throttled)."""
        mono = time.monotonic()
        last = self._noted.get(user_id)
        if last is not None and mono - last < self.write_interval:
            return False
        self._noted[user_id] = mono
        self._pending[user_id] = now or utcnow()
        return True

    @property
    def pending(self) -> int:
        return len(self._pending)

    async def flush(self, db: AsyncSession) -> int:
        """Write the noted times; returns how many people. On an error the notes are kept."""
        if not self._pending:
            return 0
        batch = self._pending
        self._pending = {}
        ids = list(batch)
        ats = [batch[i] for i in ids]
        try:
            await db.execute(_UPDATE_USERS, {"ids": ids, "ats": ats})
            await db.execute(_INSERT_HOURS, {"ids": ids, "ats": ats})
            await db.commit()
        except Exception:
            await db.rollback()
            for user_id, at in batch.items():  # newer notes taken meanwhile win
                self._pending.setdefault(user_id, at)
            raise
        return len(ids)

    def forget_idle(self) -> None:
        """Drop the throttle entries older than the interval (they no longer throttle anything),
        so the map holds only the people of the last few minutes."""
        cutoff = time.monotonic() - self.write_interval
        self._noted = {k: v for k, v in self._noted.items() if v >= cutoff}


async def purge_hours(db: AsyncSession, *, retention_days: int, now: datetime) -> int:
    """The hourly rows older than the retention (the hourly purge loop); commits."""
    result = await db.execute(
        text("DELETE FROM user_activity_hours WHERE hour < :cutoff"),
        {"cutoff": now - timedelta(days=retention_days)},
    )
    await db.commit()
    return int(getattr(result, "rowcount", 0) or 0)
