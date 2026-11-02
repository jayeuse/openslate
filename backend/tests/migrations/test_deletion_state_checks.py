"""Every soft-delete table rejects an is_deleted and deleted_at pair that disagree."""

from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.sandbox.departments.models import Department
from tests.conftest import create_organization

pytestmark = pytest.mark.integration
BACKEND = Path(__file__).resolve().parents[2]

# Tables with both soft-delete columns that lack a validated pair check of the shared form.
_UNCHECKED = text(
    """
    SELECT c.relname
      FROM pg_class AS c
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = c.oid
                   AND attname = 'is_deleted' AND NOT attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = c.oid
                   AND attname = 'deleted_at' AND NOT attisdropped)
       AND NOT EXISTS (
           SELECT 1 FROM pg_constraint AS con
            WHERE con.conrelid = c.oid AND con.contype = 'c' AND con.convalidated
              AND con.conname = 'ck_' || c.relname || '_deletion_state'
              AND pg_get_constraintdef(con.oid) = :definition
       )
     ORDER BY 1
    """
)
_DEFINITION = (
    "CHECK (((is_deleted AND (deleted_at IS NOT NULL)) OR "
    "((NOT is_deleted) AND (deleted_at IS NULL))))"
)


def test_every_soft_delete_table_has_a_validated_deletion_state_check(
    integration_owner_db: Session,
) -> None:
    # 82 tables kept the pair only in application code (plan finding F7). The query reads
    # the catalog, so a table that defines the columns without BaseModel is checked too.
    connection = integration_owner_db.connection()
    tables = connection.scalar(
        text(
            "SELECT count(*) FROM information_schema.columns "
            "WHERE table_schema = 'public' AND column_name = 'deleted_at'"
        )
    )
    assert tables is not None and tables > 0
    unchecked = connection.scalars(_UNCHECKED, {"definition": _DEFINITION}).all()
    assert unchecked == []


@pytest.mark.parametrize(
    ("is_deleted", "deleted_at"),
    [
        pytest.param(True, None, id="deleted-without-time"),
        pytest.param(False, datetime(2026, 10, 31, tzinfo=UTC), id="live-with-time"),
    ],
)
def test_a_mismatched_soft_delete_pair_is_rejected(
    integration_db: Session, is_deleted: bool, deleted_at: datetime | None
) -> None:
    organization = create_organization(integration_db)
    integration_db.add(
        Department(
            org_id=organization.id,
            department_name=f"Deletion state {uuid7()}",
            is_deleted=is_deleted,
            deleted_at=deleted_at,
        )
    )
    with pytest.raises(IntegrityError) as rejected:
        integration_db.flush()
    assert getattr(rejected.value.orig, "sqlstate", None) == "23514"
    assert rejected.value.orig.diag.constraint_name == "ck_departments_deletion_state"


