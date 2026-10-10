from uuid import UUID

from fastapi import APIRouter, Request

from app.core.db import Db
from app.core.errors import forbidden, not_found
from app.modules.auth.deps import CurrentUser
from app.modules.channels import service as channels  # M13e guest visibility (ARCHITECTURE.md §5)
from app.modules.users import service
from app.modules.users import username as usernames
from app.modules.users.presence import PresenceUpdate, set_presence
from app.modules.users.schemas import UserMe, UserPublic, UserUpdate, to_user_me, to_user_public

router = APIRouter(prefix="/users", tags=["users"])


def _sso_reserved(request: Request, email: str, current: str | None) -> bool:
    """A new address in a domain Google sign-in accepts (while it is enabled)."""
    if request.app.state.sso_google is None or email.lower() == (current or "").lower():
        return False
    domain = email.rsplit("@", 1)[-1].lower()
    return domain in request.app.state.settings.sso_allowed_domains


@router.get("", response_model=list[UserPublic])
async def list_users(user: CurrentUser, db: Db) -> list[UserPublic]:
    rows = await service.list_users(db)
    if user.is_guest:  # M13e: only the people who share a channel with the guest
        visible = await channels.shared_member_ids(db, user.id)
        rows = [u for u in rows if u.id in visible]
    return [to_user_public(u) for u in rows]


@router.get("/me", response_model=UserMe, name="users:me")
async def get_me(user: CurrentUser) -> UserMe:
    return to_user_me(user)


@router.patch("/me", response_model=UserMe)
async def update_me(request: Request, user: CurrentUser, body: UserUpdate, db: Db) -> UserMe:
    if body.email and _sso_reserved(request, body.email, user.email):
        # M48: Google sign-in links by address (docs/SSO.md §4); an unverified address of a
        # sign-in domain typed here would let its real owner land in this account.
        raise forbidden("email_domain_reserved", "This domain's addresses come from Google sign-in")
    if body.username is not None:
        # M96: renaming myself (3 times in 24 hours); the same transaction as the rest.
        locked = await service.get_user(db, user.id, for_update=True)
        if locked is not None:
            await usernames.rename_in_tx(db, locked, body.username, actor=user)
    updated = await service.update_me(db, user.id, body)
    if body.presence_hidden is not None:
        # L4: the hub (process-local presence) announces me as offline, or as I am again. Both
        # flags as committed, versioned by updated_at (an older request's call changes nothing).
        request.app.state.hub.set_presence_flags(
            updated.id,
            hidden=updated.presence_hidden,
            away=updated.presence_manual == "away",
            version=updated.updated_at,
        )
    return to_user_me(updated)


@router.put("/me/presence", response_model=UserMe)
async def update_my_presence(
    request: Request, user: CurrentUser, body: PresenceUpdate, db: Db
) -> UserMe:
    """The quick status menu (docs/PRESENCE.md §11): auto / away / dnd (with duration or until) /
    invisible. One at a time; user.updated tells the others and my other devices."""
    locked = await service.get_user(db, user.id, for_update=True)
    if locked is None:
        raise not_found("user_not_found", "User not found")
    updated = await set_presence(db, locked, body)
    # Both flags in one announcement: invisible → 離席中 must not flash online in between.
    request.app.state.hub.set_presence_flags(
        updated.id,
        hidden=updated.presence_hidden,
        away=updated.presence_manual == "away",
        version=updated.updated_at,
    )
    return to_user_me(updated)


@router.get("/{user_id}", response_model=UserPublic)
async def get_user(user_id: UUID, user: CurrentUser, db: Db) -> UserPublic:
    visible = await channels.visible_user_ids(db, user)
    if visible is not None and user_id not in visible:  # M13e: as if the user did not exist
        raise not_found("user_not_found", "User not found")
    return to_user_public(await service.require_user(db, user_id))
