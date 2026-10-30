"""The HTTP pipeline every request passes through, inside the file dispatch middleware.

It binds the request context, admits file transfers against the process budget, bounds
request bodies, maps database and unexpected failures to safe responses, adds the cache
and security headers, and logs each request.
"""

import asyncio
import time
from collections.abc import Awaitable, Callable
from contextlib import ExitStack

from fastapi import FastAPI, HTTPException, Request
from sqlalchemy.exc import OperationalError
from sqlalchemy.exc import TimeoutError as SQLAlchemyTimeoutError
from starlette.responses import JSONResponse, Response

from app.core.config import Settings
from app.core.middleware.file_transfers import (
    CapacityResponse,
    admit_request,
    backup_export_body_limit,
    file_transfer_policy,
    read_bounded_body,
    release_request_body,
    wait_for_processing_slot,
)
from app.core.middleware.request_context import (
    RequestContext,
    bind_request_context,
    reset_request_context,
)
from app.core.observability import failure_cause, log_event
from app.systems.manage.backups.downloads import release_export_response, wrap_export_response


def _request_route(request: Request) -> str:
    route = request.scope.get("route")
    # FastAPI included routers keep the child route in scope; their effective
    # context carries the registered template with all inclusion prefixes.
    fastapi_scope = request.scope.get("fastapi", {})
    effective = fastapi_scope.get("effective_route_context")
    if effective is not None and getattr(effective, "original_route", None) is route:
        route = effective
    path = getattr(route, "path", None)
    return path if isinstance(path, str) else "unknown"


def _request_headers(context: RequestContext) -> dict[str, str]:
    return {"X-Request-ID": str(context.request_id)}


# A fixed vocabulary by SQLSTATE, so the log names the failure without exception data.
def _database_unavailable_response(
    request: Request, context: RequestContext, error: Exception
) -> JSONResponse:
    log_event(
        "database_unavailable",
        request_id=context.request_id,
        method=request.method,
        route=_request_route(request),
        status=503,
        reason_code=failure_cause(error),
    )
    return JSONResponse(
        status_code=503,
        content={"detail": "Database unavailable"},
        headers=_request_headers(context),
    )


def _unexpected_error_response(request: Request, context: RequestContext) -> JSONResponse:
    log_event(
        "http_failure",
        request_id=context.request_id,
        method=request.method,
        route=_request_route(request),
        status=500,
        reason_code="unexpected_error",
    )
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
        headers=_request_headers(context),
    )


def install_request_middleware(
    app: FastAPI, settings: Settings, *, relaxed_development: bool
) -> None:
    """Register the pipeline; call it right after ``FileDispatchMiddleware`` is added."""

    @app.middleware("http")
    async def add_request_context(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        context = RequestContext(method=request.method, path=request.url.path)
        request.state.request_context = context
        token = bind_request_context(context)
        started = time.perf_counter()
        transfer = file_transfer_policy(request.url.path, request.method)
        capacity = ExitStack()
        sandbox_document_limit = _sandbox_document_body_limit(request.url.path, request.method)
        export_limit = backup_export_body_limit(request.url.path, request.method)
        body_limit = (
            export_limit
            if export_limit is not None
            else transfer.request_bytes
            if transfer is not None
            else sandbox_document_limit
            if sandbox_document_limit is not None
            else None
            if relaxed_development
            else settings.request_body_max_bytes
        )
        body_refusal = (
            {"code": "export_body_too_large", "message": "Export request body is too large"}
            if export_limit is not None
            else "Request body is too large"
        )
        deadline = None
        try:
            if transfer is not None:
                # No wait: when the budget is full the client retries after Retry-After.
                lease = admit_request(request.headers, transfer.request_bytes)
                capacity.callback(lease.close_response)
                capacity.callback(lease.release_middleware)
                request.state.file_transfer_lease = lease
                body_limit = lease.body_bytes
            declared_size = request.headers.get("content-length")
            response: Response
            if (
                body_limit is not None
                and declared_size is not None
                and _is_body_too_large(
                    declared_size,
                    body_limit,
                )
            ):
                response = JSONResponse(
                    status_code=413,
                    content={"detail": body_refusal},
                )
            else:
                async with asyncio.timeout(
                    transfer.deadline_seconds if transfer else None
                ) as deadline:
                    if body_limit is not None and not await read_bounded_body(request, body_limit):
                        response = JSONResponse(
                            status_code=413,
                            content={"detail": body_refusal},
                        )
                    else:
                        await wait_for_processing_slot(request)
                        response = await call_next(request)
                        release_request_body(request)
        except HTTPException as error:
            response = JSONResponse(
                status_code=error.status_code,
                content={"detail": error.detail},
                headers=error.headers,
            )
        except TimeoutError:
            if transfer is not None and deadline is not None and deadline.expired():
                response = JSONResponse(
                    status_code=504,
                    content={
                        "detail": {
                            "code": "file_timeout",
                            "message": (
                                "File operation timed out; inspect its state before retrying"
                            ),
                        }
                    },
                )
            else:
                response = _unexpected_error_response(request, context)
        except (OperationalError, SQLAlchemyTimeoutError) as error:
            response = _database_unavailable_response(request, context, error)
        except Exception:
            response = _unexpected_error_response(request, context)
        except BaseException:
            # Client cancellation must close admission without dropping a running worker ref.
            capacity.close()
            release_export_response(request)
            reset_request_context(token)
            raise
        try:
            if request.url.path.startswith("/api"):
                response.headers.setdefault("Cache-Control", "no-store")
            if request.url.path.rstrip("/") in {"/auth/setup", "/auth/recovery"}:
                response.headers["Cache-Control"] = "no-store"
                response.headers["Referrer-Policy"] = "no-referrer"
            if not relaxed_development:
                _add_security_headers(response)
            response.headers.update(_request_headers(context))
            log_event(
                "http_request",
                method=request.method,
                route=_request_route(request),
                status=response.status_code,
                duration_ms=int((time.perf_counter() - started) * 1000),
            )
            return CapacityResponse(wrap_export_response(request, response), capacity.close)
        except BaseException:
            capacity.close()
            release_export_response(request)
            raise
        finally:
            reset_request_context(token)


def _add_security_headers(response: Response) -> None:
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault(
        "Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=()"
    )


def _is_body_too_large(content_length: str, limit: int) -> bool:
    try:
        return int(content_length) > limit
    except ValueError:
        return False


def _sandbox_document_body_limit(path: str, method: str) -> int | None:
    if (path, method) in {
        ("/api/sandbox/document", "PUT"),
        ("/api/sandbox/imports", "POST"),
    }:
        return 5 * 1024 * 1024
    return None
