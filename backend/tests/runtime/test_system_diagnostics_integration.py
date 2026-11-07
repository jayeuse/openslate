"""S6-C2 to S6-C4: the installation owner's and an organization admin's support files, and
nobody else's (PostgreSQL)."""

import re
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database.organization_scope import scope_session
from app.core.database.session import get_db
from app.main import create_app
from app.systems.access.users.models import Membership, User
from app.systems.manage.audit.models import AuditLog, SecurityEvent
from app.systems.manage.health import history, service
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.platform.files.models import File
from tests.conftest import create_member, make_operator
from tests.organization_scope_support import scoped_override
from tests.runtime.health_support import (
    add_sample,
    add_server_error,
    clear_samples,
    committed_organization,
    owner_engine,
    remove_organizations,
    remove_server_errors,
)

pytestmark = pytest.mark.integration

READY = {
    "status": "ready",
    "components": {
        name: {"status": "ready", "required": True}
        for name in ("database", "auth", "storage", "smtp")
    },
}
INSTALLATION = "/api/system/diagnostics/installation"
ORGANIZATION = "/api/system/diagnostics/organization"


def _committed_admin(org_id: UUID) -> UUID:
    user_id = uuid7()
    with owner_engine().begin() as connection:
        connection.execute(User.__table__.insert().values(
            id=user_id, email=f"support-{user_id}@example.test", username=f"support-{user_id}",
            status="active",
        ))
        connection.execute(Membership.__table__.insert().values(
            id=uuid7(), org_id=org_id, user_id=user_id, role="admin", status="active",
        ))
    return user_id


def _committed_file(org_id: UUID, creator: UUID, size: int) -> None:
    with owner_engine().begin() as connection:
        connection.execute(File.__table__.insert().values(
            id=uuid7(), org_id=org_id, purpose="workspace_logo", creator_id=creator,
            filename="logo.png", expected_size=size, actual_size=size, digest="d" * 64,
            object_key=uuid4().hex, state="ready", is_deleted=False,
        ))


@pytest.fixture
def committed():
    """Two committed organizations with files and server errors, plus samples.

    Requested before ``integration_db``, so it is removed after the test transaction, which
    holds key locks on these accounts, has ended.
    """

    clear_samples()
    first, second = committed_organization("support-a"), committed_organization("support-b")
    owner_id, admin_id = _committed_admin(first), _committed_admin(first)
    _committed_file(first, owner_id, 100)
    _committed_file(second, owner_id, 250)
    now = datetime.now(UTC)
    errors = {
        "first_old": (first, now - timedelta(hours=2)),
        "first_new": (first, now - timedelta(hours=1)),
        "second": (second, now - timedelta(minutes=30)),
        "none": (None, now - timedelta(minutes=20)),
    }
    ids = {name: uuid7() for name in errors}
    for name, (org_id, moment) in errors.items():
        add_server_error(ids[name], org_id=org_id, occurred_at=moment)
    minute = now.replace(second=0, microsecond=0)
    add_sample(minute - timedelta(minutes=2), database_bytes=4096)
    add_sample(minute - timedelta(minutes=1), files_status="not_working", files_ms=2000)
    try:
        yield {"first": first, "second": second, "errors": ids, "owner_id": owner_id,
               "admin_id": admin_id, "now": now}
    finally:
        remove_server_errors(*ids.values())
        clear_samples()
        remove_organizations(first, second)
        with owner_engine().begin() as connection:
            connection.execute(text("DELETE FROM public.users WHERE id = ANY(:ids)"),
                               {"ids": [owner_id, admin_id]})


@pytest.fixture
def world(committed, integration_db: Session, monkeypatch):
    monkeypatch.setattr(service, "_cached", None)
    monkeypatch.setattr(service, "get_readiness_snapshot", lambda: READY)
    monkeypatch.setattr(history, "_cached", None)
    db = integration_db
    owner = db.get(User, committed["owner_id"])
    make_operator(db, owner)
    organization = db.get(WorkspaceProfile, committed["first"])
    member, _ = create_member(db, organization, "member")
    guest, _ = create_member(
        db, organization, "guest", sponsor_user_id=committed["admin_id"],
        expires_at=committed["now"] + timedelta(days=7),
    )
    db.commit()
    return db, {
        **committed,
        "people": {"owner": owner, "admin": db.get(User, committed["admin_id"]),
                   "member": member, "guest": guest},
    }


def _client(db: Session, actor: User | None) -> TestClient:
    application = create_app()
    if actor is not None:
        application.dependency_overrides[get_db] = lambda: db
        application.dependency_overrides[get_current_user] = scoped_override(lambda: actor)
    return TestClient(application)


def _written(db: Session, org_id: UUID) -> tuple[int, int]:
    scope_session(db, org_id)
    return (
        db.scalar(select(func.count()).select_from(AuditLog)) or 0,
        db.scalar(select(func.count()).select_from(SecurityEvent)) or 0,
    )


def _attachment(response, kind: str) -> None:
    assert response.headers["Cache-Control"] == "no-store"
    assert re.fullmatch(
        rf'attachment; filename="slateops-diagnostics-{kind}-\d{{8}}-\d{{4}}Z\.json"',
        response.headers["Content-Disposition"],
    )


def test_s6_c2_i17_the_installation_owner_downloads_the_whole_installation(world):
    db, facts = world
    errors = facts["errors"]
    before = _written(db, facts["first"])

    response = _client(db, facts["people"]["owner"]).get(INSTALLATION)

    assert response.status_code == 200, response.text
    _attachment(response, "installation")
    body = response.json()
    assert list(body) == [
        "summary", "versions", "database", "workers", "organizations", "samples", "periods",
        "server_errors",
    ]
    assert body["summary"]["kind"] == "installation"
    assert body["versions"]["application"] == "0.1.0"
    assert body["versions"]["schema_revision"] == "4d8efe5fde6f"
    assert body["versions"]["postgresql"]
    assert body["database"]["bytes"] == 4096
    assert [worker["key"] for worker in body["workers"]] == [
        "record_triggers", "report_scheduling", "comms_jobs", "provider_signout", "backup_runner",
    ]
    totals = {row["org_id"]: row["storage_used_bytes"] for row in body["organizations"]}
    assert (totals[str(facts["first"])], totals[str(facts["second"])]) == (100, 250)
    assert body["samples"]["columns"] == [
        "sampled_at", "data_status", "data_ms", "signing_in_status", "signing_in_ms",
        "files_status", "files_ms", "email_status",
    ]
    assert len(body["samples"]["rows"]) == 2
    assert body["periods"][0]["part"] == "files"
    mine = {UUID(item["request_id"]): item for item in body["server_errors"]["items"]
            if UUID(item["request_id"]) in set(errors.values())}
    assert {request_id: mine[request_id]["org_id"] for request_id in mine} == {
        errors["first_old"]: str(facts["first"]),
        errors["first_new"]: str(facts["first"]),
        errors["second"]: str(facts["second"]),
        errors["none"]: None,
    }
    assert body["server_errors"]["total_30d"] >= 4
    # No audit row or security event for the download (J2 A).
    assert _written(db, facts["first"]) == before


def test_s6_c3_i18_an_admin_downloads_only_their_organization(world):
    db, facts = world
    errors = facts["errors"]
    before = _written(db, facts["first"])

    response = _client(db, facts["people"]["admin"]).get(ORGANIZATION)

    assert response.status_code == 200, response.text
    _attachment(response, "organization")
    body = response.json()
    assert list(body) == ["summary", "versions", "periods", "storage", "server_errors"]
    assert body["versions"] == {"application": "0.1.0"}
    assert body["storage"] == {"used_bytes": 100}
    assert body["summary"]["storage_used_bytes"] == 100
    items = body["server_errors"]["items"]
    assert (body["server_errors"]["total_30d"], body["server_errors"]["truncated"]) == (2, False)
    assert [UUID(item["request_id"]) for item in items] == [
        errors["first_new"], errors["first_old"],
    ]
    assert all(set(item) == {"request_id", "occurred_at", "status", "method", "route"}
               for item in items)
    for installation_only in (str(facts["second"]), "database", "workers", "samples", "4096"):
        assert installation_only not in response.text
    assert _written(db, facts["first"]) == before


def test_s6_c4_i19_members_guests_and_plain_admins_cannot_download(world):
    db, facts = world
    people = facts["people"]

    statuses = {
        (role, path): _client(db, people[role]).get(path).status_code
        for role in ("member", "guest", "admin")
        for path in (INSTALLATION, ORGANIZATION)
        if not (role == "admin" and path == ORGANIZATION)
    }
    signed_out = {path: _client(db, None).get(path).status_code
                  for path in (INSTALLATION, ORGANIZATION)}

    assert statuses == {
        ("member", INSTALLATION): 403, ("member", ORGANIZATION): 403,
        ("guest", INSTALLATION): 403, ("guest", ORGANIZATION): 403,
        ("admin", INSTALLATION): 403,
    }
    assert signed_out == {INSTALLATION: 401, ORGANIZATION: 401}
