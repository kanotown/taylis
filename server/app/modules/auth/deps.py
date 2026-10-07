"""Bearer authentication and current database-backed user permissions."""

import logging
from collections.abc import Awaitable, Callable
from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.db import Db
from app.core.errors import AppError, forbidden, unauthorized
from app.core.roles import Capability, ensure_capability
from app.core.settings import Settings
from app.modules.auth import service
from app.modules.users.models import User

bearer = HTTPBearer(auto_error=False)
log = logging.getLogger("app.auth")

# Explicit names allow only the recovery/session endpoints during a forced password change.
_PASSWORD_CHANGE_ALLOWED = {
    "users:me",
    "auth:password",
    "auth:logout",
    "auth:sessions",
    "auth:revoke_session",
    "users:delete_account",  # M104: deleting the account needs no new password first
}


async def get_auth_context(
    request: Request,
    db: Db,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
) -> service.AuthContext:
    if credentials is None:
        if request.headers.get("Authorization"):
            raise unauthorized("invalid_token", "Invalid Authorization header")
        raise unauthorized("missing_token", "Bearer token required")
    settings: Settings = request.app.state.settings
    context = await service.authenticate(db, credentials.credentials, settings)
    request.state.user_id = str(context.user.id)
    request.state.session_id = str(context.session.id)
    request.state.user_locale = context.user.locale  # M115: errors in the chosen language
    # M116 (docs/ANALYTICS.md §2): "last active", throttled in memory and written in batches.
    request.app.state.activity.touch(context.user.id)
    return context


CurrentSession = Annotated[service.AuthContext, Depends(get_auth_context)]


async def get_current_user(request: Request, context: CurrentSession) -> User:
    user = context.user
    if user.must_change_password and request.scope["route"].name not in _PASSWORD_CHANGE_ALLOWED:
        log.warning("password change required", extra={"user_id": str(user.id)})
        raise forbidden("password_change_required", "Password change required")
    return user


def require_capability(capability: Capability) -> Callable[[User], Awaitable[User]]:
    """A dependency: the current user, who must have `capability` (docs/ROLES.md §2; 403
    manager_required / admin_required)."""

    async def dependency(user: Annotated[User, Depends(get_current_user)]) -> User:
        try:
            ensure_capability(user, capability)
        except AppError:
            log.warning(
                "capability required", extra={"user_id": str(user.id), "capability": capability}
            )
            raise
        return user

    return dependency


CurrentUser = Annotated[User, Depends(get_current_user)]


# The current user with a capability (docs/ROLES.md §2), one alias per capability a router needs.
UsersViewer = Annotated[User, Depends(require_capability("users.view"))]
ProfileEditor = Annotated[User, Depends(require_capability("users.edit_profile"))]
UsersManager = Annotated[User, Depends(require_capability("users.manage"))]
InviteManager = Annotated[User, Depends(require_capability("invites.manage"))]
RosterManager = Annotated[User, Depends(require_capability("roster.manage"))]
RolloverAdmin = Annotated[User, Depends(require_capability("lab.rollover"))]
ChannelsManager = Annotated[User, Depends(require_capability("channels.manage"))]
EmojiManager = Annotated[User, Depends(require_capability("emoji.manage"))]
AttendanceManager = Annotated[User, Depends(require_capability("attendance.manage"))]
AttendanceConfigurer = Annotated[User, Depends(require_capability("attendance.configure"))]
ReportsManager = Annotated[User, Depends(require_capability("reports.manage"))]
WorkspaceAdmin = Annotated[User, Depends(require_capability("workspace.settings"))]
GroupsManager = Annotated[User, Depends(require_capability("groups.manage"))]
IntegrationsManager = Annotated[User, Depends(require_capability("integrations.manage"))]
AiManager = Annotated[User, Depends(require_capability("ai.manage"))]
AnalyticsViewer = Annotated[User, Depends(require_capability("analytics.view"))]
