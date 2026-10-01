"""docs/AI.md §5: the contract the three clients code against (JSON keys as written there)."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from app.modules.admin.schemas import USERNAME_PATTERN
from app.modules.ai.models import MAX_CHARACTER_LENGTH, MAX_NAME_LENGTH, AiAgent, AiRun

AiModel = Literal[
    "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5", "gpt-6.1-sol", "gpt-6-luna"
]
AiProviderName = Literal["anthropic", "openai"]
AiEffort = Literal["low", "medium", "high"]
AiRunKind = Literal["mention", "summary"]
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


class AiAgentPublic(BaseModel):
    id: UUID
    bot_user_id: UUID
    name: str
    model: AiModel


class AiAgentCreate(BaseModel):
    username: str = Field(pattern=USERNAME_PATTERN)
    name: str = Field(min_length=1, max_length=MAX_NAME_LENGTH)
    character: str = Field(max_length=MAX_CHARACTER_LENGTH)
    model: AiModel
    effort: AiEffort = "medium"
    allow_private: bool = False
    enabled: bool = True

    _name = field_validator("name")(_clean_name)
    _character = field_validator("character")(_clean_character)


class AiAgentUpdate(BaseModel):
    """Only the fields sent change; the username never does."""

    name: str | None = Field(default=None, min_length=1, max_length=MAX_NAME_LENGTH)
    character: str | None = Field(default=None, max_length=MAX_CHARACTER_LENGTH)
    model: AiModel | None = None
    effort: AiEffort | None = None
    allow_private: bool | None = None
    enabled: bool | None = None

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


class AiRunOut(BaseModel):
    id: UUID
    kind: AiRunKind
    status: AiRunStatus
    channel_id: UUID
    thread_id: UUID | None
    scope: AiScope | None
    days: int | None
    output: str | None
    error: str | None
    omitted_count: int
    created_at: datetime
    finished_at: datetime | None


class AiRunUpdatedData(BaseModel):
    run: AiRunOut


class AiUsageByAgent(BaseModel):
    agent_id: UUID
    name: str
    runs: int
    input_tokens: int
    output_tokens: int
    cost_usd: float


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


def to_agent_out(agent: AiAgent, username: str) -> AiAgentOut:
    return AiAgentOut(
        id=agent.id,
        bot_user_id=agent.bot_user_id,
        username=username,
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
    )
