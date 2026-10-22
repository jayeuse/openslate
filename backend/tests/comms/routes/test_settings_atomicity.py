"""Rejected settings commits never publish partially written values or audit success."""

import pytest
from sqlalchemy import event, text

from app.core.database.session import AuditSession
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY
from tests.comms.routes.settings_support import stored
from tests.comms.routes.structure_support import ROOT, _error, _ok, _read, _tag, _unchanged_read

pytestmark = pytest.mark.integration


def test_settings_database_failure_rolls_back_values_and_audit(structure_routes):
    case, org = structure_routes, structure_routes.world.first
    admin = case.client(org.author, org.id)
    path = ROOT + "/settings/workspace"
    current = _read(admin, path)
    before = stored(case)
    reached = []

    def fail(db):
        context = db.info.get(AUDIT_CONTEXT_KEY)
        if db.get_bind() is case.world.runtime and context and context.request_path == path:
            db.flush()
            reached.append(True)
            db.connection().execute(text("SELECT 1 / 0"))

    event.listen(AuditSession, "before_commit", fail)
    try:
        response = admin.patch(
            path, headers={"If-Match": _tag(current)}, json={"formatting": False}
        )
    finally:
        event.remove(AuditSession, "before_commit", fail)
    _error(response, 503, "comms_unavailable")
    assert reached == [True] and "division" not in response.text
    assert stored(case) == before
    _unchanged_read(admin, path, current)


def test_settings_read_validator_cannot_describe_a_later_snapshot(structure_routes, monkeypatch):
    from app.systems.comms.settings import service

    case, org = structure_routes, structure_routes.world.first
    reader, writer = case.client(org.author, org.id), case.client(org.author, org.id)
    path = ROOT + "/settings/workspace"
    before = _read(reader, path)
    original = service.settings
    interleaved = []
    active = []

    def bounded_wait(db, _transaction, connection):
        context = db.info.get(AUDIT_CONTEXT_KEY)
        if (
            active
            and context
            and context.request_method == "PATCH"
            and context.request_path == path
        ):
            connection.execute(text("SET LOCAL lock_timeout = '100ms'"))

    def interleave(db, scope):
        value = original(db, scope)
        context = db.info.get(AUDIT_CONTEXT_KEY)
        if not interleaved and not active and context.request_method == "GET":
            active.append(True)
            try:
                interleaved.append(
                    writer.patch(
                        path, headers={"If-Match": _tag(before)}, json={"formatting": False}
                    )
                )
            finally:
                active.clear()
        return value

    event.listen(AuditSession, "after_begin", bounded_wait)
    monkeypatch.setattr(service, "settings", interleave)
    try:
        response = _read(reader, path)
    finally:
        event.remove(AuditSession, "after_begin", bounded_wait)
        monkeypatch.setattr(service, "settings", original)
    assert response.json() == before.json()
    assert _tag(response) == _tag(before), "The returned token must bind the returned snapshot"
    assert len(interleaved) == 1 and interleaved[0].status_code == 503
    _unchanged_read(reader, path, before)
    # The bounded loser is rolled back; a later command with the same current token succeeds.
    assert (
        _ok(writer.patch(path, headers={"If-Match": _tag(before)}, json={"formatting": False}))[
            "effective"
        ]["formatting"]
        is False
    )
