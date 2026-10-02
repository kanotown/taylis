import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    SmallInteger,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base import Base
from app.core.ids import uuid7
from app.core.time import utcnow

MAX_NAME_LENGTH = 80  # the bot's display name (users.display_name)
MAX_CHARACTER_LENGTH = 4000
# docs/AI.md §12: Anthropic and OpenAI models; the provider follows from the model (llm.py).
MODELS = ("claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5", "gpt-6.1-sol", "gpt-6-luna")
EFFORTS = ("low", "medium", "high")


class AiAgent(Base):
    """An AI bot (docs/AI.md §2.1): a `bot` user that answers mentions with the character and
    model set here. Deleting is logical (the bot's posts keep its name)."""

    __tablename__ = "ai_agents"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    bot_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), unique=True)
    name: Mapped[str] = mapped_column(String(MAX_NAME_LENGTH))
    character: Mapped[str] = mapped_column(Text, default="", server_default="")
    model: Mapped[str] = mapped_column(String(32))
    effort: Mapped[str] = mapped_column(String(8), default="medium", server_default="medium")
    allow_private: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false")
    )
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, server_default=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(f"char_length(character) <= {MAX_CHARACTER_LENGTH}", name="character_len"),
        CheckConstraint(
            "model IN ('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', "
            "'gpt-6.1-sol', 'gpt-6-luna')",
            name="model_values",
        ),
        CheckConstraint("effort IN ('low', 'medium', 'high')", name="effort_values"),
    )


class AiRun(Base):
    """One call to the model (docs/AI.md §2.2-§2.3): a mention's reply or a summary. Kept for
    audit and cost; `input` (the prompt text) is dropped after 90 days."""

    __tablename__ = "ai_runs"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    kind: Mapped[str] = mapped_column(String(16))  # mention | summary
    # pending | running | done | failed
    status: Mapped[str] = mapped_column(String(16), default="pending", server_default="pending")
    agent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("ai_agents.id"))
    requester_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id"))
    thread_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("messages.id"))
    source_message_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("messages.id"))
    scope: Mapped[str | None] = mapped_column(String(16))  # unread | thread | recent
    days: Mapped[int | None] = mapped_column(SmallInteger)
    input: Mapped[str | None] = mapped_column(Text)
    output: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    omitted_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    attempts: Mapped[int] = mapped_column(SmallInteger, default=0, server_default="0")
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    input_tokens: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    output_tokens: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    cache_read_tokens: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    cache_write_tokens: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    cost_usd: Mapped[Decimal] = mapped_column(
        Numeric(12, 6), default=Decimal(0), server_default="0"
    )
    # The target, fixed when the run is created (review v0.1.18 #2): the worker calls this model
    # of this provider or fails the run, it never switches.
    model: Mapped[str | None] = mapped_column(String(64))
    provider: Mapped[str | None] = mapped_column(String(16))  # anthropic | openai
    # The budget held while the run is open (docs/AI.md §3); 0 once it ends (cost_usd is actual).
    reserved_usd: Mapped[Decimal] = mapped_column(
        Numeric(12, 6), default=Decimal(0), server_default="0"
    )
    # A mention's reply (or notice) is posted apart from getting it (review v0.1.18 #11):
    # pending (to post, again at reply_next_at) | posted | failed. NULL for summaries.
    reply_state: Mapped[str | None] = mapped_column(String(8))
    reply_attempts: Mapped[int] = mapped_column(SmallInteger, default=0, server_default="0")
    reply_next_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint("kind IN ('mention', 'summary')", name="kind_values"),
        CheckConstraint("status IN ('pending', 'running', 'done', 'failed')", name="status_values"),
        CheckConstraint(
            "reply_state IN ('pending', 'posted', 'failed')", name="reply_state_values"
        ),
        Index(
            "ai_runs_source_uniq",
            "kind",
            "source_message_id",
            unique=True,
            postgresql_where=text("source_message_id IS NOT NULL"),
        ),
        # The worker's pick: open runs only.
        Index(
            "ai_runs_open_idx",
            "created_at",
            postgresql_where=text("status IN ('pending', 'running')"),
        ),
        # The month's cost and the per-person count of the last day.
        Index("ai_runs_created_idx", "created_at"),
        Index("ai_runs_requester_idx", "requester_id", text("created_at DESC")),
        # The input purge.
        Index("ai_runs_input_idx", "created_at", postgresql_where=text("input IS NOT NULL")),
        # Replies to post (again).
        Index(
            "ai_runs_reply_due_idx",
            "reply_next_at",
            postgresql_where=text("reply_state = 'pending'"),
        ),
    )


class AiMentionInbox(Base):
    """A mention whose handling failed in the outbox relay (review v0.1.18 #10): the AI worker
    tries it again later, with a pause, and tells the thread when it gives up."""

    __tablename__ = "ai_mention_inbox"

    message_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), primary_key=True
    )
    attempts: Mapped[int] = mapped_column(SmallInteger, default=0, server_default="0")
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (Index("ai_mention_inbox_due_idx", "next_attempt_at"),)
