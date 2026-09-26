"""FastAPI application factory (composition root)."""

import asyncio
import logging
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import timedelta

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.db import Database
from app.core.errors import install_error_handlers
from app.core.health import router as health_router
from app.core.logging import RequestContextMiddleware, configure_logging
from app.core.ratelimit import RateLimiter
from app.core.settings import Settings, get_settings
from app.core.time import utcnow
from app.events.in_memory import InMemoryEventBus
from app.events.outbox import OutboxRelay, asyncpg_dsn, purge_processed
from app.modules.admin.router import router as admin_router
from app.modules.attachments import service as attachments_service
from app.modules.attachments.blobstore import build_blobstore
from app.modules.attachments.router import router as attachments_router
from app.modules.auth.router import router as auth_router
from app.modules.channels import service as channels_service
from app.modules.channels.router import router as channels_router
from app.modules.messages.router import router as messages_router
from app.modules.notifications import repository as notifications_repo
from app.modules.notifications.planner import PushPlanner
from app.modules.notifications.providers import build_providers
from app.modules.notifications.router import router as notifications_router
from app.modules.notifications.sender import PushSender
from app.modules.search.router import router as search_router
from app.modules.sync.router import router as sync_router
from app.modules.users.router import router as users_router
from app.realtime.hub import RealtimeHub
from app.realtime.router import router as realtime_router

API_PREFIX = "/api/v1"
API_VERSION = "0.1.0"

log = logging.getLogger("app")


def _resolve_secret(settings: Settings) -> Settings:
    if len(settings.secret_key) >= 32:
        return settings
    if settings.environment == "production":
        raise RuntimeError("SECRET_KEY must be set to at least 32 characters in production")
    log.warning("SECRET_KEY is not set; using an ephemeral key (tokens are invalidated on restart)")
    return settings.model_copy(update={"secret_key": secrets.token_urlsafe(48)})


async def _purge_loop(app: FastAPI, stop: asyncio.Event) -> None:
    settings: Settings = app.state.settings
    while not stop.is_set():
        try:
            purged = await purge_processed(
                app.state.db, timedelta(days=settings.outbox_retention_days)
            )
            if purged:
                log.info("purged %d processed outbox events", purged)
            async with app.state.db.session_factory() as session:
                purged_pushes = await notifications_repo.purge_deliveries(
                    session, utcnow() - timedelta(days=settings.push_retention_days)
                )
                await session.commit()
            if purged_pushes:
                log.info("purged %d push deliveries", purged_pushes)
        except Exception:
            log.exception("outbox purge failed")
        try:
            await asyncio.wait_for(stop.wait(), timeout=3600)
        except TimeoutError:
            continue


async def _attachment_gc_loop(app: FastAPI, stop: asyncio.Event) -> None:
    """Expired pending uploads and the bytes of deleted messages (DATA_MODEL.md "attachments")."""
    settings: Settings = app.state.settings
    while not stop.is_set():
        try:
            async with app.state.db.session_factory() as session:
                removed, purged = await attachments_service.gc(
                    session,
                    app.state.blobs,
                    pending_ttl_hours=settings.attachment_pending_ttl_hours,
                )
            if removed or purged:
                log.info("attachment gc: %d expired uploads, %d purged", removed, purged)
        except Exception:
            log.exception("attachment gc failed")
        try:
            await asyncio.wait_for(stop.wait(), timeout=settings.attachment_gc_interval_seconds)
        except TimeoutError:
            continue


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = app.state.settings
    stop = asyncio.Event()
    tasks: list[asyncio.Task[None]] = []
    try:
        await app.state.blobs.ensure_bucket()
    except Exception:  # readiness reports the object store; uploads fail loudly until it is back
        log.exception("object store is not reachable at startup")
    if settings.run_background_tasks:
        tasks.append(asyncio.create_task(app.state.relay.run(stop), name="outbox-relay"))
        tasks.append(asyncio.create_task(_purge_loop(app, stop), name="outbox-purge"))
        tasks.append(asyncio.create_task(app.state.push_sender.run(stop), name="push-sender"))
        tasks.append(asyncio.create_task(_attachment_gc_loop(app, stop), name="attachment-gc"))
    try:
        yield
    finally:
        stop.set()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await app.state.db.dispose()


def build_api_router() -> APIRouter:
    api = APIRouter(prefix=API_PREFIX)
    api.include_router(auth_router)
    api.include_router(users_router)
    api.include_router(admin_router)
    api.include_router(channels_router)
    api.include_router(messages_router)
    api.include_router(attachments_router)
    api.include_router(search_router)
    api.include_router(notifications_router)
    api.include_router(sync_router)
    api.include_router(realtime_router)
    return api


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = _resolve_secret(settings or get_settings())
    configure_logging(settings.log_level, settings.log_json)

    app = FastAPI(
        title=f"{settings.app_name} API",
        version=API_VERSION,
        lifespan=lifespan,
        docs_url=f"{API_PREFIX}/docs",
        openapi_url=f"{API_PREFIX}/openapi.json",
        redoc_url=None,
    )
    app.state.settings = settings
    # SQL echo prints bound parameters (hashes, tokens): development only.
    echo_sql = settings.debug and settings.environment != "production"
    app.state.db = Database(settings.database_url, echo=echo_sql)
    app.state.limiters = {
        "login_ip": RateLimiter(settings.login_rate_limit_per_ip),
        "login_account": RateLimiter(settings.login_rate_limit_per_account),
        "upload": RateLimiter(settings.upload_rate_limit_per_user),
        "search": RateLimiter(settings.search_rate_limit_per_user),
    }
    app.state.blobs = build_blobstore(settings)
    app.state.bus = InMemoryEventBus()
    app.state.hub = RealtimeHub(queue_size=settings.ws_send_queue_size)
    app.state.bus.subscribe(app.state.hub.on_event)
    app.state.push_providers = build_providers(settings)
    app.state.push_sender = PushSender(
        app.state.db,
        app.state.push_providers,
        poll_interval=settings.push_poll_interval_seconds,
        batch_size=settings.push_batch_size,
        concurrency=settings.push_concurrency,
        lease_seconds=settings.push_lease_seconds,
    )
    planner = PushPlanner(
        settings,
        is_active=lambda user_id: app.state.hub.is_active(
            user_id, settings.push_active_window_seconds
        ),
    )
    app.state.relay = OutboxRelay(
        app.state.db,
        app.state.bus,
        channels_service.resolve_event_audience,
        handlers=[planner],
        listen_dsn=asyncpg_dsn(settings.database_url),
        poll_interval=settings.outbox_poll_interval_seconds,
        batch_size=settings.outbox_batch_size,
        max_attempts=settings.outbox_max_attempts,
    )

    app.add_middleware(RequestContextMiddleware)
    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type", "Accept", "X-Request-ID"],
            expose_headers=["X-Request-ID", "Retry-After"],
            allow_credentials=False,
            max_age=600,
        )
    install_error_handlers(app)
    app.include_router(health_router)
    app.include_router(build_api_router())
    return app
