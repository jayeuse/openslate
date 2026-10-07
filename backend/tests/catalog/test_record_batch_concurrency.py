"""Owned PostgreSQL lock/savepoint and stale-write boundaries for batches."""

from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.sandbox.fields.models import FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.errors import RelationshipUnavailable
from app.systems.sandbox.relationships.locking import lock_row
from tests.catalog.dynamic_field_support import (
    _database_url,
    _seed_committed_module,
    _seed_committed_record,
    _set_request,
)
from tests.conftest import guarded_create_engine

pytestmark = pytest.mark.integration
pytest_plugins = ("tests.catalog.dynamic_field_support", "tests.auth.session_policy_support")


def test_nested_lock_timeout_retains_the_previous_item_write(integration_db, owned_ids):
    module = _seed_committed_module(owned_ids, fields=(("Title", FieldType.TEXT, 0, False, {}),))
    key = str(module.fields["Title"])
    first_id = _seed_committed_record(owned_ids, module.module_id, {key: "Before"})
    held_id = _seed_committed_record(owned_ids, module.module_id, {key: "Held"})
    db = integration_db
    _set_request(db, uuid7(), "/api/test/batch-savepoint-lock")
    first = db.get(Record, first_id)
    first.data = {key: "Kept"}
    db.flush()
    engine = guarded_create_engine(_database_url())
    try:
        with Session(engine) as holder:
            assert holder.scalar(select(Record).where(Record.id == held_id).with_for_update())
            with pytest.raises(RelationshipUnavailable), db.begin_nested():
                lock_row(db, Record, held_id)
        assert db.get(Record, first_id, populate_existing=True).data == {key: "Kept"}
        db.commit()
        assert db.get(Record, first_id).data == {key: "Kept"}
    finally:
        engine.dispose()


def test_batch_refreshes_revision_after_the_same_module_record_lock_order(
    policy_world,
    owned_ids,
    monkeypatch,
):
    from threading import Event

    import app.systems.sandbox.records.batch_router as batch_router

    world = policy_world
    module = _seed_committed_module(owned_ids, fields=(("Title", FieldType.TEXT, 0, False, {}),))
    key = str(module.fields["Title"])
    record_id = _seed_committed_record(owned_ids, module.module_id, {key: "Before"})
    engine = guarded_create_engine(_database_url())
    attempted = Event()
    original = batch_router._lock_active_module

    def signal(db, module_id):
        attempted.set()
        return original(db, module_id)

    monkeypatch.setattr(batch_router, "_lock_active_module", signal)
    try:
        with Session(engine) as before:
            revision = before.get(Record, record_id).updated_at.isoformat()
        payload = {
            "module_id": str(module.module_id),
            "items": [
                {
                    "record_id": str(record_id),
                    "revision": revision,
                    "field_id": key,
                    "value": "Must not overwrite",
                }
            ],
        }
        with AuditSession(engine) as holder:
            _set_request(holder, uuid7(), "/api/test/concurrent-record-writer")
            assert lock_row(holder, Module, module.module_id)
            record = lock_row(holder, Record, record_id)
            record.data = {key: "Concurrent write"}
            holder.flush()
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(
                    world.client.post,
                    "/api/records/batch-update",
                    json=payload,
                    headers=world.headers(),
                )
                assert attempted.wait(5), "Batch never reached its parent lock"
                holder.commit()
                response = future.result(5)
        assert response.status_code == 200, response.text
        assert response.json()["results"] == [{"record_id": str(record_id), "status": "stale"}]
        with Session(engine) as db:
            assert db.get(Record, record_id).data == {key: "Concurrent write"}
    finally:
        engine.dispose()
