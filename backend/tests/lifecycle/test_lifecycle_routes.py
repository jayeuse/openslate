from datetime import UTC, datetime, timedelta
from secrets import token_urlsafe
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
from fastapi import Response
from uuid6 import uuid7

from app.systems.sandbox.lifecycle.router import (
    _preview,
    _purge,
)
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleCloseRequest,
    LifecycleImpactResponse,
    LifecyclePurgeRequest,
    LifecycleTargetType,
)

PREVIEW_TOKEN = token_urlsafe(32)
CONFIRMATION_TOKEN = token_urlsafe(32)
CONFIRMATION_PASSWORD = token_urlsafe(32)
BOUNDARY_TOKEN = token_urlsafe(32)
BOUNDARY_PASSWORD = token_urlsafe(32)


def _user() -> SimpleNamespace:
    return SimpleNamespace(
        id=uuid7(),
        email="admin@example.com",
        role="admin",
    )


def _impact() -> LifecycleImpactResponse:
    return LifecycleImpactResponse(
        target_type=LifecycleTargetType.DEPARTMENT,
        target_id=uuid7(),
        operation="close",
        actor_id=uuid7(),
        impact_digest="digest",
    )


def test_preview_returns_opaque_token_and_no_store_header() -> None:
    user = _user()
    target_id = uuid7()
    target = SimpleNamespace(is_deleted=False, department_name="Operations")
    issued = SimpleNamespace(
        token=PREVIEW_TOKEN,
        expires_at=datetime.now(UTC) + timedelta(minutes=5),
    )
    db = Mock()
    db.get.return_value = target
    response = Response()

    with (
        patch("app.systems.sandbox.lifecycle.router.plan_lifecycle") as plan,
        patch("app.systems.sandbox.lifecycle.router.issue_challenge", return_value=issued),
    ):
        plan.return_value.response.return_value = _impact()
        plan.return_value.impact_digest = "digest"
        result = _preview(LifecycleTargetType.DEPARTMENT, target_id, user, db, response)

    assert result.token == PREVIEW_TOKEN
    assert result.confirmation_name == "Operations"
    assert response.headers["Cache-Control"] == "no-store"


def test_purge_binds_confirmation_to_purge_operation_and_target() -> None:
    user = _user()
    target_id = uuid7()
    target = SimpleNamespace(is_deleted=True, name="Archived field")
    db = Mock()
    db.get.return_value = target
    db.info = {"audit_context": SimpleNamespace(request_id=uuid7())}
    request = LifecyclePurgeRequest(
        token=CONFIRMATION_TOKEN, confirmation_name="Archived field", password=CONFIRMATION_PASSWORD
    )
    challenge = SimpleNamespace(impact_digest="digest")
    impact = _impact().model_copy(update={"operation": "purge"})

    with (
        patch(
            "app.systems.sandbox.lifecycle.router.get_settings",
            return_value=SimpleNamespace(lifecycle_purge_enabled=True),
        ),
        patch("app.systems.sandbox.lifecycle.router.require_fresh_exact_admin", return_value=user),
        patch(
            "app.systems.sandbox.lifecycle.router.challenge_impact_digest", return_value="digest"
        ) as digest,
        patch(
            "app.systems.sandbox.lifecycle.router.verify_challenge", return_value=challenge
        ) as verify,
        patch("app.systems.sandbox.lifecycle.router.plan_lifecycle") as plan,
        patch("app.systems.sandbox.lifecycle.router.purge_lifecycle", return_value=impact),
    ):
        plan.return_value.impact_digest = "digest"
        result = _purge(
            LifecycleTargetType.FIELD,
            target_id,
            request,
            user,
            db,
            Response(),
        )

    digest.assert_called_once_with(db, CONFIRMATION_TOKEN, user.id, "purge", "field", target_id)
    assert verify.call_args.args[3] == "purge"
    assert verify.call_args.args[4] == "field"
    assert verify.call_args.args[5] == target_id
    assert verify.call_args.args[6] == "digest"
    assert result.impact.operation == "purge"


@pytest.mark.parametrize(
    "request_model",
    [LifecycleCloseRequest, LifecyclePurgeRequest],
)
def test_lifecycle_confirmation_requests_bound_all_secret_and_confirmation_fields(
    request_model: type[LifecycleCloseRequest],
) -> None:
    valid = {"token": BOUNDARY_TOKEN, "confirmation_name": "n", "password": BOUNDARY_PASSWORD}
    for field_name in valid:
        oversized = dict(valid)
        oversized[field_name] = "x" * 1001
        if field_name == "confirmation_name" and request_model is LifecyclePurgeRequest:
            # Purge accepts the exact stored display name; the global body limit still applies.
            assert (
                request_model.model_validate(oversized).confirmation_name == oversized[field_name]
            )
            continue
        with pytest.raises(ValueError):
            request_model(**oversized)
