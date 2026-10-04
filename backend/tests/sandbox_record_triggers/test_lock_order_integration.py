"""A trigger run and a link write take module, field and record locks in one order."""

import os
import threading
from uuid import UUID

import pytest
from sqlalchemy import Engine, create_engine, delete, event, select, text
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.manage.audit.models import AuditLog
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.record_triggers.execution import claim_due_events
from app.systems.sandbox.record_triggers.models import RecordTriggerEvent, RecordTriggerRun
from app.systems.sandbox.record_triggers.runner import execute_claim
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.router import create_record, update_record
from app.systems.sandbox.records.schemas import RecordCreate, RecordUpdate
from app.systems.sandbox.relationships.models import RelationshipEdge
from app.systems.sandbox.relationships.service import create_relationship
from tests.postgres_runtime import assert_runner_database_url
from tests.record_versions import record_version
from tests.relationships_integration.relationships_integration_support import _set_request
from tests.sandbox_record_triggers.support import (
    cleanup_committed_trigger,
    document_baseline,
    option_id,
    publish_trigger,
)

pytestmark = pytest.mark.integration

_WAIT = 10


def _waiting_for_a_lock(engine: Engine, pid: int) -> bool:
    with engine.connect() as connection:
        return bool(
            connection.scalar(
                text("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = :pid AND NOT granted)"),
                {"pid": pid},
            )
        )


def test_a_trigger_run_and_a_link_to_its_record_both_commit() -> None:
    # School Standard 47ae8ca0 had 2 deadlocks. The worker locks the module's fields and
    # the record, then updates its event row a second time. That row version is its own,
    # so PostgreSQL rechecks the event's foreign keys and takes FOR KEY SHARE on the
    # module row. A link write holding that module FOR UPDATE and waiting for the record
    # closes the cycle.
    database_url = os.getenv("MIGRATION_DATABASE_URL")
    if database_url is None:
        pytest.skip("requires the disposable PostgreSQL integration database")
    assert_runner_database_url(database_url, allowed_roles=frozenset({"openslate_owner"}))
    engine = create_engine(database_url, pool_size=4, max_overflow=0)
    worker_engine = create_engine(database_url, pool_size=1, max_overflow=0)
    cleanup: tuple[UUID, UUID, UUID] | None = None
    link_ids: dict[str, UUID] = {}
    release_worker = threading.Event()
    threads: list[threading.Thread] = []
    try:
        with AuditSession(bind=engine, expire_on_commit=False) as db:
            baseline = document_baseline(db)
            actor, module, fields, definition = publish_trigger(db)
            db.commit()
            cleanup = (actor.id, module.id, definition.id)
            source_module = Module(
                department_id=module.department_id, module_name=f"Lock order {uuid7()}"
            )
            db.add(source_module)
            db.flush()
            link_field = Field(
                module_id=source_module.id,
                name="Request",
                type=FieldType.RELATIONSHIP,
                required=False,
                position=0,
                config={},
                relationship_target_module_id=module.id,
                relationship_multiple_targets=True,
                relationship_multiple_sources=True,
            )
            source = Record(module_id=source_module.id, data={})
            db.add_all([link_field, source])
            db.commit()
            link_ids = {"module": source_module.id, "field": link_field.id, "source": source.id}
            target = create_record(
                RecordCreate(
                    module_id=module.id,
                    data={
                        str(fields["request-number"].id): "REQ-LOCK",
                        str(fields["priority"].id): option_id(fields["priority"], "Low"),
                        str(fields["status"].id): option_id(fields["status"], "Open"),
                    },
                ),
                actor,
                db,
            )
            link_ids["target"] = target.id
            # The record-created event matches no trigger; run it so only the edit remains.
            created_claims = claim_due_events(db)
            db.commit()
            for claim in created_claims:
                execute_claim(db, claim)
                db.commit()
            update_record(
                target.id,
                RecordUpdate(
                    data={
                        **target.data,
                        str(fields["priority"].id): option_id(fields["priority"], "High"),
                    }
                ),
                actor,
                db,
                if_match=record_version(db, target.id),
            )
            claims = claim_due_events(db)
            db.commit()
            assert len(claims) == 1

        worker_holds_locks = threading.Event()
        link_pid: list[int] = []
        outcomes: dict[str, object] = {}

        def pause_before_finishing_the_event(
            _connection: object, _cursor: object, statement: str, *_args: object
        ) -> None:
            if statement.lstrip().upper().startswith("UPDATE RECORD_TRIGGER_EVENTS SET STATE"):
                if not worker_holds_locks.is_set():
                    worker_holds_locks.set()
                    release_worker.wait(_WAIT)

        event.listen(worker_engine, "before_cursor_execute", pause_before_finishing_the_event)

        def run_worker() -> None:
            with AuditSession(bind=worker_engine) as session:
                try:
                    outcomes["worker"] = execute_claim(session, claims[0])
                    session.commit()
                except Exception as error:  # noqa: BLE001 - recorded for the assertion
                    outcomes["worker"] = error

        def write_link() -> None:
            with AuditSession(bind=engine, expire_on_commit=False) as session:
                _set_request(session, uuid7())
                # Read on the connection: the audited session refuses raw statements.
                pid = session.connection().exec_driver_sql("SELECT pg_backend_pid()").scalar()
                link_pid.append(int(pid or 0))
                try:
                    outcomes["link"] = create_relationship(
                        session, link_ids["field"], link_ids["source"], link_ids["target"]
                    )
                except Exception as error:  # noqa: BLE001 - recorded for the assertion
                    outcomes["link"] = error

        worker = threading.Thread(target=run_worker)
        threads.append(worker)
        worker.start()
        assert worker_holds_locks.wait(_WAIT), "the worker never finished its event"
        link = threading.Thread(target=write_link)
        threads.append(link)
        link.start()
        # Release the worker only once the link write is blocked behind one of its locks.
        deadline = threading.Event()
        timer = threading.Timer(_WAIT, deadline.set)
        timer.start()
        while not deadline.is_set() and not (link_pid and _waiting_for_a_lock(engine, link_pid[0])):
            deadline.wait(0.01)
        timer.cancel()
        assert not deadline.is_set(), f"the link write never waited: {outcomes!r}"
        release_worker.set()
        for thread in threads:
            thread.join(_WAIT)

        assert outcomes["worker"] is True, f"worker failed: {outcomes['worker']!r}"
        link_outcome = outcomes["link"]
        assert not isinstance(link_outcome, Exception), (
            f"link failed: {link_outcome!r} caused by {link_outcome.__cause__!r}"
        )
        with AuditSession(bind=engine) as db:
            record = db.get(Record, link_ids["target"])
            assert record is not None
            assert record.data[str(fields["status"].id)] == option_id(
                fields["status"], "In progress"
            )
            assert db.scalar(
                select(RelationshipEdge.id).where(RelationshipEdge.field_id == link_ids["field"])
            )
    finally:
        release_worker.set()
        for thread in threads:
            thread.join(_WAIT)
        worker_engine.dispose()
        if cleanup is not None:
            actor_id, module_id, definition_id = cleanup
            _remove_link_rows(engine, module_id, definition_id, link_ids)
            cleanup_committed_trigger(
                engine,
                actor_id=actor_id,
                module_id=module_id,
                definition_id=definition_id,
                baseline=baseline,
            )
        engine.dispose()


def _remove_link_rows(
    engine: Engine, module_id: UUID, definition_id: UUID, ids: dict[str, UUID]
) -> None:
    """Remove the rows this test added beside the published trigger, children first."""

    with engine.begin() as connection:
        module_events = select(RecordTriggerEvent.id).where(
            RecordTriggerEvent.module_id == module_id
        )
        connection.execute(
            delete(RecordTriggerRun).where(
                (RecordTriggerRun.trigger_id == definition_id)
                | RecordTriggerRun.event_id.in_(module_events)
            )
        )
        connection.execute(
            delete(RecordTriggerEvent).where(RecordTriggerEvent.module_id == module_id)
        )
        edge_ids = []
        if "field" in ids:
            edge_ids = list(
                connection.scalars(
                    select(RelationshipEdge.id).where(RelationshipEdge.field_id == ids["field"])
                )
            )
            connection.execute(
                delete(RelationshipEdge).where(RelationshipEdge.field_id == ids["field"])
            )
            connection.execute(delete(Field).where(Field.id == ids["field"]))
        record_ids = [ids[key] for key in ("source", "target") if key in ids]
        connection.execute(delete(Record).where(Record.id.in_(record_ids)))
        if "module" in ids:
            connection.execute(delete(Module).where(Module.id == ids["module"]))
        connection.execute(
            delete(AuditLog).where(AuditLog.entity_id.in_([*ids.values(), *edge_ids]))
        )
