"""Liveness and readiness endpoints (outside /api/v1; used by compose and Caddy)."""

import logging
from functools import cache
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

log = logging.getLogger("app.health")
router = APIRouter(tags=["health"])


@router.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/readyz")
async def readyz(request: Request) -> JSONResponse:
    checks: dict[str, Any] = {}
    ok = True

    try:
        async with request.app.state.db.engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        checks["db"] = "ok"
    except Exception as exc:  # readiness must report, not raise
        log.warning("readiness: database unavailable: %s", exc)
        checks["db"] = "unavailable"
        ok = False

    try:
        async with request.app.state.db.engine.connect() as conn:
            version = (await conn.execute(text("SELECT version_num FROM alembic_version"))).scalar()
            pending = (
                await conn.execute(
                    text("SELECT count(*) FROM outbox_events WHERE processed_at IS NULL")
                )
            ).scalar()
        head = schema_head()
        checks["schema"] = "ok" if version == head else f"behind ({version} != {head})"
        checks["outbox_pending"] = int(pending or 0)
        if version != head:
            ok = False
    except Exception as exc:  # pragma: no cover - only when the schema tables are missing
        log.warning("readiness: schema check failed: %s", exc)
        checks["schema"] = "unknown"

    endpoint = request.app.state.settings.s3_endpoint
    if endpoint:
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                await client.get(endpoint)  # any HTTP answer (even 403) means reachable
            checks["objectstore"] = "ok"
        except httpx.HTTPError as exc:
            log.warning("readiness: object store unavailable: %s", exc)
            checks["objectstore"] = "unavailable"
            ok = False

    return JSONResponse(
        status_code=200 if ok else 503,
        content={"status": "ok" if ok else "degraded", "checks": checks},
    )


@cache
def schema_head() -> str | None:
    """The newest migration in migrations/versions (compared with alembic_version at readiness)."""
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    root = Path(__file__).resolve().parents[2]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "migrations"))
    return ScriptDirectory.from_config(config).get_current_head()
