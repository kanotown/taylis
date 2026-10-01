from datetime import date
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Query, Response

from app.core.db import Db
from app.modules.auth.deps import CurrentUser
from app.modules.tasks import service
from app.modules.tasks.schemas import TaskCreate, TaskMove, TaskOut, TaskUpdate

router = APIRouter(tags=["tasks"])

# TASKS.md §3. Personal tasks: their owner only; a board's: the channel's members (§2). A task
# someone cannot see is 404.


@router.get("/tasks", response_model=list[TaskOut])
async def list_board(
    user: CurrentUser,
    db: Db,
    channel_id: UUID = Query(description="The channel whose board to read"),
    include_done: Literal["recent", "all"] = Query(
        default="recent", description="recent: the 100 most recently completed; all: every one"
    ),
) -> list[TaskOut]:
    """A channel's board: every open task and the completed ones, by column and position."""
    return await service.list_board(db, user, channel_id, include_done=include_done == "all")


@router.get("/tasks/mine", response_model=list[TaskOut])
async def list_mine(user: CurrentUser, db: Db) -> list[TaskOut]:
    """My own tasks and the shared ones assigned to me (in channels I belong to); of the
    completed ones, the 50 most recent."""
    return await service.list_mine(db, user)


@router.get("/tasks/due", response_model=list[TaskOut])
async def list_due(
    user: CurrentUser,
    db: Db,
    start: date = Query(alias="from", description="First day (YYYY-MM-DD)"),
    end: date = Query(
        alias="to", description="The day after the last (excluded); at most 100 days after `from`"
    ),
) -> list[TaskOut]:
    """Tasks I can see whose due date is in [from, to), completed ones too (the calendar);
    at most 1000."""
    return await service.list_due(db, user, start, end)


@router.post(
    "/tasks",
    response_model=TaskOut,
    status_code=201,
    responses={200: {"model": TaskOut, "description": "A retry: the task made before"}},
)
async def create_task(body: TaskCreate, user: CurrentUser, db: Db, response: Response) -> TaskOut:
    """A new task in my list or on a channel's board (a member who may post there)."""
    out, created = await service.create(db, user, body)
    response.status_code = 201 if created else 200
    return out


@router.get("/tasks/{task_id}", response_model=TaskOut)
async def get_task(task_id: UUID, user: CurrentUser, db: Db) -> TaskOut:
    return await service.get_task(db, user, task_id)


@router.patch("/tasks/{task_id}", response_model=TaskOut)
async def update_task(task_id: UUID, body: TaskUpdate, user: CurrentUser, db: Db) -> TaskOut:
    """Members who may post on the board (a personal task: its owner)."""
    return await service.update(db, user, task_id, body)


@router.post("/tasks/{task_id}/move", response_model=TaskOut)
async def move_task(task_id: UUID, body: TaskMove, user: CurrentUser, db: Db) -> TaskOut:
    """To a column and a place in it; the server picks the position."""
    return await service.move(db, user, task_id, body)


@router.delete("/tasks/{task_id}", status_code=204)
async def delete_task(task_id: UUID, user: CurrentUser, db: Db) -> Response:
    """Its creator, its assignees, the channel's owners and administrators."""
    await service.delete(db, user, task_id)
    return Response(status_code=204)
