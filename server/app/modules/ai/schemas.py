"""docs/AI.md §5 (and §13.5): the contract the three clients code against (JSON keys as written
there)."""

import re
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from app.modules.admin.schemas import USERNAME_PATTERN
from app.modules.ai.models import MAX_CHARACTER_LENGTH, MAX_NAME_LENGTH, AiAgent, AiRun
from app.modules.search.schemas import MAX_QUERY_LENGTH

AiModel = Literal[
    "claude-fable-5-1",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-4-5",
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6-luna",
]
AiProviderName = Literal["anthropic", "openai"]
AiEffort = Literal["low", "medium", "high"]
AiRunKind = Literal["mention", "summary", "ask"]
AiRunStatus = Literal["pending", "running", "done", "failed"]
AiScope = Literal["unread", "thread", "recent"]


def _clean_name(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = " ".join(value.split())
    if not cleaned:
        raise ValueError("A name cannot be blank")
    return cleaned


def _clean_character(value: str | None) -> str | None:
    if value is None:
        return None
    return value.replace("\r\n", "\n").replace("\r", "\n").strip()


class AiAgentOut(BaseModel):
    id: UUID
    bot_user_id: UUID
    username: str
    name: str
    character: str
    model: AiModel
    effort: AiEffort
    allow_private: bool
    enabled: bool
    created_at: datetime
    updated_at: datetime
    # docs/AI.md §14: mention replies may search the web; the bot summaries and questions use when
    # the conversation has none of its own; the bot user's picture version (null: no picture).
    web_search: bool = False
    is_default: bool = False
    avatar_updated_at: datetime | None = None


class AiAgentPublic(BaseModel):
    id: UUID
    bot_user_id: UUID
    name: str
    model: AiModel
    # docs/AI.md §14: for the notice (§4): its replies may send search queries to the web.
    web_search: bool = False


class AiAgentCreate(BaseModel):
    username: str = Field(pattern=USERNAME_PATTERN)
    name: str = Field(min_length=1, max_length=MAX_NAME_LENGTH)
    character: str = Field(max_length=MAX_CHARACTER_LENGTH)
    model: AiModel
    effort: AiEffort = "medium"
    allow_private: bool = False
    enabled: bool = True
    # docs/AI.md §14.
    web_search: bool = False
    is_default: bool = False

    _name = field_validator("name")(_clean_name)
    _character = field_validator("character")(_clean_character)


class AiAgentUpdate(BaseModel):
    """Only the fields sent change; the username changes through PATCH /admin/users/{id} (M96)."""

    name: str | None = Field(default=None, min_length=1, max_length=MAX_NAME_LENGTH)
    character: str | None = Field(default=None, max_length=MAX_CHARACTER_LENGTH)
    model: AiModel | None = None
    effort: AiEffort | None = None
    allow_private: bool | None = None
    enabled: bool | None = None
    # docs/AI.md §14: true makes this the default bot (the previous one stops being it); false
    # leaves no default bot (the oldest usable one is used, as before).
    web_search: bool | None = None
    is_default: bool | None = None

    _name = field_validator("name")(_clean_name)
    _character = field_validator("character")(_clean_character)


class AiStatusOut(BaseModel):
    available: bool
    summary_available: bool
    agents: list[AiAgentPublic]


class AiProviderOut(BaseModel):
    """docs/AI.md §12 (admin only): a provider, whether its key file is configured, its models."""

    name: AiProviderName
    configured: bool
    models: list[AiModel]


class AiSummaryCreate(BaseModel):
    channel_id: UUID
    scope: AiScope
    thread_id: UUID | None = None
    days: int | None = Field(default=None, ge=1, le=7)
    # The requester's offset from UTC: the times in the transcript are written in it (default
    # Japan, +540).
    tz_offset_minutes: int | None = Field(default=None, ge=-840, le=840)


class AiAskCreate(BaseModel):
    """POST /ai/ask (docs/AI.md §13): the question as typed in the search box, modifiers
    (in:# from:@ before: after: on: has: is:) included; they limit what is looked through."""

    q: str = Field(min_length=1, max_length=MAX_QUERY_LENGTH)
    # The requester's offset from UTC (dates in the question, times in the transcript; default
    # Japan, +540).
    tz_offset_minutes: int | None = Field(default=None, ge=-840, le=840)
    # The conversation the search screen is narrowed to, as the search's channel_id.
    channel_id: UUID | None = None


class AiSourceOut(BaseModel):
    """A message an answer cites as [n] (docs/AI.md §13.3)."""

    n: int
    message_id: UUID
    channel_id: UUID
    parent_id: UUID | None
    sender_id: UUID
    created_at: datetime
    # Plain text around the first matching word (about 60 characters on each side).
    excerpt: str


class AiRunOut(BaseModel):
    id: UUID
    kind: AiRunKind
    status: AiRunStatus
    # null only for a question (ask) not narrowed to one conversation.
    channel_id: UUID | None
    thread_id: UUID | None
    scope: AiScope | None
    days: int | None
    output: str | None
    error: str | None
    omitted_count: int
    created_at: datetime
    finished_at: datetime | None
    # Added (review v0.1.18 #2): where the run's text is sent, fixed when the run was created.
    # null only for runs from before that.
    provider: AiProviderName | None
    model: str | None
    # Added (M70, docs/AI.md §13): the question of an ask run (null for the other kinds), and
    # the messages its answer cites, by their [n] (done runs only; empty otherwise).
    question: str | None = None
    sources: list[AiSourceOut] = Field(default_factory=list)


class AiSummaryTargetOut(BaseModel):
    """GET /ai/summaries/target (docs/AI.md §5): where a summary of this conversation would be
    sent, shown before asking. `reason` (ai_unavailable, ai_private_not_allowed,
    ai_budget_exceeded) when it cannot be asked now; provider / model / agent_name are still
    given when a bot was found (e.g. the bot of a private conversation without allow_private)."""

    available: bool
    provider: AiProviderName | None
    model: str | None
    agent_name: str | None
    reason: str | None


class AiAskTargetOut(BaseModel):
    """GET /ai/ask/target (docs/AI.md §13.5): where a question would be sent, shown before
    asking; the same shape and reasons as AiSummaryTargetOut."""

    available: bool
    provider: AiProviderName | None
    model: str | None
    agent_name: str | None
    reason: str | None


class AiRunUpdatedData(BaseModel):
    run: AiRunOut


class AiUsageByAgent(BaseModel):
    agent_id: UUID
    name: str
    runs: int
    input_tokens: int
    output_tokens: int
    cost_usd: float
    # docs/AI.md §14: web searches the provider ran for the bot (in cost_usd at their own price).
    web_search_requests: int = 0


class AiUsageByUser(BaseModel):
    user_id: UUID
    runs: int
    cost_usd: float


class AiUsageOut(BaseModel):
    month: str
    budget_usd: float
    total_cost_usd: float
    total_runs: int
    by_agent: list[AiUsageByAgent]
    by_user: list[AiUsageByUser]


def to_agent_out(
    agent: AiAgent, username: str, avatar_updated_at: datetime | None = None
) -> AiAgentOut:
    return AiAgentOut(
        id=agent.id,
        bot_user_id=agent.bot_user_id,
        username=username,
        web_search=agent.web_search,
        is_default=agent.is_default,
        avatar_updated_at=avatar_updated_at,
        name=agent.name,
        character=agent.character,
        model=agent.model,  # type: ignore[arg-type]
        effort=agent.effort,  # type: ignore[arg-type]
        allow_private=agent.allow_private,
        enabled=agent.enabled,
        created_at=agent.created_at,
        updated_at=agent.updated_at,
    )


def to_agent_public(agent: AiAgent) -> AiAgentPublic:
    return AiAgentPublic(
        id=agent.id,
        bot_user_id=agent.bot_user_id,
        name=agent.name,
        model=agent.model,  # type: ignore[arg-type]
        web_search=agent.web_search,
    )


def to_run_out(run: AiRun) -> AiRunOut:
    return AiRunOut(
        id=run.id,
        kind=run.kind,  # type: ignore[arg-type]
        status=run.status,  # type: ignore[arg-type]
        channel_id=run.channel_id,
        thread_id=run.thread_id,
        scope=run.scope,  # type: ignore[arg-type]
        days=run.days,
        output=run.output,
        error=run.error,
        omitted_count=run.omitted_count,
        created_at=run.created_at,
        finished_at=run.finished_at,
        provider=run.provider,  # type: ignore[arg-type]
        model=run.model,
        question=run.question,
        sources=cited_sources(run),
    )


_CITATION = re.compile(r"\[(\d+(?:\s*[,、]\s*\d+)*)\]")


def cited_numbers(text: str) -> set[int]:
    """The source numbers an answer cites: [3], [1][4], [1, 4] and [1、4]."""
    found: set[int] = set()
    for match in _CITATION.finditer(text):
        found.update(int(n) for n in re.split(r"\s*[,、]\s*", match.group(1)))
    return found


def cited_sources(run: AiRun) -> list[AiSourceOut]:
    """docs/AI.md §13.3: the sources of a done ask run that its answer cites, by number."""
    if run.kind != "ask" or run.status != "done" or not run.output or not run.sources:
        return []
    cited = cited_numbers(run.output)
    return [
        AiSourceOut.model_validate(s)
        for s in sorted(run.sources, key=lambda s: int(s["n"]))
        if int(s["n"]) in cited
    ]
