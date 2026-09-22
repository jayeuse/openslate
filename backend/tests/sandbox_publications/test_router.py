"""Publication password and persistence failure contracts."""

from datetime import UTC, datetime
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.sandbox.publications.router as publication_router
from app.common.dependencies.auth import CurrentIdentity
from app.systems.access.identity.service import IdentityRateLimited, InvalidCredentials
from app.systems.access.users.models import Role, User, UserStatus
from app.systems.sandbox.publications.schemas import PublicationRequest


def _identity() -> CurrentIdentity:
    role = Role(id=uuid7(), role="admin", permissions={}, is_deleted=False)
    now = datetime.now(UTC)
    user = User(
        id=uuid7(),
        email="publisher@example.test",
        username="publisher",
        status=UserStatus.ACTIVE.value,
        role_id=role.id,
        role=role,
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
    monkeypatch.setattr(
        publication_router, "authenticate_password", Mock(side_effect=InvalidCredentials("bad"))
    )

    with pytest.raises(HTTPException) as invalid:
        publication_router.post_publication(_payload(), identity, database, "publication-key")

    assert invalid.value.status_code == 403
    database.commit.assert_called_once()
    database.rollback.assert_not_called()
    monkeypatch.setattr(
        publication_router,
        "authenticate_password",
        Mock(side_effect=IdentityRateLimited("blocked")),
    )

    with pytest.raises(HTTPException) as limited:
        publication_router.post_publication(_payload(), identity, database, "publication-key")

    assert limited.value.status_code == 429
    database.rollback.assert_called_once()


def test_publication_integrity_failures_return_a_safe_unavailable_error() -> None:
    database = Mock(spec=Session)

    def fail() -> None:
        raise IntegrityError("statement", {}, RuntimeError("database detail"))

    with pytest.raises(HTTPException) as unavailable:
        publication_router._run(database, fail)

    assert unavailable.value.status_code == 503
    assert unavailable.value.detail != "database detail"
    database.rollback.assert_called_once()
