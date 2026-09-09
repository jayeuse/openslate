from contextvars import ContextVar, Token
from uuid import UUID

from fastapi import Request
from uuid6 import uuid7


class RequestContext:
    def __init__(
        self,
        *,
        request_id: UUID | None = None,
        method: str | None = None,
        path: str | None = None,
    ) -> None:
        self.request_id = request_id or uuid7()
        self.method = method
        self.path = path
        self.performed_by: UUID | None = None


_current_request_context: ContextVar[RequestContext | None] = ContextVar(
    "current_request_context",
    default=None,
)


def get_request_context(request: Request) -> RequestContext:
    context = getattr(request.state, "request_context", None)
    if isinstance(context, RequestContext):
        return context

    context = RequestContext(
        method=request.method,
        path=request.url.path,
    )
    request.state.request_context = context
    return context


def bind_request_context(context: RequestContext) -> Token[RequestContext | None]:
    """Make the request context available to safe infrastructure diagnostics."""

    return _current_request_context.set(context)


def reset_request_context(token: Token[RequestContext | None]) -> None:
    _current_request_context.reset(token)


def get_current_request_context() -> RequestContext | None:
    return _current_request_context.get()
