from uuid import UUID

from fastapi import APIRouter, Request, Response

from app.core.db import Db
from app.core.errors import rate_limited
from app.modules.auth.deps import CurrentUser
from app.modules.messages import service as messages
from app.modules.messages.schemas import MessageOut
from app.modules.workflows import service
from app.modules.workflows.schemas import (
    WorkflowCreate,
    WorkflowOut,
    WorkflowSubmit,
    WorkflowTemplateOut,
    WorkflowUpdate,
)
from app.modules.workflows.templates import workflow_templates

router = APIRouter(tags=["workflows"])

# docs/WORKFLOWS.md §4. Whoever can read a workflow's target channel sees it; its owners and the
# administrators who can read it manage it (403 workflow_manage_restricted); whoever may post
# there submits it.


@router.get("/workflow-templates", response_model=list[WorkflowTemplateOut])
async def list_workflow_templates(user: CurrentUser) -> list[WorkflowTemplateOut]:
    """「テンプレートから作成」: starting points for the editor (never workflows by themselves)."""
    return workflow_templates()


@router.get("/workflows", response_model=list[WorkflowOut])
async def list_workflows(user: CurrentUser, db: Db) -> list[WorkflowOut]:
    """The workflows I may manage (paused ones too), by name."""
    return await service.list_manageable(db, user)


@router.get("/channels/{channel_id}/workflows", response_model=list[WorkflowOut])
async def list_channel_workflows(channel_id: UUID, user: CurrentUser, db: Db) -> list[WorkflowOut]:
    """The workflows offered in the channel whose target I can read (the menu and `/`), by name;
    `run_blocked` says why I cannot submit one."""
    return await service.list_offered(db, user, channel_id)


@router.post("/workflows", response_model=WorkflowOut, status_code=201)
async def create_workflow(body: WorkflowCreate, user: CurrentUser, db: Db) -> WorkflowOut:
    """A new workflow posting to `channel_id` (its owners and administrators). At most 200 in the
    workspace (409 too_many_workflows); names are unique (409 workflow_name_taken)."""
    return await service.create(db, user, body)


@router.get("/workflows/{workflow_id}", response_model=WorkflowOut)
async def get_workflow(workflow_id: UUID, user: CurrentUser, db: Db) -> WorkflowOut:
    return await service.get(db, user, workflow_id)


@router.patch("/workflows/{workflow_id}", response_model=WorkflowOut)
async def update_workflow(
    workflow_id: UUID, body: WorkflowUpdate, user: CurrentUser, db: Db
) -> WorkflowOut:
    """A new target must be one I manage too. Messages already posted stay as they are."""
    return await service.update(db, user, workflow_id, body)


@router.delete("/workflows/{workflow_id}", status_code=204)
async def delete_workflow(workflow_id: UUID, user: CurrentUser, db: Db) -> Response:
    """Gone for good; the messages it posted keep their 「⚡ name」 label."""
    await service.delete(db, user, workflow_id)
    return Response(status_code=204)


@router.post("/workflows/{workflow_id}/submit", response_model=MessageOut)
async def submit_workflow(
    workflow_id: UUID,
    body: WorkflowSubmit,
    user: CurrentUser,
    db: Db,
    request: Request,
    response: Response,
) -> MessageOut:
    """Posts the filled form to the target channel as me: 201 with the new message, 200 with the
    same message for a retry with the same client_msg_id. 400 workflow_values_invalid carries
    `details.fields = {key: reason}`."""
    limiter = request.app.state.limiters["message"]  # counts as a post (SECURITY.md §5)
    key = str(user.id)
    if not limiter.try_acquire(key):
        raise rate_limited(limiter.retry_after_seconds(key))
    message, created = await service.submit(db, user, workflow_id, body)
    response.status_code = 201 if created else 200
    return await messages.message_out(db, message, user.id)
