from collections.abc import Generator
from functools import lru_cache
from typing import Any

from fastapi import Request
from sqlalchemy import Engine, create_engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database import organization_scope
from app.core.middleware.request_context import get_request_context
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext


class AuditSession(Session):
    """Application session with transactional ORM audit hooks."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        from app.systems.comms.realtime import publication as _comms_publication  # noqa: F401
        from app.systems.manage.audit import listeners as _audit_listeners  # noqa: F401

        super().__init__(*args, **kwargs)


organization_scope.register(AuditSession)


@lru_cache
def get_engine() -> Engine:
    settings = get_settings()
    return create_engine(
        settings.database_url,
        pool_size=settings.database_pool_size,
        max_overflow=settings.database_max_overflow,
        pool_timeout=settings.database_pool_timeout_seconds,
        pool_pre_ping=True,
        connect_args={
            "connect_timeout": settings.database_connect_timeout_seconds,
            "options": f"-c statement_timeout={settings.database_statement_timeout_ms}",
        },
    )


def dispose_database_resources() -> None:
    """Dispose the cached application pool during application shutdown."""

    if get_engine.cache_info().currsize:
        get_engine().dispose()
    get_engine.cache_clear()


def get_db(request: Request) -> Generator[Session, None, None]:
    request_context = get_request_context(request)
    audit_context = AuditContext(
        performed_by=request_context.performed_by,
        request_id=request_context.request_id,
        request_method=request_context.method,
        request_path=request_context.path,
    )
    with AuditSession(get_engine()) as session:
        session.info[AUDIT_CONTEXT_KEY] = audit_context
        try:
            yield session
        except SQLAlchemyError:
            session.rollback()
            raise
