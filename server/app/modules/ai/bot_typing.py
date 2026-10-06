"""An AI bot shown as typing while it works on a mention (docs/AI.md §2.2).

While a mention run is open (pending or running), the ordinary volatile `typing` frame
(SYNC_PROTOCOL.md §5.2) goes out with the bot's user id every TYPING_INTERVAL seconds, to the
conversation's members (not the bot), over the EventBus. Clients drop a typer after 5 s without a
refresh, so the indicator ends by itself once the run is done or failed (or cancelled, e.g. the
bot was removed), and after a restart nothing lingers; the reply clears it at once where it is
shown, as a person's message does.

Where it shows: the reply goes to the thread (the mention's thread, or for a top-level mention
the thread under that message), so the frame carries that thread's root as `parent_id`, like a
person typing in the thread. A top-level mention is also shown in the conversation itself
(`parent_id` null), where the person who asked is looking.

One query per tick for all open mentions (the partial index `ai_runs_open_idx`), one loop in
main.py; nothing per client.
"""

import uuid

from app.core.db import Database
from app.core.time import utcnow
from app.events.bus import EventBus
from app.events.envelope import Audience, Envelope
from app.modules.ai import repository as repo
from app.modules.channels import repository as channel_repo
from app.realtime.protocol import TypingOut

# Seconds between two typing frames for one run: the pace of a person's client (it sends at
# most every 3 s; SYNC_PROTOCOL.md §5.1), inside the 5 s after which clients drop a typer.
TYPING_INTERVAL = 3.0
# At most this many open mentions are announced per tick (the worker runs 2 at a time).
MAX_TYPING = 50


def _targets(
    rows: list[tuple[uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID]],
) -> set[tuple[uuid.UUID, uuid.UUID, uuid.UUID | None]]:
    """(bot, channel, parent) to announce: the reply's thread, and the conversation itself for
    a top-level mention (its thread root is the mention)."""
    out: set[tuple[uuid.UUID, uuid.UUID, uuid.UUID | None]] = set()
    for bot_id, channel_id, thread_id, source_id in rows:
        out.add((bot_id, channel_id, thread_id))
        if thread_id == source_id:
            out.add((bot_id, channel_id, None))
    return out


async def publish_typing(database: Database, bus: EventBus) -> int:
    """One tick: a typing frame for every open mention run. Returns how many frames went out."""
    async with database.session_factory() as db:
        rows = await repo.typing_mentions(db, MAX_TYPING)
        if not rows:
            return 0
        members = await channel_repo.member_ids_for_channels(db, list({r[1] for r in rows}))
    sent = 0
    now = utcnow()
    for bot_id, channel_id, parent_id in sorted(_targets(rows), key=str):
        in_channel = members.get(channel_id, [])
        if bot_id not in in_channel:  # removed: its runs are being cancelled
            continue
        audience = tuple(m for m in in_channel if m != bot_id)
        if not audience:
            continue
        frame = TypingOut(channel_id=channel_id, parent_id=parent_id, user_id=bot_id)
        await bus.publish(
            Envelope(
                id=0,
                event="typing",
                ts=now,
                channel_id=channel_id,
                seq=None,
                data={},
                audience=Audience(kind="users", ids=audience),
                volatile=frame.model_dump(mode="json"),
            )
        )
        sent += 1
    return sent
