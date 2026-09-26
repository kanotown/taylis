"""FastAPI application factory (composition root)."""

import logging
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI

from app.core.db import Database
from app.core.errors import install_error_handlers
from app.core.health import router as health_router
from app.core.logging import RequestContextMiddleware, configure_logging
from app.core.ratelimit import RateLimiter
from app.core.settings import Settings, get_settings
from app.modules.admin.router import router as admin_router
from app.modules.auth.router import router as auth_router
from app.modules.channels.router import router as channels_router
from app.modules.messages.router import router as messages_router
from app.modules.users.router import router as users_router

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


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    yield
    await app.state.db.dispose()


def build_api_router() -> APIRouter:
    api = APIRouter(prefix=API_PREFIX)
    api.include_router(auth_router)
    api.include_router(users_router)
    api.include_router(admin_router)
    api.include_router(channels_router)
    api.include_router(messages_router)
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
    }

    app.add_middleware(RequestContextMiddleware)
    install_error_handlers(app)
    app.include_router(health_router)
    app.include_router(build_api_router())
    return app
