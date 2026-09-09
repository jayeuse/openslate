from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
from fastapi import FastAPI, HTTPException, Response
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.main import create_app
from app.systems.lifecycle.exceptions import (
    LifecycleChallengeExpired,
    LifecycleChallengeNotFound,
    LifecycleClosedAncestorError,
    LifecycleInvalidCredentials,
    LifecyclePasswordServiceUnavailable,
    LifecyclePreflightError,
)
from app.systems.lifecycle.router import (
    _close,
    _preview,
    _purge,
    _reopen,
    router,
)
from app.systems.lifecycle.schemas import (
    LifecycleBlocker,
    LifecycleBlockerCode,
    LifecycleCloseRequest,
    LifecycleImpactResponse,
    LifecycleMutationResponse,
    LifecyclePurgeRequest,
    LifecycleReopenRequest,
    LifecycleTargetType,
)


def _registered_client(database: Session) -> TestClient:
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: _user()
    app.dependency_overrides[get_db] = lambda: database
    return TestClient(app)


def _user() -> SimpleNamespace:
    return SimpleNamespace(
        id=uuid7(),
        email="admin@example.com",
        role=SimpleNamespace(role="admin", permissions={}),
    )


def _impact() -> LifecycleImpactResponse:
    return LifecycleImpactResponse(
        target_type=LifecycleTargetType.DEPARTMENT,
        target_id=uuid7(),
        operation="close",
        actor_id=uuid7(),
        impact_digest="digest",
    )


def test_lifecycle_routes_are_admin_protected_and_expose_all_resource_operations() -> None:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    paths = TestClient(app).get("/openapi.json").json()["paths"]

    assert "/api/departments/{department_id}/close/preview" in paths
    assert "/api/modules/{module_id}/close" in paths
    assert "/api/fields/{field_id}/reopen" in paths
    assert paths["/api/departments/{department_id}/close"]["post"]["security"] == [
        {"HTTPBearer": []}
    ]


def test_preview_returns_opaque_token_and_no_store_header() -> None:
    user = _user()
    target_id = uuid7()
    target = SimpleNamespace(is_deleted=False, department_name="Operations")
    issued = SimpleNamespace(
        token="opaque-token",
        expires_at=datetime.now(UTC) + timedelta(minutes=5),
    )
    db = Mock()
    db.get.return_value = target
    response = Response()

    with (
        patch("app.systems.lifecycle.router.plan_lifecycle") as plan,
        patch("app.systems.lifecycle.router.issue_challenge", return_value=issued),
    ):
        plan.return_value.response.return_value = _impact()
        plan.return_value.impact_digest = "digest"
        result = _preview(LifecycleTargetType.DEPARTMENT, target_id, user, db, response)

    assert result.token == "opaque-token"
    assert result.confirmation_name == "Operations"
    assert response.headers["Cache-Control"] == "no-store"


def test_close_rejects_typed_name_mismatch_before_verification() -> None:
    user = _user()
    target_id = uuid7()
    db = Mock()
    db.get.return_value = SimpleNamespace(is_deleted=False, module_name="Assets")

    with pytest.raises(Exception) as raised:
        _close(
            LifecycleTargetType.MODULE,
            target_id,
            LifecycleCloseRequest(
                token="token", confirmation_name="Wrong", password="password"
            ),
            user,
            db,
            Response(),
        )
    assert raised.value.status_code == 422


def test_close_maps_wrong_password_to_forbidden_and_drift_to_named_conflict() -> None:
    user = _user()
    target_id = uuid7()
    target = SimpleNamespace(is_deleted=False, module_name="Assets")
    db = Mock()
    db.get.return_value = target
    request = LifecycleCloseRequest(
        token="token", confirmation_name="Assets", password="wrong"
    )
    with (
        patch("app.systems.lifecycle.router.challenge_impact_digest", return_value="digest"),
        patch(
            "app.systems.lifecycle.router.verify_challenge",
            side_effect=LifecycleInvalidCredentials("invalid"),
        ),
    ):
        with pytest.raises(Exception) as raised:
            _close(LifecycleTargetType.MODULE, target_id, request, user, db, Response())
    assert raised.value.status_code == 403

    challenge = SimpleNamespace(impact_digest="old")
    db.get.return_value = target
    with (
        patch("app.systems.lifecycle.router.challenge_impact_digest", return_value="old"),
        patch("app.systems.lifecycle.router.verify_challenge", return_value=challenge),
        patch("app.systems.lifecycle.router.plan_lifecycle") as plan,
    ):
        plan.return_value.impact_digest = "new"
        with pytest.raises(Exception) as raised:
            _close(LifecycleTargetType.MODULE, target_id, request, user, db, Response())
    assert raised.value.status_code == 409
    assert raised.value.detail["code"] == "impact_changed"


@pytest.mark.parametrize(
    ("error", "status_code", "code"),
    [
        (LifecycleChallengeNotFound("challenge missing"), 404, "challenge_not_found"),
        (LifecycleChallengeExpired("challenge expired"), 409, "challenge_expired"),
        (
            LifecyclePasswordServiceUnavailable("provider unavailable"),
            503,
            "password_upstream_unavailable",
        ),
    ],
)
def test_registered_close_maps_challenge_and_provider_failures(
    error: Exception,
    status_code: int,
    code: str,
) -> None:
    database = Mock(spec=Session)
    database.get.return_value = SimpleNamespace(is_deleted=False, module_name="Assets")
    client = _registered_client(database)
    request = {"token": "token", "confirmation_name": "Assets", "password": "password"}

    with (
        patch("app.systems.lifecycle.router.challenge_impact_digest", return_value="digest"),
        patch("app.systems.lifecycle.router.verify_challenge", side_effect=error),
    ):
        response = client.post(f"/api/modules/{uuid7()}/close", json=request)

    assert response.status_code == status_code
    assert response.json()["detail"]["code"] == code


def test_registered_close_rejects_confirmation_name_before_provider_verification() -> None:
    database = Mock(spec=Session)
    database.get.return_value = SimpleNamespace(is_deleted=False, module_name="Assets")
    client = _registered_client(database)

    with patch("app.systems.lifecycle.router.verify_challenge") as verify:
        response = client.post(
            f"/api/modules/{uuid7()}/close",
            json={"token": "token", "confirmation_name": "Wrong", "password": "password"},
        )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "confirmation_name_mismatch"
    verify.assert_not_called()


def test_registered_close_rejects_plan_drift_after_verification() -> None:
    database = Mock(spec=Session)
    database.get.return_value = SimpleNamespace(is_deleted=False, module_name="Assets")
    client = _registered_client(database)
    challenge = SimpleNamespace(impact_digest="old")
    request = {"token": "token", "confirmation_name": "Assets", "password": "password"}

    with (
        patch("app.systems.lifecycle.router.challenge_impact_digest", return_value="old"),
        patch("app.systems.lifecycle.router.verify_challenge", return_value=challenge),
        patch("app.systems.lifecycle.router.plan_lifecycle") as plan,
    ):
        plan.return_value.impact_digest = "new"
        response = client.post(f"/api/modules/{uuid7()}/close", json=request)

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "impact_changed"


def test_purge_is_forbidden_by_default_before_loading_the_target() -> None:
    with patch(
        "app.systems.lifecycle.router.get_settings",
        return_value=SimpleNamespace(lifecycle_purge_enabled=False),
    ):
        with pytest.raises(HTTPException) as raised:
            _purge(
                LifecycleTargetType.RECORD,
                uuid7(),
                LifecyclePurgeRequest(
                    token="token", confirmation_name="anything", password="password"
                ),
                _user(),
                Mock(),
                Response(),
            )

    assert raised.value.status_code == 403
    assert raised.value.detail["code"] == "purge_disabled"


def test_purge_binds_confirmation_to_purge_operation_and_target() -> None:
    user = _user()
    target_id = uuid7()
    target = SimpleNamespace(is_deleted=True, name="Archived field")
    db = Mock()
    db.get.return_value = target
    db.info = {"audit_context": SimpleNamespace(request_id=uuid7())}
    request = LifecyclePurgeRequest(
        token="token", confirmation_name="Archived field", password="password"
    )
    challenge = SimpleNamespace(impact_digest="digest")
    impact = _impact().model_copy(update={"operation": "purge"})

    with (
        patch(
            "app.systems.lifecycle.router.get_settings",
            return_value=SimpleNamespace(lifecycle_purge_enabled=True),
        ),
        patch(
            "app.systems.lifecycle.router.challenge_impact_digest", return_value="digest"
        ) as digest,
        patch("app.systems.lifecycle.router.verify_challenge", return_value=challenge) as verify,
        patch("app.systems.lifecycle.router.plan_lifecycle") as plan,
        patch("app.systems.lifecycle.router.purge_lifecycle", return_value=impact),
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

    digest.assert_called_once_with(
        db, "token", user.id, "purge", "field", target_id
    )
    assert verify.call_args.args[3] == "purge"
    assert verify.call_args.args[4] == "field"
    assert verify.call_args.args[5] == target_id
    assert verify.call_args.args[6] == "digest"
    assert result.impact.operation == "purge"


def test_purge_rejects_an_open_root_before_confirmation() -> None:
    target_id = uuid7()
    db = Mock()
    db.get.return_value = SimpleNamespace(is_deleted=False, name="Open field")

    with (
        patch(
            "app.systems.lifecycle.router.get_settings",
            return_value=SimpleNamespace(lifecycle_purge_enabled=True),
        ),
        pytest.raises(Exception) as raised,
    ):
        _purge(
            LifecycleTargetType.FIELD,
            target_id,
            LifecyclePurgeRequest(
                token="token", confirmation_name="Open field", password="password"
            ),
            _user(),
            db,
            Response(),
        )

    assert raised.value.status_code == 409
    assert raised.value.detail["code"] == "purge_requires_closed"


def test_close_delegates_cascade_and_reopen_reports_ancestor_and_blockers() -> None:
    user = _user()
    target_id = uuid7()
    target = SimpleNamespace(is_deleted=False, department_name="Operations")
    db = Mock()
    db.get.return_value = target
    impact = _impact()
    db.info = {"audit_context": SimpleNamespace(request_id=uuid7())}
    request = LifecycleCloseRequest(
        token="token", confirmation_name="Operations", password="password"
    )
    challenge = SimpleNamespace(impact_digest="digest")
    with (
        patch("app.systems.lifecycle.router.challenge_impact_digest", return_value="digest"),
        patch("app.systems.lifecycle.router.verify_challenge", return_value=challenge),
        patch("app.systems.lifecycle.router.plan_lifecycle") as plan,
        patch("app.systems.lifecycle.router.close_lifecycle", return_value=impact) as close,
    ):
        plan.return_value.impact_digest = "digest"
        plan.return_value.response.return_value = impact
        result = _close(LifecycleTargetType.DEPARTMENT, target_id, request, user, db, Response())
    close.assert_called_once()
    assert isinstance(result, LifecycleMutationResponse)

    db.get.return_value = SimpleNamespace(is_deleted=True, module_name="Assets")
    with patch(
        "app.systems.lifecycle.router.reopen_lifecycle",
        side_effect=LifecycleClosedAncestorError("closed ancestor"),
    ):
        with pytest.raises(Exception) as raised:
            _reopen(
                LifecycleTargetType.MODULE,
                target_id,
                LifecycleReopenRequest(confirmed=True),
                user,
                db,
            )
    assert raised.value.detail["code"] == "closed_ancestor"

    blocker = LifecycleBlocker(
        code=LifecycleBlockerCode.MODULE_NAME_CONFLICT,
        entity_type="modules",
        entity_id=target_id,
        detail="conflict",
    )
    with patch(
        "app.systems.lifecycle.router.reopen_lifecycle",
        side_effect=LifecyclePreflightError([blocker]),
    ):
        with pytest.raises(Exception) as raised:
            _reopen(
                LifecycleTargetType.MODULE,
                target_id,
                LifecycleReopenRequest(confirmed=True),
                user,
                db,
            )
    assert raised.value.detail["blockers"][0]["code"] == "module_name_conflict"


@pytest.mark.parametrize(
    "request_model",
    [LifecycleCloseRequest, LifecyclePurgeRequest],
)
def test_lifecycle_confirmation_requests_bound_all_secret_and_confirmation_fields(
    request_model: type[LifecycleCloseRequest],
) -> None:
    valid = {"token": "t", "confirmation_name": "n", "password": "p"}
    for field_name in valid:
        oversized = dict(valid)
        oversized[field_name] = "x" * 1001
        with pytest.raises(ValueError):
            request_model(**oversized)
