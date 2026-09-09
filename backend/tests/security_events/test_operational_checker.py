from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock

import pytest
from sqlalchemy import text
from uuid6 import uuid7

from scripts import check_operational_health as checker


def test_checker_caps_output_and_never_includes_metadata() -> None:
    connection = MagicMock()
    connection.execute.return_value.mappings.return_value.all.return_value = [
        {
            "id": uuid7(),
            "operation_id": uuid7(),
            "event_type": "user.invitation",
            "source": "users.service",
            "reason": "unresolved",
            "metadata": "secret",
        }
        for _ in range(101)
    ]
    report = checker.inspect_operations(connection)
    assert report["truncated"] is True
    assert len(report["operations"]) == 100
    assert "secret" not in str(report)


def test_checker_failure_is_not_a_healthy_result(monkeypatch, capsys) -> None:
    def unavailable():
        raise RuntimeError("database password secret")

    monkeypatch.setattr(checker, "get_engine", unavailable)
    assert checker.main() == 2
    output = capsys.readouterr().out
    assert '"status": "unavailable"' in output
    assert "password" not in output


@pytest.mark.integration
def test_operation_matching_and_grace_period(integration_db) -> None:
    # Insert via the trusted event writer; read in a separate transaction below
    # is unnecessary because this fixture contains all rows in its rollback scope.
    from app.systems.audit.schemas import SecurityEventIngestRequest
    from app.systems.audit.service import append_security_event

    now = datetime.now(UTC)
    unresolved, resolved, partial, recent = [uuid7() for _ in range(4)]
    for operation, outcome, age, event_type in [
        (unresolved, "attempt", 10, "user.invitation"),
        (unresolved, "success", 8, "user.invitation_resend"),
        (resolved, "attempt", 10, "user.invitation"),
        (resolved, "success", 8, "user.invitation"),
        (partial, "attempt", 10, "user.invitation"),
        (partial, "partial", 8, "user.invitation"),
        (recent, "attempt", 1, "user.invitation"),
    ]:
        append_security_event(
            integration_db,
            SecurityEventIngestRequest(
                operation_id=operation,
                event_type=event_type,
                source="users.service",
                outcome=outcome,
                occurred_at=now - timedelta(minutes=age),
            ),
        )
    integration_db.flush()
    rows = integration_db.connection().execute(checker.ATTENTION_QUERY).mappings().all()
    own_rows = {
        row["operation_id"]: row["reason"]
        for row in rows
        if row["operation_id"] in {unresolved, resolved, partial, recent}
    }
    assert own_rows == {unresolved: "unresolved", partial: "partial"}
    assert integration_db.connection().scalar(text("SELECT 1")) == 1
