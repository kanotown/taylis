"""What a client may learn before signing in (WORKSPACES.md §3): which server this is."""

from fastapi import APIRouter, File, Request, UploadFile
from fastapi.responses import StreamingResponse

from app.core.db import Db
from app.core.errors import rate_limited
from app.modules.attachments import service as attachments
from app.modules.auth.deps import CurrentAdmin
from app.modules.workspace import default_channels, service
from app.modules.workspace.schemas import (
    AdminWorkspaceSettingsOut,
    DefaultChannelsApply,
    DefaultChannelsApplyOut,
    ServerInfoOut,
    WorkspaceSettingsUpdate,
)

router = APIRouter(tags=["server"])


@router.get("/server", response_model=ServerInfoOut)
async def server_info(request: Request, db: Db) -> ServerInfoOut:
    return ServerInfoOut(
        workspace_id=await service.workspace_id(db) or await service.ensure(db),
        name=request.app.state.settings.workspace_display_name,
        api_version=request.app.version,
        icon_version=await service.icon_version(db),
    )


@router.get("/server/icon")
async def server_icon(request: Request, db: Db) -> StreamingResponse:
    """M93 (WORKSPACES.md §3.4): the workspace's icon, a 256px square PNG. Public like GET /server
    (the login screen and the rail show it before signing in): it is the workspace's logo, not a
    secret. Clients add `?v=<icon_version>` so a new icon is not cached away. 404
    workspace_icon_not_found when there is none."""
    key = await service.icon_key(db)
    return StreamingResponse(
        attachments.stream(request.app.state.blobs, key),
        headers={
            "Content-Type": "image/png",
            "Content-Disposition": "inline",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "public, max-age=86400",
        },
    )


def _legacy(request: Request) -> list[str]:
    """SSO_DEFAULT_CHANNELS (deprecated by M90), shown while the list was never saved."""
    names: list[str] = request.app.state.settings.sso_default_channel_names
    return names


@router.get("/admin/workspace-settings", response_model=AdminWorkspaceSettingsOut, tags=["admin"])
async def get_workspace_settings(
    _: CurrentAdmin, db: Db, request: Request
) -> AdminWorkspaceSettingsOut:
    """M88 (docs/MEMBERSHIP.md §3): 「参加・退出の表示」 and
    「参加前にチャンネルの中を見られる」; M90 (§6): 「既定のチャンネル」."""
    return await service.admin_settings(db, _legacy(request))


@router.patch("/admin/workspace-settings", response_model=AdminWorkspaceSettingsOut, tags=["admin"])
async def update_workspace_settings(
    actor: CurrentAdmin, body: WorkspaceSettingsUpdate, db: Db, request: Request
) -> AdminWorkspaceSettingsOut:
    """M130 (docs/CALLS.md §5.1): also 「アプリ内通話」 (`in_app_calls_enabled`). M117's
    `meeting_base_url` is refused with 409 meeting_links_retired."""
    return await service.update_settings(db, actor.id, body, _legacy(request))


@router.post(
    "/admin/workspace-settings/apply-default-channels",
    response_model=DefaultChannelsApplyOut,
    tags=["admin"],
)
async def apply_default_channels(
    actor: CurrentAdmin, body: DefaultChannelsApply, db: Db
) -> DefaultChannelsApplyOut:
    """M90 (docs/MEMBERSHIP.md §6) 「今いる人も全員入れる」: every active non-guest, non-bot
    account joins the default channels it is not in (one join line per channel). Idempotent.
    `dry_run` only counts (the confirmation)."""
    return await default_channels.apply_to_everyone(db, actor, dry_run=body.dry_run)


@router.post(
    "/admin/workspace-settings/icon", response_model=AdminWorkspaceSettingsOut, tags=["admin"]
)
async def upload_workspace_icon(
    actor: CurrentAdmin, db: Db, request: Request, file: UploadFile = File(...)
) -> AdminWorkspaceSettingsOut:
    """M93 (WORKSPACES.md §3.4): a PNG / JPEG / WebP, centre-cropped square and resized to a 256px
    PNG. Audited (`workspace.settings_updated`, `{icon: {from, to}}`) and announced to every
    device."""
    limiter = request.app.state.limiters["upload"]
    key = str(actor.id)
    if not limiter.try_acquire(key):
        raise rate_limited(limiter.retry_after_seconds(key))
    return await service.upload_icon(
        db,
        actor.id,
        file,
        request.app.state.settings,
        request.app.state.blobs,
        _legacy(request),
    )


@router.delete(
    "/admin/workspace-settings/icon", response_model=AdminWorkspaceSettingsOut, tags=["admin"]
)
async def delete_workspace_icon(
    actor: CurrentAdmin, db: Db, request: Request
) -> AdminWorkspaceSettingsOut:
    """M93: no icon; clients draw the letter tile again. Idempotent."""
    return await service.remove_icon(db, actor.id, request.app.state.blobs, _legacy(request))
