import json
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Request
from pydantic import ValidationError

from app.core.db import Db
from app.core.errors import AppError, rate_limited
from app.core.ratelimit import RateLimiter
from app.modules.auth.deps import IntegrationsManager
from app.modules.webhooks import service
from app.modules.webhooks.schemas import (
    WebhookCreate,
    WebhookCreated,
    WebhookOut,
    WebhookPost,
    WebhookPosted,
    WebhookUpdate,
)

router = APIRouter(tags=["webhooks"])


@router.post("/admin/webhooks", response_model=WebhookCreated, status_code=201)
async def create_webhook(actor: IntegrationsManager, body: WebhookCreate, db: Db) -> WebhookCreated:
    """Issue an incoming webhook (M13a). The token appears only in this response."""
    webhook, token = await service.create(db, actor, body)
    return WebhookCreated(webhook=webhook, token=token)


@router.get("/admin/webhooks", response_model=list[WebhookOut])
async def list_webhooks(_: IntegrationsManager, db: Db) -> list[WebhookOut]:
    return await service.list_all(db)


@router.patch("/admin/webhooks/{webhook_id}", response_model=WebhookOut)
async def update_webhook(
    webhook_id: UUID, actor: IntegrationsManager, body: WebhookUpdate, db: Db
) -> WebhookOut:
    return await service.update(db, actor, webhook_id, body)


@router.delete("/admin/webhooks/{webhook_id}", status_code=204)
async def delete_webhook(webhook_id: UUID, actor: IntegrationsManager, db: Db) -> None:
    await service.delete(db, actor, webhook_id)


async def _read_post(request: Request) -> WebhookPost:
    """JSON `{"text": ...}`, or Slack's legacy form encoding with a `payload` JSON field."""
    content_type = request.headers.get("content-type", "")
    raw: Any
    try:
        if content_type.startswith("application/x-www-form-urlencoded"):
            form = await request.form()
            payload = form.get("payload")
            raw = json.loads(str(payload)) if payload else {"text": form.get("text")}
        else:
            raw = json.loads(await request.body() or b"{}")
        return WebhookPost.model_validate(raw)
    except (ValueError, ValidationError) as exc:
        raise AppError(422, "validation_error", "Send JSON with a non-empty text") from exc


@router.post("/hooks/{token}", response_model=WebhookPosted, status_code=201)
async def post_to_webhook(token: str, request: Request, db: Db) -> WebhookPosted:
    """No login: the URL token is the credential. Posts as the webhook's bot user."""
    webhook = await service.resolve(db, token)
    limiter: RateLimiter = request.app.state.limiters["webhook"]
    key = str(webhook.id)
    if not limiter.try_acquire(key):
        raise rate_limited(limiter.retry_after_seconds(key))
    data = await _read_post(request)
    return WebhookPosted(message_id=await service.post(db, webhook, data))
