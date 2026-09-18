import asyncio
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import ExitStack, asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.exc import OperationalError
from sqlalchemy.exc import TimeoutError as SQLAlchemyTimeoutError
from starlette.responses import JSONResponse, Response

from app.core.config import get_settings
from app.core.database import model_registry  # noqa: F401
from app.core.database.session import dispose_database_resources
from app.core.middleware.file_transfers import (
    CapacityResponse,
    FileDispatchMiddleware,
    file_transfer_policy,
)
from app.core.middleware.request_context import (
    RequestContext,
    bind_request_context,
    reset_request_context,
)
from app.core.observability import configure_observability_logging, log_event
from app.core.readiness import dispose_readiness_resources, is_database_ready
from app.systems.access.auth.router import router as auth_router
from app.systems.manage.audit.router import internal_security_events_router, security_events_router
from app.systems.manage.audit.router import router as audit_router
from app.systems.manage.workspace.router import router as workspace_router
from app.systems.openview.views.router import router as views_router
from app.systems.platform.files.lifecycle_router import router as file_lifecycle_router
from app.systems.platform.files.providers import transfer_slot
from app.systems.platform.files.router import router as files_router
from app.systems.sandbox.departments.router import router as departments_router
from app.systems.sandbox.fields.router import module_fields_router
from app.systems.sandbox.fields.router import router as fields_router
from app.systems.sandbox.lifecycle.router import router as lifecycle_router
from app.systems.sandbox.modules.router import router as modules_router
from app.systems.sandbox.records.query_router import router as record_queries_router
from app.systems.sandbox.records.router import router as records_router
from app.systems.sandbox.relationships.router import router as relationships_router


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


def _database_unavailable_response(request: Request, context: RequestContext) -> JSONResponse:
    log_event(
        "database_unavailable",
        request_id=context.request_id,
        method=request.method,
        route=_request_route(request),
        status=503,
        reason_code="database_operation_failed",
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


@asynccontextmanager
async def application_lifespan(_: FastAPI) -> AsyncIterator[None]:
    configure_observability_logging()
    try:
        yield
    finally:
        dispose_readiness_resources()
        dispose_database_resources()


def create_app() -> FastAPI:
    settings = get_settings()
    configure_observability_logging()
    app = FastAPI(title=settings.app_name, version="0.1.0", lifespan=application_lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(FileDispatchMiddleware)

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
        body_limit = transfer.request_bytes if transfer else settings.request_body_max_bytes
        deadline = None
        try:
            if transfer is not None:
                request.state.file_transfer_lease = capacity.enter_context(transfer_slot())
            declared_size = request.headers.get("content-length")
            response: Response
            if declared_size is not None and _is_body_too_large(
                declared_size,
                body_limit,
            ):
                response = JSONResponse(
                    status_code=413,
                    content={"detail": "Request body is too large"},
                )
            else:
                async with asyncio.timeout(
                    transfer.deadline_seconds if transfer else None
                ) as deadline:
                    if not await _read_bounded_body(request, body_limit):
                        response = JSONResponse(
                            status_code=413,
                            content={"detail": "Request body is too large"},
                        )
                    else:
                        response = await call_next(request)
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
        except (OperationalError, SQLAlchemyTimeoutError):
            response = _database_unavailable_response(request, context)
        except Exception:
            response = _unexpected_error_response(request, context)
        except BaseException:
            # Client cancellation must close admission without dropping a running worker ref.
            capacity.close()
            reset_request_context(token)
            raise
        try:
            if request.url.path.startswith(("/api/workspace", "/api/views", "/api/files")):
                response.headers["Cache-Control"] = "no-store"
            response.headers.update(_request_headers(context))
            log_event(
                "http_request",
                method=request.method,
                route=_request_route(request),
                status=response.status_code,
                duration_ms=int((time.perf_counter() - started) * 1000),
            )
            return CapacityResponse(response, capacity.close)
        except BaseException:
            capacity.close()
            raise
        finally:
            reset_request_context(token)

    app.include_router(auth_router, prefix="/api")
    app.include_router(departments_router, prefix="/api")
    app.include_router(modules_router, prefix="/api")
    app.include_router(fields_router, prefix="/api")
    app.include_router(module_fields_router, prefix="/api")
    app.include_router(record_queries_router, prefix="/api")
    app.include_router(records_router, prefix="/api")
    app.include_router(views_router, prefix="/api")
    app.include_router(workspace_router, prefix="/api")
    app.include_router(files_router, prefix="/api")
    app.include_router(file_lifecycle_router, prefix="/api")
    app.include_router(relationships_router, prefix="/api")
    app.include_router(lifecycle_router, prefix="/api")
    app.include_router(audit_router, prefix="/api")
    app.include_router(security_events_router, prefix="/api")
    app.include_router(internal_security_events_router, prefix="/api")

    @app.get("/api/health", tags=["system"])
    def health() -> dict[str, str]:
        return {"status": "ok", "service": "openslate-api"}

    @app.get("/api/ready", tags=["system"])
    def ready() -> JSONResponse:
        if is_database_ready():
            return JSONResponse(
                status_code=200,
                content={"status": "ready"},
                headers={"Cache-Control": "no-store"},
            )
        return JSONResponse(
            status_code=503,
            content={"status": "not_ready"},
            headers={"Cache-Control": "no-store"},
        )

    return app


app = create_app()


def _is_body_too_large(content_length: str, limit: int) -> bool:
    try:
        return int(content_length) > limit
    except ValueError:
        return False


async def _read_bounded_body(request: Request, limit: int) -> bool:
    """Cache only an in-limit body so the downstream request can read it once."""

    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            return False
        chunks.append(chunk)
    request._body = b"".join(chunks)  # noqa: SLF001 - Starlette middleware cache contract.
    return True
