"""CSV batches cross real HTTP, published fields, policy, audit, and PostgreSQL."""

import importlib
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.main import app as application
from app.systems.access.policy.models import GroupAccess
from app.systems.access.users.models import User, UserRole
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.record_triggers.models import RecordTriggerEvent
from app.systems.sandbox.records.models import Record
from tests.rbac.support import add_department, add_module, add_user, make_group_access

pytestmark = pytest.mark.integration


@dataclass
class _World:
    db: Session
    module: Module
    fields: dict[str, Field]
    admin: User
    reader: User
    outsider: User
    guest: User
    grant: GroupAccess
    actor: list[User]
    client: TestClient
    option_id: str

    def payload(self, *, mode: str = "preview") -> dict[str, Any]:
        return {
            "mode": mode,
            "module_id": str(self.module.id),
            "headers": ["Title", "Quantity", "Owner"],
            "mapping": [
                {"column_index": index, "field_id": str(self.fields[name].id)}
                for index, name in enumerate(("title", "int", "user"))
            ],
            "rows": [
                {"row_number": 2, "cells": ["  retained title  ", "12", str(self.reader.id)]},
                {"row_number": 8, "cells": ["invalid", "1.5", str(self.reader.id)]},
                {"row_number": 3, "cells": ["", "2", ""]},
            ],
            "defaults": {str(self.fields["default"].id): "request default"},
        }

    def count(self, model: type[Record] | type[RecordTriggerEvent]) -> int:
        return int(
            self.db.scalar(
                select(func.count()).select_from(model).where(model.module_id == self.module.id)
            )
            or 0
        )


@pytest.fixture
def world(integration_owner_db: Session) -> Iterator[_World]:
    db = integration_owner_db
    department = add_department(db)
    module = add_module(db, department)
    admin = add_user(db, "import-admin", role=UserRole.ADMIN)
    reader = add_user(db, "import-reader")
    outsider = add_user(db, "import-outsider")
    guest = add_user(db, "import-guest", role=UserRole.GUEST)
    grant = make_group_access(db, [reader], department, module)
    option_id = str(uuid7())
    definitions = [
        ("title", FieldType.TEXT, True, {}),
        ("int", FieldType.INTEGER, False, {}),
        ("user", FieldType.USER, False, {}),
        ("default", FieldType.TEXT, False, {"defaultValue": "published default"}),
        ("boolean", FieldType.BOOLEAN, True, {"defaultValue": True}),
        ("number", FieldType.NUMBER, False, {}),
        ("decimal", FieldType.DECIMAL, False, {}),
        ("date", FieldType.DATE, False, {}),
        ("datetime", FieldType.DATETIME, False, {}),
        ("select", FieldType.SELECT, False, {"options": [{"id": option_id, "label": "Open"}]}),
        ("long", FieldType.LONG_TEXT, False, {}),
        ("email", FieldType.EMAIL, False, {}),
        ("url", FieldType.URL, False, {}),
    ]
    fields = {}
    for position, (name, field_type, required, config) in enumerate(definitions):
        field = Field(
            module_id=module.id,
            name=name,
            type=field_type,
            required=required,
            position=position,
            config=config,
        )
        db.add(field)
        fields[name] = field
    db.commit()
    db.info[AUDIT_CONTEXT_KEY] = AuditContext(
        performed_by=admin.id,
        request_id=uuid7(),
        request_method="POST",
        request_path="/api/records/import",
    )
    app = FastAPI()
    # Exercise the registered production route without starting unrelated workers.
    app.include_router(application.router)
    actor = [admin]
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor[0]
    client = TestClient(app)
    try:
        yield _World(
            db, module, fields, admin, reader, outsider, guest, grant, actor, client, option_id
        )
    finally:
        client.close()


def _preview(world: _World, payload: dict[str, Any]) -> dict[str, Any]:
    response = world.client.post("/api/records/import", json=payload)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    return response.json()


def test_import_preview_then_mixed_batch_creates_audited_records_and_events(world: _World) -> None:
    payload = world.payload()
    before_audit = world.db.scalar(select(func.count()).select_from(AuditLog))
    preview = _preview(world, payload)
    assert [row["row_number"] for row in preview["rows"]] == [2, 8, 3]
    assert [row["status"] for row in preview["rows"]] == ["valid", "invalid", "invalid"]
    assert (preview["valid_count"], preview["invalid_count"], preview["created_count"]) == (1, 2, 0)
    assert all(row["record_id"] is None for row in preview["rows"])
    normalized = preview["rows"][0]["data"]
    assert normalized[str(world.fields["title"].id)] == "  retained title  "
    assert normalized[str(world.fields["int"].id)] == 12
    assert normalized[str(world.fields["default"].id)] == "request default"
    assert normalized[str(world.fields["boolean"].id)] is True
    error = preview["rows"][1]["errors"][0]
    assert error["field_id"] == str(world.fields["int"].id)
    assert error["column_index"] == 1
    assert world.count(Record) == world.count(RecordTriggerEvent) == 0
    assert world.db.scalar(select(func.count()).select_from(AuditLog)) == before_audit

    payload.update(mode="import", schema_digest=preview["schema_digest"])
    imported = _preview(world, payload)
    assert (imported["valid_count"], imported["invalid_count"], imported["created_count"]) == (
        1,
        2,
        1,
    )
    assert [row["status"] for row in imported["rows"]] == ["created", "invalid", "invalid"]
    record_id = UUID(imported["rows"][0]["record_id"])
    record = world.db.get(Record, record_id)
    assert record is not None and record.data == normalized
    assert record.performed_by == world.admin.id
    audit = world.db.scalars(
        select(AuditLog).where(
            AuditLog.entity_id == record_id, AuditLog.action == AuditAction.CREATE
        )
    ).all()
    assert len(audit) == 1 and audit[0].performed_by == world.admin.id
    assert audit[0].request_path == "/api/records/import"
    events = world.db.scalars(
        select(RecordTriggerEvent).where(RecordTriggerEvent.module_id == world.module.id)
    ).all()
    assert len(events) == 1
    assert events[0].record_id == record_id
    assert events[0].event_kind == "record-created" and events[0].values == normalized


def test_import_converts_every_primitive_and_preserves_mapped_blanks(world: _World) -> None:
    payload = world.payload()
    names = [
        "title",
        "int",
        "user",
        "boolean",
        "number",
        "decimal",
        "date",
        "datetime",
        "select",
        "long",
        "email",
        "url",
        "default",
    ]
    payload["headers"] = names
    payload["mapping"] = [
        {"column_index": i, "field_id": str(world.fields[name].id)} for i, name in enumerate(names)
    ]
    payload["defaults"] = {}
    valid = [
        "' =formula",
        "-21",
        str(world.reader.id).upper(),
        " FaLsE ",
        "1e2",
        "1.2300",
        "2026-10-03",
        "2026-10-03T12:30:00+08:00",
        "Open",
        "  long\ntext  ",
        "name@example.test",
        "https://example.test/path",
        "",
    ]
    blanks = ["blank fields", "", "", "true", "", "", "", "", "", "", "", "", ""]
    payload["rows"] = [{"row_number": 2, "cells": valid}, {"row_number": 3, "cells": blanks}]
    preview = _preview(world, payload)
    assert preview["invalid_count"] == 0
    first = preview["rows"][0]["data"]
    expected = [
        "' =formula",
        -21,
        str(world.reader.id),
        False,
        100.0,
        "1.23",
        "2026-10-03",
        "2026-10-03T12:30:00+08:00",
        world.option_id,
        "  long\ntext  ",
        "name@example.test",
        "https://example.test/path",
        "",
    ]
    assert first == {
        str(world.fields[name].id): value for name, value in zip(names, expected, strict=True)
    }
    blank_data = preview["rows"][1]["data"]
    assert blank_data[str(world.fields["default"].id)] == ""
    assert blank_data[str(world.fields["int"].id)] is None
    assert blank_data[str(world.fields["select"].id)] is None
    payload.update(mode="import", schema_digest=preview["schema_digest"])
    assert _preview(world, payload)["created_count"] == 2


def test_import_reports_malformed_cells_and_current_record_constraints(world: _World) -> None:
    payload = world.payload()
    names = [
        "title",
        "int",
        "user",
        "boolean",
        "number",
        "decimal",
        "date",
        "datetime",
        "select",
        "email",
        "url",
    ]
    payload["headers"] = names
    payload["mapping"] = [
        {"column_index": i, "field_id": str(world.fields[name].id)} for i, name in enumerate(names)
    ]
    base = [
        "good",
        "2",
        str(world.reader.id),
        "true",
        "2.5",
        "1.2",
        "2026-10-03",
        "2026-10-03T12:30Z",
        world.option_id,
        "name@example.test",
        "https://example.test",
    ]
    invalids = [
        (0, ""),
        (1, "2.1"),
        (2, "Alex Reader"),
        (2, str(world.outsider.id)),
        (3, "yes"),
        (4, "NaN"),
        (4, "Infinity"),
        (5, "1e2"),
        (6, "10/03/2026"),
        (7, "yesterday"),
        (8, "Unknown"),
        (9, "private bad email"),
        (10, "ftp://bad"),
    ]
    rows = []
    for number, (index, value) in enumerate(invalids, 2):
        cells = list(base)
        cells[index] = value
        rows.append({"row_number": number, "cells": cells})
    payload["rows"] = rows
    preview = _preview(world, payload)
    assert preview["invalid_count"] == len(invalids) and preview["valid_count"] == 0
    assert all(row["errors"] and len(row["errors"]) <= 20 for row in preview["rows"])
    assert all(
        row["errors"][0]["column_index"] == invalids[i][0] for i, row in enumerate(preview["rows"])
    )
    assert "private bad email" not in str(preview["rows"])
    payload.update(mode="import", schema_digest=preview["schema_digest"])
    assert _preview(world, payload)["created_count"] == 0
    assert world.count(Record) == world.count(RecordTriggerEvent) == 0


def test_import_rejects_invalid_batch_shape_without_writes(world: _World) -> None:
    """One HTTP case; test_record_import_rules.py owns every batch shape rule."""

    payload = world.payload()
    payload["mode"] = "import"
    response = world.client.post("/api/records/import", json=payload)
    assert response.status_code == 422
    assert world.count(Record) == world.count(RecordTriggerEvent) == 0


@pytest.mark.parametrize("target", ["unknown", "foreign", "closed", "relationship"])
@pytest.mark.parametrize("placement", ["mapping", "defaults"])
def test_import_rejects_unavailable_fields(world: _World, target: str, placement: str) -> None:
    module_id = world.module.id
    if target == "unknown":
        field_id = uuid7()
    else:
        field = world.fields["default"]
        if target == "foreign":
            field.module_id = add_module(world.db, add_department(world.db)).id
        elif target == "closed":
            field.is_deleted = True
        else:
            field.type = FieldType.RELATIONSHIP
            field.config = {}
            field.relationship_target_module_id = module_id
            field.relationship_multiple_targets = True
            field.relationship_multiple_sources = True
        world.db.commit()
        field_id = field.id
    payload = world.payload()
    payload["defaults"] = {}
    if placement == "mapping":
        payload["mapping"][0]["field_id"] = str(field_id)
    else:
        payload["defaults"] = {str(field_id): "not allowed"}
    response = world.client.post("/api/records/import", json=payload)
    assert response.status_code == 422
    assert world.count(Record) == 0


def test_import_rejects_schema_changes_in_unmapped_fields_before_writes(world: _World) -> None:
    for attribute, value in [
        ("name", "Renamed"),
        ("required", True),
        ("config", {"defaultValue": "new default"}),
        ("type", FieldType.LONG_TEXT),
        ("is_deleted", True),
    ]:
        payload = world.payload()
        payload["defaults"] = {}
        digest = _preview(world, payload)["schema_digest"]
        setattr(world.fields["default"], attribute, value)
        world.db.commit()
        payload.update(mode="import", schema_digest=digest)
        response = world.client.post("/api/records/import", json=payload)
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "schema_changed"
        assert world.count(Record) == world.count(RecordTriggerEvent) == 0


def test_import_rechecks_user_eligibility_and_typed_defaults(world: _World) -> None:
    payload = world.payload()
    payload["mapping"] = payload["mapping"][:2]
    payload["defaults"][str(world.fields["user"].id)] = str(world.reader.id)
    payload["rows"] = payload["rows"][:1]
    preview = _preview(world, payload)
    assert preview["valid_count"] == 1
    world.grant.is_deleted = True
    world.db.commit()
    payload.update(mode="import", schema_digest=preview["schema_digest"])
    response = _preview(world, payload)
    assert response["invalid_count"] == 1 and response["created_count"] == 0
    assert response["rows"][0]["errors"][0]["column_index"] is None
    assert world.count(Record) == 0


def test_import_rejects_ambiguous_select_label(world: _World) -> None:
    world.fields["select"].config = {
        "options": [{"id": world.option_id, "label": "Open"}, {"id": str(uuid7()), "label": "Open"}]
    }
    world.db.commit()
    payload = world.payload()
    payload["mapping"][1]["field_id"] = str(world.fields["select"].id)
    payload["rows"] = [{"row_number": 2, "cells": ["valid title", "Open", ""]}]
    preview = _preview(world, payload)
    assert preview["invalid_count"] == 1
    assert preview["rows"][0]["errors"][0]["code"] == "ambiguous_select"
    assert world.count(Record) == 0


@pytest.mark.parametrize("role", ["member", "guest"])
@pytest.mark.parametrize("mode", ["preview", "import"])
def test_import_is_administrator_only(world: _World, role: str, mode: str) -> None:
    world.actor[:] = [world.reader if role == "member" else world.guest]
    payload = world.payload(mode=mode)
    payload["schema_digest"] = "0" * 64
    assert world.client.post("/api/records/import", json=payload).status_code == 403
    assert world.count(Record) == 0


def test_import_closed_module_and_missing_identity_do_not_write(world: _World) -> None:
    world.module.is_deleted = True
    world.db.commit()
    assert world.client.post("/api/records/import", json=world.payload()).status_code == 409
    world.client.app.dependency_overrides.pop(get_current_user)
    assert world.client.post("/api/records/import", json=world.payload()).status_code == 401
    assert world.count(Record) == 0


def test_import_real_persistence_failure_rolls_back_records_audit_and_events(
    world: _World,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = importlib.import_module("app.systems.sandbox.records.importing")
    original = service.enqueue_record_event
    calls = 0

    def reject_second_event(db: Session, record: Record, *, previous: None) -> None:
        nonlocal calls
        calls += 1
        original(db, record, previous=previous)
        if calls == 2:
            for pending in db.new:
                if isinstance(pending, RecordTriggerEvent):
                    pending.depth = -1  # Real PostgreSQL CHECK failure during commit.

    payload = world.payload()
    payload["rows"] = [{"row_number": i, "cells": [f"valid {i}", "1", ""]} for i in (2, 3)]
    payload.update(mode="import", schema_digest=_preview(world, payload)["schema_digest"])
    before_audit = world.db.scalar(select(func.count()).select_from(AuditLog))
    monkeypatch.setattr(service, "enqueue_record_event", reject_second_event)
    response = world.client.post("/api/records/import", json=payload)
    assert calls == 2 and response.status_code == 409
    assert response.json()["detail"]["code"] == "record_import_failed"
    assert "created_count" not in response.json()
    assert world.count(Record) == world.count(RecordTriggerEvent) == 0
    assert world.db.scalar(select(func.count()).select_from(AuditLog)) == before_audit
