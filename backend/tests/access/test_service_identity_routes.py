"""Service-identity HTTP lifecycle, filtering, and error contracts."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest
from fastapi import HTTPException, Response
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.main import create_app
from app.systems.access.service_identities import router as service_router
from app.systems.access.service_identities.schemas import ServiceIdentityListRequest
from app.systems.access.users.models import IdentityKind, Role, User, UserRole, UserStatus
from app.systems.manage.audit.context import set_audit_actor


def test_service_identity_list_maps_database_errors_to_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    admin = SimpleNamespace(id=uuid4())
    monkeypatch.setattr(service_router, "require_fresh_exact_admin", Mock())
    monkeypatch.setattr(
        service_router,
        "execute_standard_list",
        Mock(side_effect=SQLAlchemyError("database connection string")),
    )

    with pytest.raises(HTTPException) as unavailable:
        service_router.list_service_identities(
            admin,
            db,
            Response(),
            ServiceIdentityListRequest(status="active", owner_id=uuid4(), role_id=uuid4()),
        )

    assert unavailable.value.status_code == 503
    assert unavailable.value.detail == "Database unavailable"
    db.rollback.assert_called_once()


@pytest.mark.integration
def test_service_identity_http_lifecycle_and_filtered_list(integration_db: Session) -> None:
    suffix = uuid4().hex
    admin_role = integration_db.scalar(
        select(Role).where(Role.role == UserRole.ADMIN.value, Role.is_deleted.is_(False))
    )
    assert isinstance(admin_role, Role)
    first_role = Role(role=f"service-role-one-{suffix}", description="", permissions={})
    second_role = Role(role=f"service-role-two-{suffix}", description="", permissions={})
    integration_db.add_all([first_role, second_role])
    integration_db.flush()
    admin = User(
        email=f"service-admin-{suffix}@example.test",
        username=f"service_admin_{suffix[:16]}",
        status=UserStatus.ACTIVE.value,
        identity_kind=IdentityKind.INTERNAL.value,
        role_id=admin_role.id,
        role=admin_role,
    )
    first_owner = User(
        email=f"service-owner-one-{suffix}@example.test",
        username=f"service_owner_one_{suffix[:16]}",
        status=UserStatus.ACTIVE.value,
        identity_kind=IdentityKind.INTERNAL.value,
        role_id=first_role.id,
        role=first_role,
    )
    second_owner = User(
        email=f"service-owner-two-{suffix}@example.test",
        username=f"service_owner_two_{suffix[:16]}",
        status=UserStatus.ACTIVE.value,
        identity_kind=IdentityKind.INTERNAL.value,
        role_id=second_role.id,
        role=second_role,
    )
    integration_db.add_all([admin, first_owner, second_owner])
    integration_db.flush()
    set_audit_actor(integration_db, admin.id)

    application = create_app()
    application.dependency_overrides[get_db] = lambda: integration_db
    application.dependency_overrides[get_current_user] = lambda: admin
    create_payload = {
        "name": "  Scheduled export  ",
        "purpose": "  Generate a daily report  ",
        "owner_id": str(first_owner.id),
        "role_id": str(first_role.id),
        "expires_at": (datetime.now(UTC) + timedelta(days=3)).isoformat(),
    }

    with TestClient(application, raise_server_exceptions=False) as client:
        created = client.post("/api/access/service-identities", json=create_payload)
        assert created.status_code == 201, created.text
        created_body = created.json()
        service_id = created_body["id"]
        assert created_body["name"] == "Scheduled export"
        assert created_body["purpose"] == "Generate a daily report"
        assert created.headers["cache-control"] == "private, no-store"
        assert created.headers["etag"]
        assert created.headers["location"] == f"/api/access/service-identities/{service_id}"

        active_list = client.get(
            "/api/access/service-identities",
            params={
                "status": "active",
                "owner_id": str(first_owner.id),
                "role_id": str(first_role.id),
            },
        )
        assert active_list.status_code == 200, active_list.text
        assert active_list.headers["cache-control"] == "private, no-store"
        assert [item["id"] for item in active_list.json()["items"]] == [service_id]
        assert active_list.json()["pagination"]["count"] == 1

        detail = client.get(f"/api/access/service-identities/{service_id}")
        assert detail.status_code == 200, detail.text
        assert detail.headers["cache-control"] == "private, no-store"
        assert detail.headers["etag"] == created.headers["etag"]

        missing_detail = client.get(f"/api/access/service-identities/{uuid4()}")
        assert missing_detail.status_code == 404
        missing_patch = client.patch(
            f"/api/access/service-identities/{uuid4()}",
            headers={"If-Match": created.headers["etag"]},
            json={"name": "Missing"},
        )
        assert missing_patch.status_code == 404

        active_restore = client.post(
            f"/api/access/service-identities/{service_id}/restore",
            headers={"If-Match": created.headers["etag"]},
        )
        assert active_restore.status_code == 409

        invalid_owner = client.post(
            "/api/access/service-identities",
            json=create_payload | {"owner_id": str(uuid4())},
        )
        assert invalid_owner.status_code == 409
        invalid_role = client.post(
            "/api/access/service-identities",
            json=create_payload | {"role_id": str(admin_role.id)},
        )
        assert invalid_role.status_code == 409

        missing_match = client.patch(
            f"/api/access/service-identities/{service_id}", json={"name": "Updated"}
        )
        stale_match = client.patch(
            f"/api/access/service-identities/{service_id}",
            headers={"If-Match": '"stale"'},
            json={"name": "Updated"},
        )
        assert missing_match.status_code == 428
        assert stale_match.status_code == 412

        update_payload = {
            "name": "  Disabled export  ",
            "purpose": "  Updated report generation  ",
            "owner_id": str(second_owner.id),
            "role_id": str(second_role.id),
            "expires_at": (datetime.now(UTC) + timedelta(days=4)).isoformat(),
            "status": "disabled",
        }
        updated = client.patch(
            f"/api/access/service-identities/{service_id}",
            headers={"If-Match": created.headers["etag"]},
            json=update_payload,
        )
        assert updated.status_code == 200, updated.text
        updated_body = updated.json()
        assert updated_body["name"] == "Disabled export"
        assert updated_body["purpose"] == "Updated report generation"
        assert updated_body["effective_status"] == "disabled"
        assert updated.headers["cache-control"] == "private, no-store"
        assert updated.headers["etag"]

        disabled_list = client.get(
            "/api/access/service-identities",
            params={
                "status": "disabled",
                "owner_id": str(second_owner.id),
                "role_id": str(second_role.id),
            },
        )
        assert disabled_list.status_code == 200
        assert [item["id"] for item in disabled_list.json()["items"]] == [service_id]

        deleted = client.delete(
            f"/api/access/service-identities/{service_id}",
            headers={"If-Match": updated.headers["etag"]},
        )
        assert deleted.status_code == 204
        assert deleted.content == b""
        assert deleted.headers["cache-control"] == "private, no-store"

        deleted_detail = client.get(f"/api/access/service-identities/{service_id}")
        assert deleted_detail.status_code == 200
        assert deleted_detail.json()["effective_status"] == "deleted"
        assert deleted_detail.headers["etag"]

        deleted_patch = client.patch(
            f"/api/access/service-identities/{service_id}",
            headers={"If-Match": deleted_detail.headers["etag"]},
            json={"name": "Cannot update"},
        )
        repeated_delete = client.delete(
            f"/api/access/service-identities/{service_id}",
            headers={"If-Match": deleted_detail.headers["etag"]},
        )
        missing_restore_match = client.post(f"/api/access/service-identities/{service_id}/restore")
        stale_restore_match = client.post(
            f"/api/access/service-identities/{service_id}/restore",
            headers={"If-Match": '"stale"'},
        )
        assert deleted_patch.status_code == 409
        assert repeated_delete.status_code == 409
        assert missing_restore_match.status_code == 428
        assert stale_restore_match.status_code == 412

        restored = client.post(
            f"/api/access/service-identities/{service_id}/restore",
            headers={"If-Match": deleted_detail.headers["etag"]},
        )

    assert restored.status_code == 200, restored.text
    assert restored.json()["is_deleted"] is False
    assert restored.json()["effective_status"] == "disabled"
    assert restored.headers["cache-control"] == "private, no-store"
    assert restored.headers["etag"]
    application.dependency_overrides.clear()
