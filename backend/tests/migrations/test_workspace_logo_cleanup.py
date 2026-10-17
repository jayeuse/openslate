"""Internal cleanup origin constraints and runtime privileges on the fresh root."""

from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from tests.conftest import alembic_heads, create_member, create_organization, guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment

pytestmark = pytest.mark.integration


@pytest.fixture
def migration_actor():
    environment = guarded_migration_environment()
    engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    with Session(engine) as db:
        organization = create_organization(db)
        user, _membership = create_member(db, organization, "admin")
        identity, org_id = user.id, organization.id
        db.commit()
    try:
        yield identity, org_id
    finally:
        with engine.begin() as connection:
            connection.execute(text("DELETE FROM files WHERE creator_id=:id"), {"id": identity})
            connection.execute(text("DELETE FROM memberships WHERE user_id=:id"), {"id": identity})
            connection.execute(text("DELETE FROM users WHERE id=:id"), {"id": identity})
            connection.execute(text("DELETE FROM organizations WHERE id=:id"), {"id": org_id})
        engine.dispose()


def test_file_cleanup_origin_is_nullable_internal_column_with_named_fail_closed_check(
    integration_owner_db,
):
    connection = integration_owner_db.connection()
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
    [head] = alembic_heads()
    assert connection.scalar(text("SELECT version_num FROM alembic_version")) == head


@pytest.mark.parametrize("bad", ["origin", "purpose", "archive", "state", "token"])
def test_stored_origin_rejects_every_nonadmitted_shape(bad, integration_db):
    db = integration_db
    organization = create_organization(db)
    user, _membership = create_member(db, organization, "admin")
    connection = db.connection()
    identity = uuid4()
    actor = user.id
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
            text("INSERT INTO departments(id,org_id,department_name) VALUES(:id,:org,:name)"),
            {"id": department, "org": organization.id, "name": str(department)},
        )
    with pytest.raises(IntegrityError) as caught, connection.begin_nested():
        connection.execute(
            text(
                "INSERT INTO files(id,org_id,purpose,creator_id,filename,object_key,expected_size,"
                "actual_size,digest,state,is_deleted,deletion_origin,operation_id,department_id) "
                "VALUES(:id,:org,:purpose,:actor,'owned.png',:key,4,4,:digest,:state,"
                ":archive,:origin,:token,:department)"
            ),
            {
                **values, "id": identity, "org": organization.id, "actor": actor,
                "key": identity.hex, "digest": "a" * 64, "department": department,
            },
        )
    assert caught.value.orig.diag.constraint_name == "ck_files_deletion_origin"


def test_runtime_role_can_use_valid_origin_without_new_table_or_index_grants(migration_actor):
    environment = guarded_migration_environment()
    engine = guarded_create_engine(environment["TEST_DATABASE_URL"])
    actor, org_id = migration_actor
    connection = engine.connect()
    identity = uuid4()
    try:
        connection.execute(
            text(
                "INSERT INTO files(id,org_id,purpose,creator_id,filename,object_key,"
                "expected_size,state) "
                "VALUES(:id,:org,'workspace_logo',:actor,'runtime.png',:key,4,'awaiting_upload')"
            ),
            {"id": identity, "org": org_id, "actor": actor, "key": identity.hex},
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
            text("SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='files'")
        ).all()
        assert not any("deletion_origin" in definition for definition in indexes)
        connection.execute(text("DELETE FROM files WHERE id=:id"), {"id": identity})
        connection.commit()
    finally:
        connection.close()
        engine.dispose()
