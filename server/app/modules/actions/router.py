"""操作ボタン (M143, docs/ACTIONS.md §7)."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query, Request

from app.core.db import Db
from app.core.errors import rate_limited
from app.modules.actions import service
from app.modules.actions.schemas import (
    ActionAdminOut,
    ActionCreate,
    ActionInvocationOut,
    ActionInvoke,
    ActionInvokeOut,
    ActionListOut,
    ActionOrder,
    ActionSettingsOut,
    ActionSettingsUpdate,
    ActionUpdate,
)
from app.modules.auth.deps import CurrentUser, IntegrationsManager

router = APIRouter(tags=["actions"])


def _limit(request: Request, name: str, key: str) -> None:
    limiter = request.app.state.limiters[name]
    if not limiter.try_acquire(key):
        raise rate_limited(limiter.retry_after_seconds(key))


@router.get("/actions", response_model=ActionListOut)
async def list_actions(user: CurrentUser, db: Db) -> ActionListOut:
    """The enabled buttons I may press, in order (none while the feature is off, and never for
    guests or bots). No URL, key or rights."""
    return await service.list_for(db, user)


@router.post("/actions/{action_id}/invoke", response_model=ActionInvokeOut)
async def invoke(
    action_id: UUID, body: ActionInvoke, user: CurrentUser, request: Request
) -> ActionInvokeOut:
    """Calls the button's relay once, now, and returns its answer (docs/ACTIONS.md §4). A relay
    failure is 200 with `ok: false`. The same client_invoke_id again returns the earlier result
    without calling the relay. Never retried. 409 actions_disabled / action_disabled, 403
    action_not_allowed, 429 (one press per button every few seconds)."""
    key = f"{user.id}:{action_id}"
    return await service.invoke(
        request.app.state.db.session_factory,
        user,
        action_id,
        body.client_invoke_id,
        request.app.state.settings,
        request.app.state.action_poster,
        lambda: _limit(request, "action_invoke", key),
    )


# --- administration ------------------------------------------------------------------------


@router.get("/admin/actions/settings", response_model=ActionSettingsOut, tags=["admin"])
async def get_settings(_: IntegrationsManager, db: Db) -> ActionSettingsOut:
    return await service.admin_settings(db)


@router.patch("/admin/actions/settings", response_model=ActionSettingsOut, tags=["admin"])
async def update_settings(
    body: ActionSettingsUpdate, actor: IntegrationsManager, db: Db
) -> ActionSettingsOut:
    return await service.update_settings(db, actor, body)


@router.get("/admin/actions", response_model=list[ActionAdminOut], tags=["admin"])
async def admin_list(_: IntegrationsManager, db: Db, request: Request) -> list[ActionAdminOut]:
    """Every button, with its relay, key file name (never the key) and rights."""
    return await service.admin_list(db, request.app.state.settings)


@router.post("/admin/actions", response_model=ActionAdminOut, status_code=201, tags=["admin"])
async def create_action(
    body: ActionCreate, actor: IntegrationsManager, db: Db, request: Request
) -> ActionAdminOut:
    """`url` must be https and public; `secret_name` names the signing key's file in
    ACTION_SECRETS_DIR. At most 50 buttons."""
    return await service.create_action(db, actor, body, request.app.state.settings)


@router.put("/admin/actions/order", response_model=list[ActionAdminOut], tags=["admin"])
async def reorder(
    body: ActionOrder, actor: IntegrationsManager, db: Db, request: Request
) -> list[ActionAdminOut]:
    return await service.reorder(db, actor, body, request.app.state.settings)


@router.patch("/admin/actions/{action_id}", response_model=ActionAdminOut, tags=["admin"])
async def update_action(
    action_id: UUID,
    body: ActionUpdate,
    actor: IntegrationsManager,
    db: Db,
    request: Request,
) -> ActionAdminOut:
    return await service.update_action(db, actor, action_id, body, request.app.state.settings)


@router.delete("/admin/actions/{action_id}", status_code=204, tags=["admin"])
async def delete_action(action_id: UUID, actor: IntegrationsManager, db: Db) -> None:
    await service.delete_action(db, actor, action_id)


@router.post("/admin/actions/{action_id}/test", response_model=ActionInvokeOut, tags=["admin"])
async def test_action(
    action_id: UUID, actor: IntegrationsManager, request: Request
) -> ActionInvokeOut:
    """「テスト送信」: an `action.test` now (the relay must not act on it); recorded, never
    retried."""
    _limit(request, "action_test", str(actor.id))
    return await service.send_test(
        request.app.state.db.session_factory,
        actor,
        action_id,
        request.app.state.settings,
        request.app.state.action_poster,
    )


@router.get(
    "/admin/actions/{action_id}/invocations",
    response_model=list[ActionInvocationOut],
    tags=["admin"],
)
async def list_invocations(
    action_id: UUID,
    _: IntegrationsManager,
    db: Db,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[ActionInvocationOut]:
    """Newest first."""
    return await service.invocations(db, action_id, limit)
