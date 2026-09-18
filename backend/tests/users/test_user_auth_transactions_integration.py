from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException

from app.core.database.session import AuditSession
from app.core.integrations.supabase import SupabaseAdminError
from app.systems.access.users.coordination import active_admin_count
from app.systems.access.users.models import UserStatus
from tests.users.user_transaction_support import (
    UserTransactionFixture,
    user_api_fixture,  # noqa: F401
)

pytestmark = pytest.mark.integration


def _assert_events(fixture, outcomes, subject_id=None):
    assert fixture.event_outcomes(subject_id or fixture.seeded.target_id) == outcomes


def test_activation_success_releases_request_transaction_before_auth_io(
    user_api_fixture: UserTransactionFixture,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = user_api_fixture
    accepted = datetime.now(UTC) - timedelta(minutes=1)
    fixture.set_target(status=UserStatus.DISABLED, sent=accepted, accepted=accepted)
    callback = fixture.provider_callback(monkeypatch, "_enable_auth_user")
    with fixture.client() as client:
        response = client.patch(
            f"/api/users/{fixture.seeded.target_id}",
            json={"status": UserStatus.ACTIVE.value},
        )
    assert response.status_code == 200
    assert callback.call_args.args == (fixture.seeded.target_id,)
    assert fixture.row(fixture.seeded.target_id)["status"] == UserStatus.ACTIVE.value
    _assert_events(fixture, ["attempt", "success"])


def test_activation_provider_failure_keeps_local_state_and_records_failure(
    user_api_fixture: UserTransactionFixture,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = user_api_fixture
    fixture.set_target(status=UserStatus.DISABLED)
    callback = fixture.provider_callback(
        monkeypatch,
        "_enable_auth_user",
        error=HTTPException(status_code=503, detail="provider unavailable"),
    )
    with fixture.client() as client:
        response = client.patch(
            f"/api/users/{fixture.seeded.target_id}",
            json={"status": UserStatus.ACTIVE.value},
        )
    assert response.status_code == 503
    assert callback.call_args.args == (fixture.seeded.target_id,)
    assert fixture.row(fixture.seeded.target_id)["status"] == UserStatus.DISABLED.value
    _assert_events(fixture, ["attempt", "failure"])


def test_activation_drift_after_auth_success_returns_conflict(
    user_api_fixture: UserTransactionFixture,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = user_api_fixture
    fixture.set_target(status=UserStatus.DISABLED)
    fixture.provider_callback(monkeypatch, "_enable_auth_user", drift=True)
    with fixture.client() as client:
        response = client.patch(
            f"/api/users/{fixture.seeded.target_id}",
            json={"status": UserStatus.ACTIVE.value},
        )
    assert response.status_code == 409
    assert fixture.row(fixture.seeded.target_id)["status"] == UserStatus.DISABLED.value
    _assert_events(fixture, ["attempt", "partial"])


def test_restore_success_releases_request_transaction_before_auth_io(
    user_api_fixture: UserTransactionFixture,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = user_api_fixture
    accepted = datetime.now(UTC) - timedelta(minutes=1)
    fixture.set_target(
        status=UserStatus.DISABLED,
        deleted=True,
        sent=accepted,
        accepted=accepted,
    )
    callback = fixture.provider_callback(monkeypatch, "_enable_auth_user")
    with fixture.client() as client:
        response = client.post(f"/api/users/{fixture.seeded.target_id}/restore")
    assert response.status_code == 200
    assert callback.call_args.args == (fixture.seeded.target_id,)
    row = fixture.row(fixture.seeded.target_id)
    assert row["status"] == UserStatus.ACTIVE.value
    assert row["is_deleted"] is False
    _assert_events(fixture, ["attempt", "success"])


def test_restore_provider_failure_keeps_deleted_local_state(
    user_api_fixture: UserTransactionFixture,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = user_api_fixture
    accepted = datetime.now(UTC) - timedelta(minutes=1)
    fixture.set_target(status=UserStatus.DISABLED, deleted=True, sent=accepted, accepted=accepted)
    fixture.provider_callback(
        monkeypatch,
        "_enable_auth_user",
        error=HTTPException(status_code=503, detail="provider unavailable"),
    )
    with fixture.client() as client:
        response = client.post(f"/api/users/{fixture.seeded.target_id}/restore")
    assert response.status_code == 503
    row = fixture.row(fixture.seeded.target_id)
    assert row["status"] == UserStatus.DISABLED.value
    assert row["is_deleted"] is True
    _assert_events(fixture, ["attempt", "failure"])


def test_restore_drift_after_auth_success_returns_conflict(
    user_api_fixture: UserTransactionFixture,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = user_api_fixture
    accepted = datetime.now(UTC) - timedelta(minutes=1)
    fixture.set_target(status=UserStatus.DISABLED, deleted=True, sent=accepted, accepted=accepted)
    fixture.provider_callback(monkeypatch, "_enable_auth_user", drift=True)
    with fixture.client() as client:
        response = client.post(f"/api/users/{fixture.seeded.target_id}/restore")
    assert response.status_code == 409
    assert fixture.row(fixture.seeded.target_id)["is_deleted"] is True
    _assert_events(fixture, ["attempt", "partial"])


@pytest.mark.parametrize("operation", ["disable", "delete"])
def test_local_first_disable_and_delete_success_commit_before_auth_io(
    user_api_fixture: UserTransactionFixture,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
) -> None:
    fixture = user_api_fixture
    callback = fixture.provider_callback(monkeypatch, "_disable_auth_user")
    with fixture.client() as client:
        response = (
            client.patch(
                f"/api/users/{fixture.seeded.target_id}",
                json={"status": UserStatus.DISABLED.value},
            )
            if operation == "disable"
            else client.delete(f"/api/users/{fixture.seeded.target_id}")
        )
    assert response.status_code == (200 if operation == "disable" else 204)
    assert callback.call_args.args == (fixture.seeded.target_id,)
    row = fixture.row(fixture.seeded.target_id)
    assert row["status"] == UserStatus.DISABLED.value
    assert row["is_deleted"] is (operation == "delete")
    _assert_events(fixture, ["attempt", "success"])


@pytest.mark.parametrize("operation", ["disable", "delete"])
def test_local_first_disable_and_delete_provider_failure_is_partial(
    user_api_fixture: UserTransactionFixture,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
) -> None:
    fixture = user_api_fixture
    fixture.provider_callback(
        monkeypatch,
        "_disable_auth_user",
        error=HTTPException(status_code=503, detail="provider unavailable"),
    )
    with fixture.client() as client:
        response = (
            client.patch(
                f"/api/users/{fixture.seeded.target_id}",
                json={"status": UserStatus.DISABLED.value},
            )
            if operation == "disable"
            else client.delete(f"/api/users/{fixture.seeded.target_id}")
        )
    assert response.status_code == 503
    row = fixture.row(fixture.seeded.target_id)
    assert row["status"] == UserStatus.DISABLED.value
    assert row["is_deleted"] is (operation == "delete")
    _assert_events(fixture, ["attempt", "partial"])


def test_reconcile_corrupted_active_profile_disables_auth_without_local_activation(
    user_api_fixture: UserTransactionFixture,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = user_api_fixture
    callback = fixture.provider_callback(monkeypatch, "_disable_auth_user")
    with fixture.client() as client:
        response = client.post(f"/api/users/{fixture.seeded.corrupted_admin_id}/reconcile-auth")
    assert response.status_code == 200
    assert callback.call_args.args == (fixture.seeded.corrupted_admin_id,)
    row = fixture.row(fixture.seeded.corrupted_admin_id)
    assert row["status"] == UserStatus.ACTIVE.value
    assert row["invitation_accepted_at"] is None
    _assert_events(fixture, ["attempt", "success"], fixture.seeded.corrupted_admin_id)


def test_reconcile_provider_failure_is_recorded_without_local_mutation(
    user_api_fixture: UserTransactionFixture,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = user_api_fixture
    fixture.provider_callback(
        monkeypatch,
        "_disable_auth_user",
        error=SupabaseAdminError("provider unavailable"),
    )
    with fixture.client() as client:
        response = client.post(f"/api/users/{fixture.seeded.corrupted_admin_id}/reconcile-auth")
    assert response.status_code == 503
    row = fixture.row(fixture.seeded.corrupted_admin_id)
    assert row["status"] == UserStatus.ACTIVE.value
    _assert_events(fixture, ["attempt", "failure"], fixture.seeded.corrupted_admin_id)


def test_reconcile_drift_fails_closed_after_remote_disable(
    user_api_fixture: UserTransactionFixture,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = user_api_fixture
    fixture.provider_callback(monkeypatch, "_disable_auth_user", drift=True)
    with fixture.client() as client:
        response = client.post(f"/api/users/{fixture.seeded.corrupted_admin_id}/reconcile-auth")
    assert response.status_code == 409
    row = fixture.row(fixture.seeded.corrupted_admin_id)
    assert row["status"] == UserStatus.DISABLED.value
    assert row["tokens_valid_after"] is not None
    _assert_events(fixture, ["attempt", "partial"], fixture.seeded.corrupted_admin_id)


def test_active_admin_count_excludes_corrupted_invitation_profile(
    user_api_fixture: UserTransactionFixture,  # noqa: F811
) -> None:
    fixture = user_api_fixture
    with AuditSession(bind=fixture.runtime_engine) as database:
        assert active_admin_count(database) == fixture.baseline_admin_count + 1
