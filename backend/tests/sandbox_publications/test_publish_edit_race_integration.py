"""A Sandbox publish that waits behind a record edit refuses its stale review.

The live-state digest a review approves covers record data, and the executor
recomputes it after taking its canonical locks. A publish that started while another
user's record save held the module and record locks must therefore wait, then refuse
with ``live_state_changed`` and leave no partial publication, while the save commits.
"""

import os
import threading
import time
from hashlib import sha256
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import Engine, create_engine, delete, event, func, select, text
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.manage.audit.models import AuditLog
from app.systems.sandbox.designs.models import SandboxDocument as SandboxDocumentRow
from app.systems.sandbox.designs.schemas import SandboxDocument
from app.systems.sandbox.designs.service import read_document, replace_document
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.executor import (
    PublicationError,
    apply_publication,
    request_fingerprint,
)
from app.systems.sandbox.publications.models import SandboxPublication
from app.systems.sandbox.publications.planner import publication_plan
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.router import create_record, update_record
from app.systems.sandbox.records.schemas import RecordCreate, RecordUpdate
from tests.postgres_runtime import assert_runner_database_url
from tests.record_versions import record_version
from tests.sandbox_record_triggers.support import (
    cleanup_committed_trigger,
    document_baseline,
    option_id,
    publish_trigger,
)

pytestmark = pytest.mark.integration

_WAIT = 10.0


def _audited(session: AuditSession, actor_id: UUID, path: str) -> AuditSession:
    session.info[AUDIT_CONTEXT_KEY] = AuditContext(
        performed_by=actor_id, request_id=uuid7(), request_method="POST", request_path=path
    )
    return session


def _blocked_by(engine: Engine, holder_pid: int) -> bool:
    with engine.connect() as connection:
        return bool(
            connection.scalar(
                text(
                    "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE NOT granted "
                    "AND :holder = ANY (pg_blocking_pids(pid)))"
                ),
                {"holder": holder_pid},
            )
        )


def test_a_publish_behind_a_record_edit_refuses_its_stale_review_and_writes_nothing() -> None:
    database_url = os.getenv("MIGRATION_DATABASE_URL")
    if database_url is None:
        pytest.skip("requires the disposable PostgreSQL integration database")
    assert_runner_database_url(database_url, allowed_roles=frozenset({"openslate_owner"}))
    engine = create_engine(database_url, pool_size=4, max_overflow=0)
    edit_engine = create_engine(database_url, pool_size=1, max_overflow=0)
    cleanup: tuple[UUID, UUID, UUID] | None = None
    record_id: UUID | None = None
    try:
        with AuditSession(bind=engine, expire_on_commit=False) as db:
            baseline = document_baseline(db)
            actor, module, fields, definition = publish_trigger(db)
            db.commit()
            cleanup = (actor.id, module.id, definition.id)
            title_key = str(fields["title"].id)
            record_id = create_record(
                RecordCreate(
                    module_id=module.id,
                    data={
                        str(fields["request-number"].id): "REQ-RACE",
                        title_key: "Before",
                        str(fields["priority"].id): option_id(fields["priority"], "Low"),
                        str(fields["status"].id): option_id(fields["status"], "Open"),
                    },
                ),
                actor,
                db,
            ).id
            # The review: rename the module, a change that keeps the published trigger.
            current = read_document(db)
            payload = current.document.model_dump(by_alias=True, mode="json")
            payload["design"]["modules"][0]["name"] = "Requests renamed"
            saved = replace_document(
                db,
                actor_id=actor.id,
                expected_revision=current.revision,
                document=SandboxDocument.model_validate(payload),
            )
            review = publication_plan(db, saved.document)
            assert not review.blockers
            db.commit()
            version = record_version(db, record_id)
            record = db.get(Record, record_id)
            assert record is not None
            edited_data = {**record.data, title_key: "After"}
            publications_before = db.scalar(select(func.count()).select_from(SandboxPublication))

        edit_holds_locks = threading.Event()
        release_edit = threading.Event()
        holder_pid: list[int] = []
        outcomes: dict[str, object] = {}

        def pause_before_record_update(
            _connection: Any, cursor: Any, statement: str, *_args: Any
        ) -> None:
            if edit_holds_locks.is_set():
                return
            if statement.lstrip().upper().startswith("UPDATE RECORDS "):
                holder_pid.append(int(cursor.connection.info.backend_pid))
                edit_holds_locks.set()
                release_edit.wait(_WAIT)

        event.listen(edit_engine, "before_cursor_execute", pause_before_record_update)

        def edit() -> None:
            with _audited(AuditSession(bind=edit_engine), actor.id, "/api/records") as session:
                try:
                    outcomes["edit"] = update_record(
                        record_id,
                        RecordUpdate(data=edited_data),
                        actor,
                        session,
                        if_match=version,
                    )
                except Exception as error:  # noqa: BLE001 - recorded for the assertion
                    outcomes["edit"] = error

        def publish() -> None:
            path = "/api/sandbox/publications"
            with _audited(AuditSession(bind=engine), actor.id, path) as session:
                token = sha256(f"race-{actor.id}".encode()).hexdigest()
                try:
                    outcomes["publish"] = apply_publication(
                        session,
                        actor_id=actor.id,
                        expected_revision=saved.revision,
                        impact_digest=review.impact_digest,
                        expected_live_state_digest=review.live_state_digest,
                        preview_token_digest=token,
                        idempotency_key=f"race-{actor.id}",
                        fingerprint=request_fingerprint(
                            expected_revision=saved.revision,
                            document_hash=saved.content_hash,
                            impact_digest=review.impact_digest,
                            preview_token_digest=token,
                            note=None,
                        ),
                        note=None,
                    )
                except Exception as error:  # noqa: BLE001 - recorded for the assertion
                    session.rollback()
                    outcomes["publish"] = error

        editor = threading.Thread(target=edit)
        publisher = threading.Thread(target=publish)
        try:
            editor.start()
            assert edit_holds_locks.wait(_WAIT), "the record edit never reached its update"
            publisher.start()
            deadline = time.monotonic() + _WAIT
            while not _blocked_by(engine, holder_pid[0]):
                assert time.monotonic() < deadline, "the publish never waited for the edit"
                threading.Event().wait(0.01)
            release_edit.set()
        finally:
            release_edit.set()
            for thread in (editor, publisher):
                if thread.ident is not None:
                    thread.join(_WAIT)
            event.remove(edit_engine, "before_cursor_execute", pause_before_record_update)
        assert not editor.is_alive() and not publisher.is_alive(), "a writer hung"

        assert not isinstance(outcomes["edit"], Exception), f"edit failed: {outcomes['edit']!r}"
        refusal = outcomes["publish"]
        assert isinstance(refusal, PublicationError), f"publish did not refuse: {refusal!r}"
        assert (refusal.code, refusal.status_code) == ("live_state_changed", 409)
        with AuditSession(bind=engine) as db:
            stored = db.get(Record, record_id)
            assert stored is not None and stored.data[title_key] == "After"
            assert db.scalar(select(Module.module_name).where(Module.id == module.id)) == (
                "Requests"
            )
            assert (
                db.scalar(select(func.count()).select_from(SandboxPublication))
                == publications_before
            )
            assert db.scalar(select(SandboxDocumentRow.revision)) == saved.revision
    finally:
        edit_engine.dispose()
        if cleanup is not None:
            actor_id, module_id, definition_id = cleanup
            with engine.begin() as connection:
                # cleanup_committed_trigger removes trigger events but not records.
                if record_id is not None:
                    connection.execute(
                        text("DELETE FROM public.record_trigger_events WHERE record_id = :id"),
                        {"id": record_id},
                    )
                    connection.execute(delete(Record).where(Record.id == record_id))
                    connection.execute(delete(AuditLog).where(AuditLog.entity_id == record_id))
            cleanup_committed_trigger(
                engine,
                actor_id=actor_id,
                module_id=module_id,
                definition_id=definition_id,
                baseline=baseline,
            )
        engine.dispose()
