"""S4: any reader of a record lists its history with readable fields only; audit detail,
export, options and security events stay admin-only (PostgreSQL)."""

from datetime import UTC, datetime
from uuid import UUID

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database.organization_scope import ORGANIZATION_SCOPE_KEY, scope_session
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User, UserRole
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import append_security_event
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.records.models import Record
from tests.conftest import create_organization
from tests.rbac.support import _client, add_department, add_module, add_user, make_group_access

pytestmark = pytest.mark.integration


def _raw_audit(db: Session, **values: object) -> None:
    # Only the audit system adds audit rows through the ORM.
    db.connection().execute(AuditLog.__table__.insert().values(**values))


class World:
    def __init__(self, db: Session) -> None:
        from app.main import create_app

        self.db = db
        self.api = create_app()
        self.sales: Department = add_department(db)
        stock = add_department(db)
        module = add_module(db, self.sales)
        self.open, self.redacted, self.closed = (
            Field(org_id=module.org_id, module_id=module.id, name=name, type=FieldType.TEXT,
                  position=position, audit_redacted=position == 1)
            for position, name in enumerate(("Status", "Salary", "Retired note"))
        )
        db.add_all([self.open, self.redacted, self.closed])
        db.flush()
        self.record = Record(org_id=module.org_id, module_id=module.id, data={
            str(self.open.id): "new", str(self.redacted.id): "secret-1",
            str(self.closed.id): "old-note",
        })
        db.add(self.record)
        db.flush()
        self.closed.is_deleted = True
        self.closed.deleted_at = datetime.now(UTC)
        db.flush()
        for data in (
            {str(self.open.id): "open"},
            {str(self.redacted.id): "secret-2"},
            {str(self.open.id): "won", str(self.redacted.id): "secret-3"},
        ):
            self.record.data = {**self.record.data, **data}
            db.flush()
        self.record.is_deleted, self.record.deleted_at = True, datetime.now(UTC)
        db.flush()
        self.record.is_deleted, self.record.deleted_at = False, None
        db.flush()
        # Another entity type that happens to carry the record's ID.
        _raw_audit(db, org_id=module.org_id, action=AuditAction.CREATE, entity_type="files",
                   entity_id=self.record.id, after={"name": "other-entity"})
        self.admin = add_user(db, role=UserRole.ADMIN)
        self.manager = add_user(db)
        make_group_access(db, [self.manager], self.sales, level=AccessLevel.MANAGE)
        # Reads the record's module through a module row, and writes in another department.
        self.reader = add_user(db)
        make_group_access(db, [self.reader], self.sales, module, level=AccessLevel.READ)
        make_group_access(db, [self.reader], stock, level=AccessLevel.WRITE)
        self.outsider = add_user(db)

    def get(self, user: User, path: str = "/api/audit-logs", **params: object):
        return _client(self.api, user, self.db).get(path, params=params)


@pytest.fixture
def world(integration_db: Session) -> World:
    return World(integration_db)


def test_s4_c3_c4_a_reader_gets_readable_history_and_a_non_reader_an_empty_page(world: World):
    shown = world.get(world.reader, entity_id=str(world.record.id), limit=100)

    assert shown.status_code == 200, shown.text
    body = shown.json()
    assert body["pagination"]["total"] == len(body["items"]) == 5
    readable = str(world.open.id)
    history = [(item["action"], item["before"], item["after"]) for item in body["items"]]
    assert list(reversed(history)) == [
        ("create", None, {"data": {readable: "new"}}),
        ("update", {"data": {readable: "new"}}, {"data": {readable: "open"}}),
        ("update", {"data": {readable: "open"}}, {"data": {readable: "won"}}),
        ("delete", {"is_deleted": False}, {"is_deleted": True}),
        ("update", {"is_deleted": True}, {"is_deleted": False}),
    ]
    assert all(item["entity_type"] == "records" for item in body["items"])
    assert all(
        (item["request_method"], item["request_path"], item["note"]) == (None, None, None)
        for item in body["items"]
    )
    for hidden in (str(world.redacted.id), str(world.closed.id), "old-note", "other-entity"):
        assert hidden not in shown.text
    assert world.get(world.reader, entity_id=str(world.record.id),
                     entity_type="files").json()["pagination"]["total"] == 0
    # No probe of hidden values or paths: search and request-path sort are refused for a
    # reader whatever the value, while an admin still finds the closed field's old value.
    for probe in ({"search": "old-note"}, {"search": "zzz-no-such-value"},
                  {"sort_by": "request_path"}):
        refused = world.get(world.reader, entity_id=str(world.record.id), **probe)
        assert refused.status_code == 422, (probe, refused.text)
    assert world.get(world.admin, entity_id=str(world.record.id),
                     search="old-note").json()["pagination"]["total"] == 1

    real = world.get(world.outsider, entity_id=str(world.record.id))
    missing = world.get(world.outsider, entity_id=str(uuid7()))
    assert real.status_code == missing.status_code == 200
    assert real.json() == missing.json() == {
        "items": [],
        "pagination": {"limit": 25, "offset": 0, "count": 0, "total": 0, "has_more": False},
    }


def test_s4_c3_admin_and_manager_paths_keep_the_full_history(world: World):
    record = str(world.record.id)
    managed = world.get(world.manager, entity_id=record, department_id=str(world.sales.id))
    administered = world.get(world.admin, entity_id=record, limit=100)
    refused = world.get(world.reader, entity_id=record, department_id=str(world.sales.id))

    assert managed.status_code == administered.status_code == 200
    assert managed.json()["pagination"]["total"] == 6
    assert administered.json()["pagination"]["total"] == 7
    assert str(world.redacted.id) in managed.text and "old-note" in managed.text
    assert all(item["request_path"] == "/api/test" for item in managed.json()["items"])
    assert refused.status_code == 403
    assert world.get(world.reader).status_code == 403


@pytest.mark.parametrize(
    "path",
    ["/api/audit-logs/{entry}", "/api/audit-logs/export", "/api/audit-logs/options",
     "/api/security-events"],
)
def test_s4_c6_a_reader_stays_out_of_detail_export_options_and_security_events(
    world: World, path: str,
):
    entry = world.get(world.admin, entity_id=str(world.record.id)).json()["items"][0]["id"]

    response = world.get(world.reader, path.format(entry=entry), entity_id=str(world.record.id))

    assert response.status_code == 403


REFERENCED = UUID("019a0000-0000-7000-8000-1111deadbeef")
OTHER_ORGANIZATION = UUID("019a0000-0000-7000-8000-2222deadbeef")
UNRELATED = UUID("019a0000-0000-7000-8000-3333cafebabe")


def _referenced(world: World, request_id: UUID, org_id: UUID) -> None:
    _raw_audit(world.db, org_id=org_id, action=AuditAction.UPDATE, entity_type="records",
               entity_id=uuid7(), request_id=request_id)
    append_security_event(world.db, SecurityEventIngestRequest(
        event_type="workspace.policy_check", outcome="success", source="tests.reference",
        operation_id=uuid7(), request_id=request_id,
    ), org_id=org_id)
    world.db.flush()


def test_d7_c1_admins_find_audit_and_security_entries_by_the_reference(world: World):
    own = world.sales.org_id
    _referenced(world, REFERENCED, own)
    _referenced(world, UNRELATED, own)
    create_organization(world.db)
    _referenced(world, OTHER_ORGANIZATION, world.db.info[ORGANIZATION_SCOPE_KEY])
    scope_session(world.db, own)

    for path in ("/api/audit-logs", "/api/security-events"):
        for reference in ("deadbeef", "DEADBEEF", str(REFERENCED), str(REFERENCED).upper()):
            response = world.get(world.admin, path, reference=reference)
            assert response.status_code == 200, (path, reference, response.text)
            assert [item["request_id"] for item in response.json()["items"]] == [
                str(REFERENCED)
            ], (path, reference)
        for invalid in ("deadbee", "deadbeeg", REFERENCED.hex, f" {REFERENCED}"):
            assert world.get(world.admin, path, reference=invalid).status_code == 422, (
                path, invalid,
            )
