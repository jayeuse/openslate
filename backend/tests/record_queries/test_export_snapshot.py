import csv
import io

from record_queries.test_database import request_for, setup_rows
from sqlalchemy.orm import Session

from app.core.database.session import AuditSession
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records import export as exporter
from app.systems.sandbox.records.models import Record


def test_export_uses_one_real_repeatable_snapshot_and_ignores_page(query_db, monkeypatch):
    # The guard runs before acquiring a second independently committed connection.
    engine = query_db.get_bind().engine
    with AuditSession(engine) as setup:
        module, field, rows = setup_rows(setup, "text", ["original", "second"])
        setup.commit()
        module_id, field_id, department_id = module.id, field.id, module.department_id
        row_ids = [row.id for row in rows]
        payload = request_for(module, field)
        payload.limit = 1
        payload.offset = 1
    original_encoder = exporter.encode_csv

    def update_after_snapshot_started(rows, fields, timezone, locale):
        with AuditSession(engine) as writer:
            record = writer.get(Record, row_ids[0])
            record.data = {str(field_id): "changed"}
            writer.commit()
        return original_encoder(rows, fields, timezone, locale)

    monkeypatch.setattr(exporter, "encode_csv", update_after_snapshot_started)
    try:
        content, count = exporter.export_snapshot(engine, payload)
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
            ):
                for identifier in ids:
                    cleanup.delete(cleanup.get(model, identifier))
                cleanup.flush()
            cleanup.commit()


def test_registered_query_and_export_share_rows_and_commit_event(query_db):
    from fastapi.testclient import TestClient
    from sqlalchemy import select
    from uuid6 import uuid7

    from app.common.dependencies import get_current_user
    from app.core.database import get_db
    from app.main import app
    from app.systems.access.users.models import Role, User
    from app.systems.manage.audit.models import SecurityEvent

    engine = query_db.get_bind().engine
    actor_id = uuid7()
    with AuditSession(engine) as setup:
        role = setup.scalar(select(Role).where(Role.role == "admin"))
        assert role is not None
        actor = User(
            id=actor_id,
            email=f"p7-export-{actor_id}@example.com",
            username=f"p7_export_{actor_id.hex[:12]}",
            role_id=role.id,
            status="active",
        )
        setup.add(actor)
        module, field, records = setup_rows(setup, "decimal", ["2", "10"])
        setup.commit()
        module_id, field_id, department_id = module.id, field.id, module.department_id
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

    app.dependency_overrides[get_current_user] = lambda: actor
    app.dependency_overrides[get_db] = database
    try:
        with TestClient(app) as client:
            interactive = client.post("/api/records/query", json=payload.model_dump(mode="json"))
            exported = client.post("/api/records/export", json=payload.model_dump(mode="json"))
        assert interactive.status_code == exported.status_code == 200
        data = list(csv.reader(io.StringIO(exported.text)))
        assert [item["id"] for item in interactive.json()["items"]] == [row[0] for row in data[1:]]
        assert exported.headers["cache-control"] == "no-store"
        with Session(engine) as observer:
            event = observer.scalar(select(SecurityEvent).where(SecurityEvent.actor_id == actor_id))
            assert event is not None and event.event_type == "records.export.authorized"
            assert event.event_metadata == {"row_count": 1}
    finally:
        app.dependency_overrides.pop(get_current_user, None)
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
            cleanup.delete(cleanup.get(User, actor_id))
            cleanup.flush()
            cleanup.commit()
