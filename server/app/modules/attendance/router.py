"""在室状況 (M140, docs/PRESENCE.md §3, §6)."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.db import Db
from app.core.errors import rate_limited, unauthorized
from app.modules.attendance import service, webhooks
from app.modules.attendance.schemas import (
    AttendanceAdminSettingsOut,
    AttendanceBoardOut,
    AttendanceDeliveryOut,
    AttendanceEntryOut,
    AttendanceInbound,
    AttendanceInboundOut,
    AttendanceIntegrationCreate,
    AttendanceIntegrationCreated,
    AttendanceIntegrationOut,
    AttendanceIntegrationUpdate,
    AttendanceLogPage,
    AttendanceSet,
    AttendanceSettingsUpdate,
    AttendanceStateCreate,
    AttendanceStateOrder,
    AttendanceStateOut,
    AttendanceStateUpdate,
    AttendanceTestOut,
    AttendanceTokenOut,
)
from app.modules.auth.deps import (
    AttendanceConfigurer,
    AttendanceManager,
    CurrentUser,
    IntegrationsManager,
)

router = APIRouter(tags=["attendance"])
_bearer = HTTPBearer(auto_error=False)


def _limit(request: Request, name: str, key: str) -> None:
    limiter = request.app.state.limiters[name]
    if not limiter.try_acquire(key):
        raise rate_limited(limiter.retry_after_seconds(key))


# --- the board -----------------------------------------------------------------------------


@router.get("/attendance", response_model=AttendanceBoardOut)
async def get_board(user: CurrentUser, db: Db) -> AttendanceBoardOut:
    """The board: states (the workspace's and everyone's own), one entry per person who has set
    one, and whether I may add my own states. `enabled: false` while off; 403 for guests."""
    return await service.board(db, user)


@router.put("/attendance/me", response_model=AttendanceEntryOut)
async def set_mine(
    body: AttendanceSet, user: CurrentUser, db: Db, request: Request
) -> AttendanceEntryOut:
    """My state (a workspace state or one of mine) and note. The same state and note again
    changes nothing (no event). 409 attendance_disabled while off."""
    _limit(request, "attendance", str(user.id))
    return await service.set_mine(db, user, body)


@router.get("/attendance/log", response_model=AttendanceLogPage)
async def get_log(
    user: CurrentUser,
    db: Db,
    user_id: UUID | None = None,
    before_id: int | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> AttendanceLogPage:
    """Newest first. Mine for anyone; another person's (or everyone's) for administrators."""
    return await service.log_page(db, user, user_id, before_id, limit)


@router.post("/attendance/my-states", response_model=AttendanceStateOut, status_code=201)
async def create_my_state(
    body: AttendanceStateCreate, user: CurrentUser, db: Db
) -> AttendanceStateOut:
    """A personal state (when the administrator's rule allows me; at most 10)."""
    return await service.create_mine(db, user, body)


@router.patch("/attendance/my-states/{state_id}", response_model=AttendanceStateOut)
async def update_my_state(
    state_id: UUID, body: AttendanceStateUpdate, user: CurrentUser, db: Db
) -> AttendanceStateOut:
    return await service.update_mine(db, user, state_id, body)


@router.delete("/attendance/my-states/{state_id}", status_code=204)
async def delete_my_state(state_id: UUID, user: CurrentUser, db: Db) -> None:
    """Archived: if I am in it, I stay until my next change."""
    await service.delete_mine(db, user, state_id)


# --- administration ------------------------------------------------------------------------


@router.get("/admin/attendance/settings", response_model=AttendanceAdminSettingsOut, tags=["admin"])
async def get_settings(_: AttendanceManager, db: Db) -> AttendanceAdminSettingsOut:
    return await service.admin_settings(db)


@router.patch(
    "/admin/attendance/settings", response_model=AttendanceAdminSettingsOut, tags=["admin"]
)
async def update_settings(
    body: AttendanceSettingsUpdate, actor: AttendanceConfigurer, db: Db
) -> AttendanceAdminSettingsOut:
    """Turning the board on the first time makes the four default states (in the
    administrator's language) when there are none."""
    return await service.update_settings(db, actor, body)


@router.post(
    "/admin/attendance/states", response_model=AttendanceStateOut, status_code=201, tags=["admin"]
)
async def create_state(
    body: AttendanceStateCreate, actor: AttendanceManager, db: Db
) -> AttendanceStateOut:
    return await service.create_state(db, actor, body)


@router.put(
    "/admin/attendance/states/order", response_model=AttendanceAdminSettingsOut, tags=["admin"]
)
async def reorder_states(
    body: AttendanceStateOrder, actor: AttendanceManager, db: Db
) -> AttendanceAdminSettingsOut:
    return await service.reorder_states(db, actor, body)


@router.patch(
    "/admin/attendance/states/{state_id}", response_model=AttendanceStateOut, tags=["admin"]
)
async def update_state(
    state_id: UUID, body: AttendanceStateUpdate, actor: AttendanceManager, db: Db
) -> AttendanceStateOut:
    return await service.update_state(db, actor, state_id, body)


@router.delete("/admin/attendance/states/{state_id}", status_code=204, tags=["admin"])
async def delete_state(state_id: UUID, actor: AttendanceManager, db: Db) -> None:
    """Archived (people in it stay until their next change). 409 for the last one."""
    await service.delete_state(db, actor, state_id)


@router.put("/admin/attendance/users/{user_id}", response_model=AttendanceEntryOut, tags=["admin"])
async def set_for_user(
    user_id: UUID, body: AttendanceSet, actor: AttendanceManager, db: Db
) -> AttendanceEntryOut:
    """Someone else's state (audited, source `admin`)."""
    return await service.set_for(db, actor, user_id, body)


@router.get(
    "/admin/attendance/integrations",
    response_model=list[AttendanceIntegrationOut],
    tags=["admin"],
)
async def list_integrations(_: IntegrationsManager, db: Db) -> list[AttendanceIntegrationOut]:
    return await service.list_integrations(db)


@router.post(
    "/admin/attendance/integrations",
    response_model=AttendanceIntegrationCreated,
    status_code=201,
    tags=["admin"],
)
async def create_integration(
    body: AttendanceIntegrationCreate, actor: IntegrationsManager, db: Db, request: Request
) -> AttendanceIntegrationCreated:
    """`url` (https, public) needs `secret_name` (the signing key's file). `inbound: true`
    returns the inbound token, this once."""
    return await service.create_integration(db, actor, body, request.app.state.settings)


@router.patch(
    "/admin/attendance/integrations/{integration_id}",
    response_model=AttendanceIntegrationOut,
    tags=["admin"],
)
async def update_integration(
    integration_id: UUID,
    body: AttendanceIntegrationUpdate,
    actor: IntegrationsManager,
    db: Db,
    request: Request,
) -> AttendanceIntegrationOut:
    return await service.update_integration(
        db, actor, integration_id, body, request.app.state.settings
    )


@router.delete("/admin/attendance/integrations/{integration_id}", status_code=204, tags=["admin"])
async def delete_integration(integration_id: UUID, actor: IntegrationsManager, db: Db) -> None:
    await service.delete_integration(db, actor, integration_id)


@router.post(
    "/admin/attendance/integrations/{integration_id}/token",
    response_model=AttendanceTokenOut,
    tags=["admin"],
)
async def rotate_token(
    integration_id: UUID, actor: IntegrationsManager, db: Db
) -> AttendanceTokenOut:
    """A new inbound token (shown this once); the previous one stops working at once."""
    return await service.rotate_token(db, actor, integration_id)


@router.delete(
    "/admin/attendance/integrations/{integration_id}/token",
    response_model=AttendanceIntegrationOut,
    tags=["admin"],
)
async def revoke_token(
    integration_id: UUID, actor: IntegrationsManager, db: Db
) -> AttendanceIntegrationOut:
    return await service.revoke_token(db, actor, integration_id)


@router.post(
    "/admin/attendance/integrations/{integration_id}/test",
    response_model=AttendanceTestOut,
    tags=["admin"],
)
async def test_integration(
    integration_id: UUID, actor: IntegrationsManager, request: Request
) -> AttendanceTestOut:
    """「テスト送信」: sends an `attendance.test` now and returns the recorded delivery."""
    _limit(request, "attendance_test", str(actor.id))
    delivery = await webhooks.send_test(
        request.app.state.db.session_factory,
        actor,
        integration_id,
        request.app.state.settings,
        request.app.state.attendance_sender,
    )
    return AttendanceTestOut(delivery=delivery)


@router.get(
    "/admin/attendance/integrations/{integration_id}/deliveries",
    response_model=list[AttendanceDeliveryOut],
    tags=["admin"],
)
async def list_deliveries(
    integration_id: UUID, _: IntegrationsManager, db: Db
) -> list[AttendanceDeliveryOut]:
    """The latest 50, newest first."""
    return await webhooks.recent_deliveries(db, integration_id)


# --- inbound -------------------------------------------------------------------------------


@router.post("/integrations/attendance", response_model=AttendanceInboundOut, tags=["integrations"])
async def inbound(
    body: AttendanceInbound,
    db: Db,
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> AttendanceInboundOut:
    """An outside system reports a change (docs/PRESENCE.md §6), with an integration's token as
    the Bearer token. The state is matched by id or name (workspace states first, then the
    person's own); unknown is 422 attendance_state_unknown. Never echoed back to the same
    integration."""
    if credentials is None:
        raise unauthorized("missing_token", "Bearer token required")
    integration = await service.resolve_token(db, credentials.credentials)
    _limit(request, "attendance_inbound", str(integration.id))
    return await service.inbound(db, integration, body)
