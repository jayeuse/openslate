from types import SimpleNamespace

from sqlalchemy import create_engine

from app.core.database import session as database_session
from app.core.middleware.request_context import RequestContext, get_request_context


def test_request_context_is_reused_on_request_state() -> None:
    request = SimpleNamespace(
        state=SimpleNamespace(),
        method="GET",
        url=SimpleNamespace(path="/api/test"),
    )

    first = get_request_context(request)
    second = get_request_context(request)

    assert first is second
    assert first.method == "GET"


def test_get_db_attaches_request_audit_context(monkeypatch) -> None:
    monkeypatch.setattr(database_session, "get_engine", lambda: create_engine("sqlite://"))
    request = SimpleNamespace(
        state=SimpleNamespace(
            request_context=RequestContext(method="POST", path="/api/test")
        )
    )
    generator = database_session.get_db(request)

    session = next(generator)

    assert session.info["audit_context"].request_method == "POST"
    generator.close()
