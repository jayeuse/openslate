"""Department-library invariants on the fresh organization root."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.systems.boards.models import Board
from app.systems.platform.files.models import File
from app.systems.sandbox.records.models import Record
from tests.conftest import create_member, create_organization
from tests.rbac.support import add_department, add_module, add_user

pytestmark = pytest.mark.integration


def test_library_owns_exactly_one_department_and_parent_delete_is_restricted(integration_db):
    db = integration_db
    creator = add_user(db)
    department = add_department(db)
    module = add_module(db, department)
    record = Record(org_id=department.org_id, module_id=module.id, data={})
    board = Board(org_id=department.org_id, scope="project",
                  name=f"Library isolation {uuid7()}", status="active")
    db.add_all([record, board])
    db.flush()

    def inventory(purpose="library_document", **parents):
        return File(
            org_id=department.org_id,
            purpose=purpose,
            creator_id=creator.id,
            filename="guide.pdf",
            expected_size=1,
            object_key=uuid7().hex,
            state="awaiting_upload",
            **parents,
        )

    valid = inventory(department_id=department.id)
    db.add(valid)
    db.flush()
    for purpose, parents in (
        ("library_document", {"department_id": department.id, "record_id": record.id}),
        ("library_document", {"department_id": department.id, "board_id": board.id}),
        ("record_attachment", {"department_id": department.id, "record_id": record.id}),
        ("board_attachment", {"department_id": department.id, "board_id": board.id}),
        ("workspace_logo", {"department_id": department.id}),
    ):
        savepoint = db.begin_nested()
        db.add(inventory(purpose, **parents))
        with pytest.raises(IntegrityError) as rejected:
            db.flush()
        savepoint.rollback()
        assert rejected.value.orig.diag.constraint_name == "ck_files_purpose_parent"
    savepoint = db.begin_nested()
    db.add(inventory(department_id=uuid7()))
    with pytest.raises(IntegrityError) as missing:
        db.flush()
    savepoint.rollback()
    assert missing.value.orig.diag.constraint_name == "fk_files_department_id_departments"
    # Remove the record/module so this rejection is specifically the File FK.
    db.delete(record)
    db.flush()
    db.delete(module)
    db.flush()
    savepoint = db.begin_nested()
    db.delete(department)
    with pytest.raises(IntegrityError) as restricted:
        db.flush()
    savepoint.rollback()
    assert restricted.value.orig.diag.constraint_name == "fk_files_department_id_departments"
    assert (
        db.connection().scalar(
            text(
                "SELECT indexdef FROM pg_indexes WHERE schemaname='public' "
                "AND indexname='ix_files_department_id'"
            )
        )
        is not None
    )


def test_library_without_department_is_rejected(integration_owner_db):
    db = integration_owner_db
    organization = create_organization(db)
    user, _membership = create_member(db, organization)
    with pytest.raises(IntegrityError) as rejected:
        with db.begin_nested():
            db.connection().execute(
                text(
                    "INSERT INTO files (id,org_id,purpose,creator_id,filename,"
                    "expected_size,object_key,state) "
                    "VALUES (:id,:org,'library_document',:creator,'guide.pdf',1,:key,"
                    "'awaiting_upload')"
                ),
                {"id": uuid7(), "org": organization.id, "creator": user.id, "key": uuid7().hex},
            )
    assert rejected.value.orig.diag.constraint_name == "ck_files_purpose_parent"
