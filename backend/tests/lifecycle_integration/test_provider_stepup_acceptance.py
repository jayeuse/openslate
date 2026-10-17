"""Real Supabase password step-up through the registered lifecycle API."""

from datetime import timedelta
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.core.config import get_settings
from app.main import create_app
from app.systems.access.identity.models import IdentityRateLimitBucket
from app.systems.access.identity.rate_limits import login_fingerprint, rate_limit_fingerprint
from app.systems.access.users.models import Membership, User, UserRole
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from tests.lifecycle_integration.lifecycle_integration_support import delete_committed_scope
from tests.sandbox_designs.fixtures import create_document

pytest_plugins = ("tests.auth.provider_account_support",)
pytestmark = pytest.mark.integration


def _bind_provider_account_as_admin(owner: Engine, provider_id: UUID, local_id: UUID) -> UUID:
    with Session(owner) as db:
        user = db.get(User, local_id)
        assert user is not None
        membership = db.scalars(select(Membership).where(Membership.user_id == user.id)).one()
        membership.role = UserRole.ADMIN.value
        user.supabase_user_id = provider_id
        organization_id = membership.org_id
        create_document(db, db.get(WorkspaceProfile, organization_id))
        db.commit()
    return organization_id


def _seed_protected_module(
    owner: Engine, organization_id: UUID, suffix: str
) -> tuple[UUID, UUID, UUID]:
    """Commit the lifecycle target directly; the Sandbox publish owns schema writes."""

    with Session(owner) as db:
        department = Department(org_id=organization_id, department_name=f"Step-up {suffix}")
        module = Module(org_id=department.org_id, department=department,
                        module_name=f"Protected {suffix}")
        field = Field(
            org_id=module.org_id,
            module=module,
            name=f"Label {suffix}",
            type=FieldType.TEXT,
            required=False,
            position=0,
            config={},
        )
        db.add_all([department, module, field])
        db.flush()
        identifiers = (department.id, module.id, field.id)
        db.commit()
    return identifiers


def _cleanup_stepup_rows(
    owner: Engine,
    actor_id: UUID,
    email: str,
    department_ids: set[UUID],
    module_ids: set[UUID],
    field_ids: set[UUID],
    organization_id: UUID,
) -> None:
    """Remove only the synthetic actor's challenge, audit, limit, and API rows."""

    with owner.begin() as connection:
        for fingerprint in (
            login_fingerprint(email, None),
            rate_limit_fingerprint("login-account", email, None),
        ):
            connection.execute(
                text(
                    "DELETE FROM public.identity_rate_limit_buckets "
                    "WHERE fingerprint = :fingerprint"
                ),
                {"fingerprint": fingerprint},
            )
        connection.execute(
            text(
                "DELETE FROM public.security_events "
                "WHERE actor_id = :actor_id OR subject_id = :actor_id"
            ),
            {"actor_id": actor_id},
        )
        delete_committed_scope(
            connection,
            actor_id=actor_id,
            audit_entity_ids=department_ids | module_ids | field_ids,
            audit_by_actor=True,
            field_ids=field_ids,
            module_ids=module_ids,
            department_ids=department_ids,
        )
        connection.execute(
            text("DELETE FROM public.sandbox_documents WHERE org_id = :org_id"),
            {"org_id": organization_id},
        )


def test_real_provider_stepup_retries_consumes_and_rejects_replay(provider_account) -> None:
    """A temporary Auth password grant must not become an application session."""

    email, password, provider_id, local_id, owner = provider_account
    organization_id = _bind_provider_account_as_admin(owner, provider_id, local_id)
    department_ids: set[UUID] = set()
    module_ids: set[UUID] = set()
    field_ids: set[UUID] = set()
    client = None
    try:
        settings = get_settings()
        client = TestClient(create_app(), base_url=settings.public_origin)
        client.headers["Origin"] = settings.public_origin

        login = client.post("/api/auth/login", json={"email": email, "password": password})
        assert login.status_code == 200
        csrf_token = client.cookies.get("openslate_csrf")
        assert csrf_token
        client.headers["X-CSRF-Token"] = csrf_token

        before_stepup = client.get("/api/auth/sessions")
        assert before_stepup.status_code == 200
        original_sessions = before_stepup.json()
        assert len(original_sessions) == 1
        assert original_sessions[0]["current"] is True

        suffix = uuid7().hex[:12]
        department_id, module_id, field_id = _seed_protected_module(owner, organization_id, suffix)
        department_ids.add(department_id)
        module_ids.add(module_id)
        field_ids.add(field_id)
        module_id_path = str(module_id)

        preview = client.post(f"/api/modules/{module_id_path}/close/preview")
        assert preview.status_code == 200
        challenge = preview.json()
        close_payload = {
            "token": challenge["token"],
            "confirmation_name": challenge["confirmation_name"],
        }

        account_key = rate_limit_fingerprint("login-account", email, None)
        with Session(owner) as db:
            db.add(
                IdentityRateLimitBucket(
                    fingerprint=account_key,
                    attempt_count=9,
                    window_started_at=utc_now() - timedelta(hours=49),
                    blocked_until=None,
                )
            )
            db.commit()
        rejected = client.post(
            f"/api/modules/{module_id_path}/close",
            json={**close_payload, "password": "definitely-not-the-password"},
        )
        assert rejected.status_code == 403
        assert rejected.json()["detail"]["code"] == "invalid_credentials"
        with Session(owner) as db:
            assert db.get(IdentityRateLimitBucket, account_key).attempt_count == 1
        after_rejection = client.get(f"/api/modules/{module_id_path}")
        assert after_rejection.status_code == 200
        assert after_rejection.json()["is_deleted"] is False

        closed = client.post(
            f"/api/modules/{module_id_path}/close",
            json={**close_payload, "password": password},
        )
        assert closed.status_code == 200
        with Session(owner) as db:
            assert db.get(IdentityRateLimitBucket, account_key) is None
        after_close = client.get(f"/api/modules/{module_id_path}")
        assert after_close.status_code == 200
        assert after_close.json()["is_deleted"] is True

        after_stepup = client.get("/api/auth/sessions")
        assert after_stepup.status_code == 200
        remaining_sessions = after_stepup.json()
        same_application_session = (
            len(remaining_sessions) == len(original_sessions) == 1
            and remaining_sessions[0]["current"] is True
            and remaining_sessions[0]["id"] == original_sessions[0]["id"]
        )
        assert same_application_session, (
            "Provider password verification must not admit another application session"
        )

        reopened = client.post(f"/api/modules/{module_id_path}/reopen", json={"confirmed": True})
        assert reopened.status_code == 200
        after_reopen = client.get(f"/api/modules/{module_id_path}")
        assert after_reopen.status_code == 200
        assert after_reopen.json()["is_deleted"] is False

        replay = client.post(
            f"/api/modules/{module_id_path}/close",
            json={**close_payload, "password": password},
        )
        assert replay.status_code == 404
        assert replay.json()["detail"]["code"] == "challenge_not_found"
        after_replay = client.get(f"/api/modules/{module_id_path}")
        assert after_replay.status_code == 200
        assert after_replay.json()["is_deleted"] is False
    finally:
        if client is not None:
            client.close()
        _cleanup_stepup_rows(
            owner,
            local_id,
            email,
            department_ids,
            module_ids,
            field_ids,
            organization_id,
        )
