from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database import session as database_session
from app.core.middleware.request_context import RequestContext, get_request_context
from app.systems.audit.context import AuditContext, get_audit_context, set_audit_actor


def test_audit_context_defaults_to_system() -> None:
    session = Session()

    context = get_audit_context(session)

    assert context.performed_by is None
    assert get_audit_context(session) is context


def test_audit_actor_can_be_updated_for_a_session() -> None:
    session = Session()
    session.info["audit_context"] = AuditContext(request_id=uuid7())

    actor = uuid7()
    set_audit_actor(session, actor)

    assert get_audit_context(session).performed_by == actor


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
