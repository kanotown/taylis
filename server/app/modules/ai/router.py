from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Query, Request, Response

from app.core.db import Db
from app.modules.ai import service
from app.modules.ai.llm import AiRuntime
from app.modules.ai.schemas import (
    AiAgentCreate,
    AiAgentOut,
    AiAgentUpdate,
    AiRunOut,
    AiStatusOut,
    AiSummaryCreate,
    AiUsageOut,
)
from app.modules.auth.deps import CurrentAdmin, CurrentUser

router = APIRouter(tags=["ai"])

# docs/AI.md §5: the contract the three clients code against.


def _runtime(request: Request) -> AiRuntime:
    runtime: AiRuntime = request.app.state.ai
    return runtime


@router.get("/admin/ai/agents", response_model=list[AiAgentOut])
async def list_agents(_: CurrentAdmin, db: Db) -> list[AiAgentOut]:
    """The AI bots (deleted ones are not listed), oldest first."""
    return await service.list_agents(db)


@router.post("/admin/ai/agents", response_model=AiAgentOut, status_code=201)
async def create_agent(actor: CurrentAdmin, body: AiAgentCreate, db: Db) -> AiAgentOut:
    """A new AI bot with its own bot user (409 username_taken)."""
    return await service.create_agent(db, actor, body)


@router.patch("/admin/ai/agents/{agent_id}", response_model=AiAgentOut)
async def update_agent(
    agent_id: UUID, actor: CurrentAdmin, body: AiAgentUpdate, db: Db
) -> AiAgentOut:
    """Only the fields sent change; the username never does."""
    return await service.update_agent(db, actor, agent_id, body)


@router.delete("/admin/ai/agents/{agent_id}", status_code=204)
async def delete_agent(agent_id: UUID, actor: CurrentAdmin, db: Db) -> Response:
    """The bot leaves every conversation and is deactivated; its posts stay."""
    await service.delete_agent(db, actor, agent_id)
    return Response(status_code=204)


@router.get("/admin/ai/usage", response_model=AiUsageOut)
async def get_usage(
    _: CurrentAdmin,
    db: Db,
    request: Request,
    month: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}$"),
) -> AiUsageOut:
    """A month's use (UTC month; default this one): per bot and per person."""
    return await service.usage(db, _runtime(request), month)


@router.get("/ai/status", response_model=AiStatusOut)
async def get_status(_: CurrentUser, db: Db, request: Request) -> AiStatusOut:
    """Whether the AI can be used here, and the AI bots (for the 「AI」 badge)."""
    return await service.status(db, _runtime(request))


@router.post("/ai/summaries", response_model=AiRunOut, status_code=202)
async def create_summary(
    body: AiSummaryCreate, user: CurrentUser, db: Db, request: Request
) -> AiRunOut:
    """A summary only the requester sees, of the messages they can read; the result arrives as
    ai.run_updated and through GET /ai/runs/{id}."""
    return await service.create_summary(db, _runtime(request), user, body)


@router.get("/ai/runs/{run_id}", response_model=AiRunOut)
async def get_run(run_id: UUID, user: CurrentUser, db: Db) -> AiRunOut:
    """One of my runs (others' are 404 ai_run_not_found)."""
    return await service.get_run(db, user, run_id)


@router.get("/ai/runs", response_model=list[AiRunOut])
async def list_runs(
    user: CurrentUser,
    db: Db,
    kind: Literal["mention", "summary"] | None = Query(default=None),
) -> list[AiRunOut]:
    """My most recent 20 runs, newest first."""
    return await service.list_runs(db, user, kind)
