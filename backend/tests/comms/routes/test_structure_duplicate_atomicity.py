"""A failed copy cannot publish structure, local configuration, membership, or audit rows."""

import pytest
from sqlalchemy import event, select, text

from app.core.database.session import AuditSession
from app.systems.comms.conversations.models import CommsConversation, CommsMember
from app.systems.comms.messages.models import CommsConversationCounter, CommsMessage
from app.systems.comms.settings.models import CommsCapabilityGrant, CommsSettings
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY
from app.systems.manage.audit.models import AuditLog
from tests.comms.routes.structure_support import (
    ROOT,
    _error,
    _ok,
    _read,
    _snapshot,
    _tag,
    _unchanged_read,
)

pytestmark = pytest.mark.integration


def test_duplicate_commit_failure_leaves_no_structure_configuration_or_audit(duplicate_source):
    case, destination = duplicate_source
    org = case.world.first
    actor = case.client(org.peer, org.id)
    source = f"{ROOT}/conversations/{org.conversation}"
    endpoint = source + "/duplicates"
    payload = {"name": "Atomic copy", "category_id": str(destination)}
    current = _read(actor, source)
    before, reached = _snapshot(case), {}

    def no_copy(reader, identity, request_id):
        assert (
            reader.scalar(
                select(CommsConversation.name).where(
                    CommsConversation.id == org.conversation,
                )
            )
            == "Copy source"
        )
        for model in (
            CommsConversationCounter,
            CommsSettings,
            CommsCapabilityGrant,
            CommsMember,
            CommsMessage,
        ):
            assert (
                reader.scalars(select(model.id).where(model.conversation_id == identity)).all()
                == []
            )
        assert (
            reader.scalars(select(AuditLog.id).where(AuditLog.request_id == request_id)).all() == []
        )

    def fail_commit(db):
        context = db.info.get(AUDIT_CONTEXT_KEY)
        if (
            db.get_bind() is not case.world.runtime
            or context is None
            or context.request_path != endpoint
        ):
            return
        db.flush()
        db.flush()
        row = db.scalar(select(CommsConversation).where(CommsConversation.name == "Atomic copy"))
        assert row is not None and row.created_by == row.performed_by == org.peer
        assert row.category_id == destination and row.topic == "Source topic"
        reached.update(identity=row.id, request_id=context.request_id)
        assert db.scalar(
            select(CommsSettings.values).where(
                CommsSettings.conversation_id == row.id,
            )
        ) == {"edit_window_minutes": 17}
        assert (
            db.scalar(
                select(CommsConversationCounter.last_seq).where(
                    CommsConversationCounter.conversation_id == row.id,
                )
            )
            == 0
        )
        assert (
            db.scalars(select(CommsMessage.id).where(CommsMessage.conversation_id == row.id)).all()
            == []
        )
        logs = db.scalars(select(AuditLog).where(AuditLog.request_id == context.request_id)).all()
        assert logs and all(r.action == "create" and r.performed_by == org.peer for r in logs)
        with case.world.owner.connect() as reader:
            no_copy(reader, row.id, context.request_id)
        db.connection().execute(text("SELECT 1 / 0"))

    event.listen(AuditSession, "before_commit", fail_commit)
    try:
        refused = actor.post(endpoint, headers={"If-Match": _tag(current)}, json=payload)
    finally:
        event.remove(AuditSession, "before_commit", fail_commit)
    _error(refused, 503, "comms_unavailable")
    assert "location" not in refused.headers and "division by zero" not in refused.text
    assert set(reached) == {"identity", "request_id"}
    with case.world.owner.connect() as reader:
        no_copy(reader, reached["identity"], reached["request_id"])
    assert _snapshot(case) == before
    _unchanged_read(actor, source, current)
    copied = _ok(actor.post(endpoint, headers={"If-Match": _tag(current)}, json=payload), 201)
    assert copied["id"] != str(reached["identity"])
    assert copied["name"] == "Atomic copy" and copied["level"] == "manage"
    assert _ok(actor.get(f"{ROOT}/conversations/{copied['id']}/messages"))["items"] == []
    _unchanged_read(actor, source, current)
