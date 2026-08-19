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
        self.performed_by = "anonymous"


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
