"""Record ownership of completed trigger history through guarded PostgreSQL."""

import os
from collections.abc import Generator
from dataclasses import dataclass
from datetime import timedelta
from secrets import token_urlsafe
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import bindparam, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.base_model import utc_now
from app.core.database import get_db
from app.core.database.session import AuditSession
from app.main import create_app
from app.systems.access.users.models import User
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.manage.audit.models import AuditAction, AuditLog, SecurityEvent
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.lifecycle.exceptions import (
    LifecycleUnavailable,
)
from app.systems.sandbox.lifecycle.planner import plan_lifecycle
from app.systems.sandbox.lifecycle.service import purge_lifecycle
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.record_triggers.execution import claim_due_events
from app.systems.sandbox.record_triggers.models import (
    RecordTrigger,
    RecordTriggerEvent,
    RecordTriggerRun,
    TriggerEventState,
)
from app.systems.sandbox.record_triggers.runner import execute_claim
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.models import RelationshipEdge
from tests.conftest import guarded_create_engine
from tests.sandbox_record_triggers.support import publish_trigger

pytestmark = pytest.mark.integration


def _event(record: Record, *, root: RecordTriggerEvent | None = None) -> RecordTriggerEvent:
    return RecordTriggerEvent(
        record_id=record.id,
        module_id=record.module_id,
        event_kind="field-changed" if root else "record-created",
        root_event_id=root.id if root else None,
        depth=1 if root else 0,
        state=TriggerEventState.FAILED if root else TriggerEventState.SUCCEEDED,
        next_attempt_at=utc_now(),
    )


@dataclass
class HistoryApi:
    db: Session
    client: TestClient
    actor: User
    module: Module
    fields: dict[str, Field]
    definition: RecordTrigger

    def request(self, method: str, path: str, payload: dict | None = None):
        self.db.info[AUDIT_CONTEXT_KEY] = AuditContext(
            performed_by=self.actor.id,
            request_id=uuid7(),
            request_method=method,
            request_path=path,
        )
        return self.client.request(method, path, json=payload)

    def create(self, name: str) -> Record:
        response = self.request(
            "POST",
            "/api/records",
            {
                "module_id": str(self.module.id),
                "data": {str(self.fields["request-number"].id): name},
            },
        )
        assert response.status_code == 201
        record = self.db.get(Record, UUID(response.json()["id"]))
        assert record is not None
        return record

    def finish(self) -> None:
        claims = claim_due_events(self.db)
        assert claims
        for claim in claims:
            assert execute_claim(self.db, claim)
        self.db.commit()

    def archive(self, record: Record) -> None:
        assert self.request("DELETE", f"/api/records/{record.id}").status_code == 204

    def preview(self, record: Record):
        response = self.request("POST", f"/api/records/{record.id}/purge/preview")
        assert response.status_code == 200
        return response.json()

    def purge(self, record: Record, review: dict):
        return self.request(
            "POST",
            f"/api/records/{record.id}/purge",
            {
                "token": review["token"],
                "confirmation_name": review["confirmation_name"],
                "password": token_urlsafe(32),
            },
        )


@pytest.fixture
def history_api(integration_db: Session, monkeypatch: pytest.MonkeyPatch) -> Generator[HistoryApi]:
    actor, module, fields, definition = publish_trigger(integration_db)
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: actor
    app.dependency_overrides[get_db] = lambda: integration_db
    monkeypatch.setattr(
        "app.systems.sandbox.lifecycle.router.get_settings",
        lambda: SimpleNamespace(lifecycle_purge_enabled=True),
    )

    class PasswordClient:
        def __init__(self, _db):
            pass

        def verify_password(self, _email, _password):
            return actor.id

    monkeypatch.setattr(
        "app.systems.sandbox.lifecycle.challenge_verification.ProviderPasswordGrantClient",
        PasswordClient,
    )
    client = TestClient(app)
    try:
        yield HistoryApi(integration_db, client, actor, module, fields, definition)
    finally:
        client.close()
        app.dependency_overrides.clear()


def test_api_created_record_purge_removes_owned_completed_history_and_records_counts(
    history_api: HistoryApi,
) -> None:
    api = history_api
    record, other = api.create("Purge me"), api.create("Keep me")
    api.finish()
    root = api.db.scalar(
        select(RecordTriggerEvent).where(RecordTriggerEvent.record_id == record.id)
    )
    assert root is not None and root.state == TriggerEventState.SUCCEEDED
    child = _event(record, root=root)
    api.db.add(child)
    api.db.flush()
    api.db.add(RecordTriggerRun(event_id=child.id, trigger_id=api.definition.id, state="failed"))
    api.db.commit()
    owned_events = {root.id, child.id}
    owned_runs = set(
        api.db.scalars(
            select(RecordTriggerRun.id).where(RecordTriggerRun.event_id.in_(owned_events))
        )
    )
    other_event = api.db.scalar(
        select(RecordTriggerEvent).where(RecordTriggerEvent.record_id == other.id)
    )
    assert other_event is not None
    other_run = api.db.scalar(
        select(RecordTriggerRun).where(RecordTriggerRun.event_id == other_event.id)
    )
    assert other_run is not None and other_run.state == "skipped"
    api.archive(record)
    review = api.preview(record)
    assert review["impact"]["blockers"] == []
    assert {(row["entity_type"], UUID(row["entity_id"])) for row in review["impact"]["rows"]} == {
        ("records", record.id),
        *[("record_trigger_events", event_id) for event_id in owned_events],
        *[("record_trigger_runs", run_id) for run_id in owned_runs],
    }
    response = api.purge(record, review)
    assert response.status_code == 200
    request_id = UUID(response.json()["operation_id"])
    api.db.expire_all()
    assert api.db.get(Record, record.id) is None
    assert not list(
        api.db.scalars(select(RecordTriggerEvent).where(RecordTriggerEvent.id.in_(owned_events)))
    )
    assert not list(
        api.db.scalars(select(RecordTriggerRun).where(RecordTriggerRun.id.in_(owned_runs)))
    )
    assert api.db.get(Record, other.id) is not None
    assert api.db.get(RecordTriggerEvent, other_event.id) is not None
    assert api.db.get(RecordTriggerRun, other_run.id) is not None
    assert api.db.get(RecordTrigger, api.definition.id) is not None
    audit = list(api.db.scalars(select(AuditLog).where(AuditLog.request_id == request_id)))
    assert {(row.entity_type, row.entity_id) for row in audit} == {
        ("records", record.id),
        *[("record_trigger_events", event_id) for event_id in owned_events],
        *[("record_trigger_runs", run_id) for run_id in owned_runs],
    }
    assert all(
        row.action == AuditAction.DELETE and row.performed_by == api.actor.id for row in audit
    )
    security = api.db.scalar(select(SecurityEvent).where(SecurityEvent.operation_id == request_id))
    assert security is not None and security.outcome == "success"
    assert security.actor_id == api.actor.id and security.subject_id == record.id
    assert security.event_metadata == {
        "trigger_event_rows_removed": 2,
        "trigger_run_rows_removed": 2,
        "trigger_history_rows_removed": 4,
    }


@pytest.mark.parametrize("expired", [False, True], ids=["leased", "expired-retry"])
def test_running_record_history_stays_blocked_even_when_retry_lease_expired(
    history_api: HistoryApi,
    expired: bool,
) -> None:
    api = history_api
    record = api.create("Not completed")
    claims = claim_due_events(api.db)
    assert len(claims) == 1
    event = api.db.get(RecordTriggerEvent, claims[0].id)
    assert event is not None
    if expired:
        event.lease_expires_at = utc_now() - timedelta(seconds=1)
    api.db.commit()
    api.archive(record)
    review = api.preview(record)
    assert any(row["entity_id"] == str(event.id) for row in review["impact"]["blockers"])
    response = api.purge(record, review)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "preflight_failed"
    assert api.db.get(Record, record.id) is not None
    assert api.db.get(RecordTriggerEvent, event.id) is not None


def test_outside_record_child_blocks_purge_without_expanding_history_ownership(
    history_api: HistoryApi,
) -> None:
    api = history_api
    record, other = api.create("Root owner"), api.create("Child owner")
    api.finish()
    root = api.db.scalar(
        select(RecordTriggerEvent).where(RecordTriggerEvent.record_id == record.id)
    )
    assert root is not None
    child = _event(other, root=root)
    api.db.add(child)
    api.db.commit()
    api.archive(record)
    review = api.preview(record)
    assert any(row["entity_id"] == str(child.id) for row in review["impact"]["blockers"])
    assert api.purge(record, review).status_code == 409
    assert api.db.get(RecordTriggerEvent, child.id) is not None
    assert api.db.get(RecordTriggerEvent, root.id) is not None
    assert api.db.get(Record, other.id) is not None


@pytest.mark.parametrize("change", ["event-state", "root-reference", "run-state", "run-owner"])
def test_history_state_and_ownership_change_invalidates_review_even_without_timestamp_change(
    history_api: HistoryApi,
    change: str,
) -> None:
    api = history_api
    record, other = api.create("Review subject"), api.create("Other history")
    api.finish()
    event = api.db.scalar(
        select(RecordTriggerEvent).where(RecordTriggerEvent.record_id == record.id)
    )
    other_event = api.db.scalar(
        select(RecordTriggerEvent).where(RecordTriggerEvent.record_id == other.id)
    )
    assert event is not None and other_event is not None
    run = api.db.scalar(select(RecordTriggerRun).where(RecordTriggerRun.event_id == event.id))
    assert run is not None
    api.archive(record)
    review = api.preview(record)
    previous_time = event.updated_at if change.startswith(("event", "root")) else run.updated_at
    if change == "event-state":
        event.state = TriggerEventState.FAILED
    elif change == "root-reference":
        event.root_event_id, event.depth = other_event.id, 1
    elif change == "run-state":
        run.state = "suspended"
    else:
        replacement = _event(other)
        api.db.add(replacement)
        api.db.flush()
        run.event_id = replacement.id
    if change.startswith(("event", "root")):
        event.updated_at = previous_time
    else:
        run.updated_at = previous_time
    api.db.commit()
    response = api.purge(record, review)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "impact_changed"
    assert api.db.get(Record, record.id) is not None
    assert api.db.get(RecordTriggerRun, run.id) is not None


def test_late_failure_rolls_back_history_record_links_audit_and_success_counter(
    history_api: HistoryApi,
) -> None:
    api = history_api
    record, other = api.create("Atomic purge"), api.create("Link target")
    api.finish()
    field = Field(
        module_id=api.module.id,
        name="Related",
        type=FieldType.RELATIONSHIP,
        position=4,
        relationship_target_module_id=api.module.id,
        relationship_multiple_targets=True,
        relationship_multiple_sources=True,
    )
    api.db.add(field)
    api.db.flush()
    edge = RelationshipEdge(field=field, source_record=record, target_record=other)
    api.db.add(edge)
    api.db.commit()
    api.archive(record)
    review = api.preview(record)
    history_ids = {
        UUID(row["entity_id"])
        for row in review["impact"]["rows"]
        if row["entity_type"].startswith("record_trigger_")
    }

    def fail_commit():
        api.db.flush()
        raise IntegrityError("forced late failure", {}, RuntimeError("forced"))

    # Provider step-up commits its challenge separately; fail only the purge transaction.
    original_commit = api.db.commit

    def guarded_commit():
        if any(isinstance(row, SecurityEvent) for row in api.db.new):
            fail_commit()
        else:
            original_commit()

    with patch.object(api.db, "commit", side_effect=guarded_commit):
        response = api.purge(record, review)
    assert response.status_code == 409
    request_id = api.db.info[AUDIT_CONTEXT_KEY].request_id
    api.db.expire_all()
    assert api.db.get(Record, record.id) is not None
    assert api.db.get(RelationshipEdge, edge.id) is not None
    stored_history = set(
        api.db.scalars(select(RecordTriggerEvent.id).where(RecordTriggerEvent.id.in_(history_ids)))
    )
    stored_history |= set(
        api.db.scalars(select(RecordTriggerRun.id).where(RecordTriggerRun.id.in_(history_ids)))
    )
    assert stored_history == history_ids
    assert not list(api.db.scalars(select(AuditLog).where(AuditLog.request_id == request_id)))
    assert not list(
        api.db.scalars(select(SecurityEvent).where(SecurityEvent.operation_id == request_id))
    )


def test_worker_claim_lock_aborts_record_purge_without_removing_history(
    integration_db: Session,
) -> None:
    """Two real transactions coordinate a retry claim and the displayed purge plan."""
    runtime = guarded_create_engine(os.environ["TEST_DATABASE_URL"])
    owner = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    owned: set[UUID] = set()
    try:
        with AuditSession(runtime) as setup:
            department = Department(department_name=f"History race {uuid7()}")
            module = Module(department=department, module_name="Claim conflict")
            record = Record(module=module, is_deleted=True, deleted_at=utc_now())
            setup.add_all([department, module, record])
            setup.flush()
            event = _event(record)
            setup.add(event)
            setup.flush()
            owned.update([department.id, module.id, record.id, event.id])
            record_id, event_id = record.id, event.id
            setup.commit()
        with AuditSession(runtime) as purge_db, AuditSession(runtime) as worker_db:
            plan = plan_lifecycle(purge_db, "record", record_id, "purge", None)
            retry = worker_db.get(RecordTriggerEvent, event_id)
            assert retry is not None
            retry.state = TriggerEventState.PENDING
            worker_db.flush()
            claims = claim_due_events(worker_db)
            assert [claim.id for claim in claims] == [event_id]
            with pytest.raises(LifecycleUnavailable):
                purge_lifecycle(purge_db, "record", record_id, None, plan=plan)
            worker_db.commit()
            assert purge_db.get(Record, record_id) is not None
            assert purge_db.get(RecordTriggerEvent, event_id) is not None
            blocked = plan_lifecycle(purge_db, "record", record_id, "purge", None)
            assert blocked.blockers
    finally:
        with owner.begin() as connection:
            for table in (
                "audit_logs",
                "record_trigger_events",
                "records",
                "modules",
                "departments",
            ):
                key = "entity_id" if table == "audit_logs" else "id"
                connection.execute(
                    text(f"DELETE FROM public.{table} WHERE {key} IN :ids").bindparams(
                        bindparam("ids", expanding=True)
                    ),
                    {"ids": list(owned)},
                )
        runtime.dispose()
        owner.dispose()


@pytest.mark.parametrize("kind", ["department", "module"])
@pytest.mark.parametrize("foreign_child", [False, True], ids=["owned-terminal", "foreign-child"])
def test_structural_purge_history_ownership_follows_records_not_dependencies(
    integration_db: Session, kind: str, foreign_child: bool
) -> None:
    db = integration_db
    actor, external_module, _, definition = publish_trigger(db)
    department = Department(department_name=f"History scope {uuid7()}", is_deleted=True)
    db.add(department)
    db.flush()
    module = Module(department_id=department.id, module_name="History owner", is_deleted=True)
    db.add(module)
    db.flush()
    owned = Record(module_id=module.id, data={}, is_deleted=True)
    external = Record(module_id=external_module.id, data={})
    db.add_all([owned, external])
    db.flush()
    root = _event(owned)
    db.add(root)
    db.flush()
    run = RecordTriggerRun(event_id=root.id, trigger_id=definition.id, state="succeeded")
    db.add(run)
    child = _event(external, root=root) if foreign_child else _event(owned, root=root)
    db.add(child)
    db.commit()
    target = department if kind == "department" else module
    plan = plan_lifecycle(db, kind, target.id, "purge", actor.id)
    if foreign_child:
        assert child.id in {blocker.entity_id for blocker in plan.blockers}
        assert db.get(Record, owned.id) is not None
        assert db.get(RecordTriggerEvent, root.id) is not None
        return
    assert not plan.blockers
    purge_lifecycle(db, kind, target.id, actor.id, plan=plan)
    assert db.get(Record, owned.id) is None
    assert all(db.get(RecordTriggerEvent, event_id) is None for event_id in (root.id, child.id))
    assert db.get(RecordTriggerRun, run.id) is None
    assert db.get(Record, external.id) is not None
    assert db.get(RecordTrigger, definition.id) is not None
