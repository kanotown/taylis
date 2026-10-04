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
from app.core.pages import router as pages_router
from app.core.ratelimit import RateLimiter
from app.core.settings import Settings, get_settings
from app.core.time import utcnow
from app.events.in_memory import InMemoryEventBus
from app.events.outbox import OutboxRelay, asyncpg_dsn, purge_processed
from app.modules.activity.router import router as activity_router
from app.modules.admin.router import router as admin_router
from app.modules.ai import service as ai_service
from app.modules.ai.llm import AiRuntime
from app.modules.ai.router import router as ai_router
from app.modules.attachments import service as attachments_service
from app.modules.attachments.blobstore import build_blobstore
from app.modules.attachments.router import router as attachments_router
from app.modules.auth import repository as auth_repo
from app.modules.auth import service as auth_service
from app.modules.auth.router import router as auth_router
from app.modules.avatars.router import router as avatars_router
from app.modules.bookmarks.router import router as bookmarks_router
from app.modules.calendar import service as calendar
from app.modules.calendar.router import router as calendar_router
from app.modules.canvases import service as canvases
from app.modules.canvases.router import router as canvases_router
from app.modules.channel_links.router import router as channel_links_router
from app.modules.channels import service as channels_service
from app.modules.channels.router import router as channels_router
from app.modules.drafts.router import router as drafts_router
from app.modules.emoji.router import router as emoji_router
from app.modules.favorites.router import router as favorites_router
from app.modules.groups.router import router as groups_router
from app.modules.invites.router import router as invites_router
from app.modules.lab import service as lab_service
from app.modules.lab.router import router as lab_router
from app.modules.link_previews.fetcher import build_fetcher
from app.modules.link_previews.router import router as link_previews_router
from app.modules.messages import service as messages_service
from app.modules.messages.router import router as messages_router
from app.modules.notifications import repository as notifications_repo
from app.modules.notifications.planner import PushPlanner
from app.modules.notifications.providers import build_providers
from app.modules.notifications.router import router as notifications_router
from app.modules.notifications.sender import PushSender
from app.modules.recurring import service as recurring
from app.modules.recurring.router import router as recurring_router
from app.modules.reminders import service as reminders
from app.modules.reminders.router import router as reminders_router
from app.modules.scheduled import service as scheduled
from app.modules.scheduled.router import router as scheduled_router
from app.modules.search.router import router as search_router
from app.modules.sidebar.router import router as sidebar_router
from app.modules.sso import service as sso_service
from app.modules.sso.oidc import build_google
from app.modules.sso.router import router as sso_router
from app.modules.sync.router import router as sync_router
from app.modules.tasks import deadlines as task_deadlines
from app.modules.tasks import service as tasks_service
from app.modules.tasks.router import router as tasks_router
from app.modules.templates.router import router as templates_router
from app.modules.threads.router import router as threads_router
from app.modules.times_feed.router import router as times_feed_router
from app.modules.totp.router import router as totp_router
from app.modules.users.router import router as users_router
from app.modules.webhooks.router import router as webhooks_router
from app.modules.workflows.router import router as workflows_router
from app.modules.workspace import service as workspace
from app.modules.workspace.router import router as workspace_router
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
                app.state.db,
                timedelta(days=settings.outbox_retention_days),
                max_attempts=settings.outbox_max_attempts,
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
            async with app.state.db.session_factory() as session:
                # Sessions run out quietly: their devices are disabled here before the sessions
                # themselves are purged, so an expired phone stops getting pushes (SECURITY.md
                # §2.6).
                expired = await auth_service.disable_expired_devices(session, utcnow())
                sessions = await auth_repo.purge_sessions(
                    session, utcnow() - timedelta(days=settings.session_retention_days)
                )
                devices = await auth_repo.purge_devices(
                    session, utcnow() - timedelta(days=settings.device_retention_days)
                )
                await session.commit()
            if expired:
                log.info("disabled %d devices whose sessions expired", expired)
            if sessions or devices:
                log.info("purged %d sessions and %d devices", sessions, devices)
            async with app.state.db.session_factory() as session:
                # CANVAS.md §4.9 / §4.14 (M42): thin old versions, purge the trash after 30 days,
                # let go of images no version refers to (the attachment GC removes the bytes).
                pruned, purged_canvases, released = await canvases.housekeeping(
                    session, now=utcnow(), trash_days=settings.canvas_trash_retention_days
                )
            if pruned or purged_canvases or released:
                log.info(
                    "canvases: %d versions pruned, %d purged from the trash, %d images released",
                    pruned,
                    purged_canvases,
                    released,
                )
            async with app.state.db.session_factory() as session:
                # M48: sign-ins that were started or ticketed and never finished.
                purged_sso = await sso_service.purge_expired(session, utcnow())
                await session.commit()
            if purged_sso:
                log.info("purged %d expired sign-in requests and tickets", purged_sso)
            async with app.state.db.session_factory() as session:
                # docs/AI.md §4: the prompt text of old AI runs (tokens and cost stay).
                purged_ai = await ai_service.purge_inputs(
                    session, days=settings.ai_input_retention_days
                )
            if purged_ai:
                log.info("dropped the input of %d old AI runs", purged_ai)
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


async def _presence_sweep_loop(app: FastAPI, stop: asyncio.Event) -> None:
    """Announces online → away when a user's activity window lapses (SYNC_PROTOCOL.md §5.2)."""
    settings: Settings = app.state.settings
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=settings.presence_sweep_interval_seconds)
        except TimeoutError:
            app.state.hub.sweep_presence()


async def _scheduled_send_loop(app: FastAPI, stop: asyncio.Event) -> None:
    """Posts scheduled messages (M12d) and fires reminders (M12e), calendar alarms (M51) and
    task due dates (M55) whose time has come; posts recurring posts and nudges those who have
    not submitted to a collection past its due time (L6, M59); posts deadlines' advance notices
    (L5, M85)."""
    settings: Settings = app.state.settings
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=settings.scheduled_send_interval_seconds)
        except TimeoutError:
            try:
                async with app.state.db.session_factory() as session:
                    await scheduled.send_due(session)
            except Exception:
                log.exception("scheduled send failed")
            try:
                async with app.state.db.session_factory() as session:
                    await reminders.fire_due(session)
            except Exception:
                log.exception("reminder firing failed")
            try:
                async with app.state.db.session_factory() as session:
                    await calendar.fire_due(session)
            except Exception:
                log.exception("calendar alarm firing failed")
            try:
                async with app.state.db.session_factory() as session:
                    await tasks_service.fire_due(session)
            except Exception:
                log.exception("task due-date firing failed")
            try:
                async with app.state.db.session_factory() as session:
                    await recurring.run_due(session)
            except Exception:
                log.exception("recurring posting failed")
            try:
                async with app.state.db.session_factory() as session:
                    await recurring.remind_due(session)
            except Exception:
                log.exception("collection nudging failed")
            try:
                async with app.state.db.session_factory() as session:
                    await task_deadlines.fire_notices(session)
            except Exception:
                log.exception("deadline notices failed")


async def _ai_loop(app: FastAPI, stop: asyncio.Event) -> None:
    """AI runs (docs/AI.md §2.2-§2.3, M65): at most two at a time, again at once while there
    are more."""
    settings: Settings = app.state.settings
    while not stop.is_set():
        claimed = 0
        try:
            claimed = await ai_service.process_due(app.state.db, app.state.ai)
        except Exception:
            log.exception("AI worker failed")
        if claimed:
            continue
        try:
            await asyncio.wait_for(stop.wait(), timeout=settings.ai_worker_interval_seconds)
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
    try:
        async with app.state.db.session_factory() as session:
            await workspace.ensure(session)
    except Exception:  # readiness reports the database
        log.exception("could not read the workspace identity at startup")
    try:
        async with app.state.db.session_factory() as session:
            await canvases.ensure_builtin_templates(session)
    except Exception:
        log.exception("could not check the built-in canvas templates at startup")
    if settings.run_background_tasks:
        tasks.append(asyncio.create_task(app.state.relay.run(stop), name="outbox-relay"))
        tasks.append(asyncio.create_task(_purge_loop(app, stop), name="outbox-purge"))
        tasks.append(asyncio.create_task(app.state.push_sender.run(stop), name="push-sender"))
        tasks.append(asyncio.create_task(_attachment_gc_loop(app, stop), name="attachment-gc"))
        tasks.append(asyncio.create_task(_presence_sweep_loop(app, stop), name="presence-sweep"))
        tasks.append(asyncio.create_task(_scheduled_send_loop(app, stop), name="scheduled-send"))
        tasks.append(asyncio.create_task(_ai_loop(app, stop), name="ai-worker"))
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
    api.include_router(workspace_router)
    api.include_router(auth_router)
    api.include_router(sso_router)
    api.include_router(totp_router)
    api.include_router(
        avatars_router
    )  # before users: /users/me/avatar must not read as /users/{id}
    api.include_router(users_router)
    api.include_router(admin_router)
    api.include_router(invites_router)
    api.include_router(channels_router)
    api.include_router(messages_router)
    api.include_router(threads_router)
    api.include_router(bookmarks_router)
    api.include_router(times_feed_router)
    api.include_router(activity_router)
    api.include_router(favorites_router)
    api.include_router(sidebar_router)
    api.include_router(drafts_router)
    api.include_router(channel_links_router)
    api.include_router(canvases_router)
    api.include_router(calendar_router)
    api.include_router(tasks_router)
    api.include_router(scheduled_router)
    api.include_router(reminders_router)
    api.include_router(recurring_router)
    api.include_router(workflows_router)
    api.include_router(emoji_router)
    api.include_router(templates_router)
    api.include_router(groups_router)
    api.include_router(lab_router)
    api.include_router(webhooks_router)
    api.include_router(link_previews_router)
    api.include_router(attachments_router)
    api.include_router(search_router)
    api.include_router(ai_router)
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
    app.state.db = Database(
        settings.database_url,
        echo=echo_sql,
        pool_size=settings.db_pool_size,
        max_overflow=settings.db_max_overflow,
    )
    # M19: how many searches may run at once in this process (search/service.py).
    app.state.search_gate = asyncio.Semaphore(settings.search_max_concurrent)
    # M24: who joins a new times (the owner's supervisors on the lab roster); channels does not
    # depend on lab, so the lookup is handed to its router here.
    app.state.times_followers = lab_service.supervisor_ids_for
    # M49: the last message of a member's conversations (ChannelOut.last_message); channels does
    # not depend on messages (the other way round), so its router gets the lookup here.
    app.state.last_messages = messages_service.last_messages
    # M80 (CANVAS.md §22): a box ticked on an item made a task moves that task; tasks depends on
    # canvases (not the other way round), so the canvas service gets the step here.
    canvases.set_task_ticks_handler(tasks_service.follow_canvas_ticks)
    # M65: an AI bot without allow_private stays out of private channels and DMs; channels does
    # not depend on ai, so its router gets the check here.
    app.state.ai_private_guard = ai_service.check_private_allowed
    # M65: the model provider, built from the key file on first use (docs/AI.md §2.4).
    app.state.ai = AiRuntime(
        settings.ai_api_key_file,
        openai_key_file=settings.ai_openai_api_key_file,
        monthly_budget_usd=settings.ai_monthly_budget_usd,
        user_daily_runs=settings.ai_user_daily_runs,
    )
    app.state.limiters = {
        "login_ip": RateLimiter(settings.login_rate_limit_per_ip),
        "login_account": RateLimiter(settings.login_rate_limit_per_account),
        "invite": RateLimiter(settings.invite_rate_limit_per_ip),
        "ical": RateLimiter(settings.ical_rate_limit_per_ip),
        "sso": RateLimiter(settings.sso_rate_limit_per_ip),
        "webhook": RateLimiter(settings.webhook_rate_limit_per_hook),
        "upload": RateLimiter(settings.upload_rate_limit_per_user),
        "search": RateLimiter(settings.search_rate_limit_per_user),
        "link_preview": RateLimiter(settings.link_preview_rate_limit_per_user),
        "message": RateLimiter(settings.message_rate_limit_per_user),
        "canvas_save": RateLimiter(settings.canvas_save_rate_limit_per_user),
        "ws_connect": RateLimiter(settings.ws_connect_rate_limit_per_ip),
        # PUSH_NOTIFICATIONS.md §15: 5 test notifications in a burst, then 1 per 2 minutes.
        "test_notification": RateLimiter(0.5, burst=5),
    }
    # M48: Google sign-in when fully configured (docs/SSO.md §2), else None (the log says why).
    app.state.sso_google = build_google(settings)
    app.state.blobs = build_blobstore(settings)
    app.state.link_fetcher = build_fetcher(
        timeout_seconds=settings.link_preview_timeout_seconds,
        max_bytes=settings.link_preview_max_bytes,
        user_agent=settings.link_preview_user_agent,
    )
    app.state.bus = InMemoryEventBus()
    app.state.hub = RealtimeHub(
        queue_size=settings.ws_send_queue_size, away_seconds=settings.presence_away_seconds
    )
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
        handlers=[
            planner,
            calendar.CalendarLeaveHandler(),
            tasks_service.TaskLeaveHandler(),
            tasks_service.TaskSourceHandler(),
            ai_service.AiMentionHandler(app.state.ai),
        ],
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
            # X-Requested-With: the desktop sends it with every refresh (the browser build needs it
            # for the cookie session, M12j); without it the WebView's preflight fails and the app
            # can never renew its token. Cookies stay out (allow_credentials=False).
            allow_headers=[
                "Authorization",
                "Content-Type",
                "Accept",
                "X-Request-ID",
                "X-Requested-With",
            ],
            expose_headers=["X-Request-ID", "Retry-After"],
            allow_credentials=False,
            max_age=600,
        )
    install_error_handlers(app)
    app.include_router(health_router)
    app.include_router(pages_router)
    app.include_router(build_api_router())
    return app
