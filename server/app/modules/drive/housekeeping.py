"""The drive's periodic jobs (docs/DRIVE.md §6.2, §10.1, §3.3), run by main.py every
DRIVE_HOUSEKEEPING_INTERVAL_SECONDS: expired upload sessions, completions a restart cut off, S3
multipart uploads nobody knows (once a day), the trash after DRIVE_TRASH_DAYS, the My Drives of
anonymised people, finished sessions after a week."""

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta

from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.attachments.blobstore import BlobStore
from app.modules.drive import service, uploads
from app.modules.drive.uploads import DriveRuntime

log = logging.getLogger("app.drive")

ORPHAN_SWEEP_EVERY = timedelta(days=1)


@dataclass
class Done:
    expired: int = 0
    recovered: int = 0
    orphans: int = 0
    purged_trash: int = 0
    purged_locations: int = 0
    finished: int = 0

    def __bool__(self) -> bool:
        return any(vars(self).values())


async def run(
    runtime: DriveRuntime, settings: Settings, blobs: BlobStore, *, now: datetime | None = None
) -> Done:
    now = now or utcnow()
    done = Done()
    factory = runtime.session_factory
    async with factory() as db:
        done.expired = await uploads.expire_due(db, blobs, now=now)
    async with factory() as db:
        done.recovered = await uploads.recover_stale(runtime, db, settings, blobs, now=now)
    if runtime.last_orphan_sweep is None or now - runtime.last_orphan_sweep >= ORPHAN_SWEEP_EVERY:
        async with factory() as db:
            done.orphans = await uploads.sweep_orphans(db, blobs, settings, now=now)
        runtime.last_orphan_sweep = now
    async with factory() as db:
        done.purged_trash = await service.purge_old_trash(
            db, days=settings.drive_trash_days, now=now
        )
    async with factory() as db:
        done.purged_locations = await service.purge_deleted_locations(db)
    async with factory() as db:
        done.finished = await uploads.purge_finished(db, now=now)
    return done
