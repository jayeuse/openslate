"""Publication password and persistence failure contracts."""

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.sandbox.publications.router as publication_router
from app.common.dependencies.auth import CurrentIdentity
from app.systems.access.users.models import User, UserStatus
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.sandbox.lifecycle.exceptions import (
    LifecycleInvalidCredentials,
    LifecyclePasswordRateLimited,
)
from app.systems.sandbox.publications.schemas import PublicationRequest
from tests.conftest import create_member


def _identity() -> CurrentIdentity:
    role = "admin"
    now = datetime.now(UTC)
    user, _membership = create_member(None, WorkspaceProfile(id=uuid7()), role,
        id=uuid7(),
        email="publisher@example.test",
        username="publisher",
        status=UserStatus.ACTIVE.value,
        created_at=now,
        updated_at=now,
        is_deleted=False,
    )
    return CurrentIdentity(
        user=user,
        session_id=uuid7(),
        cookie_authenticated=False,
        setup_only=False,
    )


def _payload() -> PublicationRequest:
    return PublicationRequest(
        expected_revision=1,
        preview_token="preview",
        impact_digest="a" * 64,
        password="wrong password",
    )


def test_failed_publication_password_commits_rate_limit_and_maps_rate_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = Mock(spec=Session)
    identity = _identity()
    calls: list[str] = []
    monkeypatch.setattr(publication_router, "require_live_session", lambda *_a, **_k: None)
    monkeypatch.setattr(
        publication_router,
        "require_fresh_exact_admin",
        lambda *_args, **_kwargs: calls.append("policy"),
    )

    def invalid_password(*_args: object, **_kwargs: object) -> User:
        calls.append("password")
        raise LifecycleInvalidCredentials("bad")

    monkeypatch.setattr(
        publication_router,
        "ProviderPasswordGrantClient",
        lambda _db: SimpleNamespace(verify_password=invalid_password),
        raising=False,
    )

    with pytest.raises(HTTPException) as invalid:
        publication_router.post_publication(_payload(), identity, database, "publication-key")

    assert invalid.value.status_code == 403
    assert calls == ["policy", "password"]
    monkeypatch.setattr(
        publication_router,
        "ProviderPasswordGrantClient",
        lambda _db: SimpleNamespace(
            verify_password=Mock(side_effect=LifecyclePasswordRateLimited("blocked"))
        ),
        raising=False,
    )

    with pytest.raises(HTTPException) as limited:
        publication_router.post_publication(_payload(), identity, database, "publication-key")

    assert limited.value.status_code == 429
    database.rollback.assert_called_once()


def test_publication_rechecks_authorization_after_password_transaction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = Mock(spec=Session)
    identity = _identity()
    checked = 0

    def authorize(*_args: object, **_kwargs: object) -> User:
        nonlocal checked
        checked += 1
        if checked == 2:
            raise HTTPException(status_code=403, detail="Forbidden")
        return identity.user

    monkeypatch.setattr(publication_router, "require_live_session", lambda *_a, **_k: None)
    monkeypatch.setattr(publication_router, "require_fresh_exact_admin", authorize)
    monkeypatch.setattr(
        publication_router,
        "ProviderPasswordGrantClient",
        lambda _db: SimpleNamespace(verify_password=lambda *_args: identity.user.id),
    )
    monkeypatch.setattr(
        publication_router,
        "decode_preview_token",
        lambda _token: SimpleNamespace(
            actor_id=identity.user.id,
            session_id=identity.session_id,
            document_revision=1,
            impact_digest="a" * 64,
            document_hash="b" * 64,
            live_state_digest="c" * 64,
        ),
    )
    replay = Mock(side_effect=AssertionError("unauthorized replay attempted"))
    publish = Mock(side_effect=AssertionError("unauthorized publication attempted"))
    monkeypatch.setattr(publication_router, "replay_or_conflict", replay)
    monkeypatch.setattr(publication_router, "apply_publication", publish)

    with pytest.raises(HTTPException) as denied:
        publication_router.post_publication(_payload(), identity, database, "publication-key")

    assert denied.value.status_code == 403
    assert checked == 2
    replay.assert_not_called()
    publish.assert_not_called()


def test_publication_integrity_failures_return_a_safe_unavailable_error() -> None:
    database = Mock(spec=Session)

    def fail() -> None:
        raise IntegrityError("statement", {}, RuntimeError("database detail"))

    with pytest.raises(HTTPException) as unavailable:
        publication_router._run(database, fail)

    assert unavailable.value.status_code == 503
    assert unavailable.value.detail != "database detail"
    database.rollback.assert_called_once()
