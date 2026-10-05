"""Structured API errors.

Every error response has the shape ``{"error": {"code": ..., "message": ..., "details": ...}}``.
``code`` is a stable string clients branch on; the HTTP status gives the category
(401 authentication, 403 permission, 400/422 validation, 404, 409 conflict, 429, 5xx temporary).
"""

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DBAPIError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app import i18n

log = logging.getLogger("app.errors")


class AppError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        *,
        details: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details
        self.headers = headers

    def to_response(self) -> JSONResponse:
        return JSONResponse(
            status_code=self.status,
            content=error_body(self.code, self.message, self.details),
            headers=self.headers,
        )


def error_body(code: str, message: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "details": details or {}}}


def unauthorized(code: str = "unauthorized", message: str = "Authentication required") -> AppError:
    return AppError(401, code, message, headers={"WWW-Authenticate": "Bearer"})


def forbidden(code: str = "forbidden", message: str = "Forbidden") -> AppError:
    return AppError(403, code, message)


def not_found(code: str, message: str) -> AppError:
    return AppError(404, code, message)


def conflict(code: str, message: str, details: dict[str, Any] | None = None) -> AppError:
    return AppError(409, code, message, details=details)


def bad_request(
    code: str = "validation_error",
    message: str = "Invalid request",
    details: dict[str, Any] | None = None,
) -> AppError:
    return AppError(400, code, message, details=details)


def rate_limited(retry_after_seconds: int) -> AppError:
    return AppError(
        429,
        "rate_limited",
        "Too many requests",
        details={"retry_after_seconds": retry_after_seconds},
        headers={"Retry-After": str(retry_after_seconds)},
    )


_HTTP_STATUS_CODES = {
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    413: "payload_too_large",
    415: "unsupported_media_type",
    429: "rate_limited",
}


def _sqlstate(exc: DBAPIError) -> str | None:
    """The PostgreSQL error code behind SQLAlchemy's wrapper (asyncpg keeps it on the cause)."""
    for candidate in (exc.orig, getattr(exc.orig, "__cause__", None)):
        state = getattr(candidate, "sqlstate", None)
        if isinstance(state, str):
            return state
    return None


def request_locale(request: Request) -> str:
    """M115 (docs/I18N.md): the signed-in person's chosen language, else the request's
    Accept-Language, else ja."""
    chosen = getattr(request.state, "user_locale", None)
    return i18n.effective(chosen, request.headers.get("accept-language"))


def localized(request: Request, status: int, code: str, message: str) -> str:
    """The error message in the reader's language (apps/shared/errors.json by code, else by
    HTTP status); the English text for a code without one."""
    return i18n.error_text(code, request_locale(request), status) or message


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status,
            content=error_body(
                exc.code, localized(request, exc.status, exc.code, exc.message), exc.details
            ),
            headers=exc.headers,
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content=error_body(
                "validation_error",
                localized(request, 422, "validation_error", "Invalid request"),
                {"errors": jsonable_encoder(exc.errors())},
            ),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _HTTP_STATUS_CODES.get(exc.status_code, f"http_{exc.status_code}")
        return JSONResponse(
            status_code=exc.status_code,
            content=error_body(code, localized(request, exc.status_code, code, str(exc.detail))),
            headers=dict(exc.headers or {}),
        )

    @app.exception_handler(DBAPIError)
    async def _database_error(request: Request, exc: DBAPIError) -> JSONResponse:
        # Text PostgreSQL cannot store (a NUL character, an unpaired surrogate) is bad input.
        if _sqlstate(exc) in ("22021", "22P05"):
            return JSONResponse(
                status_code=422,
                content=error_body(
                    "validation_error",
                    localized(
                        request, 422, "validation_error", "Text contains unsupported characters"
                    ),
                ),
            )
        log.exception("database error", exc_info=exc)
        return JSONResponse(
            status_code=500,
            content=error_body(
                "server_error", localized(request, 500, "server_error", "Internal server error")
            ),
        )

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error", exc_info=exc)
        return JSONResponse(
            status_code=500,
            content=error_body(
                "server_error", localized(request, 500, "server_error", "Internal server error")
            ),
        )
