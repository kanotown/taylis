from datetime import date
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Query, Response

from app.core.db import Db
from app.modules.auth.deps import CurrentUser
from app.modules.tasks import service
from app.modules.tasks.schemas import (
    SubtaskUpdate,
    TaskColumnCreate,
    TaskColumnOut,
    TaskColumnUpdate,
    TaskCreate,
    TaskMove,
    TaskOut,
    TaskUpdate,
)

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


@router.get("/tasks/requested", response_model=list[TaskOut])
async def list_requested(user: CurrentUser, db: Db) -> list[TaskOut]:
    """L9: the shared tasks I made with someone else assigned (my review requests and the like):
    open ones by due date, then the 50 most recently completed."""
    return await service.list_requested(db, user)


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


@router.get("/tasks/deadlines", response_model=list[TaskOut])
async def list_deadlines(
    user: CurrentUser,
    db: Db,
    channel_id: UUID | None = Query(
        default=None, description="Only this channel's (left out: every channel I am in)"
    ),
) -> list[TaskOut]:
    """M85 (DEADLINES.md): the deadlines (kind `deadline`) of my channels due from 30 days ago
    on, open and done, by due date (then time); at most 500. 「締切」 and the header's chip."""
    return await service.list_deadlines(db, user, channel_id)


# --- M81 (TASKS.md §11): a board's columns (before /tasks/{task_id}) ------------------------------


@router.get("/tasks/columns", response_model=list[TaskColumnOut])
async def list_columns(
    user: CurrentUser,
    db: Db,
    channel_id: UUID = Query(description="The channel whose board's columns to read"),
) -> list[TaskColumnOut]:
    """A board's columns, left to right: the three built-in ones (renamed and moved, never
    deleted) and those added. Each belongs to a status; the cards of a done one are completed."""
    return await service.list_columns(db, user, channel_id)


@router.post("/tasks/columns", response_model=TaskColumnOut, status_code=201)
async def create_column(body: TaskColumnCreate, user: CurrentUser, db: Db) -> TaskColumnOut:
    """A new column (at most 20 per board), right of `after_id` (left out: the right end)."""
    return await service.create_column(db, user, body)


@router.patch("/tasks/columns/{column_id}", response_model=TaskColumnOut)
async def update_column(
    column_id: UUID, body: TaskColumnUpdate, user: CurrentUser, db: Db
) -> TaskColumnOut:
    """Rename it, or move it right of `after_id` (null: the left end)."""
    return await service.update_column(db, user, column_id, body)


@router.delete("/tasks/columns/{column_id}", status_code=204)
async def delete_column(column_id: UUID, user: CurrentUser, db: Db) -> Response:
    """An added column; its cards go to the built-in column of the same status."""
    await service.delete_column(db, user, column_id)
    return Response(status_code=204)


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


@router.patch("/tasks/{task_id}/subtasks/{subtask_id}", response_model=TaskOut)
async def update_subtask(
    task_id: UUID, subtask_id: UUID, body: SubtaskUpdate, user: CurrentUser, db: Db
) -> TaskOut:
    """M81: one item of the checklist (done, title); the rest of the list is left alone."""
    return await service.update_subtask(db, user, task_id, subtask_id, body)


@router.post("/tasks/{task_id}/move", response_model=TaskOut)
async def move_task(task_id: UUID, body: TaskMove, user: CurrentUser, db: Db) -> TaskOut:
    """To a column and a place in it; the server picks the position."""
    return await service.move(db, user, task_id, body)


@router.delete("/tasks/{task_id}", status_code=204)
async def delete_task(task_id: UUID, user: CurrentUser, db: Db) -> Response:
    """Its creator, its assignees, the channel's owners and administrators."""
    await service.delete(db, user, task_id)
    return Response(status_code=204)
