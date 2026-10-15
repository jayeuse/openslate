"""HTTP acceptance for the Sandbox design lifecycle the frontend calls.

Authentication is replaced at the identity boundary only: each actor has a real
committed ``IdentitySession``, so ``require_admin``, ``require_live_session`` and
``require_fresh_exact_admin`` run against PostgreSQL. The provider password
step-up is replaced the same way ``test_concurrency_integration.py`` does it.
"""

from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from secrets import token_urlsafe
from typing import Any
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.sandbox.publications.router as publication_router
from app.common.dependencies.auth import CurrentIdentity, get_current_identity
from app.core.database import get_db
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import User, UserRole, UserStatus
from app.systems.manage.audit.context import set_audit_actor
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.designs.router import router as designs_router
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.lifecycle.exceptions import LifecycleInvalidCredentials
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.models import SandboxPublication
from app.systems.sandbox.publications.rules import _field_key
from app.systems.sandbox.records.models import Record
from tests.conftest import create_member
from tests.rbac.support import organization
from tests.sandbox_publications.support import bound_field, bound_module, publish_structure

pytestmark = pytest.mark.integration

PASSWORD = token_urlsafe(24)
NOTES_FIELD = "sample-field-requests-notes"


@dataclass
class Api:
    client: TestClient
    db: Session
    admin: CurrentIdentity
    identity: CurrentIdentity
    password_checks: list[UUID] = field(default_factory=list)

    def current(self) -> CurrentIdentity:
        set_audit_actor(self.db, self.identity.user.id)
        return self.identity


@pytest.fixture
def api(integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch) -> Iterator[Api]:
    publisher, _document = publish_structure(integration_owner_db)
    admin = _identity(integration_owner_db, publisher)
    # Routes roll back to the last savepoint on 403/409; keep the setup committed.
    integration_owner_db.commit()
    app = FastAPI()
    app.include_router(designs_router, prefix="/api")
    app.include_router(publication_router.router, prefix="/api")
    with TestClient(app) as client:
        state = Api(client=client, db=integration_owner_db, admin=admin, identity=admin)

        class PasswordGrant:
            def __init__(self, request_db: Session) -> None:
                self._db = request_db

            def verify_password(self, email: str, password: str) -> UUID:
                user = self._db.scalar(select(User).where(User.email == email))
                assert user is not None
                state.password_checks.append(user.id)
                if password != PASSWORD:
                    raise LifecycleInvalidCredentials("The supplied password is invalid")
                return user.id

        monkeypatch.setattr(publication_router, "ProviderPasswordGrantClient", PasswordGrant)
        app.dependency_overrides[get_current_identity] = state.current
        app.dependency_overrides[get_db] = lambda: integration_owner_db
        yield state
    app.dependency_overrides.clear()


def test_restoration_over_http_replaces_only_the_draft_and_checkpoints_first(
    api: Api,
) -> None:
    published = _published_versions(api)[0]
    edited = _draft(api)["document"]
    _module(edited, "sample-requests")["name"] = "Draft-only requests"
    _module(edited, "sample-requests")["fields"].append(_notes_field())
    changed = _save(api, edited)
    live_before = _live_structure(api.db)

    response = api.client.post(
        f"/api/sandbox/versions/{published['id']}/restorations",
        json={"expectedRevision": changed["revision"]},
    )

    assert response.status_code == 201, response.text
    restored = response.json()
    target = _version_detail(api, published["id"])
    assert restored["revision"] == changed["revision"] + 1
    assert restored["contentHash"] == target["contentHash"]
    assert restored["document"] == target["document"]
    assert _draft(api)["contentHash"] == target["contentHash"]
    newest = _versions(api)["items"][0]
    assert (newest["kind"], newest["label"]) == ("checkpoint", "Before restore")
    checkpoint = _version_detail(api, newest["id"])
    assert checkpoint["contentHash"] == changed["contentHash"]
    assert checkpoint["document"] == changed["document"]
    assert _live_structure(api.db) == live_before

    stale = api.client.post(
        f"/api/sandbox/versions/{published['id']}/restorations",
        json={"expectedRevision": changed["revision"]},
    )

    assert stale.status_code == 409, stale.text
    assert stale.json()["detail"]["code"] == "stale_revision"
    unchanged = _draft(api)
    assert unchanged["revision"] == restored["revision"]
    assert unchanged["contentHash"] == restored["contentHash"]
    assert _live_structure(api.db) == live_before


def test_restoring_an_earlier_published_version_then_publishing_matches_it_live(
    api: Api,
) -> None:
    original = _published_versions(api)[0]
    later = _draft(api)["document"]
    _module(later, "sample-requests")["fields"].append(_notes_field())
    _publish_draft(api, later)
    notes_key = _field_key("sample-requests", NOTES_FIELD)
    notes = bound_field(api.db, "field", f"sample-requests:{NOTES_FIELD}")
    assert notes.is_deleted is False

    restored = api.client.post(
        f"/api/sandbox/versions/{original['id']}/restorations",
        json={"expectedRevision": _draft(api)["revision"]},
    )
    assert restored.status_code == 201, restored.text
    preview = _preview(api)

    assert preview["blockers"] == []
    assert ("field", "close", notes_key) in _changes(preview)
    published = _publish(api, preview)

    assert published.status_code == 201, published.text
    body = published.json()
    assert body["version"]["kind"] == "published"
    assert published.headers["Location"] == f"/api/sandbox/versions/{body['version']['id']}"
    _refresh(api.db)
    assert notes.is_deleted is True
    module = bound_module(api.db, "sample-requests")
    active = set(
        api.db.scalars(
            # Relationship fields are listed under the document's relationships, not fields.
            select(Field.name).where(
                Field.module_id == module.id,
                Field.is_deleted.is_(False),
                Field.type != FieldType.RELATIONSHIP,
            )
        )
    )
    original_document = _version_detail(api, original["id"])["document"]
    expected = {item["name"] for item in _module(original_document, "sample-requests")["fields"]}
    assert active == expected
    assert "Notes" not in active
    assert _draft(api)["latestPublishedVersion"]["id"] == body["version"]["id"]


def test_member_is_forbidden_from_publication_preview_and_publish(api: Api) -> None:
    member, _membership = create_member(api.db, organization(api.db),
        email="design-lifecycle-member@example.test",
        username="design-lifecycle-member",
        status=UserStatus.ACTIVE.value,
        role=UserRole.MEMBER.value,
    )
    api.db.add(member)
    api.db.flush()
    member_identity = _identity(api.db, member)
    api.db.commit()
    admin_preview = _preview(api)
    live_before = _live_structure(api.db)
    publications_before = _publication_count(api.db)
    api.identity = member_identity

    preview = api.client.post(
        "/api/sandbox/publication-previews",
        json={"expectedRevision": admin_preview["documentRevision"]},
    )
    publish = _publish(api, admin_preview)

    # Source raises HTTPException(403, "Forbidden") with no machine code.
    assert preview.status_code == 403, preview.text
    assert preview.json()["detail"] == "Forbidden"
    assert publish.status_code == 403, publish.text
    assert publish.json()["detail"] == "Forbidden"
    assert api.password_checks == []
    assert _publication_count(api.db) == publications_before
    assert _live_structure(api.db) == live_before


def test_closing_then_reopening_a_module_without_records_restores_its_structure(
    api: Api,
) -> None:
    module = bound_module(api.db, "sample-equipment")
    relationship = bound_field(api.db, "relationship", "sample-uses")
    field_ids = _active_field_ids(api.db, module.id)
    assert field_ids
    assert api.db.scalar(select(func.count()).where(Record.module_id == module.id)) == 0

    closing = _draft(api)["document"]
    _module(closing, "sample-equipment")["closed"] = True
    closed_preview = _publish_draft(api, closing)

    assert ("module", "close", "sample-equipment") in _changes(closed_preview)
    _refresh(api.db)
    assert module.is_deleted is True
    assert _active_field_ids(api.db, module.id) == set()
    assert relationship.is_deleted is True

    reopening = _draft(api)["document"]
    _module(reopening, "sample-equipment")["closed"] = False
    reopened_preview = _publish_draft(api, reopening)

    assert ("module", "reopen", "sample-equipment") in _changes(reopened_preview)
    _refresh(api.db)
    assert module.is_deleted is False
    assert module.deleted_at is None
    assert _active_field_ids(api.db, module.id) == field_ids
    assert bound_field(api.db, "relationship", "sample-uses").id == relationship.id
    assert relationship.is_deleted is False
    assert bound_module(api.db, "sample-equipment").id == module.id


def test_closing_a_module_with_active_records_is_blocked_and_changes_nothing(
    api: Api,
) -> None:
    module = bound_module(api.db, "sample-customers")
    customer_id = bound_field(
        api.db, "field", "sample-customers:sample-field-customers-customer-id"
    )
    record = Record(module_id=module.id, data={str(customer_id.id): "CUS-1"})
    api.db.add(record)
    api.db.flush()
    api.db.commit()
    closing = _draft(api)["document"]
    _module(closing, "sample-customers")["closed"] = True
    _save(api, closing)
    live_before = _live_structure(api.db)
    publications_before = _publication_count(api.db)
    published_before = len(_published_versions(api))

    preview = _preview(api)

    assert ("close_has_live_dependencies", "sample-customers") in {
        (item["code"], item["targetId"]) for item in preview["blockers"]
    }
    response = _publish(api, preview)

    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "publication_blocked"
    assert _live_structure(api.db) == live_before
    assert _publication_count(api.db) == publications_before
    assert len(_published_versions(api)) == published_before
    _refresh(api.db)
    assert module.is_deleted is False
    assert record.is_deleted is False


def _identity(db: Session, user: User) -> CurrentIdentity:
    session = IdentitySession(
        user_id=user.id,
        refresh_token_digest=sha256(f"refresh-{uuid7()}".encode()).hexdigest(),
        csrf_token_digest=sha256(f"csrf-{uuid7()}".encode()).hexdigest(),
        expires_at=datetime.now(UTC) + timedelta(hours=1),
    )
    db.add(session)
    db.flush()
    return CurrentIdentity(user, session.id, False, False)


def _ok(response: Response, status: int = 200) -> dict[str, Any]:
    assert response.status_code == status, response.text
    body: dict[str, Any] = response.json()
    return body


def _draft(api: Api) -> dict[str, Any]:
    return _ok(api.client.get("/api/sandbox/document"))


def _save(api: Api, document: dict[str, Any]) -> dict[str, Any]:
    revision = _draft(api)["revision"]
    return _ok(
        api.client.put(
            "/api/sandbox/document",
            json={"expectedRevision": revision, "document": document},
        )
    )


def _versions(api: Api) -> dict[str, Any]:
    return _ok(api.client.get("/api/sandbox/versions", params={"limit": 100}))


def _published_versions(api: Api) -> list[dict[str, Any]]:
    items = [item for item in _versions(api)["items"] if item["kind"] == "published"]
    return sorted(items, key=lambda item: item["sequence"])


def _version_detail(api: Api, version_id: str) -> dict[str, Any]:
    return _ok(api.client.get(f"/api/sandbox/versions/{version_id}"))


def _preview(api: Api) -> dict[str, Any]:
    revision = _draft(api)["revision"]
    return _ok(
        api.client.post("/api/sandbox/publication-previews", json={"expectedRevision": revision})
    )


def _publish(api: Api, preview: dict[str, Any]) -> Response:
    return api.client.post(
        "/api/sandbox/publications",
        headers={"Idempotency-Key": f"design-lifecycle-{uuid7()}"},
        json={
            "expectedRevision": preview["documentRevision"],
            "previewToken": preview["previewToken"],
            "impactDigest": preview["impactDigest"],
            "password": PASSWORD,
        },
    )


def _publish_draft(api: Api, document: dict[str, Any]) -> dict[str, Any]:
    _save(api, document)
    preview = _preview(api)
    assert preview["blockers"] == []
    _ok(_publish(api, preview), 201)
    return preview


def _changes(preview: dict[str, Any]) -> set[tuple[str, str, str]]:
    return {(item["kind"], item["action"], item["sandboxId"]) for item in preview["changes"]}


def _module(document: dict[str, Any], module_id: str) -> dict[str, Any]:
    module: dict[str, Any] = next(
        item for item in document["design"]["modules"] if item["id"] == module_id
    )
    return module


def _notes_field() -> dict[str, Any]:
    return {
        "id": NOTES_FIELD,
        "name": "Notes",
        "type": "Text",
        "required": False,
        "closed": False,
        "config": {"kind": "text", "defaultValue": ""},
    }


def _refresh(db: Session) -> None:
    db.expire_all()


def _live_structure(db: Session) -> tuple[list[tuple[Any, ...]], ...]:
    db.expire_all()
    departments = db.execute(
        select(Department.id, Department.department_name, Department.is_deleted).order_by(
            Department.id
        )
    ).all()
    modules = db.execute(
        select(Module.id, Module.module_name, Module.is_deleted).order_by(Module.id)
    ).all()
    fields = db.execute(
        select(Field.id, Field.name, Field.is_deleted, Field.position).order_by(Field.id)
    ).all()
    return tuple([tuple(row) for row in rows] for rows in (departments, modules, fields))


def _active_field_ids(db: Session, module_id: UUID) -> set[UUID]:
    return set(
        db.scalars(
            select(Field.id).where(Field.module_id == module_id, Field.is_deleted.is_(False))
        )
    )


def _publication_count(db: Session) -> int:
    return int(db.scalar(select(func.count()).select_from(SandboxPublication)) or 0)
