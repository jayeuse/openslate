from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import Response

from app.core.config import get_settings
from app.core.database import model_registry  # noqa: F401
from app.core.middleware.request_context import RequestContext
from app.systems.audit.router import router as audit_router
from app.systems.auth.router import router as auth_router
from app.systems.departments.router import router as departments_router
from app.systems.fields.router import module_fields_router
from app.systems.fields.router import router as fields_router
from app.systems.modules.router import router as modules_router
from app.systems.records.router import router as records_router


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=settings.app_name, version="0.1.0")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def add_request_context(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        request.state.request_context = RequestContext(method=request.method, path=request.url.path)
        response = await call_next(request)
        response.headers["X-Request-ID"] = str(request.state.request_context.request_id)
        return response

    app.include_router(auth_router, prefix="/api")
    app.include_router(departments_router, prefix="/api")
    app.include_router(modules_router, prefix="/api")
    app.include_router(fields_router, prefix="/api")
    app.include_router(module_fields_router, prefix="/api")
    app.include_router(records_router, prefix="/api")
    app.include_router(audit_router, prefix="/api")

    @app.get("/api/health", tags=["system"])
    def health() -> dict[str, str]:
        return {"status": "ok", "service": "openslate-api"}

    return app


app = create_app()
