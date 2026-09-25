from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest
from fastapi import FastAPI, HTTPException, Response
from pydantic import ValidationError
from sqlalchemy.exc import SQLAlchemyError

from app.main import create_app
from app.systems.access.service_identities import router as service_router
from app.systems.access.service_identities.router import SERVICE_IDENTITY_LIST_SPEC
from app.systems.access.service_identities.schemas import (
    ServiceIdentityCreate,
    ServiceIdentityResponse,
    ServiceIdentityUpdate,
    effective_status,
)
from app.systems.access.service_identities.service import etag, get_service_identity, require_match


def _payload() -> dict[str, object]:
    return {
        "name": "  Reporting service  ",
        "purpose": "  Send weekly reports  ",
        "owner_id": uuid4(),
        "role_id": uuid4(),
        "expires_at": datetime.now(UTC) + timedelta(days=1),
    }


def test_service_identity_schema_rejects_extra_or_expired_input_and_trims_text() -> None:
    payload = ServiceIdentityCreate.model_validate(_payload())
    assert payload.name == "Reporting service"
    assert payload.purpose == "Send weekly reports"

    with pytest.raises(ValidationError):
        ServiceIdentityCreate.model_validate(_payload() | {"credential": "secret"})
    with pytest.raises(ValidationError):
        ServiceIdentityCreate.model_validate(
            _payload() | {"expires_at": datetime.now(UTC) - timedelta(seconds=1)}
        )
    for field in ("name", "purpose", "owner_id", "role_id", "expires_at", "status"):
        with pytest.raises(ValidationError):
            ServiceIdentityUpdate.model_validate({field: None})


@pytest.mark.parametrize(
    ("status", "is_deleted", "expires_at", "expected"),
    [
        ("active", True, datetime.now(UTC) + timedelta(days=1), "deleted"),
        ("disabled", False, datetime.now(UTC) + timedelta(days=1), "disabled"),
        ("active", False, datetime.now(UTC) + timedelta(days=1), "active"),
    ],
)
def test_effective_service_identity_status_covers_lifecycle_states(
    status: str, is_deleted: bool, expires_at: datetime, expected: str
) -> None:
    assert effective_status(status=status, is_deleted=is_deleted, expires_at=expires_at) == expected


def test_service_identity_expiry_requires_a_timezone_for_create_and_update() -> None:
    naive_expiry = datetime.now()
    with pytest.raises(ValidationError, match="expires_at must include a timezone"):
        ServiceIdentityCreate.model_validate(_payload() | {"expires_at": naive_expiry})
    with pytest.raises(ValidationError, match="expires_at must include a timezone"):
        ServiceIdentityUpdate.model_validate({"expires_at": naive_expiry})


@pytest.mark.parametrize("field", ["name", "purpose"])
def test_service_identity_text_validators_leave_non_string_type_errors_to_pydantic(
    field: str,
) -> None:
    with pytest.raises(ValidationError):
        ServiceIdentityCreate.model_validate(_payload() | {field: 42})
    with pytest.raises(ValidationError):
        ServiceIdentityUpdate.model_validate({field: 42})


def test_service_identity_response_is_secret_free_and_expiry_fails_closed() -> None:
    row = SimpleNamespace(
        id=uuid4(),
        name="Reporting service",
        purpose="Send weekly reports",
        owner_id=uuid4(),
        role_id=uuid4(),
        expires_at=datetime.now(UTC) - timedelta(seconds=1),
        status="active",
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
        deleted_at=None,
        is_deleted=False,
        performed_by=None,
    )
    response = ServiceIdentityResponse.model_validate(row)
    assert response.effective_status == "expired"
    assert ServiceIdentityResponse.model_validate(response.model_dump()) == response
    assert set(response.model_dump()) == {
        "id",
        "name",
        "purpose",
        "owner_id",
        "role_id",
        "expires_at",
        "status",
        "effective_status",
        "created_at",
        "updated_at",
        "deleted_at",
        "is_deleted",
        "performed_by",
    }


def test_etag_preconditions_and_list_contract_are_explicit() -> None:
    row = SimpleNamespace(
        id=uuid4(),
        updated_at=datetime(2026, 9, 22, tzinfo=UTC),
        status="active",
        is_deleted=False,
        expires_at=datetime.now(UTC) + timedelta(seconds=1),
    )
    value = etag(row)
    require_match(value, row)
    with pytest.raises(HTTPException) as missing:
        require_match(None, row)
    assert missing.value.status_code == 428
    with pytest.raises(HTTPException) as stale:
        require_match('"stale"', row)
    assert stale.value.status_code == 412
    row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    assert etag(row) != value
    assert set(SERVICE_IDENTITY_LIST_SPEC.sort_fields) == {"name", "expires_at", "updated_at"}


def test_service_identity_read_failures_and_create_headers_are_safe(monkeypatch) -> None:
    db = Mock()
    db.get.side_effect = SQLAlchemyError("unavailable")
    with pytest.raises(HTTPException) as unavailable:
        get_service_identity(db, uuid4())
    assert unavailable.value.status_code == 503
    db.rollback.assert_called_once()

    row = SimpleNamespace(
        id=uuid4(),
        updated_at=datetime.now(UTC),
        status="active",
        is_deleted=False,
        expires_at=datetime.now(UTC) + timedelta(days=1),
    )
    exact_admin = Mock()
    create = Mock(return_value=row)
    monkeypatch.setattr(service_router, "require_fresh_exact_admin", exact_admin)
    monkeypatch.setattr(service_router, "create_service_identity", create)
    admin = SimpleNamespace(id=uuid4())
    response = Response()
    service_router.create_one_service_identity(
        ServiceIdentityCreate.model_validate(_payload()), admin, Mock(), response
    )
    exact_admin.assert_called_once()
    assert response.headers["Cache-Control"] == "private, no-store"
    assert response.headers["Location"] == f"/api/access/service-identities/{row.id}"
    app = FastAPI()
    app.include_router(service_router.router, prefix="/api")
    document = app.openapi()["paths"]
    assert (
        "Location"
        in document["/api/access/service-identities"]["post"]["responses"]["201"]["headers"]
    )
    assert {"412", "428"} <= set(
        document["/api/access/service-identities/{service_identity_id}"]["patch"]["responses"]
    )


def test_service_identity_routes_are_registered_in_the_application() -> None:
    paths = create_app().openapi()["paths"]

    assert "/api/access/service-identities" in paths
    assert "/api/access/service-identities/{service_identity_id}" in paths
