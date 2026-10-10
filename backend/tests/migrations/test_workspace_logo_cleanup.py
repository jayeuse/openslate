"""Internal cleanup origin, preserved legacy rows and guarded downgrade on PostgreSQL."""

import subprocess
from uuid import uuid4

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment, run_alembic

pytestmark = pytest.mark.integration
PREVIOUS = "37e161cacb06"


@pytest.fixture
def migration_actor():
    environment = guarded_migration_environment()
    engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    identity = uuid4()
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO users(id,email,username,role,status) "
                "VALUES(:id,:email,:username,'admin','active')"
            ),
            {
                "id": identity,
                "email": f"logo-migration-{identity}@example.test",
                "username": f"logo_{identity.hex}",
            },
        )
    try:
        yield identity
    finally:
        with engine.begin() as connection:
            connection.execute(text("DELETE FROM files WHERE creator_id=:id"), {"id": identity})
            connection.execute(text("DELETE FROM users WHERE id=:id"), {"id": identity})
        engine.dispose()


def test_file_cleanup_origin_is_nullable_internal_column_with_named_fail_closed_check():
    environment = guarded_migration_environment()
    engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    try:
        with engine.connect() as connection:
            checks = dict(
                connection.execute(
                    text(
                        "SELECT conname,pg_get_constraintdef(oid) FROM pg_constraint "
                        "WHERE conrelid='files'::regclass AND contype='c'"
                    )
                ).all()
            )
            assert "ck_files_deletion_origin" in checks
            column = connection.execute(
                text(
                    "SELECT is_nullable,column_default,character_maximum_length "
                    "FROM information_schema.columns WHERE table_schema='public' "
                    "AND table_name='files' AND column_name='deletion_origin'"
                )
            ).one()
            assert tuple(column) == ("YES", None, 30)
            config = Config()
            config.set_main_option("script_location", "migrations")
            assert (
                connection.scalar(text("SELECT version_num FROM alembic_version"))
                == ScriptDirectory.from_config(config).get_current_head()
            )
        run_alembic(environment, "check")
    finally:
        engine.dispose()


@pytest.mark.parametrize("bad", ["origin", "purpose", "archive", "state", "token"])
def test_stored_origin_rejects_every_nonadmitted_shape(bad, migration_actor):
    environment = guarded_migration_environment()
    engine = guarded_create_engine(environment["TEST_DATABASE_URL"])
    identity = uuid4()
    try:
        with engine.connect() as connection:
            actor = migration_actor
            assert actor is not None
            values = {
                "origin": "logo_replacement",
                "purpose": "workspace_logo",
                "archive": True,
                "state": "deleting",
                "token": uuid4(),
            }
            values[bad] = {
                "origin": "invented",
                "purpose": "library_document",
                "archive": False,
                "state": "ready",
                "token": None,
            }[bad]
            department = uuid4() if bad == "purpose" else None
            if department is not None:
                connection.execute(
                    text("INSERT INTO departments(id,department_name) VALUES(:id,:name)"),
                    {"id": department, "name": str(department)},
                )
            with pytest.raises(IntegrityError) as caught:
                connection.execute(
                    text(
                        "INSERT INTO files(id,purpose,creator_id,filename,object_key,expected_size,"
                        "actual_size,digest,state,is_deleted,deletion_origin,operation_id,"
                        "department_id) "
                        "VALUES(:id,:purpose,:actor,'owned.png',:key,4,4,:digest,:state,:archive,:origin,:token,:department)"
                    ),
                    {
                        **values,
                        "id": identity,
                        "actor": actor,
                        "key": identity.hex,
                        "digest": "a" * 64,
                        "department": department,
                    },
                )
            assert caught.value.orig.diag.constraint_name == "ck_files_deletion_origin"
            connection.rollback()
    finally:
        engine.dispose()


def test_upgrade_preserves_legacy_inventory_and_downgrade_refuses_pending_origin(migration_actor):
    environment = guarded_migration_environment()
    engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    with engine.connect() as connection:
        current_revision = connection.scalar(text("SELECT version_num FROM alembic_version"))
    run_alembic(environment, "downgrade", PREVIOUS)
    identity = uuid4()
    try:
        with engine.begin() as connection:
            actor = migration_actor
            connection.execute(
                text(
                    "INSERT INTO files(id,purpose,creator_id,filename,object_key,"
                    "expected_size,state) "
                    "VALUES(:id,'workspace_logo',:actor,'legacy.png',:key,4,'awaiting_upload')"
                ),
                {"id": identity, "actor": actor, "key": identity.hex},
            )
            before = connection.scalar(
                text("SELECT to_jsonb(files) FROM files WHERE id=:id"), {"id": identity}
            )
        run_alembic(environment, "upgrade", "head")
        with engine.begin() as connection:
            after = connection.scalar(
                text("SELECT to_jsonb(files) FROM files WHERE id=:id"), {"id": identity}
            )
            assert after.pop("deletion_origin") is None
            assert after == before
            connection.execute(
                text(
                    "UPDATE files SET state='deleting',is_deleted=true,operation_id=:token,"
                    "deletion_origin='logo_replacement' WHERE id=:id"
                ),
                {"id": identity, "token": uuid4()},
            )
        with pytest.raises(subprocess.CalledProcessError):
            run_alembic(environment, "downgrade", PREVIOUS)
        with engine.begin() as connection:
            assert (
                connection.scalar(text("SELECT version_num FROM alembic_version"))
                == current_revision
            )
            assert (
                connection.scalar(
                    text("SELECT deletion_origin FROM files WHERE id=:id"), {"id": identity}
                )
                == "logo_replacement"
            )
            connection.execute(
                text("UPDATE files SET deletion_origin=NULL WHERE id=:id"), {"id": identity}
            )
        run_alembic(environment, "downgrade", PREVIOUS)
        run_alembic(environment, "upgrade", "head")
    finally:
        with engine.begin() as connection:
            connection.execute(text("DELETE FROM files WHERE id=:id"), {"id": identity})
        engine.dispose()


def test_runtime_role_can_use_valid_origin_without_new_table_or_index_grants(migration_actor):
    environment = guarded_migration_environment()
    engine = guarded_create_engine(environment["TEST_DATABASE_URL"])
    identity = uuid4()
    try:
        with engine.connect() as connection:
            actor = migration_actor
            connection.execute(
                text(
                    "INSERT INTO files(id,purpose,creator_id,filename,object_key,"
                    "expected_size,state) "
                    "VALUES(:id,'workspace_logo',:actor,'runtime.png',:key,4,'awaiting_upload')"
                ),
                {"id": identity, "actor": actor, "key": identity.hex},
            )
            connection.commit()
            assert (
                connection.scalar(
                    text("SELECT deletion_origin FROM files WHERE id=:id"), {"id": identity}
                )
                is None
            )
            connection.execute(
                text(
                    "UPDATE files SET state='deleting',is_deleted=true,operation_id=:token,"
                    "deletion_origin='logo_replacement' WHERE id=:id"
                ),
                {"id": identity, "token": uuid4()},
            )
            connection.commit()
            assert (
                connection.scalar(
                    text("SELECT deletion_origin FROM files WHERE id=:id"), {"id": identity}
                )
                == "logo_replacement"
            )
            indexes = connection.scalars(
                text(
                    "SELECT indexdef FROM pg_indexes WHERE schemaname='public' "
                    "AND tablename='files'"
                )
            ).all()
            assert not any("deletion_origin" in definition for definition in indexes)
            connection.execute(text("DELETE FROM files WHERE id=:id"), {"id": identity})
            connection.commit()
    finally:
        engine.dispose()
