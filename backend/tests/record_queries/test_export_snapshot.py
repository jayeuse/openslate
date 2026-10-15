import csv
import io
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import User
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records import export as exporter
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.query_schemas import ExportRequest
from tests.rbac.support import add_department, add_module, add_user
from tests.record_queries.support import request_for, setup_rows


@pytest.mark.integration
def test_export_resolves_select_and_active_user_ids_at_snapshot_time(query_db) -> None:
    engine = query_db.get_bind().engine
    with AuditSession(engine) as setup:
        department = add_department(setup)
        module = add_module(setup, department)
        actor = add_user(setup, "field-export-actor", role="admin")
        assignee = add_user(setup, "field-export-assignee", role="admin")
        assignee.display_name = "Avery Person"
        option_id = str(uuid7())
        select_field = Field(
            module_id=module.id,
            name="Status",
            type=FieldType.SELECT,
            position=0,
            required=False,
            config={"options": [{"id": option_id, "label": "Pending"}]},
        )
        user_field = Field(
            module_id=module.id,
            name="Assignee",
            type="user",
            position=1,
            required=False,
            config={},
        )
        setup.add_all((select_field, user_field))
        setup.flush()
        record = Record(
            module_id=module.id,
            data={str(select_field.id): option_id, str(user_field.id): str(assignee.id)},
        )
        setup.add(record)
        setup.commit()
        record_id, select_id, user_field_id = record.id, select_field.id, user_field.id
        module_id, department_id = module.id, department.id
        actor_id, assignee_id = actor.id, assignee.id

    payload = ExportRequest(
        module_id=module_id,
        include_record_id=True,
        definition={
            "columns": [
                {"field_id": select_id, "expected_type": "select"},
                {"field_id": user_field_id, "expected_type": "user"},
            ]
        },
    )
    try:
        first, count, _ = exporter.export_snapshot(engine, payload, reader_id=actor_id)
        assert count == 1
        assert list(csv.reader(io.StringIO(first.decode()))) == [
            ["Record ID", "Status", "Assignee"],
            [str(record_id), "Pending", "Avery Person"],
        ]
        with AuditSession(engine) as writer:
            field = writer.get(Field, select_id)
            assert field is not None
            field.config = {"options": [{"id": option_id, "label": "Awaiting review"}]}
            writer.commit()
        renamed, count, _ = exporter.export_snapshot(engine, payload, reader_id=actor_id)
        assert count == 1
        assert list(csv.reader(io.StringIO(renamed.decode())))[1] == [
            str(record_id),
            "Awaiting review",
            "Avery Person",
        ]
    finally:
        with AuditSession(engine) as cleanup:
            for model, ids in (
                (Record, [record_id]),
                (Field, [select_id, user_field_id]),
                (Module, [module_id]),
                (Department, [department_id]),
                (User, [actor_id, assignee_id]),
            ):
                for identifier in ids:
                    row = cleanup.get(model, identifier)
                    if row is not None:
                        cleanup.delete(row)
                cleanup.flush()
            cleanup.commit()


@pytest.mark.integration
def test_export_uses_one_real_repeatable_snapshot_and_ignores_page(query_db, monkeypatch):
    # The guard runs before acquiring a second independently committed connection.
    engine = query_db.get_bind().engine
    with AuditSession(engine) as setup:
        module, field, rows = setup_rows(setup, "text", ["original", "second"])
        reader_id = add_user(setup, "export-reader", role="admin").id
        setup.commit()
        module_id, field_id, department_id = module.id, field.id, module.department_id
        row_ids = [row.id for row in rows]
        payload = request_for(module, field)
        payload.limit = 1
        payload.offset = 1
        payload = ExportRequest(**payload.model_dump(), include_record_id=True)
    original_encoder = exporter.encode_csv

    def update_after_snapshot_started(rows, fields, timezone, locale, resolver, **options):
        with AuditSession(engine) as writer:
            record = writer.get(Record, row_ids[0])
            record.data = {str(field_id): "changed"}
            writer.commit()
        return original_encoder(rows, fields, timezone, locale, resolver, **options)

    monkeypatch.setattr(exporter, "encode_csv", update_after_snapshot_started)
    try:
        content, count, _ = exporter.export_snapshot(engine, payload, reader_id=reader_id)
        parsed = list(csv.reader(io.StringIO(content.decode())))
        assert count == 2
        assert [row[1] for row in parsed[1:]] == ["original", "second"]
        with Session(engine) as reader:
            assert reader.get(Record, row_ids[0]).data[str(field_id)] == "changed"
    finally:
        with AuditSession(engine) as cleanup:
            for model, ids in (
                (Record, row_ids),
                (Field, [field_id]),
                (Module, [module_id]),
                (Department, [department_id]),
                (User, [reader_id]),
            ):
                for identifier in ids:
                    cleanup.delete(cleanup.get(model, identifier))
                cleanup.flush()
            cleanup.commit()


@pytest.mark.integration
def test_registered_query_and_export_share_rows_and_commit_event(query_db):
    from fastapi.testclient import TestClient
    from sqlalchemy import select
    from uuid6 import uuid7

    from app.common.dependencies import CurrentIdentity, get_current_identity
    from app.core.database import get_db
    from app.systems.access.users.models import User
    from app.systems.manage.audit.models import SecurityEvent
    from tests.route_app_support import route_app

    app = route_app()

    engine = query_db.get_bind().engine
    actor_id = uuid7()
    with AuditSession(engine) as setup:
        role = "admin"
        assert role is not None
        actor = User(
            id=actor_id,
            email=f"p7-export-{actor_id}@example.com",
            username=f"p7_export_{actor_id.hex[:12]}",
            role=role,
            status="active",
        )
        setup.add(actor)
        setup.flush()
        identity_session = IdentitySession(
            user_id=actor_id,
            refresh_token_digest=uuid7().hex * 2,
            csrf_token_digest=uuid7().hex * 2,
            expires_at=datetime.now(UTC) + timedelta(days=1),
        )
        setup.add(identity_session)
        module, field, records = setup_rows(setup, "decimal", ["2", "10"])
        setup.commit()
        module_id, field_id, department_id = module.id, field.id, module.department_id
        session_id = identity_session.id
        row_ids = [record.id for record in records]
        payload = request_for(
            module,
            field,
            filters=[
                {"field_id": field.id, "expected_type": "decimal", "operator": "gt", "value": "2"}
            ],
        )
        _ = actor.role
        setup.expunge(actor)

    def database():
        with AuditSession(engine) as db:
            yield db

    app.dependency_overrides[get_current_identity] = lambda: CurrentIdentity(
        actor, session_id, False, False
    )
    app.dependency_overrides[get_db] = database
    try:
        with TestClient(app) as client:
            interactive = client.post("/api/records/query", json=payload.model_dump(mode="json"))
            exported = client.post(
                "/api/records/export",
                json={**payload.model_dump(mode="json"), "include_record_id": True},
            )
        assert interactive.status_code == exported.status_code == 200
        data = list(csv.reader(io.StringIO(exported.text)))
        assert [item["id"] for item in interactive.json()["items"]] == [row[0] for row in data[1:]]
        assert exported.headers["cache-control"] == "no-store"
        with Session(engine) as observer:
            event = observer.scalar(select(SecurityEvent).where(SecurityEvent.actor_id == actor_id))
            assert event is not None and event.event_type == "records.export.authorized"
            assert event.event_metadata["row_count"] == 1
            assert event.event_metadata["format"] == "csv"
    finally:
        app.dependency_overrides.pop(get_current_identity, None)
        app.dependency_overrides.pop(get_db, None)
        with AuditSession(engine) as cleanup:
            for model, ids in (
                (Record, row_ids),
                (Field, [field_id]),
                (Module, [module_id]),
                (Department, [department_id]),
            ):
                for identifier in ids:
                    cleanup.delete(cleanup.get(model, identifier))
                cleanup.flush()
            cleanup.delete(cleanup.get(IdentitySession, session_id))
            cleanup.flush()
            cleanup.delete(cleanup.get(User, actor_id))
            cleanup.flush()
            cleanup.commit()
