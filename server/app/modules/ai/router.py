from typing import Literal
from uuid import UUID

from fastapi import APIRouter, File, Query, Request, Response, UploadFile

from app.core.db import Db
from app.core.errors import rate_limited
from app.modules.ai import service
from app.modules.ai.llm import AiRuntime
from app.modules.ai.schemas import (
    AiAgentCreate,
    AiAgentOut,
    AiAgentUpdate,
    AiAskCreate,
    AiAskTargetOut,
    AiProviderOut,
    AiRunOut,
    AiStatusOut,
    AiSummaryCreate,
    AiSummaryTargetOut,
    AiUsageOut,
)
from app.modules.auth.deps import AiManager, CurrentUser
from app.modules.search.schemas import MAX_QUERY_LENGTH

router = APIRouter(tags=["ai"])

# docs/AI.md §5: the contract the three clients code against.


def _runtime(request: Request) -> AiRuntime:
    runtime: AiRuntime = request.app.state.ai
    return runtime


@router.get("/admin/ai/agents", response_model=list[AiAgentOut])
async def list_agents(_: AiManager, db: Db) -> list[AiAgentOut]:
    """The AI bots (deleted ones are not listed), oldest first."""
    return await service.list_agents(db)


@router.post("/admin/ai/agents", response_model=AiAgentOut, status_code=201)
async def create_agent(actor: AiManager, body: AiAgentCreate, db: Db) -> AiAgentOut:
    """A new AI bot with its own bot user (409 username_taken)."""
    return await service.create_agent(db, actor, body)


@router.patch("/admin/ai/agents/{agent_id}", response_model=AiAgentOut)
async def update_agent(agent_id: UUID, actor: AiManager, body: AiAgentUpdate, db: Db) -> AiAgentOut:
    """Only the fields sent change; the username changes through PATCH /admin/users/{id} (M96)."""
    return await service.update_agent(db, actor, agent_id, body)


@router.post("/admin/ai/agents/{agent_id}/avatar", response_model=AiAgentOut)
async def upload_agent_avatar(
    agent_id: UUID, actor: AiManager, db: Db, request: Request, file: UploadFile = File(...)
) -> AiAgentOut:
    """The bot's picture (docs/AI.md §14): as POST /users/me/avatar (a PNG / JPEG / GIF / WebP,
    cropped square and resized to 256px) for the bot user. 404 ai_agent_not_found."""
    limiter = request.app.state.limiters["upload"]
    key = str(actor.id)
    if not limiter.try_acquire(key):
        raise rate_limited(limiter.retry_after_seconds(key))
    return await service.set_agent_avatar(
        db, actor, agent_id, file, request.app.state.settings, request.app.state.blobs
    )


@router.delete("/admin/ai/agents/{agent_id}/avatar", response_model=AiAgentOut)
async def delete_agent_avatar(
    agent_id: UUID, actor: AiManager, db: Db, request: Request
) -> AiAgentOut:
    """The bot goes back to its drawn initial (docs/AI.md §14)."""
    return await service.clear_agent_avatar(db, actor, agent_id, request.app.state.blobs)


@router.delete("/admin/ai/agents/{agent_id}", status_code=204)
async def delete_agent(agent_id: UUID, actor: AiManager, db: Db) -> Response:
    """The bot leaves every conversation and is deactivated; its posts stay."""
    await service.delete_agent(db, actor, agent_id)
    return Response(status_code=204)


@router.get("/admin/ai/usage", response_model=AiUsageOut)
async def get_usage(
    _: AiManager,
    db: Db,
    request: Request,
    month: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}$"),
) -> AiUsageOut:
    """A month's use (UTC month; default this one): per bot and per person."""
    return await service.usage(db, _runtime(request), month)


@router.get("/admin/ai/providers", response_model=list[AiProviderOut])
async def list_providers(_: AiManager, request: Request) -> list[AiProviderOut]:
    """The model providers (anthropic, openai): whether the server has each one's API key, and
    the models it serves (docs/AI.md §12)."""
    return service.providers(_runtime(request))


@router.get("/ai/status", response_model=AiStatusOut)
async def get_status(_: CurrentUser, db: Db, request: Request) -> AiStatusOut:
    """Whether the AI can be used here, and the AI bots (for the 「AI」 badge)."""
    return await service.status(db, _runtime(request))


@router.get("/ai/summaries/target", response_model=AiSummaryTargetOut)
async def get_summary_target(
    channel_id: UUID, user: CurrentUser, db: Db, request: Request
) -> AiSummaryTargetOut:
    """Where a summary of this conversation would be sent (provider, model, bot), shown before
    asking; `available = false` with `reason` when it cannot be asked now (404 channel_not_found
    for a conversation one cannot read)."""
    return await service.summary_target(db, _runtime(request), user, channel_id)


@router.post("/ai/summaries", response_model=AiRunOut, status_code=202)
async def create_summary(
    body: AiSummaryCreate, user: CurrentUser, db: Db, request: Request
) -> AiRunOut:
    """A summary only the requester sees, of the messages they can read; the result arrives as
    ai.run_updated and through GET /ai/runs/{id}."""
    return await service.create_summary(db, _runtime(request), user, body)


@router.get("/ai/ask/target", response_model=AiAskTargetOut)
async def get_ask_target(
    user: CurrentUser,
    db: Db,
    request: Request,
    q: str = Query(default="", max_length=MAX_QUERY_LENGTH),
    channel_id: UUID | None = None,
) -> AiAskTargetOut:
    """Where a question would be sent (provider, model, bot), shown before asking: the bot of the
    one conversation the question is narrowed to (channel_id or in:#), else the default bot
    (docs/AI.md §13.4). 404 channel_not_found for a conversation one cannot search."""
    return await service.ask_target(db, _runtime(request), user, q, channel_id)


@router.post("/ai/ask", response_model=AiRunOut, status_code=202)
async def create_ask(body: AiAskCreate, user: CurrentUser, db: Db, request: Request) -> AiRunOut:
    """「AI に聞く」 (docs/AI.md §13): an answer only the requester sees, from the messages the
    search finds for the question (the search's scope and modifiers), citing them as [n]
    (`sources`). The result arrives as ai.run_updated and through GET /ai/runs/{id}."""
    settings = request.app.state.settings
    return await service.create_ask(
        db,
        _runtime(request),
        user,
        body,
        timeout_ms=settings.search_timeout_ms,
        gate=request.app.state.search_gate,
    )


@router.get("/ai/runs/{run_id}", response_model=AiRunOut)
async def get_run(run_id: UUID, user: CurrentUser, db: Db) -> AiRunOut:
    """One of my runs (others' are 404 ai_run_not_found)."""
    return await service.get_run(db, user, run_id)


@router.get("/ai/runs", response_model=list[AiRunOut])
async def list_runs(
    user: CurrentUser,
    db: Db,
    kind: Literal["mention", "summary", "ask"] | None = Query(default=None),
) -> list[AiRunOut]:
    """My most recent 20 runs, newest first."""
    return await service.list_runs(db, user, kind)
