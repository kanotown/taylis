"""Bearer authentication and current database-backed user permissions."""

import logging
from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.db import Db
from app.core.errors import forbidden, unauthorized
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
    return context


CurrentSession = Annotated[service.AuthContext, Depends(get_auth_context)]


async def get_current_user(request: Request, context: CurrentSession) -> User:
    user = context.user
    if user.must_change_password and request.scope["route"].name not in _PASSWORD_CHANGE_ALLOWED:
        log.warning("password change required", extra={"user_id": str(user.id)})
        raise forbidden("password_change_required", "Password change required")
    return user


async def get_current_admin(user: Annotated[User, Depends(get_current_user)]) -> User:
    if not user.is_admin:
        log.warning("administrator required", extra={"user_id": str(user.id)})
        raise forbidden("admin_required", "Administrator role required")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]
CurrentAdmin = Annotated[User, Depends(get_current_admin)]
