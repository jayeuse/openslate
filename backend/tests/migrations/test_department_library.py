"""Department-library invariants and fail-safe upgrades on guarded PostgreSQL."""

import subprocess

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.systems.boards.models import Board
from app.systems.platform.files.models import File
from app.systems.sandbox.records.models import Record
from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment, run_alembic
from tests.rbac.support import add_department, add_module, add_user

pytestmark = pytest.mark.integration
PREVIOUS_HEAD = "3a869b1c1e34"


def test_library_owns_exactly_one_department_and_parent_delete_is_restricted(integration_db):
    db = integration_db
    creator = add_user(db)
    department = add_department(db)
    module = add_module(db, department)
    record = Record(module_id=module.id, data={})
    board = Board(scope="project", name=f"Library isolation {uuid7()}", status="active")
    db.add_all([record, board])
    db.flush()

    def inventory(purpose="library_document", **parents):
        return File(
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
    identity = uuid7()
    db.connection().execute(
        text(
            "INSERT INTO users (id,email,username,status,role) "
            "VALUES (:id,:email,:name,'active','member')"
        ),
        {"id": identity, "email": f"parent-{identity}@example.test", "name": str(identity)},
    )
    with pytest.raises(IntegrityError) as rejected:
        with db.begin_nested():
            db.connection().execute(
                text(
                    "INSERT INTO files (id,purpose,creator_id,filename,"
                    "expected_size,object_key,state) "
                    "VALUES (:id,'library_document',:creator,'guide.pdf',1,:key,'awaiting_upload')"
                ),
                {"id": uuid7(), "creator": identity, "key": uuid7().hex},
            )
    assert rejected.value.orig.diag.constraint_name == "ck_files_purpose_parent"


def test_upgrade_refuses_unmapped_legacy_library_before_schema_changes():
    environment = guarded_migration_environment()
    run_alembic(environment, "downgrade", PREVIOUS_HEAD)
    engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    identity, file_id = uuid7(), uuid7()
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO users (id,email,username,status,role) "
                    "VALUES (:id,:email,:name,'active','member')"
                ),
                {"id": identity, "email": f"legacy-{identity}@example.test", "name": str(identity)},
            )
            connection.execute(
                text(
                    "INSERT INTO files (id,purpose,creator_id,filename,"
                    "expected_size,object_key,state,is_deleted) "
                    "VALUES (:id,'library_document',:creator,'legacy.pdf',"
                    "1,:key,'awaiting_upload',true)"
                ),
                {"id": file_id, "creator": identity, "key": uuid7().hex},
            )
        with pytest.raises(subprocess.CalledProcessError):
            run_alembic(environment, "upgrade", "head")
        with engine.connect() as connection:
            assert (
                connection.scalar(text("SELECT version_num FROM alembic_version")) == PREVIOUS_HEAD
            )
            assert (
                connection.scalar(text("SELECT count(*) FROM files WHERE id=:id"), {"id": file_id})
                == 1
            )
            assert (
                connection.scalar(
                    text(
                        "SELECT count(*) FROM information_schema.columns "
                        "WHERE table_schema='public' AND table_name='files' "
                        "AND column_name='department_id'"
                    )
                )
                == 0
            )
    finally:
        with engine.begin() as connection:
            connection.execute(text("DELETE FROM files WHERE id=:id"), {"id": file_id})
            connection.execute(text("DELETE FROM users WHERE id=:id"), {"id": identity})
        engine.dispose()
        run_alembic(environment, "upgrade", "head")
