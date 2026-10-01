import datetime as dt
import re
from collections.abc import Sequence
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator

from app.modules.attachments.schemas import AttachmentOut
from app.modules.messages.models import Message, MessageAck, PollComment, PollVote, Reaction
from app.modules.messages.schedule import (
    MAX_SLOT,
    MAX_SLOTS,
    MIN_SLOT,
    MIN_SLOTS,
    slot_key,
    slot_label,
    stored_slot,
)
from app.modules.users.dnd import valid_zone

MAX_BODY_LENGTH = 20_000
# Control characters other than newline and tab are stripped (SECURITY.md §5).
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
# A unicode emoji (sequence) or a :shortcode:.
EMOJI_PATTERN = r"^(:[a-z0-9_+\-]{1,30}:|[^\x00-\x7f]{1,16})$"


def strip_control_chars(value: str) -> str:
    return _CONTROL_CHARS.sub("", value)


def clean_body(value: str) -> str:
    cleaned = strip_control_chars(value)
    if not cleaned.strip():
        raise ValueError("body must not be empty")
    return cleaned


PollKind = Literal["choice", "schedule"]
# M53: yes / maybe / no for one slot of a scheduling poll.
PollAnswer = Literal["yes", "maybe", "no"]
MAX_POLL_COMMENT = 100


class ScheduleSlotIn(BaseModel):
    """One candidate of a scheduling poll (M53): a time (15 minutes to 12 hours) or a whole day."""

    model_config = ConfigDict(extra="forbid")

    starts_at: AwareDatetime | None = None
    ends_at: AwareDatetime | None = None
    date: dt.date | None = None

    @model_validator(mode="after")
    def _one_shape(self) -> "ScheduleSlotIn":
        if self.date is not None:
            if self.starts_at is not None or self.ends_at is not None:
                raise ValueError("A slot is either a date or starts_at and ends_at")
            return self
        if self.starts_at is None or self.ends_at is None:
            raise ValueError("A slot needs starts_at and ends_at, or a date")
        length = self.ends_at - self.starts_at
        if length < MIN_SLOT or length > MAX_SLOT:
            raise ValueError("A slot lasts 15 minutes to 12 hours")
        return self


class PollCreate(BaseModel):
    """A poll attached to a message (M14b): 2-10 options, one or several votes per person.

    M53 `kind = "schedule"` (SCHEDULING.md): 2-20 `slots` and the zone (`tz`) their labels are
    written in; the server makes `options` from them (any sent are ignored) and the poll always
    takes several answers."""

    model_config = ConfigDict(extra="forbid")

    question: str = Field(min_length=1, max_length=200)
    options: list[str] = Field(default_factory=list, max_length=MAX_SLOTS)
    multiple: bool = False
    # M27: nobody sees who voted, only how many (set when the poll is made).
    anonymous: bool = False
    kind: PollKind = "choice"
    slots: list[ScheduleSlotIn] | None = Field(default=None, max_length=MAX_SLOTS)
    # The IANA zone of the creator's device: the slots' labels (「10/3 (土) 14:00〜15:00」).
    tz: str | None = Field(default=None, max_length=64)

    @field_validator("options")
    @classmethod
    def _options_clean(cls, value: list[str]) -> list[str]:
        return [_CONTROL_CHARS.sub("", o).strip() for o in value]

    @model_validator(mode="after")
    def _by_kind(self) -> "PollCreate":
        if self.kind == "choice":
            if self.slots is not None or self.tz is not None:
                raise ValueError("slots and tz are for kind schedule")
            if not 2 <= len(self.options) <= 10:
                raise ValueError("A poll has 2-10 options")
            if any(not o or len(o) > 80 for o in self.options):
                raise ValueError("Each option is 1-80 characters")
            if len({o.lower() for o in self.options}) != len(self.options):
                raise ValueError("Options must be distinct")
            return self
        if self.tz is None or not valid_zone(self.tz):
            raise ValueError("A scheduling poll needs the device's time zone (tz)")
        if self.slots is None or not MIN_SLOTS <= len(self.slots) <= MAX_SLOTS:
            raise ValueError(f"A scheduling poll has {MIN_SLOTS}-{MAX_SLOTS} slots")
        stored = self.stored_slots()
        if len({slot_key(slot) for slot in stored}) != len(stored):
            raise ValueError("Slots must be distinct")
        self.options = [slot_label(slot, self.tz) for slot in stored]
        self.multiple = True
        return self

    def stored_slots(self) -> list[dict[str, str]]:
        return [stored_slot(s.starts_at, s.ends_at, s.date) for s in self.slots or []]


class PollAnswerIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    index: int = Field(ge=0, lt=MAX_SLOTS)
    answer: PollAnswer


class PollAnswersIn(BaseModel):
    """M53: my answers to a scheduling poll, all at once: the slots left out become unanswered.
    `comment`: a string sets my comment, null or blank removes it, left out keeps it."""

    model_config = ConfigDict(extra="forbid")

    answers: list[PollAnswerIn] = Field(max_length=MAX_SLOTS)
    comment: str | None = Field(default=None, max_length=400)

    @field_validator("comment")
    @classmethod
    def _comment_clean(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = " ".join(strip_control_chars(value).split())
        if len(cleaned) > MAX_POLL_COMMENT:
            raise ValueError(f"A comment is at most {MAX_POLL_COMMENT} characters")
        return cleaned or None

    @model_validator(mode="after")
    def _distinct(self) -> "PollAnswersIn":
        if len({a.index for a in self.answers}) != len(self.answers):
            raise ValueError("One answer per slot")
        return self


class PollDecideIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    index: int = Field(ge=0, lt=MAX_SLOTS)
    # Make the event in the channel's calendar (never in a DM, which has none).
    create_event: bool = True


class ScheduleSlotOut(BaseModel):
    """A timed slot (starts_at, ends_at in UTC) or an all-day one (date)."""

    starts_at: datetime | None = None
    ends_at: datetime | None = None
    date: dt.date | None = None


class SlotAnswersOut(BaseModel):
    """Who answered yes / maybe / no for one slot, in order of answering (empty in an anonymous
    poll), and how many."""

    yes: list[UUID] = []
    maybe: list[UUID] = []
    no: list[UUID] = []
    yes_count: int = 0
    maybe_count: int = 0
    no_count: int = 0


class PollCommentOut(BaseModel):
    # null in an anonymous poll.
    user_id: UUID | None
    text: str


class PollDecidedOut(BaseModel):
    index: int
    # The event made in the channel's calendar; null in a DM or when none was asked for.
    event_id: UUID | None = None
    by: UUID
    at: datetime


class PollOut(BaseModel):
    question: str
    options: list[str]
    multiple: bool
    # M27: an anonymous poll names no voters: `votes` is empty for every option, `counts` says
    # how many.
    anonymous: bool = False
    closed_at: datetime | None = None
    # Who voted for each option, in order of voting (empty lists in an anonymous poll).
    votes: list[list[UUID]]
    # How many voted for each option.
    counts: list[int] = []
    # The options the viewer voted for, in a response to them. None in events: every member gets
    # the same one, so a client keeps what it knew (DATA_MODEL.md).
    mine: list[int] | None = None
    # M53 (SCHEDULING.md §3). A choice poll: kind "choice" and the rest empty. In a scheduling
    # poll `votes` / `counts` / `mine` are the ○ answers (what an app before M53 shows).
    kind: PollKind = "choice"
    slots: list[ScheduleSlotOut] = []
    tz: str | None = None
    decided: PollDecidedOut | None = None
    # Per slot.
    answers: list[SlotAnswersOut] = []
    # Who answered or commented, in order of their first answer (empty in an anonymous poll): the
    # rows of the people-by-slots table.
    respondents: list[UUID] = []
    comments: list[PollCommentOut] = []
    # Mine per slot ("yes" / "maybe" / "no", null = unanswered) and my comment ("" = none), in a
    # response to me; null in events (a client keeps what it knew, as `mine`).
    my_answers: list[PollAnswer | None] | None = None
    my_comment: str | None = None


Priority = Literal["important", "urgent"]


class AckOut(BaseModel):
    user_id: UUID
    acked_at: datetime


class AckPendingOut(BaseModel):
    """L4: the members who have not acknowledged yet (by display name)."""

    user_ids: list[UUID]


class MessageCreate(BaseModel):
    client_msg_id: UUID
    body: str = Field(default="", max_length=MAX_BODY_LENGTH)
    parent_id: UUID | None = None
    # M15c: a reply that also appears in the channel timeline (Slack's "also send to channel").
    also_in_channel: bool = False
    attachment_ids: list[UUID] = Field(default_factory=list, max_length=10)
    poll: PollCreate | None = None
    # M15e: a top-level post may be marked important / urgent and ask readers to acknowledge it.
    priority: Priority | None = None
    ack_requested: bool = False

    @field_validator("body")
    @classmethod
    def _clean_body(cls, value: str) -> str:
        return strip_control_chars(value)

    @model_validator(mode="after")
    def _body_or_attachments(self) -> "MessageCreate":
        if not self.body.strip() and not self.attachment_ids and self.poll is None:
            raise ValueError("body must not be empty")
        if self.also_in_channel and self.parent_id is None:
            raise ValueError("also_in_channel is for thread replies")
        if self.parent_id is not None and (self.priority is not None or self.ack_requested):
            raise ValueError("priority and acknowledgements are for top-level messages")
        return self


class MessageEdit(BaseModel):
    body: str = Field(min_length=1, max_length=MAX_BODY_LENGTH)

    @field_validator("body")
    @classmethod
    def _clean_body(cls, value: str) -> str:
        return clean_body(value)


class ReactionOut(BaseModel):
    emoji: str
    count: int
    user_ids: list[UUID]


class ParentThread(BaseModel):
    """The parent's thread fields after a reply changed them (SYNC_PROTOCOL.md §6)."""

    id: UUID
    reply_count: int
    last_reply_at: datetime | None
    # C3: the parent's reply_user_ids after the change (MessageOut.reply_user_ids).
    reply_user_ids: list[UUID] = []
    updated_seq: int
    # The thread's followers (THREADS.md §2): push targets for the reply (PUSH_NOTIFICATIONS.md §4).
    participant_ids: list[UUID] = []


class MessageOut(BaseModel):
    id: UUID
    channel_id: UUID
    sender_id: UUID
    parent_id: UUID | None = None
    # M15c: this reply is shown in the channel timeline as well as in its thread.
    also_in_channel: bool = False
    seq: int
    updated_seq: int
    client_msg_id: UUID | None
    type: str = "user"
    body: str
    mentioned_user_ids: list[UUID] = []
    mention_all: bool = False
    reactions: list[ReactionOut] = []
    attachments: list[AttachmentOut] = []
    reply_count: int = 0
    last_reply_at: datetime | None = None
    # C3: on a thread parent, who replied: distinct authors of the live replies, most recent
    # reply first, at most 5 (the parent's author too when they replied). Empty otherwise.
    reply_user_ids: list[UUID] = []
    created_at: datetime
    edited_at: datetime | None
    deleted: bool
    # Pinned in the channel (M11c); both null when not pinned.
    pinned_at: datetime | None = None
    pinned_by: UUID | None = None
    # M14b: the poll, when the message carries one.
    poll: PollOut | None = None
    # M15e: priority label, and who acknowledged a message that asked for it (oldest first).
    priority: Priority | None = None
    ack_requested: bool = False
    acks: list[AckOut] = []


class MessageRevisionOut(BaseModel):
    """An earlier body of a message (M14c), oldest first; the current body is the message's."""

    body: str
    written_at: datetime
    replaced_at: datetime


class MentionListOut(BaseModel):
    """Messages that mention me (M11h), newest first; `next_cursor` goes back as `cursor`."""

    items: list[MessageOut]
    next_cursor: datetime | None


class HistoryOut(BaseModel):
    channel_last_seq: int
    messages: list[MessageOut]
    has_more: bool


class DeltaOut(BaseModel):
    messages: list[MessageOut]
    next_since_seq: int
    has_more: bool


def reactions_out(reactions: Sequence[Reaction]) -> list[ReactionOut]:
    """Grouped per emoji in order of first reaction (rows arrive sorted by created_at)."""
    groups: dict[str, list[UUID]] = {}
    for reaction in reactions:
        groups.setdefault(reaction.emoji, []).append(reaction.user_id)
    return [ReactionOut(emoji=emoji, count=len(ids), user_ids=ids) for emoji, ids in groups.items()]


def poll_out(
    data: dict[str, Any] | None,
    votes: Sequence[PollVote] = (),
    viewer: UUID | None = None,
    comments: Sequence[PollComment] = (),
) -> PollOut | None:
    if not data:
        return None
    options = list(data.get("options", []))
    per_option: list[list[UUID]] = [[] for _ in options]
    for vote in votes:
        if 0 <= vote.option_index < len(options) and vote.answer == "yes":
            per_option[vote.option_index].append(vote.user_id)
    closed = data.get("closed_at")
    anonymous = bool(data.get("anonymous", False))
    out = PollOut(
        question=str(data.get("question", "")),
        options=options,
        multiple=bool(data.get("multiple", False)),
        anonymous=anonymous,
        closed_at=datetime.fromisoformat(closed) if closed else None,
        votes=[[] for _ in options] if anonymous else per_option,
        counts=[len(voters) for voters in per_option],
        mine=None
        if viewer is None
        else [i for i, voters in enumerate(per_option) if viewer in voters],
    )
    if data.get("kind") == "schedule":
        _fill_schedule(out, data, votes, viewer, comments)
    return out


def _fill_schedule(
    out: PollOut,
    data: dict[str, Any],
    votes: Sequence[PollVote],
    viewer: UUID | None,
    comments: Sequence[PollComment],
) -> None:
    anonymous = out.anonymous
    slots = list(data.get("slots", []))
    out.kind = "schedule"
    out.slots = [ScheduleSlotOut.model_validate(slot) for slot in slots]
    out.tz = data.get("tz")
    decided = data.get("decided")
    out.decided = PollDecidedOut.model_validate(decided) if decided else None
    per_slot: list[dict[str, list[UUID]]] = [{"yes": [], "maybe": [], "no": []} for _ in slots]
    respondents: list[UUID] = []
    mine: list[PollAnswer | None] = [None for _ in slots]
    for vote in votes:  # oldest first
        if not 0 <= vote.option_index < len(slots) or vote.answer not in ("yes", "maybe", "no"):
            continue
        per_slot[vote.option_index][vote.answer].append(vote.user_id)
        if vote.user_id not in respondents:
            respondents.append(vote.user_id)
        if vote.user_id == viewer:
            mine[vote.option_index] = vote.answer  # type: ignore[call-overload]
    for comment in comments:
        if comment.user_id not in respondents:
            respondents.append(comment.user_id)
    out.answers = [
        SlotAnswersOut(
            yes=[] if anonymous else groups["yes"],
            maybe=[] if anonymous else groups["maybe"],
            no=[] if anonymous else groups["no"],
            yes_count=len(groups["yes"]),
            maybe_count=len(groups["maybe"]),
            no_count=len(groups["no"]),
        )
        for groups in per_slot
    ]
    out.respondents = [] if anonymous else respondents
    out.comments = [
        PollCommentOut(user_id=None if anonymous else c.user_id, text=c.text) for c in comments
    ]
    if viewer is not None:
        out.my_answers = mine
        out.my_comment = next((c.text for c in comments if c.user_id == viewer), "")


def to_message_out(
    message: Message,
    reactions: Sequence[Reaction] = (),
    attachments: Sequence[AttachmentOut] = (),
    votes: Sequence[PollVote] = (),
    acks: Sequence[MessageAck] = (),
    viewer: UUID | None = None,
    comments: Sequence[PollComment] = (),
) -> MessageOut:
    """`viewer`: the user a response is for (their own poll votes, M27); None for events."""
    deleted = message.is_deleted
    return MessageOut(
        id=message.id,
        channel_id=message.channel_id,
        sender_id=message.sender_id,
        parent_id=message.parent_id,
        also_in_channel=message.also_in_channel,
        seq=message.seq,
        updated_seq=message.updated_seq,
        client_msg_id=message.client_msg_id,
        type=message.type,
        body="" if deleted else message.body,
        mentioned_user_ids=[] if deleted else list(message.mentioned_user_ids),
        mention_all=False if deleted else message.mention_all,
        reactions=[] if deleted else reactions_out(reactions),
        attachments=[] if deleted else list(attachments),
        reply_count=message.reply_count,
        last_reply_at=message.last_reply_at,
        reply_user_ids=list(message.reply_user_ids or []),
        created_at=message.created_at,
        edited_at=message.edited_at,
        deleted=deleted,
        pinned_at=None if deleted else message.pinned_at,
        pinned_by=None if deleted else message.pinned_by,
        poll=None if deleted else poll_out(message.poll, votes, viewer, comments),
        priority=message.priority,  # type: ignore[arg-type]
        ack_requested=message.ack_requested,
        acks=[] if deleted else [AckOut(user_id=a.user_id, acked_at=a.acked_at) for a in acks],
    )


def thread_of(parent: Message, participant_ids: list[UUID]) -> ParentThread:
    return ParentThread(
        id=parent.id,
        reply_count=parent.reply_count,
        last_reply_at=parent.last_reply_at,
        reply_user_ids=list(parent.reply_user_ids or []),
        updated_seq=parent.updated_seq,
        participant_ids=participant_ids,
    )
