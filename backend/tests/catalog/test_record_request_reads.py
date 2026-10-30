"""One record create or edit reads the module's readers and fields once.

Profile 4.2 (2026-10-29, Harbor Standard): each create and edit read the module's
readers twice (validation, then the response labels) and its fields twice (before
the write, then again after the commit). Before: 2 and 2. After: 1 and 1.
Who is notified is owned by ``test_record_assignment_notifications.py``.
"""

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from unittest.mock import Mock
from uuid import UUID

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.users.models import Membership, User
from app.systems.sandbox.fields.models import FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records import display, mutation_validation
from app.systems.sandbox.records import router as records_router
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.router import create_record, update_record
from app.systems.sandbox.records.schemas import RecordCreate, RecordUpdate
from tests.catalog.field_record_support import make_field, make_module
from tests.rbac.support import make_user

READER = UUID("0192f0c4-6b1e-7c3a-9d2e-4f5a6b7c8d9e")
SECOND_READER = UUID("0192f0c4-6b1e-7c3a-9d2e-4f5a6b7c8da0")


class _Rows(list[Any]):
    def all(self) -> list[Any]:
        return list(self)


def _persist(record: Record) -> None:
    now = datetime.now(UTC)
    if record.id is None:
        record.id = uuid7()
        record.created_at = now
    record.updated_at = now
    record.is_deleted = False
    record.deleted_at = None
    record.performed_by = None


def _database(module: Module, record: Record | None) -> tuple[User, Mock]:
    actor, membership = make_user("record_writer")
    db = Mock(spec=Session)
    db.info = {}  # a real Session.info is a dict; the lock helper keeps a marker in it
    db.dirty = set()
    db.get.side_effect = lambda model, *_args, **_kwargs: module if model is Module else record
    db.scalars.side_effect = lambda query: _Rows(
        [membership] if query.column_descriptions[0]["entity"] is Membership else []
    )
    db.execute.return_value = [(READER, "Rea Der", "reader"), (SECOND_READER, None, "second")]
    db.refresh.side_effect = _persist
    return actor, db


@dataclass
class Reads:
    module: Module
    user_key: str
    text_key: str
    readers: list[UUID] = field(default_factory=list)
    fields: list[UUID] = field(default_factory=list)


@pytest.fixture
def reads(monkeypatch: pytest.MonkeyPatch) -> Reads:
    """Count the reader and field reads at every binding the record routes reach."""

    module = make_module()
    fields = [make_field(module.id, FieldType.USER), make_field(module.id, FieldType.TEXT)]
    fields[1].position = 1
    for item in fields:
        item.org_id = uuid7()
    counted = Reads(module, str(fields[0].id), str(fields[1].id))

    def readers(_db: Session, module_id: UUID, **_kwargs: Any) -> frozenset[UUID]:
        counted.readers.append(module_id)
        return frozenset({READER, SECOND_READER})

    def module_fields(_db: Session, module_id: UUID) -> list[Any]:
        counted.fields.append(module_id)
        return list(fields)

    for binding in (mutation_validation, display):
        monkeypatch.setattr(binding, "module_reader_ids", readers)
    monkeypatch.setattr(records_router, "_module_fields", module_fields)
    return counted


def test_a_record_create_reads_module_readers_and_fields_once(reads: Reads) -> None:
    actor, db = _database(reads.module, None)

    response = create_record(
        RecordCreate(module_id=reads.module.id, data={reads.user_key: str(READER)}), actor, db
    )

    assert response.display_values == {reads.user_key: "Rea Der"}
    assert (len(reads.readers), len(reads.fields)) == (1, 1)


def test_a_record_edit_reads_module_readers_and_fields_once(reads: Reads) -> None:
    record = Record(module_id=reads.module.id, data={reads.user_key: str(READER)})
    _persist(record)
    actor, db = _database(reads.module, record)

    response = update_record(
        record.id,
        RecordUpdate(data={reads.user_key: str(SECOND_READER), reads.text_key: "b"}),
        actor,
        db,
        if_match=record.updated_at.isoformat(),
    )

    assert response.display_values == {reads.user_key: "second"}
    assert (len(reads.readers), len(reads.fields)) == (1, 1)
