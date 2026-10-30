"""A workspace security 503 logs a bounded cause, never the error text."""

import psycopg
import pytest
from sqlalchemy.exc import OperationalError

from app.core.integrations.supabase_auth import SupabaseAuthUnavailable
from app.systems.manage.workspace import security_router


@pytest.fixture
def logged(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, object]]:
    entries: list[dict[str, object]] = []
    monkeypatch.setattr(
        security_router,
        "log_event",
        lambda event, **fields: entries.append({"event": event, **fields}),
    )
    return entries


def _lock_refused() -> OperationalError:
    return OperationalError("SELECT", {}, psycopg.errors.LockNotAvailable("private detail"))


def _wrapped_lock_refused() -> SupabaseAuthUnavailable:
    try:
        raise SupabaseAuthUnavailable("private detail") from _lock_refused()
    except SupabaseAuthUnavailable as error:
        return error


@pytest.mark.parametrize(
    ("error", "upstream", "cause"),
    [
        (_lock_refused(), "postgresql", "database_lock_unavailable"),
        # A policy read wraps its database error; the log names the database failure.
        (_wrapped_lock_refused(), "postgresql", "database_lock_unavailable"),
        (SupabaseAuthUnavailable("private detail"), "supabase-auth", "SupabaseAuthUnavailable"),
        (None, "postgresql", "policy_row_missing"),
    ],
)
def test_unavailable_logs_the_cause_without_message_text(
    logged: list[dict[str, object]],
    error: BaseException | None,
    upstream: str,
    cause: str,
) -> None:
    raised = security_router._unavailable(error)

    assert raised.status_code == 503
    assert raised.detail == {
        "code": "workspace_unavailable",
        "message": "Workspace configuration is unavailable",
    }
    assert logged == [
        {
            "event": "upstream_failure",
            "reason_code": "workspace_security_unavailable",
            "upstream": upstream,
            "cause": cause,
        }
    ]
    assert "private detail" not in str(logged)
