"""The generated S18 migration enforces the conversation-only file parent and organization FK."""

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.systems.platform.files.models import File

pytestmark = pytest.mark.integration


def test_comms_file_parent_constraints_at_migrated_head(comms_world):
    org, table = comms_world.first, File.__table__
    with comms_world.owner.connect() as connection:
        transaction = connection.begin()
        try:

            def values(**changes):
                return {
                    "id": uuid7(),
                    "org_id": org.id,
                    "creator_id": org.author,
                    "purpose": "comms_attachment",
                    "conversation_id": org.conversation,
                    "filename": "constraint-only.png",
                    "expected_size": 1,
                    "state": "awaiting_upload",
                    "object_key": f"org/{org.id}/{uuid7().hex}",
                    **changes,
                }

            valid = values()
            connection.execute(table.insert().values(**valid))
            assert (
                connection.scalar(select(table.c.id).where(table.c.id == valid["id"]))
                == valid["id"]
            )
            for changes, sqlstate, constraint in (
                ({"conversation_id": None}, "23514", "ck_files_purpose_parent"),
                ({"department_id": org.department}, "23514", "ck_files_purpose_parent"),
                (
                    {"purpose": "library_document", "department_id": org.department},
                    "23514",
                    "ck_files_purpose_parent",
                ),
                ({"conversation_id": comms_world.second.conversation}, "23503", None),
            ):
                invalid = values(**changes)
                savepoint = connection.begin_nested()
                try:
                    with pytest.raises(IntegrityError) as caught:
                        connection.execute(table.insert().values(**invalid))
                    assert caught.value.orig.sqlstate == sqlstate
                    if constraint:
                        assert caught.value.orig.diag.constraint_name == constraint
                finally:
                    savepoint.rollback()
                assert (
                    connection.scalar(select(table.c.id).where(table.c.id == invalid["id"])) is None
                )
        finally:
            transaction.rollback()
