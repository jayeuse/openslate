"""Partial preferences through real Auth, CSRF, runtime PostgreSQL and audit."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database.session import AuditSession
from app.main import create_app
from app.systems.access.users.models import User
from app.systems.manage.audit.models import AuditLog
from tests.auth.test_provider_auth_integration import provider_account  # noqa: F401

pytestmark = pytest.mark.integration
DEFAULT_APPEARANCE = {"motion": "system", "keyboard_shortcuts": True}


def _login(account):
    email, password, _, _, _ = account
    settings = get_settings()
    client = TestClient(create_app(), base_url=settings.public_origin)
    client.headers["Origin"] = settings.public_origin
    try:
        assert (
            client.post("/api/auth/login", json={"email": email, "password": password}).status_code
            == 200
        )
        csrf = client.cookies.get("openslate_csrf")
        assert csrf
        client.headers["X-CSRF-Token"] = csrf
        return client
    except BaseException:
        client.close()
        raise


@pytest.fixture
def preferences_client(provider_account):  # noqa: F811
    _, _, provider_id, local_id, owner = provider_account
    with Session(owner) as db:
        user = db.get(User, local_id)
        assert user is not None
        user.supabase_user_id = provider_id
        # An existing explicit choice isolates transport tests from the new-user default.
        user.theme_preference = "light"
        db.commit()
    client = _login(provider_account)
    try:
        yield client, provider_account, f"/api/users/{local_id}/preferences"
    finally:
        client.close()


def _state(account):
    _, _, _, local_id, owner = account
    with Session(owner) as db:
        user = db.get(User, local_id)
        assert user is not None
        audits = list(
            db.scalars(
                select(AuditLog)
                .where(
                    AuditLog.entity_type == "users",
                    AuditLog.entity_id == local_id,
                    AuditLog.action == "update",
                )
                .order_by(AuditLog.id)
            )
        )
        return (
            user.theme_preference,
            user.appearance,
            user.updated_at,
            [(row.id, row.before, row.after, row.performed_by) for row in audits],
        )


def test_preferences_read_includes_strict_appearance_without_general_profile_expansion(
    preferences_client,
):
    client, account, path = preferences_client
    response = client.get(path)
    assert response.status_code == 200
    assert response.json() == {
        "user_id": str(account[3]),
        "theme": "light",
        "appearance": DEFAULT_APPEARANCE,
    }
    assert "no-store" in response.headers["Cache-Control"]
    profile = client.get("/api/auth/me")
    assert profile.status_code == 200
    assert {"theme", "theme_preference", "appearance"}.isdisjoint(profile.json())


def test_partial_nested_preferences_persist_preserve_omissions_and_audit_once(preferences_client):
    client, account, path = preferences_client
    for payload, expected in (
        ({"appearance": {"motion": "reduce"}}, {"motion": "reduce", "keyboard_shortcuts": True}),
        (
            {"appearance": {"keyboard_shortcuts": False}},
            {"motion": "reduce", "keyboard_shortcuts": False},
        ),
        ({"theme": "system"}, {"motion": "reduce", "keyboard_shortcuts": False}),
    ):
        saved = client.patch(path, json=payload)
        assert saved.status_code == 200
        assert saved.json()["appearance"] == expected
        assert "no-store" in saved.headers["Cache-Control"]
    state = _state(account)
    assert state[:2] == ("system", {"motion": "reduce", "keyboard_shortcuts": False})
    assert len(state[3]) == 3 and all(row[3] == account[3] for row in state[3])
    assert state[3][0][1:3] == (
        {"appearance": {"motion": "system"}},
        {"appearance": {"motion": "reduce"}},
    )
    fresh = _login(account)
    try:
        assert fresh.get(path).json() == {
            "user_id": str(account[3]),
            "theme": "system",
            "appearance": {"motion": "reduce", "keyboard_shortcuts": False},
        }
    finally:
        fresh.close()
    combined = client.patch(path, json={"theme": "dark", "appearance": DEFAULT_APPEARANCE})
    assert combined.status_code == 200
    assert combined.json() == {
        "user_id": str(account[3]),
        "theme": "dark",
        "appearance": DEFAULT_APPEARANCE,
    }
    assert _state(account)[:2] == ("dark", DEFAULT_APPEARANCE)
    assert len(_state(account)[3]) == 4


def test_empty_and_same_value_preferences_do_not_write(preferences_client):
    client, account, path = preferences_client
    before = _state(account)
    for payload in ({}, {"appearance": {}}, {"theme": "light"}, {"appearance": DEFAULT_APPEARANCE}):
        response = client.patch(path, json=payload)
        assert response.status_code == 200
        assert response.json() == {
            "user_id": str(account[3]),
            "theme": "light",
            "appearance": DEFAULT_APPEARANCE,
        }
        assert _state(account) == before


@pytest.mark.parametrize(
    "invalid",
    [
        {"theme": None},
        {"theme": "sepia"},
        {"appearance": None},
        {"appearance": []},
        {"appearance": {"motion": None}},
        {"appearance": {"motion": "normal"}},
        {"appearance": {"keyboard_shortcuts": None}},
        {"appearance": {"keyboard_shortcuts": "false"}},
        {"appearance": {"keyboard_shortcuts": "true"}},
        {"appearance": {"keyboard_shortcuts": 0}},
        {"appearance": {"keyboard_shortcuts": 1}},
        {"appearance": {"density": "compact"}},
        {"theme": "dark", "role": "admin"},
        {"text_size": 125},
    ],
)
def test_invalid_preferences_are_rejected_without_persistence(preferences_client, invalid):
    client, account, path = preferences_client
    before = _state(account)
    rejected = client.patch(path, json=invalid)
    assert rejected.status_code == 422
    assert _state(account) == before


def test_combined_preferences_roll_back_all_values_and_audit_on_commit_failure(preferences_client):
    client, account, path = preferences_client
    before = _state(account)

    def fail_commit(db):
        db.flush()
        raise SQLAlchemyError("owned private preference failure")

    with patch.object(AuditSession, "commit", fail_commit):
        rejected = client.patch(
            path,
            json={"theme": "dark", "appearance": {"motion": "reduce", "keyboard_shortcuts": False}},
        )
    assert rejected.status_code == 503
    assert rejected.json() == {"detail": "Unable to update preferences"}
    assert _state(account) == before


def test_nested_merge_uses_fresh_locked_values_after_authentication(preferences_client):
    client, account, path = preferences_client
    _, _, _, local_id, owner = account
    changed = []

    def change_after_auth_read(_db, instance):
        if isinstance(instance, User) and instance.id == local_id and not changed:
            changed.append(True)
            with Session(owner) as concurrent:
                user = concurrent.get(User, local_id)
                user.appearance = {"motion": "reduce", "keyboard_shortcuts": True}
                concurrent.commit()

    event.listen(AuditSession, "loaded_as_persistent", change_after_auth_read)
    try:
        saved = client.patch(path, json={"appearance": {"keyboard_shortcuts": False}})
        assert saved.status_code == 200
        assert saved.json()["appearance"] == {"motion": "reduce", "keyboard_shortcuts": False}
    finally:
        event.remove(AuditSession, "loaded_as_persistent", change_after_auth_read)
    assert changed and _state(account)[:2] == (
        "light",
        {"motion": "reduce", "keyboard_shortcuts": False},
    )
    assert len(_state(account)[3]) == 1


def test_concurrent_sessions_preserve_disjoint_nested_updates(preferences_client, monkeypatch):
    first, account, path = preferences_client
    second = _login(account)
    attempts = Barrier(2)
    original = AuditSession.refresh

    def synchronized_refresh(db, instance, *args, **kwargs):
        if (
            isinstance(instance, User)
            and instance.id == account[3]
            and kwargs.get("with_for_update")
        ):
            # Both real requests reach their current-row lock query before either proceeds.
            attempts.wait(timeout=10)
        return original(db, instance, *args, **kwargs)

    monkeypatch.setattr(AuditSession, "refresh", synchronized_refresh)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            left = pool.submit(first.patch, path, json={"appearance": {"motion": "reduce"}})
            right = pool.submit(
                second.patch, path, json={"appearance": {"keyboard_shortcuts": False}}
            )
            responses = [left.result(timeout=20), right.result(timeout=20)]
        assert [response.status_code for response in responses] == [200, 200]
        assert _state(account)[:2] == ("light", {"motion": "reduce", "keyboard_shortcuts": False})
        assert len(_state(account)[3]) == 2
    finally:
        attempts.abort()
        second.close()
