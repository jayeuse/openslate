"""Private immutable Report runs on runner-owned, committed PostgreSQL data."""

import csv
import importlib
import io
import os
from collections.abc import Generator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from sqlalchemy import Engine, bindparam, func, select, text
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database import get_db
from app.core.database.session import AuditSession
from app.core.security.tokens import TokenType, create_token
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import Role, User, UserStatus
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.openview.reports.models import Report, ReportRun, ReportRunRow
from app.systems.openview.reports.router import router
from app.systems.openview.reports.schemas import ReportRecipe
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from tests.conftest import _guard_integration_database, guarded_create_engine

pytestmark = pytest.mark.integration


@dataclass
class _RunFixture:
    client: TestClient
    owner_engine: Engine
    runtime_engine: Engine
    owner_id: UUID
    owner_token: str
    outsider_token: str
    write_only_token: str
    report_id: UUID
    module_id: UUID
    note_field_id: UUID
    first_record_id: UUID

    def headers(self, token: str | None = None, *, key: UUID | None = None) -> dict[str, str]:
        values = {"Authorization": f"Bearer {token or self.owner_token}"}
        if key is not None:
            values["Idempotency-Key"] = str(key)
        return values


@pytest.fixture
def report_run_fixture() -> Generator[_RunFixture, None, None]:
    owner_url = os.environ["MIGRATION_DATABASE_URL"]
    runtime_url = os.environ["TEST_DATABASE_URL"]
    _guard_integration_database(owner_url)
    _guard_integration_database(runtime_url)
    owner_engine = guarded_create_engine(owner_url)
    runtime_engine = guarded_create_engine(runtime_url)
    owner_id, outsider_id, write_only_id = uuid7(), uuid7(), uuid7()
    actor_ids = (owner_id, outsider_id, write_only_id)
    role_ids = (uuid7(), uuid7(), uuid7())
    session_ids = (uuid7(), uuid7(), uuid7())
    department_id, module_id, report_id = uuid7(), uuid7(), uuid7()
    category_id, note_id, amount_id = uuid7(), uuid7(), uuid7()
    record_ids = (uuid7(), uuid7(), uuid7(), uuid7())
    all_ids = [
        *actor_ids,
        *role_ids,
        *session_ids,
        department_id,
        module_id,
        report_id,
        category_id,
        note_id,
        amount_id,
        *record_ids,
    ]
    client: TestClient | None = None
    try:
        with AuditSession(owner_engine) as setup:
            setup.info[AUDIT_CONTEXT_KEY] = AuditContext(
                request_id=uuid7(),
                request_method="POST",
                request_path="/api/reports/run-fixture",
            )
            roles = [
                Role(
                    id=role_id,
                    role=f"report-run-{role_id.hex}",
                    permissions=permissions,
                )
                for role_id, permissions in zip(
                    role_ids,
                    (
                        {"records.read": True, "records.write": True},
                        {"records.read": True, "records.write": True},
                        {"records.write": True},
                    ),
                    strict=True,
                )
            ]
            users = [
                User(
                    id=actor_id,
                    email=f"report-run-{actor_id.hex}@example.test",
                    username=f"report_run_{actor_id.hex[:16]}",
                    status=UserStatus.ACTIVE.value,
                    role=role,
                )
                for actor_id, role in zip(actor_ids, roles, strict=True)
            ]
            setup.add_all(users)
            setup.flush()
            for actor_id, session_id in zip(actor_ids, session_ids, strict=True):
                setup.add(
                    IdentitySession(
                        id=session_id,
                        user_id=actor_id,
                        refresh_token_digest=uuid7().hex * 2,
                        csrf_token_digest=uuid7().hex * 2,
                        expires_at=datetime.now(UTC) + timedelta(days=1),
                    )
                )
            setup.add(Department(id=department_id, department_name=f"Report run {uuid7().hex}"))
            setup.flush()
            setup.add(
                Module(
                    id=module_id,
                    department_id=department_id,
                    module_name=f"Report run {uuid7().hex}",
                    is_schema_accepted=True,
                )
            )
            setup.flush()
            fields = [
                Field(
                    id=field_id,
                    module_id=module_id,
                    name=name,
                    type=field_type,
                    required=False,
                    position=position,
                    config={},
                )
                for position, (field_id, name, field_type) in enumerate(
                    (
                        (category_id, "Category", FieldType.TEXT),
                        (note_id, "Note", FieldType.TEXT),
                        (amount_id, "Amount", FieldType.DECIMAL),
                    )
                )
            ]
            setup.add_all(fields)
            setup.flush()

            def reference(field: Field) -> dict[str, str]:
                return {
                    "field_id": str(field.id),
                    "expected_type": str(field.type),
                }

            recipe = ReportRecipe.model_validate(
                {
                    "fields": [reference(field) for field in fields],
                    "filters": [{**reference(fields[2]), "operator": "gt", "value": "1"}],
                    "sorts": [{**reference(fields[2]), "direction": "desc"}],
                    "group_by": reference(fields[0]),
                    "include_row_count": True,
                }
            )
            setup.add(
                Report(
                    id=report_id,
                    owner_id=owner_id,
                    module_id=module_id,
                    name="Operations snapshot",
                    recipe=recipe.model_dump(mode="json"),
                )
            )
            source_values = (
                ("Alpha", "=SUM(1,1)", "1.25"),
                ("Alpha", "ordinary", "9007199254740993"),
                ("Beta", "completed", "2.5"),
                ("Beta", "excluded", "0"),
            )
            setup.add_all(
                Record(
                    id=record_id,
                    module_id=module_id,
                    data={
                        str(category_id): category,
                        str(note_id): note,
                        str(amount_id): amount,
                    },
                )
                for record_id, (category, note, amount) in zip(
                    record_ids, source_values, strict=True
                )
            )
            setup.commit()

        application = FastAPI()
        application.include_router(router, prefix="/api")

        def database(request: Request) -> Generator[Session, None, None]:
            with AuditSession(runtime_engine) as db:
                db.info[AUDIT_CONTEXT_KEY] = AuditContext(
                    request_id=uuid7(),
                    request_method=request.method,
                    request_path=request.url.path,
                )
                yield db

        application.dependency_overrides[get_db] = database
        client = TestClient(application)
        with client:
            yield _RunFixture(
                client=client,
                owner_engine=owner_engine,
                runtime_engine=runtime_engine,
                owner_id=owner_id,
                owner_token=create_token(owner_id, session_ids[0], TokenType.ACCESS),
                outsider_token=create_token(outsider_id, session_ids[1], TokenType.ACCESS),
                write_only_token=create_token(write_only_id, session_ids[2], TokenType.ACCESS),
                report_id=report_id,
                module_id=module_id,
                note_field_id=note_id,
                first_record_id=record_ids[0],
            )
    finally:
        if client is not None:
            client.close()
        with owner_engine.begin() as cleanup:
            cleanup.execute(
                text(
                    "DELETE FROM public.audit_logs "
                    "WHERE performed_by IN :actors OR entity_id IN :all_ids"
                ).bindparams(
                    bindparam("actors", expanding=True),
                    bindparam("all_ids", expanding=True),
                ),
                {"actors": list(actor_ids), "all_ids": all_ids},
            )
            cleanup.execute(
                text(
                    "DELETE FROM public.report_run_eligible_users WHERE run_id IN "
                    "(SELECT id FROM public.report_runs WHERE report_id = :report_id)"
                ),
                {"report_id": report_id},
            )
            cleanup.execute(
                text(
                    "DELETE FROM public.report_run_rows WHERE run_id IN "
                    "(SELECT id FROM public.report_runs WHERE report_id = :report_id)"
                ),
                {"report_id": report_id},
            )
            for table, condition, values in (
                ("report_runs", "report_id = :id", {"id": report_id}),
                ("reports", "id = :id", {"id": report_id}),
                ("records", "module_id = :id", {"id": module_id}),
                ("fields", "module_id = :id", {"id": module_id}),
                ("modules", "id = :id", {"id": module_id}),
                ("departments", "id = :id", {"id": department_id}),
            ):
                cleanup.execute(text(f"DELETE FROM public.{table} WHERE {condition}"), values)
            cleanup.execute(
                text("DELETE FROM public.identity_sessions WHERE user_id IN :ids").bindparams(
                    bindparam("ids", expanding=True)
                ),
                {"ids": list(actor_ids)},
            )
            cleanup.execute(
                text("DELETE FROM public.users WHERE id IN :ids").bindparams(
                    bindparam("ids", expanding=True)
                ),
                {"ids": list(actor_ids)},
            )
            cleanup.execute(
                text("DELETE FROM public.roles WHERE id IN :ids").bindparams(
                    bindparam("ids", expanding=True)
                ),
                {"ids": list(role_ids)},
            )
        owner_engine.dispose()
        runtime_engine.dispose()


def test_manual_report_run_freezes_grouped_csv_and_replays_key(
    report_run_fixture: _RunFixture,
) -> None:
    fixture = report_run_fixture
    key = uuid7()
    path = f"/api/reports/{fixture.report_id}/runs"
    created = fixture.client.post(path, headers=fixture.headers(key=key))
    assert created.status_code == 201, created.text
    body = created.json()
    run_id = UUID(body["id"])
    assert body["report_id"] == str(fixture.report_id)
    assert body["recipe_revision"] == 1
    assert body["row_count"] == 3
    assert body["headings"] == ["Category", "Note", "Amount"]
    assert created.headers["location"] == f"{path}/{run_id}"
    assert created.headers["cache-control"] == "private, no-store"

    csv_path = f"{path}/{run_id}/csv"
    first_csv = fixture.client.get(csv_path, headers=fixture.headers())
    assert first_csv.status_code == 200
    assert first_csv.headers["cache-control"] == "private, no-store"
    assert first_csv.headers["x-content-type-options"] == "nosniff"
    assert first_csv.headers["content-type"].startswith("text/csv")
    assert list(csv.reader(io.StringIO(first_csv.text))) == [
        ["Category", "Note", "Amount"],
        ["Group: Alpha", "", ""],
        ["Alpha", "ordinary", "9007199254740993"],
        ["Alpha", "'=SUM(1,1)", "1.25"],
        ["Group total: 2", "", ""],
        ["Group: Beta", "", ""],
        ["Beta", "completed", "2.5"],
        ["Group total: 1", "", ""],
        ["Grand total: 3", "", ""],
    ]

    with AuditSession(fixture.owner_engine) as writer:
        writer.info[AUDIT_CONTEXT_KEY] = AuditContext(
            performed_by=fixture.owner_id,
            request_id=uuid7(),
            request_method="PATCH",
            request_path="/api/report-run-test/source-change",
        )
        record = writer.get(Record, fixture.first_record_id)
        assert record is not None
        record.data = {**record.data, str(fixture.note_field_id): "changed after run"}
        writer.commit()

    replay = fixture.client.post(path, headers=fixture.headers(key=key))
    assert replay.status_code == 201
    assert replay.json()["id"] == str(run_id)
    assert replay.headers["location"] == created.headers["location"]
    second_csv = fixture.client.get(csv_path, headers=fixture.headers())
    assert second_csv.content == first_csv.content
    with Session(fixture.owner_engine) as observer:
        assert (
            observer.scalar(
                select(func.count())
                .select_from(ReportRun)
                .where(ReportRun.report_id == fixture.report_id)
            )
            == 1
        )
        assert (
            observer.scalar(
                select(func.count()).select_from(ReportRunRow).where(ReportRunRow.run_id == run_id)
            )
            == 3
        )


def test_manual_report_run_denies_foreign_and_incomplete_capabilities(
    report_run_fixture: _RunFixture,
) -> None:
    fixture = report_run_fixture
    path = f"/api/reports/{fixture.report_id}/runs"
    assert fixture.client.post(path, headers=fixture.headers(key=uuid7())).status_code == 201
    foreign = fixture.client.post(
        path, headers=fixture.headers(fixture.outsider_token, key=uuid7())
    )
    assert foreign.status_code == 404
    write_only = fixture.client.post(
        path, headers=fixture.headers(fixture.write_only_token, key=uuid7())
    )
    assert write_only.status_code == 403
    assert fixture.client.post(path, headers=fixture.headers()).status_code == 422
    malformed = fixture.client.post(
        path,
        headers={**fixture.headers(), "Idempotency-Key": "not-a-uuid"},
    )
    assert malformed.status_code == 422


def test_empty_grouped_run_is_frozen_and_unavailable_source_adds_no_run(
    report_run_fixture: _RunFixture,
) -> None:
    fixture = report_run_fixture
    with AuditSession(fixture.owner_engine) as writer:
        writer.info[AUDIT_CONTEXT_KEY] = AuditContext(
            performed_by=fixture.owner_id,
            request_id=uuid7(),
            request_method="PATCH",
            request_path="/api/report-run-test/empty-recipe",
        )
        report = writer.get(Report, fixture.report_id)
        assert report is not None
        amount_reference = report.recipe["sorts"][0]
        report.recipe = {
            **report.recipe,
            "filters": [
                {
                    "field_id": amount_reference["field_id"],
                    "expected_type": amount_reference["expected_type"],
                    "operator": "gt",
                    "value": "999999999999999999999",
                }
            ],
        }
        report.revision += 1
        writer.commit()

    path = f"/api/reports/{fixture.report_id}/runs"
    created = fixture.client.post(path, headers=fixture.headers(key=uuid7()))
    assert created.status_code == 201, created.text
    assert created.json()["row_count"] == 0
    csv_result = fixture.client.get(f"{path}/{created.json()['id']}/csv", headers=fixture.headers())
    assert list(csv.reader(io.StringIO(csv_result.text))) == [
        ["Category", "Note", "Amount"],
        ["Grand total: 0", "", ""],
    ]

    with AuditSession(fixture.owner_engine) as writer:
        writer.info[AUDIT_CONTEXT_KEY] = AuditContext(
            performed_by=fixture.owner_id,
            request_id=uuid7(),
            request_method="PATCH",
            request_path="/api/report-run-test/unavailable-module",
        )
        module = writer.get(Module, fixture.module_id)
        assert module is not None
        module.is_deleted = True
        module.deleted_at = datetime.now(UTC)
        writer.commit()
    denied = fixture.client.post(path, headers=fixture.headers(key=uuid7()))
    assert denied.status_code == 409
    assert denied.json()["detail"]["code"] == "report_invalid"
    with Session(fixture.owner_engine) as observer:
        assert (
            observer.scalar(
                select(func.count())
                .select_from(ReportRun)
                .where(ReportRun.report_id == fixture.report_id)
            )
            == 1
        )


def test_source_purged_after_snapshot_rolls_back_run_and_rows(
    report_run_fixture: _RunFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = report_run_fixture
    router_module = importlib.import_module("app.systems.openview.reports.router")
    original = router_module.capture_report_snapshot

    def purge_after_snapshot(engine: Engine, report_id: UUID, owner_id: UUID):
        snapshot = original(engine, report_id, owner_id)
        with AuditSession(fixture.owner_engine) as writer:
            writer.info[AUDIT_CONTEXT_KEY] = AuditContext(
                performed_by=fixture.owner_id,
                request_id=uuid7(),
                request_method="DELETE",
                request_path="/api/report-run-test/purge-race",
            )
            record = writer.get(Record, fixture.first_record_id)
            assert record is not None
            writer.delete(record)
            writer.commit()
        return snapshot

    monkeypatch.setattr(router_module, "capture_report_snapshot", purge_after_snapshot)
    created = fixture.client.post(
        f"/api/reports/{fixture.report_id}/runs",
        headers=fixture.headers(key=uuid7()),
    )
    assert created.status_code == 409
    assert created.json()["detail"]["code"] == "report_source_changed"
    with Session(fixture.owner_engine) as observer:
        assert (
            observer.scalar(
                select(func.count())
                .select_from(ReportRun)
                .where(ReportRun.report_id == fixture.report_id)
            )
            == 0
        )
        assert observer.scalar(select(func.count()).select_from(ReportRunRow)) == 0
