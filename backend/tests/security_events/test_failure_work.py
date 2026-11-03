"""A failed sign-in does the same database work for a known account and an unknown email."""

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest
from pydantic import SecretStr
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Session


def _work(monkeypatch: pytest.MonkeyPatch, subject_id, existing):
    from app.systems.manage.audit import security_failures

    monkeypatch.setattr(security_failures, "get_settings", lambda: SimpleNamespace(
        security_event_server_key=SecretStr("dq1-unit-key"),
    ))
    db = Mock(spec=Session)
    db.scalar.return_value = existing
    appended = Mock()
    monkeypatch.setattr(security_failures, "append_security_event", appended)
    security_failures.append_representative_failure(
        db, "identity.sign_in_failure", "203.0.113.7",
        now=datetime(2033, 4, 5, 6, 15, tzinfo=UTC), subject_id=subject_id,
        user_agent="Agent/1.0",
    )
    statements = []
    for name, args, _ in db.method_calls:
        compiled = args[0].compile(dialect=postgresql.dialect())
        statements.append((name, str(compiled), compiled.params))
    return statements, appended


def test_dq1_a_known_account_takes_the_same_lock_and_lookup_as_an_unknown_email(monkeypatch):
    # Without them the known path is faster, and the timing tells which emails exist.
    unknown, unknown_appended = _work(monkeypatch, None, None)
    # A grouped row already exists for this address and hour; the attempt is still its own event.
    known, known_appended = _work(monkeypatch, uuid4(), uuid4())

    assert [name for name, _, _ in unknown] == ["execute", "scalar"]
    assert "pg_advisory_xact_lock" in unknown[0][1]
    assert known == unknown
    assert unknown_appended.call_count == known_appended.call_count == 1
    assert known_appended.call_args.args[1].fingerprint is None
