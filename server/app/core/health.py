"""Liveness and readiness endpoints (outside /api/v1; used by compose and Caddy)."""

import logging
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
