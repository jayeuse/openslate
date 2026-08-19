from collections.abc import Generator
from functools import lru_cache
from typing import Any

from fastapi import Request
from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.middleware.request_context import get_request_context
from app.systems.audit.context import AUDIT_CONTEXT_KEY, AuditContext


class AuditSession(Session):
    """Application session with transactional ORM audit hooks."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        from app.systems.audit import listeners as _audit_listeners  # noqa: F401

        super().__init__(*args, **kwargs)


@lru_cache
def get_engine() -> Engine:
    return create_engine(get_settings().database_url, pool_pre_ping=True)


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
        yield session
