import re
from collections.abc import Sequence
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.modules.attachments.schemas import AttachmentOut
from app.modules.messages.models import Message, MessageAck, PollVote, Reaction

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


class PollCreate(BaseModel):
    """A poll attached to a message (M14b): 2-10 options, one or several votes per person."""

    model_config = ConfigDict(extra="forbid")

    question: str = Field(min_length=1, max_length=200)
    options: list[str] = Field(min_length=2, max_length=10)
    multiple: bool = False
    # M27: nobody sees who voted, only how many (set when the poll is made).
    anonymous: bool = False

    @field_validator("options")
    @classmethod
    def _options_clean(cls, value: list[str]) -> list[str]:
        cleaned = [_CONTROL_CHARS.sub("", o).strip() for o in value]
        if any(not o or len(o) > 80 for o in cleaned):
            raise ValueError("Each option is 1-80 characters")
        if len({o.lower() for o in cleaned}) != len(cleaned):
            raise ValueError("Options must be distinct")
        return cleaned


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
    data: dict[str, Any] | None, votes: Sequence[PollVote] = (), viewer: UUID | None = None
) -> PollOut | None:
    if not data:
        return None
    options = list(data.get("options", []))
    per_option: list[list[UUID]] = [[] for _ in options]
    for vote in votes:
        if 0 <= vote.option_index < len(options):
            per_option[vote.option_index].append(vote.user_id)
    closed = data.get("closed_at")
    anonymous = bool(data.get("anonymous", False))
    return PollOut(
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


def to_message_out(
    message: Message,
    reactions: Sequence[Reaction] = (),
    attachments: Sequence[AttachmentOut] = (),
    votes: Sequence[PollVote] = (),
    acks: Sequence[MessageAck] = (),
    viewer: UUID | None = None,
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
        poll=None if deleted else poll_out(message.poll, votes, viewer),
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
