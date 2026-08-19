from uuid import uuid7

from sqlalchemy.orm import Session

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
