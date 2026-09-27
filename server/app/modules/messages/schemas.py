import re
from collections.abc import Sequence
from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.modules.attachments.schemas import AttachmentOut
from app.modules.messages.models import Message, PollVote, Reaction

MAX_BODY_LENGTH = 20_000
# Control characters other than newline and tab are stripped (SECURITY.md §5).
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
# A unicode emoji (sequence) or a :shortcode:.
EMOJI_PATTERN = r"^(:[a-z0-9_+\-]{1,30}:|[^\x00-\x7f]{1,16})$"


def clean_body(value: str) -> str:
    cleaned = _CONTROL_CHARS.sub("", value)
    if not cleaned.strip():
        raise ValueError("body must not be empty")
    return cleaned


class PollCreate(BaseModel):
    """A poll attached to a message (M14b): 2-10 options, one or several votes per person."""

    model_config = ConfigDict(extra="forbid")

    question: str = Field(min_length=1, max_length=200)
    options: list[str] = Field(min_length=2, max_length=10)
    multiple: bool = False

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
    closed_at: datetime | None = None
    # Who voted for each option, in order of voting; counts and "mine" are derived on the client.
    votes: list[list[UUID]]


class MessageCreate(BaseModel):
    client_msg_id: UUID
    body: str = Field(default="", max_length=MAX_BODY_LENGTH)
    parent_id: UUID | None = None
    attachment_ids: list[UUID] = Field(default_factory=list, max_length=10)
    poll: PollCreate | None = None

    @field_validator("body")
    @classmethod
    def _clean_body(cls, value: str) -> str:
        return _CONTROL_CHARS.sub("", value)

    @model_validator(mode="after")
    def _body_or_attachments(self) -> "MessageCreate":
        if not self.body.strip() and not self.attachment_ids and self.poll is None:
            raise ValueError("body must not be empty")
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
    updated_seq: int
    # The thread's followers (THREADS.md §2): push targets for the reply (PUSH_NOTIFICATIONS.md §4).
    participant_ids: list[UUID] = []


class MessageOut(BaseModel):
    id: UUID
    channel_id: UUID
    sender_id: UUID
    parent_id: UUID | None = None
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
    created_at: datetime
    edited_at: datetime | None
    deleted: bool
    # Pinned in the channel (M11c); both null when not pinned.
    pinned_at: datetime | None = None
    pinned_by: UUID | None = None
    # M14b: the poll, when the message carries one.
    poll: PollOut | None = None


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


def poll_out(data: dict[str, Any] | None, votes: Sequence[PollVote] = ()) -> PollOut | None:
    if not data:
        return None
    options = list(data.get("options", []))
    per_option: list[list[UUID]] = [[] for _ in options]
    for vote in votes:
        if 0 <= vote.option_index < len(options):
            per_option[vote.option_index].append(vote.user_id)
    closed = data.get("closed_at")
    return PollOut(
        question=str(data.get("question", "")),
        options=options,
        multiple=bool(data.get("multiple", False)),
        closed_at=datetime.fromisoformat(closed) if closed else None,
        votes=per_option,
    )


def to_message_out(
    message: Message,
    reactions: Sequence[Reaction] = (),
    attachments: Sequence[AttachmentOut] = (),
    votes: Sequence[PollVote] = (),
) -> MessageOut:
    deleted = message.is_deleted
    return MessageOut(
        id=message.id,
        channel_id=message.channel_id,
        sender_id=message.sender_id,
        parent_id=message.parent_id,
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
        created_at=message.created_at,
        edited_at=message.edited_at,
        deleted=deleted,
        pinned_at=None if deleted else message.pinned_at,
        pinned_by=None if deleted else message.pinned_by,
        poll=None if deleted else poll_out(message.poll, votes),
    )


def thread_of(parent: Message, participant_ids: list[UUID]) -> ParentThread:
    return ParentThread(
        id=parent.id,
        reply_count=parent.reply_count,
        last_reply_at=parent.last_reply_at,
        updated_seq=parent.updated_seq,
        participant_ids=participant_ids,
    )
