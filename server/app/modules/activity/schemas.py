from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from app.modules.messages.schemas import MessageOut

ActivityKind = Literal[
    "mention",
    "reaction",
    "thread_reply",
    "canvas_mention",
    "reservation",
    "page_mention",
    "page_shared",
]
ActivityFilter = Literal["all", "mentions", "reactions", "threads"]
# M76 (CANVAS.md §20): canvas_mention items only go to clients that name the kind in `include`
# (clients before them cannot read an item without `message`). Unknown `include` values are
# ignored, so a newer client may name kinds an older server does not have.
# M112 (RESERVATIONS.md §5): reservation items likewise only with `include=reservation`.
# M120 (docs/WIKI.md §9.3): page_mention / page_shared likewise, by name each.


class ActivityCanvas(BaseModel):
    """A canvas_mention item's canvas (M76): it opens the canvas in its conversation."""

    # The item itself (one per canvas while unread; a later mention moves it).
    item_id: UUID
    canvas_id: UUID
    channel_id: UUID
    # The canvas's title now.
    title: str
    # The line around the mention as one plain line (mentions as names), at most 200 characters.
    excerpt: str
    # The version that added the (latest) mention.
    rev_id: UUID


class ActivityPage(BaseModel):
    """A page_mention / page_shared item's page (M120): it opens the page. Listed only while I can
    read the page."""

    item_id: UUID
    page_id: UUID
    # The page's title and icon now.
    title: str
    icon: str | None
    # page_mention: the line around the mention (as for a canvas), else "".
    excerpt: str
    # page_mention: the version that added the (latest) mention.
    rev_id: UUID | None
    # page_shared: the level I was given.
    level: Literal["view", "edit", "full"] | None


class ActivityReservation(BaseModel):
    """A reservation item's notice (M112, docs/RESERVATIONS.md §5): it opens the reservations
    page. An operator's to-do is `done` once one of them handled it (or it is no longer
    needed)."""

    item_id: UUID
    pool_id: UUID
    pool_name: str
    reservation_id: UUID | None
    # The notice as one line of plain text (Japanese, written by the server).
    text: str
    # A to-do sent to the pool's operators (the others are news about my own reservation).
    operator: bool
    done: bool
    done_at: datetime | None
    # Who handled it (null: it went away by itself).
    done_by: UUID | None


class ActivityItem(BaseModel):
    # The item's id (2026-10-07): the message's for mention / thread_reply / reaction, else the
    # canvas / page / reservation item's `item_id`. PUT /activity/items/read takes it.
    id: UUID
    kind: ActivityKind
    # When it happened: the message's time, a reaction's (the newest on that message), or the
    # canvas save's.
    at: datetime
    # The message mentioning me, my message reacted to, or the reply; null for canvas_mention.
    message: MessageOut | None = None
    # canvas_mention only (M76): the canvas and the excerpt.
    canvas: ActivityCanvas | None = None
    # reservation only (M112): the notice.
    reservation: ActivityReservation | None = None
    # page_mention / page_shared only (M120): the page.
    page: ActivityPage | None = None
    # Who did it: the sender, or everyone who reacted (not me).
    actor_ids: list[UUID]
    # A reaction item's emoji (the distinct ones on my message by others).
    emojis: list[str] = []
    # Read (MOBILE_UI.md §6.4): `at` is not after read_at, or I opened the item since it
    # happened (PUT /activity/items/read, 2026-10-07), or the item's message is read in its
    # conversation (mention / thread_reply: the channel's read position for a timeline row, the
    # thread's for a reply; 2026-10-06), or a reservation to-do is done. The unread dot and the
    # badge follow it. Null from a server before 2026-10-06: compare `at` with read_at.
    read: bool | None = None


class ActivityListOut(BaseModel):
    items: list[ActivityItem]
    # The oldest item's time: the next page's `cursor`; null at the end.
    next_cursor: datetime | None
    read_at: datetime


class ActivitySummaryOut(BaseModel):
    read_at: datetime
    # Unread items (at most 99), and whether one of them is a mention (the badge turns red):
    # after read_at, and for a mention or a thread reply its message not yet read in its
    # conversation (2026-10-06, MOBILE_UI.md §6.4; `read` on GET /activity's items).
    unread_count: int
    mention_unread: bool


class ActivityReadIn(BaseModel):
    read_at: datetime


class ActivityReadData(BaseModel):
    read_at: datetime


class ActivityItemsReadIn(BaseModel):
    # Items' `id`s from GET /activity (ids that are not my items are ignored).
    item_ids: list[UUID] = Field(min_length=1, max_length=100)


class ActivityItemsReadData(BaseModel):
    """To me (2026-10-07): I opened these activity items on one of my devices; each is read
    while its `at` is not after `read_at` (a reaction item with a newer reaction is unread
    again). Clients drop their dots and fetch the summary again."""

    item_ids: list[UUID]
    read_at: datetime


class ActivityUpdatedData(BaseModel):
    """To me: activity items I may hold changed in place (Review v0.1.22: a canvas version's body
    was erased, and the excerpts taken from it with it). A client showing or keeping the list
    reads it again (or drops the excerpt of these items); the badge does not change."""

    item_ids: list[UUID]


class ReactionAddedData(BaseModel):
    """To the message's author: someone reacted to it (the activity badge; a push if they asked for
    one)."""

    channel_id: UUID
    message_id: UUID
    user_id: UUID
    emoji: str
    at: datetime
